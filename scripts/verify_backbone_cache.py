"""Verify the exact public backbone files used by offline serving."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from shareguard.platform.safe_checkpoints import sha256_file


def verify_cache(hf_home: Path, lock_path: Path) -> int:
    lock = json.loads(lock_path.read_text(encoding="utf-8"))
    if lock.get("format") != "shareguard-backbone-lock-v1":
        raise ValueError("Unsupported backbone lock format")

    verified = 0
    hub = hf_home.resolve() / "hub"
    for item in lock.get("models", []):
        repository_dir = "models--" + item["repository"].replace("/", "--")
        path = (
            hub
            / repository_dir
            / "snapshots"
            / item["revision"]
            / item["filename"]
        )
        if path.is_symlink() or not path.is_file():
            raise ValueError(f"Locked backbone file is missing: {item['name']}")
        if path.stat().st_size != int(item["size"]):
            raise ValueError(f"Locked backbone size mismatch: {item['name']}")
        if sha256_file(path) != item["sha256"]:
            raise ValueError(f"Locked backbone SHA-256 mismatch: {item['name']}")
        verified += 1
    if verified != 3:
        raise ValueError("Backbone lock must contain exactly three models")
    return verified


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--hf-home", required=True)
    parser.add_argument("--lock", required=True)
    args = parser.parse_args(argv)
    verified = verify_cache(Path(args.hf_home), Path(args.lock))
    print(f"Verified {verified} locked backbone files.")


if __name__ == "__main__":
    main()
