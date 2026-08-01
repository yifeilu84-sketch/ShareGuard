"""Local-only fixture server for browser contract checks."""

from shareguard.platform.app import run_server
from shareguard.platform.backends import DetectionResult
from shareguard.platform.config import PlatformConfig


class FixtureBackend:
    name = "frontend-fixture"

    def analyze(self, image, filename="image"):
        return DetectionResult(
            file_name=filename,
            label="ai_generated",
            probability_ai_generated=0.7349,
            confidence=0.6129,
            risk_level="medium",
            backend=self.name,
            image={"width": image.width, "height": image.height, "mode": "RGB"},
            evidence=[],
            raw={"model_version": "fixture-v1"},
        )


if __name__ == "__main__":
    run_server(
        "127.0.0.1",
        8765,
        FixtureBackend(),
        config=PlatformConfig(
            include_propagation_views=True,
            public_score_decimals=3,
        ),
    )
