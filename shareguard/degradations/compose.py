"""Degradation composition and pipeline management.

Defines preset degradation pipelines simulating real-world sharing scenarios.
"""

import argparse
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Union

import pandas as pd
from PIL import Image
from tqdm import tqdm

from .jpeg import JPEG, WEBP, RandomJPEG
from .resize import Resize, RandomResize, DownscaleUpscale
from .crop import CenterCrop, RandomCrop
from .blur import GaussianBlur, MotionBlur
from .color import Brightness, Contrast, RandomColorJitter
from .overlay import WhiteBorder, TextOverlay
from .screenshot import ScreenshotSimulation


class DegradationComposer:
    """Compose multiple degradations into a pipeline.

    Args:
        degradations: List of degradation callables.
        name: Name of this pipeline.
    """

    def __init__(self, degradations: List[Callable], name: str = "custom"):
        self.degradations = degradations
        self.name = name

    def __call__(self, image: Image.Image) -> Image.Image:
        """Apply all degradations in sequence."""
        for deg in self.degradations:
            image = deg(image)
        return image

    def __repr__(self) -> str:
        return f"DegradationComposer({self.name}, {len(self.degradations)} steps)"


# ============================================================
# Preset degradation pipelines
# ============================================================

# --- Single degradations ---
SINGLE_DEGRADATIONS = {
    "jpeg_q95": lambda: DegradationComposer([JPEG(quality=95)], "jpeg_q95"),
    "jpeg_q75": lambda: DegradationComposer([JPEG(quality=75)], "jpeg_q75"),
    "jpeg_q50": lambda: DegradationComposer([JPEG(quality=50)], "jpeg_q50"),
    "jpeg_q30": lambda: DegradationComposer([JPEG(quality=30)], "jpeg_q30"),
    "webp_q75": lambda: DegradationComposer([WEBP(quality=75)], "webp_q75"),
    "resize_0.75": lambda: DegradationComposer([Resize(scale=0.75)], "resize_0.75"),
    "resize_0.50": lambda: DegradationComposer([Resize(scale=0.50)], "resize_0.50"),
    "gaussian_blur": lambda: DegradationComposer([GaussianBlur(radius=1.0)], "gaussian_blur"),
    "motion_blur": lambda: DegradationComposer([MotionBlur(kernel_size=7)], "motion_blur"),
    "brightness": lambda: DegradationComposer([Brightness(factor=1.2)], "brightness"),
    "contrast": lambda: DegradationComposer([Contrast(factor=1.2)], "contrast"),
    "crop_90": lambda: DegradationComposer([CenterCrop(ratio=0.9)], "crop_90"),
    "crop_75": lambda: DegradationComposer([CenterCrop(ratio=0.75)], "crop_75"),
}

# --- Compound degradations (simulating sharing pipelines) ---
COMPOUND_DEGRADATIONS = {
    "share_light": lambda: DegradationComposer(
        [
            Resize(short_side=1080),
            JPEG(quality=85),
        ],
        "share_light",
    ),
    "share_medium": lambda: DegradationComposer(
        [
            Resize(short_side=720),
            CenterCrop(ratio=0.95),
            JPEG(quality=70),
        ],
        "share_medium",
    ),
    "share_heavy": lambda: DegradationComposer(
        [
            Resize(short_side=512),
            GaussianBlur(radius=0.6),
            JPEG(quality=50),
        ],
        "share_heavy",
    ),
    "screenshot_like": lambda: DegradationComposer(
        [
            WhiteBorder(pixels=20),
            Resize(short_side=1080),
            JPEG(quality=75),
            CenterCrop(ratio=0.92),
        ],
        "screenshot_like",
    ),
    "meme_like": lambda: DegradationComposer(
        [
            Resize(short_side=768),
            TextOverlay(position="bottom"),
            JPEG(quality=70),
        ],
        "meme_like",
    ),
    "platform_like_random": lambda: DegradationComposer(
        [
            RandomResize(short_sides=[512, 720, 1080]),
            RandomCrop(ratio=[0.85, 0.95, 1.0]),
            RandomColorJitter(),
            RandomJPEG(qualities=[45, 60, 75, 90]),
        ],
        "platform_like_random",
    ),
}

# --- Platform-inspired degradations ---
PLATFORM_DEGRADATIONS = {
    "twitter_like": lambda: DegradationComposer(
        [
            Resize(short_side=1080),
            CenterCrop(ratio=0.95),
            JPEG(quality=75),
        ],
        "twitter_like",
    ),
    "facebook_like": lambda: DegradationComposer(
        [
            Resize(short_side=720),
            GaussianBlur(radius=0.3),
            JPEG(quality=65),
        ],
        "facebook_like",
    ),
    "telegram_like": lambda: DegradationComposer(
        [
            Resize(short_side=1280),
            JPEG(quality=80),
        ],
        "telegram_like",
    ),
}

# --- All presets combined ---
ALL_PRESETS = {}
ALL_PRESETS.update(SINGLE_DEGRADATIONS)
ALL_PRESETS.update(COMPOUND_DEGRADATIONS)
ALL_PRESETS.update(PLATFORM_DEGRADATIONS)


def get_degradation(name: str) -> DegradationComposer:
    """Get a preset degradation pipeline by name.

    Args:
        name: Name of the preset.

    Returns:
        DegradationComposer instance.

    Raises:
        ValueError: If preset name not found.
    """
    if name not in ALL_PRESETS:
        raise ValueError(
            f"Unknown degradation preset: {name}. "
            f"Available: {list(ALL_PRESETS.keys())}"
        )
    return ALL_PRESETS[name]()


def get_degradations_from_config(config: Dict[str, Any]) -> Dict[str, DegradationComposer]:
    """Load degradations from a config dict.

    Config format:
        ```yaml
        degradations:
          - name: share_light
          - name: share_medium
          - name: custom_pipeline
            steps:
              - type: resize
                short_side: 720
              - type: jpeg
                quality: 70
        ```
    """
    degradations = {}

    for deg_config in config.get("degradations", []):
        name = deg_config["name"]

        if "steps" in deg_config:
            # Build custom pipeline from steps
            steps = []
            for step in deg_config["steps"]:
                step_type = step["type"]
                params = {k: v for k, v in step.items() if k != "type"}
                steps.append(_create_degradation(step_type, params))
            degradations[name] = DegradationComposer(steps, name)
        else:
            # Use preset
            degradations[name] = get_degradation(name)

    return degradations


def _create_degradation(step_type: str, params: Dict) -> Callable:
    """Create a single degradation from type and parameters."""
    creators = {
        "jpeg": lambda p: JPEG(**p),
        "webp": lambda p: WEBP(**p),
        "resize": lambda p: Resize(**p),
        "center_crop": lambda p: CenterCrop(**p),
        "gaussian_blur": lambda p: GaussianBlur(**p),
        "motion_blur": lambda p: MotionBlur(**p),
        "brightness": lambda p: Brightness(**p),
        "contrast": lambda p: Contrast(**p),
        "white_border": lambda p: WhiteBorder(**p),
        "text_overlay": lambda p: TextOverlay(**p),
        "screenshot": lambda p: ScreenshotSimulation(**p),
    }

    if step_type not in creators:
        raise ValueError(f"Unknown degradation type: {step_type}")
    return creators[step_type](params)


def compose_degradations(
    image: Image.Image,
    degradations: List[Callable],
) -> Image.Image:
    """Apply a list of degradations to an image.

    Args:
        image: Input PIL Image.
        degradations: List of degradation callables.

    Returns:
        Degraded PIL Image.
    """
    for deg in degradations:
        image = deg(image)
    return image


def apply_degradation_to_manifest(
    manifest_path: str,
    degradation: DegradationComposer,
    output_root: str,
    output_manifest: str,
    overwrite: bool = False,
) -> pd.DataFrame:
    """Apply degradation to all images in a manifest and save results.

    Args:
        manifest_path: Path to input manifest CSV.
        degradation: Degradation pipeline to apply.
        output_root: Root directory for degraded images.
        output_manifest: Path for output manifest CSV.
        overwrite: Whether to overwrite existing degraded images.

    Returns:
        Updated manifest DataFrame.
    """
    df = pd.read_csv(manifest_path)
    output_root = Path(output_root)
    output_root.mkdir(parents=True, exist_ok=True)

    new_paths = []
    for idx, row in tqdm(df.iterrows(), total=len(df), desc=f"Applying {degradation.name}"):
        img_path = Path(row["image_path"])

        # Create output path preserving directory structure
        try:
            relative = img_path.relative_to(Path(manifest_path).parent.parent)
        except ValueError:
            relative = img_path.name

        out_path = output_root / relative
        out_path = out_path.with_suffix(".jpg")  # Standardize output format

        if out_path.exists() and not overwrite:
            new_paths.append(str(out_path))
            continue

        # Load, degrade, save
        try:
            image = Image.open(img_path).convert("RGB")
            degraded = degradation(image)
            out_path.parent.mkdir(parents=True, exist_ok=True)
            degraded.save(out_path, format="JPEG", quality=95)
            new_paths.append(str(out_path))
        except Exception as e:
            print(f"Warning: Failed to process {img_path}: {e}")
            new_paths.append(str(img_path))  # Keep original on failure

    # Update manifest
    df_out = df.copy()
    df_out["image_path"] = new_paths
    df_out["quality_group"] = degradation.name
    df_out["share_type"] = "simulated"

    Path(output_manifest).parent.mkdir(parents=True, exist_ok=True)
    df_out.to_csv(output_manifest, index=False)
    print(f"Saved degraded manifest to {output_manifest}")

    return df_out


def main():
    parser = argparse.ArgumentParser(description="Apply degradations to images")
    parser.add_argument("--manifest", type=str, required=True, help="Input manifest CSV")
    parser.add_argument("--config", type=str, required=True, help="Degradation config YAML")
    parser.add_argument("--output_root", type=str, required=True, help="Output directory")
    parser.add_argument("--output_manifest", type=str, required=True, help="Output manifest CSV")
    parser.add_argument("--overwrite", action="store_true", help="Overwrite existing files")
    args = parser.parse_args()

    from ..utils.io import load_config

    config = load_config(args.config)
    degradations = get_degradations_from_config(config)

    for name, deg in degradations.items():
        print(f"Applying degradation: {name}")
        out_manifest = args.output_manifest.replace(".csv", f"_{name}.csv")
        apply_degradation_to_manifest(
            args.manifest, deg, args.output_root, out_manifest, args.overwrite
        )


if __name__ == "__main__":
    main()
