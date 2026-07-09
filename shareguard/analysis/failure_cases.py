"""Failure case analysis for AI-generated image detection."""

from pathlib import Path
from typing import Dict, List, Optional, Tuple

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
from PIL import Image


def find_failure_cases(
    y_true: np.ndarray,
    y_score: np.ndarray,
    image_paths: List[str],
    threshold: float = 0.5,
) -> Dict[str, List[dict]]:
    """Find different types of failure cases.

    Args:
        y_true: Ground truth labels (0=real, 1=fake).
        y_score: Predicted scores/probabilities.
        image_paths: List of image paths.
        threshold: Classification threshold.

    Returns:
        Dict with failure types and their cases.
    """
    y_pred = (y_score >= threshold).astype(int)

    # False Positives: real images classified as fake
    fp_mask = (y_true == 0) & (y_pred == 1)
    # False Negatives: fake images classified as real
    fn_mask = (y_true == 1) & (y_pred == 0)
    # Correct but low confidence
    low_conf_mask = (y_true == y_pred) & (np.abs(y_score - 0.5) < 0.1)

    def get_cases(mask, max_cases=16):
        indices = np.where(mask)[0]
        # Sort by confidence (most uncertain first)
        confidences = np.abs(y_score[indices] - 0.5)
        sorted_idx = np.argsort(confidences)[:max_cases]

        cases = []
        for idx in sorted_idx:
            cases.append({
                "path": image_paths[indices[idx]],
                "true_label": int(y_true[indices[idx]]),
                "predicted_prob": float(y_score[indices[idx]]),
                "confidence": float(confidences[idx]),
            })
        return cases

    return {
        "false_positive": get_cases(fp_mask),
        "false_negative": get_cases(fn_mask),
        "low_confidence": get_cases(low_conf_mask),
    }


def visualize_failure_cases(
    failures: Dict[str, List[dict]],
    output_dir: str = "outputs/figures/failures",
    max_per_type: int = 8,
):
    """Visualize failure cases as a grid of images.

    Args:
        failures: Dict from find_failure_cases.
        output_dir: Directory to save figures.
        max_per_type: Maximum images per failure type.
    """
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    labels = {
        "false_positive": "False Positive (Real → Fake)",
        "false_negative": "False Negative (Fake → Real)",
        "low_confidence": "Low Confidence",
    }

    for failure_type, cases in failures.items():
        if not cases:
            continue

        n_cases = min(len(cases), max_per_type)
        n_cols = min(4, n_cases)
        n_rows = (n_cases + n_cols - 1) // n_cols

        fig, axes = plt.subplots(n_rows, n_cols, figsize=(4 * n_cols, 4 * n_rows))
        if n_rows == 1 and n_cols == 1:
            axes = np.array([[axes]])
        elif n_rows == 1:
            axes = axes.reshape(1, -1)
        elif n_cols == 1:
            axes = axes.reshape(-1, 1)

        for idx in range(n_rows * n_cols):
            row, col = idx // n_cols, idx % n_cols
            ax = axes[row, col]

            if idx < n_cases:
                case = cases[idx]
                try:
                    img = Image.open(case["path"]).convert("RGB")
                    ax.imshow(img)
                except Exception:
                    ax.text(0.5, 0.5, "Load Error", ha="center", va="center")

                true_str = "Fake" if case["true_label"] == 1 else "Real"
                pred_prob = case["predicted_prob"]
                ax.set_title(
                    f"True: {true_str}\nP(fake)={pred_prob:.3f}",
                    fontsize=10,
                )
            ax.axis("off")

        plt.suptitle(labels.get(failure_type, failure_type), fontsize=14, fontweight="bold")
        plt.tight_layout()
        plt.savefig(output_dir / f"{failure_type}.png", dpi=150, bbox_inches="tight")
        plt.close()


def analyze_failure_patterns(
    failures: Dict[str, List[dict]],
    manifest_df: pd.DataFrame,
) -> Dict[str, Dict]:
    """Analyze patterns in failure cases.

    Args:
        failures: Dict from find_failure_cases.
        manifest_df: Manifest DataFrame with metadata.

    Returns:
        Analysis results.
    """
    analysis = {}

    for failure_type, cases in failures.items():
        if not cases:
            analysis[failure_type] = {"count": 0}
            continue

        paths = [c["path"] for c in cases]
        subset = manifest_df[manifest_df["image_path"].isin(paths)]

        patterns = {
            "count": len(cases),
            "generators": subset["generator"].value_counts().to_dict() if "generator" in subset.columns else {},
            "avg_confidence": np.mean([c["confidence"] for c in cases]),
        }

        analysis[failure_type] = patterns

    return analysis
