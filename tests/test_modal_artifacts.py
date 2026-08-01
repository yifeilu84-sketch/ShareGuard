import hashlib
import io
import json
import subprocess
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path

from scripts.modal.upload_private_bundle import (
    build_upload_command,
    modal_cli_environment,
    validate_safe_bundle,
)


ROOT = Path(__file__).resolve().parents[1]


class ModalArtifactTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def make_bundle(
        self,
        checkpoint_format="safetensors",
        include_checkpoint=True,
        checkpoint_name="models/clip_b/seed42/model.safetensors",
        include_link=False,
    ):
        archive = self.root / "shareguard-safe.tar.gz"
        manifest = {
            "bundle_type": "noisyshare_fusion",
            "checkpoint_format": checkpoint_format,
            "method": "clip_b_l_score_fusion",
            "alpha_clip_l": 0.63,
            "threshold": 0.32,
            "groups": {
                "clip_b": [{"checkpoint": checkpoint_name}],
                "clip_l": [],
            },
        }
        manifest_bytes = json.dumps(manifest).encode("utf-8")
        with tarfile.open(archive, "w:gz") as handle:
            manifest_info = tarfile.TarInfo("bundle/manifest.json")
            manifest_info.size = len(manifest_bytes)
            handle.addfile(manifest_info, io.BytesIO(manifest_bytes))
            if include_checkpoint:
                checkpoint_bytes = b"safe-tensor-placeholder"
                checkpoint_info = tarfile.TarInfo(
                    f"bundle/{checkpoint_name}"
                )
                checkpoint_info.size = len(checkpoint_bytes)
                handle.addfile(
                    checkpoint_info,
                    io.BytesIO(checkpoint_bytes),
                )
            if include_link:
                link = tarfile.TarInfo(
                    "bundle/models/escape.safetensors"
                )
                link.type = tarfile.SYMTYPE
                link.linkname = "../../outside"
                handle.addfile(link)
        return archive

    @staticmethod
    def digest(path):
        return hashlib.sha256(path.read_bytes()).hexdigest()

    def test_validate_safe_bundle_accepts_verified_safetensors_archive(self):
        archive = self.make_bundle()

        resolved = validate_safe_bundle(archive, self.digest(archive))

        self.assertEqual(resolved, archive.resolve())

    def test_validate_safe_bundle_rejects_digest_mismatch(self):
        archive = self.make_bundle()

        with self.assertRaisesRegex(ValueError, "SHA-256 mismatch"):
            validate_safe_bundle(archive, "0" * 64)

    def test_validate_safe_bundle_rejects_pickle_checkpoint(self):
        archive = self.make_bundle(
            checkpoint_format="pytorch",
            checkpoint_name="models/clip_b/seed42/model.pt",
        )

        with self.assertRaisesRegex(ValueError, "safetensors"):
            validate_safe_bundle(archive, self.digest(archive))

    def test_validate_safe_bundle_rejects_missing_checkpoint(self):
        archive = self.make_bundle(include_checkpoint=False)

        with self.assertRaisesRegex(ValueError, "missing checkpoint"):
            validate_safe_bundle(archive, self.digest(archive))

    def test_validate_safe_bundle_rejects_links(self):
        archive = self.make_bundle(include_link=True)

        with self.assertRaisesRegex(ValueError, "links"):
            validate_safe_bundle(archive, self.digest(archive))

    def test_build_upload_command_never_contains_a_secret(self):
        command = build_upload_command(
            Path("bundle.tar.gz"),
            "shareguard-models",
            "bundle.tar.gz",
        )

        self.assertEqual(
            command[:4],
            [sys.executable, "-m", "modal", "volume"],
        )
        self.assertEqual(
            command[4:7],
            ["put", "shareguard-models", "bundle.tar.gz"],
        )
        self.assertEqual(command[-2:], ["bundle.tar.gz", "--force"])

    def test_upload_script_runs_directly_from_repository_root(self):
        completed = subprocess.run(
            [
                sys.executable,
                "-S",
                "scripts/modal/upload_private_bundle.py",
                "--help",
            ],
            cwd=ROOT,
            capture_output=True,
            text=True,
            check=False,
        )

        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertIn("--archive", completed.stdout)

    def test_modal_cli_subprocess_forces_utf8_without_mutating_input(self):
        original = {"PYTHONUTF8": "0", "UNCHANGED": "yes"}

        environment = modal_cli_environment(original)

        self.assertEqual(environment["PYTHONUTF8"], "1")
        self.assertEqual(environment["PYTHONIOENCODING"], "utf-8")
        self.assertEqual(environment["UNCHANGED"], "yes")
        self.assertEqual(original, {"PYTHONUTF8": "0", "UNCHANGED": "yes"})


if __name__ == "__main__":
    unittest.main()
