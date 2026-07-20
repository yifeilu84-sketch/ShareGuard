"""Migrate a verified ShareGuard fusion bundle to tensor-only checkpoints.

This script intentionally loads legacy pickle checkpoints exactly once. Run it
only against a bundle whose archive and per-checkpoint SHA-256 values have been
verified and whose provenance is trusted.
"""

from __future__ import annotations

import argparse
import json
import shutil
import tarfile
from pathlib import Path

import torch
from safetensors.torch import save_file

from shareguard.platform.safe_checkpoints import (
    sha256_file,
    tensors_from_legacy_checkpoint,
    verify_checkpoint_sha256,
)


def _validated_source_bundle(path: Path) -> tuple[Path, dict]:
    source = path.resolve()
    manifest_path = source / "manifest.json"
    if not source.is_dir() or not manifest_path.is_file():
        raise ValueError("Source bundle must be a directory containing manifest.json")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("bundle_type") != "noisyshare_fusion":
        raise ValueError("Source bundle is not a ShareGuard fusion bundle")
    return source, manifest


def _verify_source_archive(path: Path, expected_sha256: str) -> str:
    archive = path.resolve()
    expected = expected_sha256.strip().lower()
    if not archive.is_file():
        raise FileNotFoundError(f"Source archive not found: {archive}")
    actual = sha256_file(archive)
    if actual != expected:
        raise ValueError("Source archive SHA-256 mismatch")
    return actual


def migrate_bundle(
    source_bundle: Path,
    out_dir: Path,
    archive: Path,
    source_archive: Path,
    expected_source_archive_sha256: str,
) -> dict:
    source, manifest = _validated_source_bundle(source_bundle)
    source_archive_sha256 = _verify_source_archive(
        source_archive,
        expected_source_archive_sha256,
    )

    target = out_dir.resolve()
    archive_path = archive.resolve()
    if target == source or source in target.parents:
        raise ValueError("Output bundle must not be inside the source bundle")
    if target.exists():
        raise FileExistsError(f"Output bundle already exists: {target}")
    if archive_path.exists():
        raise FileExistsError(f"Output archive already exists: {archive_path}")

    shutil.copytree(source, target)
    converted = 0
    for entries in manifest.get("groups", {}).values():
        for entry in entries:
            relative = Path(entry["checkpoint"])
            source_checkpoint = source / relative
            verify_checkpoint_sha256(
                source_checkpoint,
                entry["checkpoint_sha256"],
            )

            # The source archive and every checkpoint digest are verified before
            # this trusted, one-time legacy unpickle operation.
            legacy = torch.load(
                source_checkpoint,
                map_location="cpu",
                weights_only=False,
            )
            tensors = tensors_from_legacy_checkpoint(legacy)
            safe_relative = relative.with_suffix(".safetensors")
            safe_checkpoint = target / safe_relative
            save_file(
                tensors,
                str(safe_checkpoint),
                metadata={
                    "format": "shareguard-fusion-serving-v1",
                    "source_checkpoint_sha256": entry["checkpoint_sha256"],
                },
            )
            (target / relative).unlink()
            entry["checkpoint"] = safe_relative.as_posix()
            entry["checkpoint_sha256"] = sha256_file(safe_checkpoint)
            converted += 1

    manifest["version"] = max(int(manifest.get("version", 1)), 2)
    manifest["checkpoint_format"] = "safetensors"
    manifest["checkpoint_schema"] = "shareguard-fusion-serving-v1"
    manifest["legacy_source_archive_sha256"] = source_archive_sha256
    manifest["serving"] = {
        "backend": "fusion-bundle",
        "entrypoint": (
            "python -m shareguard.platform.app --backend fusion-bundle "
            "--bundle /models/shareguard-noisyshare-fusion-v1-safe.tar.gz"
        ),
    }
    (target / "manifest.json").write_text(
        json.dumps(manifest, indent=2),
        encoding="utf-8",
    )

    model_card_path = target / "model_card.json"
    model_card = (
        json.loads(model_card_path.read_text(encoding="utf-8"))
        if model_card_path.exists()
        else {}
    )
    model_card["checkpoint_format"] = "safetensors"
    model_card["serving_security"] = (
        "Tensor-only checkpoints with per-file SHA-256 and strict schema validation."
    )
    model_card_path.write_text(
        json.dumps(model_card, indent=2),
        encoding="utf-8",
    )

    archive_path.parent.mkdir(parents=True, exist_ok=True)
    with tarfile.open(archive_path, "w:gz") as handle:
        handle.add(target, arcname=target.name)
    archive_sha256 = sha256_file(archive_path)
    checksum_path = archive_path.with_suffix(archive_path.suffix + ".sha256")
    checksum_path.write_text(
        f"{archive_sha256}  {archive_path.name}\n",
        encoding="ascii",
    )
    return {
        "bundle": str(target),
        "archive": str(archive_path),
        "archive_sha256": archive_sha256,
        "source_archive_sha256": source_archive_sha256,
        "converted_checkpoints": converted,
    }


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-bundle", required=True)
    parser.add_argument("--source-archive", required=True)
    parser.add_argument("--expected-source-archive-sha256", required=True)
    parser.add_argument("--out-dir", required=True)
    parser.add_argument("--archive", required=True)
    args = parser.parse_args(argv)

    result = migrate_bundle(
        Path(args.source_bundle),
        Path(args.out_dir),
        Path(args.archive),
        Path(args.source_archive),
        args.expected_source_archive_sha256,
    )
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
