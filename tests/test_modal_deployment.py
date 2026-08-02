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
        self.assertIn("scaledown_window=30,\n", text)
        self.assertIn(
            'modal.Secret.from_name("shareguard-production")',
            text,
        )
        self.assertIn(
            "modal.web_server(PORT, startup_timeout=600)",
            text,
        )
        self.assertIn("if modal.is_local()", text)
        self.assertIn('ROOT = Path("/app")', text)

    def test_modal_adapter_mounts_model_read_only(self):
        text = self.modal_source()

        self.assertIn("MODEL_VOLUME.read_only()", text)
        self.assertIn('"/models":', text)
        self.assertIn('CACHE_ROOT = "/shareguard-cache"', text)
        self.assertIn("CACHE_ROOT: CACHE_VOLUME", text)
        self.assertNotIn('"/cache": CACHE_VOLUME', text)
        for setting in [
            '"SHAREGUARD_MODEL_CACHE": f"{CACHE_ROOT}/models"',
            '"XDG_CACHE_HOME": CACHE_ROOT',
            '"HF_HOME": f"{CACHE_ROOT}/huggingface"',
            '"TORCH_HOME": f"{CACHE_ROOT}/torch"',
        ]:
            self.assertIn(setting, text)

        image_environment = text[
            text.index(".env("):text.index(".add_local_dir(")
        ]
        for setting in [
            "SHAREGUARD_MODEL_CACHE",
            "XDG_CACHE_HOME",
            "HF_HOME",
            "TORCH_HOME",
        ]:
            self.assertNotIn(setting, image_environment)
        self.assertIn("env=runtime_environment()", text)
        self.assertIn('environment.get("SHAREGUARD_EDGE_SHARED_SECRET")', text)
        self.assertIn("Modal edge identity secret is missing", text)
        self.assertIn('"SHAREGUARD_RATE_LIMIT_PER_MINUTE": "0"', text)
        self.assertIn('"SHAREGUARD_DAILY_QUOTA": "0"', text)

    def test_modal_adapter_forces_production_spai_hybrid(self):
        text = self.modal_source()

        for setting in [
            '"SHAREGUARD_MODE": "production"',
            '"SHAREGUARD_BACKEND": "spai-hybrid"',
            '"SHAREGUARD_DEVICE": "cuda"',
            '"SPAI_CHECKPOINT": SPAI_CHECKPOINT',
            '"SPAI_SOURCE_DIR": SPAI_SOURCE_DIR',
            '"SPAI_CONFIG": SPAI_CONFIG',
            '"SHAREGUARD_SHADOW_SAMPLE_RATE": "0.25"',
            '"BUNDLE": MODEL_ARCHIVE',
        ]:
            self.assertIn(setting, text)
        self.assertIn("SPAI_CHECKPOINT_SHA256", text)
        self.assertIn("SPAI_SOURCE_REVISION", text)
        self.assertNotIn(
            "shareguard-noisyshare-fusion-v1-safe.tar.gz.sha256",
            text,
        )

    def test_modal_image_handles_pep668_registry_base(self):
        text = self.modal_source()

        self.assertIn(
            'extra_options="--break-system-packages"',
            text,
        )

    def test_local_source_mount_is_the_final_image_operation(self):
        text = self.modal_source()
        local_source = text.index(".add_local_dir(")

        self.assertGreater(local_source, text.index(".workdir("))
        self.assertGreater(local_source, text.index(".env("))

    def test_private_modal_files_are_excluded_from_build_context(self):
        dockerignore = (ROOT / ".dockerignore").read_text(encoding="utf-8")
        gitignore = (ROOT / ".gitignore").read_text(encoding="utf-8")

        self.assertIn("deploy/modal/.env", dockerignore)
        self.assertIn("deploy/modal/.env", gitignore)

    def test_modal_control_plane_dependency_is_separate(self):
        requirements = (ROOT / "requirements-modal.txt").read_text(
            encoding="utf-8"
        )

        self.assertEqual(
            set(requirements.splitlines()),
            {"modal>=1.2,<2", "python-dotenv>=1.0,<2"},
        )


if __name__ == "__main__":
    unittest.main()
