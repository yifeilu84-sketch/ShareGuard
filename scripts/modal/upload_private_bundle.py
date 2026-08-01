"""Verify and upload a private ShareGuard bundle to a Modal Volume."""

import argparse
import json
from pathlib import Path, PurePosixPath
import subprocess
import sys
import tarfile
from typing import Iterable

from shareguard.platform.model_artifacts import sha256_file


def _validated_digest(value: str) -> str:
    digest = value.strip().lower()
    if len(digest) != 64 or any(ch not in "0123456789abcdef" for ch in digest):
        raise ValueError("Expected SHA-256 must be 64 hexadecimal characters")
    return digest


def _safe_member_path(name: str) -> PurePosixPath:
    normalized = name.replace("\\", "/")
    path = PurePosixPath(normalized)
    if path.is_absolute() or not path.parts:
        raise ValueError("Model bundle contains an unsafe archive path")
    if any(part in {"", ".", ".."} for part in path.parts):
        raise ValueError("Model bundle contains an unsafe archive path")
    return path


def _checkpoint_paths(manifest: dict) -> Iterable[str]:
    groups = manifest.get("groups")
    if not isinstance(groups, dict):
        raise ValueError("Model bundle manifest has invalid groups")
    for entries in groups.values():
        if not isinstance(entries, list):
            raise ValueError("Model bundle manifest has invalid group entries")
        for entry in entries:
            if not isinstance(entry, dict) or not isinstance(
                entry.get("checkpoint"), str
            ):
                raise ValueError("Model bundle manifest has invalid checkpoint entry")
            yield entry["checkpoint"]


def validate_safe_bundle(path: Path, expected_sha256: str) -> Path:
    """Validate an archive without extracting it or executing model code."""

    archive = Path(path).expanduser().resolve()
    if not archive.is_file():
        raise FileNotFoundError(f"Model bundle not found: {archive}")
    if not archive.name.endswith(".tar.gz"):
        raise ValueError("Modal model bundle must be a .tar.gz archive")

    expected = _validated_digest(expected_sha256)
    if sha256_file(archive) != expected:
        raise ValueError("Model bundle SHA-256 mismatch")

    with tarfile.open(archive, mode="r:gz") as handle:
        members = handle.getmembers()
        if not members:
            raise ValueError("Model bundle archive is empty")
        if any(member.issym() or member.islnk() for member in members):
            raise ValueError("Model bundle archive cannot contain links")

        paths = [_safe_member_path(member.name) for member in members]
        roots = {member.parts[0] for member in paths}
        if len(roots) != 1:
            raise ValueError("Model bundle archive must contain one root directory")
        root = roots.pop()

        names = [path.as_posix() for path in paths]
        if len(names) != len(set(names)):
            raise ValueError("Model bundle archive contains duplicate paths")
        member_by_name = dict(zip(names, members))

        manifest_name = f"{root}/manifest.json"
        manifest_member = member_by_name.get(manifest_name)
        if manifest_member is None or not manifest_member.isfile():
            raise ValueError("Model bundle archive is missing its manifest")
        if manifest_member.size > 1024 * 1024:
            raise ValueError("Model bundle manifest is unexpectedly large")
        manifest_file = handle.extractfile(manifest_member)
        if manifest_file is None:
            raise ValueError("Model bundle manifest cannot be read")
        manifest = json.loads(manifest_file.read().decode("utf-8"))

        if manifest.get("bundle_type") != "noisyshare_fusion":
            raise ValueError("Model bundle has an unsupported bundle type")
        if manifest.get("checkpoint_format") != "safetensors":
            raise ValueError("Modal deployment requires safetensors checkpoints")

        checkpoint_count = 0
        for checkpoint in _checkpoint_paths(manifest):
            relative = _safe_member_path(checkpoint)
            if relative.suffix != ".safetensors":
                raise ValueError("Modal deployment requires safetensors checkpoints")
            archive_name = f"{root}/{relative.as_posix()}"
            checkpoint_member = member_by_name.get(archive_name)
            if checkpoint_member is None or not checkpoint_member.isfile():
                raise ValueError(
                    f"Model bundle is missing checkpoint: {relative.as_posix()}"
                )
            checkpoint_count += 1
        if checkpoint_count == 0:
            raise ValueError("Model bundle manifest contains no checkpoints")

    return archive


def build_upload_command(
    path: Path,
    volume: str,
    remote_name: str,
) -> list[str]:
    return [
        sys.executable,
        "-m",
        "modal",
        "volume",
        "put",
        volume,
        str(path),
        remote_name,
        "--force",
    ]


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Verify and upload a private ShareGuard serving bundle"
    )
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--sha256", required=True)
    parser.add_argument("--volume", default="shareguard-models")
    parser.add_argument(
        "--remote-name",
        default="shareguard-noisyshare-fusion-v1-safe.tar.gz",
    )
    return parser


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    archive = validate_safe_bundle(args.archive, args.sha256)
    digest = _validated_digest(args.sha256)
    print(f"Verified private bundle: {archive.name}")
    print(f"SHA-256: {digest}")
    subprocess.run(
        build_upload_command(
            archive,
            args.volume,
            args.remote_name,
        ),
        check=True,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
