import unittest

from shareguard.platform.config import PlatformConfig


class PlatformConfigTests(unittest.TestCase):
    def test_defaults_are_local_and_cross_origin_is_disabled(self):
        config = PlatformConfig.from_env({})

        self.assertEqual(config.mode, "local")
        self.assertEqual(config.max_upload_bytes, 10 * 1024 * 1024)
        self.assertEqual(config.max_image_pixels, 25_000_000)
        self.assertEqual(config.max_http_workers, 16)
        self.assertFalse(config.is_origin_allowed("https://example.com"))

    def test_allowed_origins_require_exact_match(self):
        config = PlatformConfig.from_env({
            "SHAREGUARD_ALLOWED_ORIGINS": (
                "https://pilot.example,https://review.example/"
            ),
        })

        self.assertTrue(config.is_origin_allowed("https://pilot.example"))
        self.assertTrue(config.is_origin_allowed("https://review.example/"))
        self.assertFalse(config.is_origin_allowed("https://pilot.example.evil"))

    def test_production_requires_api_token(self):
        config = PlatformConfig.from_env({"SHAREGUARD_MODE": "production"})

        with self.assertRaisesRegex(ValueError, "SHAREGUARD_API_TOKEN"):
            config.validate()

    def test_invalid_numeric_limit_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "SHAREGUARD_MAX_UPLOAD_BYTES"):
            PlatformConfig.from_env({"SHAREGUARD_MAX_UPLOAD_BYTES": "large"})

    def test_non_positive_numeric_limit_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "SHAREGUARD_MAX_IMAGE_PIXELS"):
            PlatformConfig.from_env({"SHAREGUARD_MAX_IMAGE_PIXELS": "0"})

    def test_waiting_queue_can_be_disabled(self):
        config = PlatformConfig.from_env({"SHAREGUARD_MAX_WAITING_REQUESTS": "0"})

        self.assertEqual(config.max_waiting_requests, 0)

    def test_http_worker_limit_is_configurable(self):
        config = PlatformConfig.from_env({"SHAREGUARD_MAX_HTTP_WORKERS": "6"})

        self.assertEqual(config.max_http_workers, 6)

    def test_invalid_mode_is_rejected(self):
        config = PlatformConfig.from_env({"SHAREGUARD_MODE": "public"})

        with self.assertRaisesRegex(ValueError, "SHAREGUARD_MODE"):
            config.validate()


if __name__ == "__main__":
    unittest.main()
