"""Model artifact resolution for deployment environments."""

import hashlib
import tarfile
import zipfile
from pathlib import Path
from typing import Optional
from urllib.parse import urlparse
from urllib.request import urlretrieve


def default_cache_dir() -> Path:
    return Path.home() / ".cache" / "shareguard" / "models"


def artifact_name_from_url(model_url: str) -> str:
    parsed = urlparse(model_url)
    name = Path(parsed.path).name
    if not name:
        digest = hashlib.sha256(model_url.encode("utf-8")).hexdigest()[:12]
        name = f"shareguard-model-{digest}.pt"
    return name


def resolve_checkpoint_path(
    checkpoint: Optional[str],
    model_url: Optional[str],
    cache_dir: Optional[Path] = None,
) -> Path:
    """Return a local checkpoint path, downloading model_url when needed."""

    if checkpoint:
        path = Path(checkpoint).expanduser()
        if not path.exists():
            raise FileNotFoundError(f"Checkpoint not found: {path}")
        return path

    if not model_url:
        raise ValueError("Either --checkpoint or --model-url is required.")

    cache = Path(cache_dir or default_cache_dir()).expanduser()
    cache.mkdir(parents=True, exist_ok=True)
    target = cache / artifact_name_from_url(model_url)
    if not target.exists() or target.stat().st_size == 0:
        tmp = target.with_suffix(target.suffix + ".download")
        if tmp.exists():
            tmp.unlink()
        urlretrieve(model_url, tmp)
        tmp.replace(target)
    return target


def resolve_bundle_path(
    bundle_path: Optional[str],
    bundle_url: Optional[str],
    cache_dir: Optional[Path] = None,
) -> Path:
    """Return a local model bundle directory, downloading/extracting archives."""

    if bundle_path:
        path = Path(bundle_path).expanduser()
        if not path.exists():
            raise FileNotFoundError(f"Model bundle not found: {path}")
        if path.is_dir():
            return path
        cache = Path(cache_dir).expanduser() if cache_dir else path.parent
        cache.mkdir(parents=True, exist_ok=True)
        return _resolve_bundle_archive(path, cache)

    if not bundle_url:
        raise ValueError("Either --bundle or --bundle-url is required.")

    cache = Path(cache_dir or default_cache_dir()).expanduser()
    cache.mkdir(parents=True, exist_ok=True)
    archive = cache / artifact_name_from_url(bundle_url)
    if not archive.exists() or archive.stat().st_size == 0:
        tmp = archive.with_suffix(archive.suffix + ".download")
        if tmp.exists():
            tmp.unlink()
        urlretrieve(bundle_url, tmp)
        tmp.replace(archive)

    return _resolve_bundle_archive(archive, cache)


def _resolve_bundle_archive(archive: Path, cache: Path) -> Path:
    if archive.suffix == ".zip":
        return _extract_zip(archive, cache)
    if archive.name.endswith((".tar.gz", ".tgz", ".tar")):
        return _extract_tar(archive, cache)
    if archive.is_dir():
        return archive
    raise ValueError(f"Unsupported model bundle format: {archive}")


def _safe_extract_root(names):
    roots = {Path(name).parts[0] for name in names if Path(name).parts}
    if len(roots) == 1:
        return roots.pop()
    digest = hashlib.sha256("|".join(sorted(names)).encode("utf-8")).hexdigest()[:12]
    return f"shareguard-bundle-{digest}"


def _assert_safe_member(path: Path, target_root: Path):
    resolved = path.resolve()
    root = target_root.resolve()
    if root != resolved and root not in resolved.parents:
        raise ValueError(f"Unsafe archive member path: {path}")


def _extract_tar(archive: Path, cache: Path) -> Path:
    with tarfile.open(archive) as tf:
        members = tf.getmembers()
        root_name = _safe_extract_root([m.name for m in members])
        target = cache / root_name
        if (target / "manifest.json").exists():
            return target
        for member in members:
            _assert_safe_member(target / member.name, cache)
        tf.extractall(cache, filter="data")
    return target


def _extract_zip(archive: Path, cache: Path) -> Path:
    with zipfile.ZipFile(archive) as zf:
        names = zf.namelist()
        root_name = _safe_extract_root(names)
        target = cache / root_name
        if (target / "manifest.json").exists():
            return target
        for name in names:
            _assert_safe_member(target / name, cache)
        zf.extractall(cache)
    return target
