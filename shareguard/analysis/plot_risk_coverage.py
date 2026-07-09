"""Risk-coverage curve analysis and visualization."""

from pathlib import Path
from typing import Dict, List, Optional

import matplotlib.pyplot as plt
import numpy as np
import torch


def compute_selective_risk(
    y_true: np.ndarray,
    y_pred: np.ndarray,
    uncertainty: np.ndarray,
    coverage_levels: List[float] = None,
) -> Dict:
    """Compute selective risk at different coverage levels.

    Args:
        y_true: Ground truth labels.
        y_pred: Predicted labels.
        uncertainty: Uncertainty scores.
        coverage_levels: List of coverage levels to evaluate.

    Returns:
        Dict with coverage, risk, and AURC.
    """
    if coverage_levels is None:
        coverage_levels = np.arange(0.1, 1.05, 0.05).tolist()

    # Sort by uncertainty (low = high confidence = accepted first)
    sorted_idx = np.argsort(uncertainty)
    sorted_correct = (y_true[sorted_idx] == y_pred[sorted_idx]).astype(float)

    n = len(y_true)
    risks = []
    coverages = []

    for cov in coverage_levels:
        n_accept = int(n * cov)
        if n_accept == 0:
            risks.append(1.0)
        else:
            risk = 1.0 - sorted_correct[:n_accept].mean()
            risks.append(risk)
        coverages.append(cov)

    # AURC
    aurc = np.trapz(risks, coverages)

    # AUROC for failure prediction
    from sklearn.metrics import roc_auc_score
    is_correct = (y_true == y_pred).astype(int)
    try:
        failure_auroc = roc_auc_score(1 - is_correct, uncertainty)
    except ValueError:
        failure_auroc = 0.5

    return {
        "coverage": coverages,
        "risk": risks,
        "aurc": aurc,
        "failure_auroc": failure_auroc,
    }


def plot_risk_coverage(
    results: Dict[str, Dict],
    output_path: str = "risk_coverage.png",
):
    """Plot risk-coverage curves for multiple methods.

    Args:
        results: Dict mapping method name to selective risk results.
        output_path: Path to save figure.
    """
    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(14, 6))

    colors = plt.cm.Set1(np.linspace(0, 1, len(results)))
    markers = ["o", "s", "^", "D", "v", "P", "*"]

    # Risk-Coverage curve
    for i, (method, res) in enumerate(results.items()):
        ax1.plot(res["coverage"], res["risk"],
                color=colors[i], marker=markers[i % len(markers)],
                label=f"{method} (AURC={res['aurc']:.4f})", linewidth=2, markersize=4)

    ax1.set_xlabel("Coverage", fontsize=12)
    ax1.set_ylabel("Risk (Error Rate)", fontsize=12)
    ax1.set_title("Risk-Coverage Curve", fontsize=14)
    ax1.legend(fontsize=10)
    ax1.grid(True, alpha=0.3)
    ax1.set_xlim(0, 1.05)
    ax1.set_ylim(0, None)

    # AURC comparison
    methods = list(results.keys())
    aurcs = [results[m]["aurc"] for m in methods]
    bars = ax2.barh(methods, aurcs, color=colors[:len(methods)])
    ax2.set_xlabel("AURC (lower is better)", fontsize=12)
    ax2.set_title("Area Under Risk-Coverage Curve", fontsize=14)

    for bar, val in zip(bars, aurcs):
        ax2.text(bar.get_width() + 0.005, bar.get_y() + bar.get_height()/2,
                f"{val:.4f}", ha="left", va="center", fontsize=10)

    plt.tight_layout()
    Path(output_path).parent.mkdir(parents=True, exist_ok=True)
    plt.savefig(output_path, dpi=150, bbox_inches="tight")
    plt.close()
