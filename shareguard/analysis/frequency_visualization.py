"""Frequency domain visualization for AI-generated image detection."""

from pathlib import Path
from typing import Optional

import matplotlib.pyplot as plt
import numpy as np
from PIL import Image

from ..models.frequency_branch import radial_fft_feature, rgb_to_y_channel


def visualize_frequency(
    real_path: str,
    fake_path: str,
    degraded_fake_path: Optional[str] = None,
    output_path: str = "frequency_visualization.png",
    bins: int = 128,
):
    """Visualize frequency domain differences between real, fake, and degraded fake images.

    Args:
        real_path: Path to real image.
        fake_path: Path to fake (AI-generated) image.
        degraded_fake_path: Path to degraded fake image.
        output_path: Path to save figure.
        bins: Number of radial bins for FFT.
    """
    # Load images
    real_img = np.array(Image.open(real_path).convert("RGB"))
    fake_img = np.array(Image.open(fake_path).convert("RGB"))

    # Compute radial FFT features
    real_feat = radial_fft_feature(real_img, bins=bins)
    fake_feat = radial_fft_feature(fake_img, bins=bins)

    # Compute 2D FFT magnitudes for visualization
    real_fft = np.log1p(np.abs(np.fft.fftshift(np.fft.fft2(rgb_to_y_channel(real_img)))))
    fake_fft = np.log1p(np.abs(np.fft.fftshift(np.fft.fft2(rgb_to_y_channel(fake_img)))))

    # Determine subplot layout
    n_cols = 3 if degraded_fake_path else 2
    fig, axes = plt.subplots(2, n_cols, figsize=(5 * n_cols, 10))

    # Row 1: Images
    axes[0, 0].imshow(real_img)
    axes[0, 0].set_title("Real Image", fontsize=12)
    axes[0, 0].axis("off")

    axes[0, 1].imshow(fake_img)
    axes[0, 1].set_title("AI-Generated Image", fontsize=12)
    axes[0, 1].axis("off")

    # Row 1: FFT magnitude
    axes[1, 0].imshow(real_fft, cmap="hot")
    axes[1, 0].set_title("Real FFT Magnitude", fontsize=12)
    axes[1, 0].axis("off")

    axes[1, 1].imshow(fake_fft, cmap="hot")
    axes[1, 1].set_title("Fake FFT Magnitude", fontsize=12)
    axes[1, 1].axis("off")

    if degraded_fake_path:
        degraded_img = np.array(Image.open(degraded_fake_path).convert("RGB"))
        degraded_feat = radial_fft_feature(degraded_img, bins=bins)
        degraded_fft = np.log1p(np.abs(np.fft.fftshift(
            np.fft.fft2(rgb_to_y_channel(degraded_img))
        )))

        axes[0, 2].imshow(degraded_img)
        axes[0, 2].set_title("Degraded Fake Image", fontsize=12)
        axes[0, 2].axis("off")

        axes[1, 2].imshow(degraded_fft, cmap="hot")
        axes[1, 2].set_title("Degraded FFT Magnitude", fontsize=12)
        axes[1, 2].axis("off")

    plt.tight_layout()
    Path(output_path).parent.mkdir(parents=True, exist_ok=True)
    plt.savefig(output_path, dpi=150, bbox_inches="tight")
    plt.close()

    # Plot radial profiles
    plot_radial_profiles(
        {"Real": real_feat, "Fake": fake_feat},
        output_path=output_path.replace(".png", "_radial.png"),
    )


def plot_radial_profiles(
    features: dict,
    output_path: str = "radial_profiles.png",
):
    """Plot radial frequency profiles for different images.

    Args:
        features: Dict mapping label to radial feature array.
        output_path: Path to save figure.
    """
    fig, ax = plt.subplots(figsize=(8, 5))

    colors = plt.cm.Set1(np.linspace(0, 1, len(features)))
    for i, (label, feat) in enumerate(features.items()):
        ax.plot(feat, label=label, color=colors[i], linewidth=2)

    ax.set_xlabel("Frequency Bin", fontsize=12)
    ax.set_ylabel("Log Magnitude", fontsize=12)
    ax.set_title("Radial Frequency Profiles", fontsize=14)
    ax.legend(fontsize=10)
    ax.grid(True, alpha=0.3)

    plt.tight_layout()
    Path(output_path).parent.mkdir(parents=True, exist_ok=True)
    plt.savefig(output_path, dpi=150, bbox_inches="tight")
    plt.close()


def visualize_frequency_difference(
    real_path: str,
    fake_path: str,
    output_path: str = "freq_diff.png",
):
    """Visualize the difference in frequency domain between real and fake.

    Args:
        real_path: Path to real image.
        fake_path: Path to fake image.
        output_path: Path to save figure.
    """
    real_img = np.array(Image.open(real_path).convert("RGB"))
    fake_img = np.array(Image.open(fake_path).convert("RGB"))

    # Compute FFT
    real_y = rgb_to_y_channel(real_img)
    fake_y = rgb_to_y_channel(fake_img)

    real_fft = np.abs(np.fft.fftshift(np.fft.fft2(real_y)))
    fake_fft = np.abs(np.fft.fftshift(np.fft.fft2(fake_y)))

    # Difference
    diff = np.log1p(fake_fft) - np.log1p(real_fft)

    fig, axes = plt.subplots(1, 3, figsize=(15, 5))

    axes[0].imshow(np.log1p(real_fft), cmap="hot")
    axes[0].set_title("Real FFT")
    axes[0].axis("off")

    axes[1].imshow(np.log1p(fake_fft), cmap="hot")
    axes[1].set_title("Fake FFT")
    axes[1].axis("off")

    im = axes[2].imshow(diff, cmap="RdBu_r", vmin=-2, vmax=2)
    axes[2].set_title("Difference (Fake - Real)")
    axes[2].axis("off")
    plt.colorbar(im, ax=axes[2])

    plt.tight_layout()
    Path(output_path).parent.mkdir(parents=True, exist_ok=True)
    plt.savefig(output_path, dpi=150, bbox_inches="tight")
    plt.close()
