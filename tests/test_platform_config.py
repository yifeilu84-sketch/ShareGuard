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

    def test_production_requires_an_authentication_boundary(self):
        config = PlatformConfig.from_env({"SHAREGUARD_MODE": "production"})

        with self.assertRaisesRegex(ValueError, "authentication"):
            config.validate()

        access_config = PlatformConfig.from_env({
            "SHAREGUARD_MODE": "production",
            "SHAREGUARD_REQUIRE_ACCESS_IDENTITY": "true",
        })
        access_config.validate()

        basic_config = PlatformConfig.from_env({
            "SHAREGUARD_MODE": "production",
            "SHAREGUARD_HTTP_BASIC_USERNAME": "shareguard-demo",
            "SHAREGUARD_HTTP_BASIC_PASSWORD": "a" * 24,
        })
        basic_config.validate()

    def test_http_basic_credentials_must_be_complete_and_strong(self):
        incomplete = PlatformConfig.from_env({
            "SHAREGUARD_HTTP_BASIC_USERNAME": "shareguard-demo",
        })
        with self.assertRaisesRegex(ValueError, "must be set together"):
            incomplete.validate()

        weak = PlatformConfig.from_env({
            "SHAREGUARD_MODE": "production",
            "SHAREGUARD_HTTP_BASIC_USERNAME": "shareguard-demo",
            "SHAREGUARD_HTTP_BASIC_PASSWORD": "too-short",
        })
        with self.assertRaisesRegex(ValueError, "at least 20"):
            weak.validate()

        conflicting = PlatformConfig.from_env({
            "SHAREGUARD_API_TOKEN": "api-token",
            "SHAREGUARD_HTTP_BASIC_USERNAME": "shareguard-demo",
            "SHAREGUARD_HTTP_BASIC_PASSWORD": "a" * 24,
        })
        with self.assertRaisesRegex(ValueError, "cannot be combined"):
            conflicting.validate()

    def test_gateway_security_settings_are_parsed(self):
        config = PlatformConfig.from_env({
            "SHAREGUARD_REQUIRE_ACCESS_IDENTITY": "true",
            "SHAREGUARD_RATE_LIMIT_PER_MINUTE": "3",
            "SHAREGUARD_DAILY_QUOTA": "30",
            "SHAREGUARD_PUBLIC_SCORE_DECIMALS": "2",
        })

        self.assertTrue(config.require_access_identity)
        self.assertEqual(config.rate_limit_per_minute, 3)
        self.assertEqual(config.daily_quota, 30)
        self.assertEqual(config.public_score_decimals, 2)

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
