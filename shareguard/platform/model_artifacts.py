"""Model artifact resolution for deployment environments."""

import hashlib
import shutil
import stat
import tarfile
import tempfile
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


def sha256_file(path: Path) -> str:
    """Return a lowercase SHA-256 digest without loading the file at once."""

    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def verify_sha256(path: Path, expected_sha256: Optional[str]) -> None:
    """Verify an artifact digest without exposing its private location."""

    if not expected_sha256:
        return
    expected = expected_sha256.strip().lower()
    if len(expected) != 64 or any(ch not in "0123456789abcdef" for ch in expected):
        raise ValueError("Expected SHA-256 must be 64 hexadecimal characters")
    if sha256_file(path) != expected:
        raise ValueError("Model artifact SHA-256 mismatch")


def _download_artifact(
    source_url: str,
    target: Path,
    expected_sha256: Optional[str],
) -> Path:
    if target.exists() and target.stat().st_size > 0:
        try:
            verify_sha256(target, expected_sha256)
            return target
        except ValueError:
            target.unlink()

    tmp = target.with_suffix(target.suffix + ".download")
    if tmp.exists():
        tmp.unlink()
    try:
        urlretrieve(source_url, tmp)
        verify_sha256(tmp, expected_sha256)
        tmp.replace(target)
    except ValueError:
        if tmp.exists():
            tmp.unlink()
        raise
    except Exception:
        if tmp.exists():
            tmp.unlink()
        raise RuntimeError("Private model artifact download failed") from None
    return target


def resolve_checkpoint_path(
    checkpoint: Optional[str],
    model_url: Optional[str],
    cache_dir: Optional[Path] = None,
    expected_sha256: Optional[str] = None,
) -> Path:
    """Return a local checkpoint path, downloading model_url when needed."""

    if checkpoint:
        path = Path(checkpoint).expanduser()
        if not path.exists():
            raise FileNotFoundError(f"Checkpoint not found: {path}")
        verify_sha256(path, expected_sha256)
        return path

    if not model_url:
        raise ValueError("Either --checkpoint or --model-url is required.")

    cache = Path(cache_dir or default_cache_dir()).expanduser()
    cache.mkdir(parents=True, exist_ok=True)
    target = cache / artifact_name_from_url(model_url)
    return _download_artifact(model_url, target, expected_sha256)


def resolve_bundle_path(
    bundle_path: Optional[str],
    bundle_url: Optional[str],
    cache_dir: Optional[Path] = None,
    expected_sha256: Optional[str] = None,
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
        verify_sha256(path, expected_sha256)
        return _resolve_bundle_archive(path, cache)

    if not bundle_url:
        raise ValueError("Either --bundle or --bundle-url is required.")

    cache = Path(cache_dir or default_cache_dir()).expanduser()
    cache.mkdir(parents=True, exist_ok=True)
    archive = cache / artifact_name_from_url(bundle_url)
    _download_artifact(bundle_url, archive, expected_sha256)

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
    if len(roots) != 1:
        raise ValueError("Model bundle archive must contain one root directory")
    root_name = roots.pop()
    if root_name in {".", ".."} or Path(root_name).is_absolute():
        raise ValueError("Model bundle archive has an unsafe root directory")
    return root_name


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
        staging = Path(tempfile.mkdtemp(prefix=".shareguard-extract-", dir=cache))
        try:
            for member in members:
                _assert_safe_member(staging / member.name, staging)
                if member.issym() or member.islnk():
                    raise ValueError("Model bundle archive cannot contain links")
            tf.extractall(staging, filter="data")
            source = staging / root_name
            _replace_extracted_bundle(source, target, cache)
            return target
        finally:
            if staging.exists():
                shutil.rmtree(staging)


def _extract_zip(archive: Path, cache: Path) -> Path:
    with zipfile.ZipFile(archive) as zf:
        entries = zf.infolist()
        names = [entry.filename for entry in entries]
        root_name = _safe_extract_root(names)
        target = cache / root_name
        staging = Path(tempfile.mkdtemp(prefix=".shareguard-extract-", dir=cache))
        try:
            for entry in entries:
                _assert_safe_member(staging / entry.filename, staging)
                file_type = (entry.external_attr >> 16) & 0o170000
                if stat.S_ISLNK(file_type):
                    raise ValueError("Model bundle archive cannot contain links")
            zf.extractall(staging)
            source = staging / root_name
            _replace_extracted_bundle(source, target, cache)
            return target
        finally:
            if staging.exists():
                shutil.rmtree(staging)


def _replace_extracted_bundle(source: Path, target: Path, cache: Path) -> None:
    _assert_safe_member(source, source.parent)
    _assert_safe_member(target, cache)
    if not source.is_dir() or not (source / "manifest.json").is_file():
        raise ValueError("Model bundle archive is missing its manifest")
    if target.is_symlink() or target.is_file():
        target.unlink()
    elif target.exists():
        shutil.rmtree(target)
    source.replace(target)
