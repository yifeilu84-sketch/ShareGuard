"""Calibration analysis for detection models."""

from pathlib import Path
from typing import Optional

import matplotlib.pyplot as plt
import numpy as np


def compute_calibration(
    y_true: np.ndarray,
    y_score: np.ndarray,
    n_bins: int = 15,
) -> dict:
    """Compute calibration metrics.

    Args:
        y_true: Ground truth labels.
        y_score: Predicted probabilities.
        n_bins: Number of bins.

    Returns:
        Dict with calibration data.
    """
    bin_edges = np.linspace(0, 1, n_bins + 1)
    bin_accs = []
    bin_confs = []
    bin_counts = []

    for i in range(n_bins):
        mask = (y_score >= bin_edges[i]) & (y_score < bin_edges[i + 1])
        if mask.sum() > 0:
            bin_accs.append(y_true[mask].mean())
            bin_confs.append(y_score[mask].mean())
            bin_counts.append(mask.sum())
        else:
            bin_accs.append(0)
            bin_confs.append(0)
            bin_counts.append(0)

    bin_accs = np.array(bin_accs)
    bin_confs = np.array(bin_confs)
    bin_counts = np.array(bin_counts)

    # ECE
    total = bin_counts.sum()
    ece = np.sum(bin_counts / total * np.abs(bin_accs - bin_confs)) if total > 0 else 0

    # MCE (Maximum Calibration Error)
    mce = np.max(np.abs(bin_accs - bin_confs))

    return {
        "ece": float(ece),
        "mce": float(mce),
        "bin_accuracies": bin_accs,
        "bin_confidences": bin_confs,
        "bin_counts": bin_counts,
        "bin_edges": bin_edges,
    }


def plot_calibration(
    y_true: np.ndarray,
    y_score: np.ndarray,
    n_bins: int = 15,
    method_name: str = "Model",
    output_path: Optional[str] = None,
):
    """Plot calibration diagram (reliability diagram).

    Args:
        y_true: Ground truth labels.
        y_score: Predicted probabilities.
        n_bins: Number of bins.
        method_name: Name for the legend.
        output_path: Path to save figure.
    """
    cal = compute_calibration(y_true, y_score, n_bins)

    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(12, 5))

    # Reliability diagram
    bin_centers = (cal["bin_edges"][:-1] + cal["bin_edges"][1:]) / 2
    ax1.plot([0, 1], [0, 1], "k--", label="Perfectly calibrated")
    ax1.bar(bin_centers, cal["bin_accuracies"],
            width=1/n_bins, alpha=0.7, label=method_name, edgecolor="black")
    ax1.set_xlabel("Confidence", fontsize=12)
    ax1.set_ylabel("Accuracy", fontsize=12)
    ax1.set_title(f"Reliability Diagram (ECE={cal['ece']:.4f})", fontsize=14)
    ax1.legend(fontsize=10)
    ax1.grid(True, alpha=0.3)

    # Histogram of predictions
    ax2.hist(y_score, bins=n_bins, edgecolor="black", alpha=0.7)
    ax2.set_xlabel("Predicted Probability", fontsize=12)
    ax2.set_ylabel("Count", fontsize=12)
    ax2.set_title("Prediction Distribution", fontsize=14)
    ax2.grid(True, alpha=0.3)

    plt.tight_layout()

    if output_path:
        Path(output_path).parent.mkdir(parents=True, exist_ok=True)
        plt.savefig(output_path, dpi=150, bbox_inches="tight")
        plt.close()

    return cal
