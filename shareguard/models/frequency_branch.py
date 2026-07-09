"""Frequency domain feature extraction.

Extracts FFT-based features for detecting AI-generated images
through frequency domain artifacts.
"""

from typing import Optional, Tuple

import numpy as np
import torch
import torch.nn as nn


def rgb_to_y_channel(image: np.ndarray) -> np.ndarray:
    """Convert RGB image to Y (luminance) channel.

    Args:
        image: RGB image as numpy array [H, W, 3] with values in [0, 255].

    Returns:
        Y channel as numpy array [H, W].
    """
    if image.ndim == 3 and image.shape[2] == 3:
        # RGB to Y: Y = 0.299R + 0.587G + 0.114B
        y = 0.299 * image[:, :, 0] + 0.587 * image[:, :, 1] + 0.114 * image[:, :, 2]
        return y
    elif image.ndim == 2:
        return image
    else:
        raise ValueError(f"Expected [H, W, 3] or [H, W], got shape {image.shape}")


def radial_average(data: np.ndarray, bins: int = 128) -> np.ndarray:
    """Compute radial average of a 2D array.

    Args:
        data: 2D array (e.g., FFT magnitude spectrum).
        bins: Number of radial bins.

    Returns:
        1D array of radial averages.
    """
    h, w = data.shape
    cy, cx = h // 2, w // 2

    # Create coordinate grids
    y, x = np.ogrid[:h, :w]
    r = np.sqrt((x - cx) ** 2 + (y - cy) ** 2).astype(int)

    # Clip to bins
    r = np.clip(r, 0, bins - 1)

    # Compute radial average
    radial_sum = np.bincount(r.ravel(), data.ravel(), minlength=bins)
    radial_count = np.bincount(r.ravel(), minlength=bins)
    radial_count = np.maximum(radial_count, 1)  # Avoid division by zero

    return radial_sum / radial_count


def radial_fft_feature(
    image: np.ndarray,
    bins: int = 128,
    log_transform: bool = True,
) -> np.ndarray:
    """Extract radial FFT feature from image.

    Args:
        image: RGB image as numpy array [H, W, 3] with values in [0, 255].
        bins: Number of radial bins.
        log_transform: Whether to apply log transform to magnitude.

    Returns:
        1D feature vector of length `bins`.
    """
    # Convert to Y channel
    y_channel = rgb_to_y_channel(image)

    # Apply FFT
    fft = np.fft.fftshift(np.fft.fft2(y_channel))
    magnitude = np.abs(fft)

    # Log transform
    if log_transform:
        magnitude = np.log1p(magnitude)

    # Radial average
    radial = radial_average(magnitude, bins=bins)

    return radial.astype(np.float32)


def highpass_residual(image: np.ndarray, sigma: float = 3.0) -> np.ndarray:
    """Extract high-pass residual (SRM-like).

    Args:
        image: RGB image as numpy array [H, W, 3].
        sigma: Gaussian blur sigma for low-pass.

    Returns:
        High-pass residual image.
    """
    try:
        from scipy.ndimage import gaussian_filter
    except ImportError:
        # Fallback: simple difference
        y = rgb_to_y_channel(image)
        return y - np.mean(y)

    y = rgb_to_y_channel(image)
    low_pass = gaussian_filter(y, sigma=sigma)
    high_pass = y - low_pass
    return high_pass


class FrequencyBranch(nn.Module):
    """Frequency domain feature branch for RIDE.

    Extracts radial FFT features and processes them through an MLP.

    Args:
        freq_dim: Dimension of radial FFT feature (number of bins).
        hidden_dim: Hidden layer dimension.
        output_dim: Output feature dimension.
        dropout: Dropout rate.
    """

    def __init__(
        self,
        freq_dim: int = 128,
        hidden_dim: int = 128,
        output_dim: int = 128,
        dropout: float = 0.1,
    ):
        super().__init__()
        self.freq_dim = freq_dim

        self.projection = nn.Sequential(
            nn.Linear(freq_dim, hidden_dim),
            nn.LayerNorm(hidden_dim),
            nn.GELU(),
            nn.Dropout(dropout),
            nn.Linear(hidden_dim, output_dim),
            nn.GELU(),
        )

    def forward(self, freq_feat: torch.Tensor) -> torch.Tensor:
        """Process frequency features.

        Args:
            freq_feat: Frequency feature tensor [B, freq_dim].

        Returns:
            Projected feature tensor [B, output_dim].
        """
        return self.projection(freq_feat)


def extract_frequency_features_batch(
    images: torch.Tensor,
    bins: int = 128,
) -> torch.Tensor:
    """Extract frequency features from a batch of images.

    Args:
        images: Image tensor [B, C, H, W] with values in [0, 1] or [0, 255].
        bins: Number of radial bins.

    Returns:
        Frequency feature tensor [B, bins].
    """
    batch_size = images.shape[0]
    features = []

    for i in range(batch_size):
        img = images[i].permute(1, 2, 0).cpu().numpy()

        # Normalize to [0, 255] if needed
        if img.max() <= 1.0:
            img = (img * 255).astype(np.uint8)
        else:
            img = img.astype(np.uint8)

        feat = radial_fft_feature(img, bins=bins)
        features.append(feat)

    return torch.tensor(np.stack(features), dtype=torch.float32, device=images.device)
