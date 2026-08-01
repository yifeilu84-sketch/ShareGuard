import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class ModalDeploymentTests(unittest.TestCase):
    def modal_source(self) -> str:
        return (
            ROOT / "deploy" / "modal" / "shareguard_modal.py"
        ).read_text(encoding="utf-8")

    def test_modal_adapter_uses_private_gpu_runtime(self):
        text = self.modal_source()

        self.assertIn('modal.App("shareguard-private-inference")', text)
        self.assertIn('gpu="T4"', text)
        self.assertIn("min_containers=0", text)
        self.assertIn("max_containers=1", text)
        self.assertIn(
            'modal.Secret.from_name("shareguard-production")',
            text,
        )
        self.assertIn(
            "modal.web_server(PORT, startup_timeout=600)",
            text,
        )

    def test_modal_adapter_mounts_model_read_only(self):
        text = self.modal_source()

        self.assertIn("MODEL_VOLUME.read_only()", text)
        self.assertIn('"/models":', text)
        self.assertIn('"/cache": CACHE_VOLUME', text)

    def test_modal_adapter_forces_production_fusion_bundle(self):
        text = self.modal_source()

        for setting in [
            '"SHAREGUARD_MODE": "production"',
            '"SHAREGUARD_BACKEND": "fusion-bundle"',
            '"SHAREGUARD_DEVICE": "cuda"',
            '"BUNDLE": MODEL_ARCHIVE',
        ]:
            self.assertIn(setting, text)
        self.assertNotIn(
            "shareguard-noisyshare-fusion-v1-safe.tar.gz.sha256",
            text,
        )

    def test_private_modal_files_are_excluded_from_build_context(self):
        dockerignore = (ROOT / ".dockerignore").read_text(encoding="utf-8")
        gitignore = (ROOT / ".gitignore").read_text(encoding="utf-8")

        self.assertIn("deploy/modal/.env", dockerignore)
        self.assertIn("deploy/modal/.env", gitignore)

    def test_modal_control_plane_dependency_is_separate(self):
        requirements = (ROOT / "requirements-modal.txt").read_text(
            encoding="utf-8"
        )

        self.assertEqual(requirements.strip(), "modal>=1.2,<2")


if __name__ == "__main__":
    unittest.main()
