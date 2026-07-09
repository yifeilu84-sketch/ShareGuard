"""Evaluation metrics for AI-generated image detection."""

from typing import Dict, List, Optional, Tuple

import numpy as np
from sklearn.metrics import (
    accuracy_score,
    average_precision_score,
    f1_score,
    precision_recall_curve,
    roc_auc_score,
)


def compute_metrics(
    y_true: np.ndarray,
    y_score: np.ndarray,
    threshold: float = 0.5,
) -> Dict[str, float]:
    """Compute detection metrics.

    Args:
        y_true: Ground truth labels (0=real, 1=fake).
        y_score: Predicted probabilities or scores.
        threshold: Classification threshold.

    Returns:
        Dict with metric names and values.
    """
    y_pred = (y_score >= threshold).astype(int)

    metrics = {
        "auc": roc_auc_score(y_true, y_score),
        "ap": average_precision_score(y_true, y_score),
        "f1": f1_score(y_true, y_pred),
        "accuracy": accuracy_score(y_true, y_pred),
    }

    # ECE (Expected Calibration Error)
    metrics["ece"] = compute_ece(y_true, y_score, n_bins=15)

    return metrics


def compute_ece(
    y_true: np.ndarray,
    y_score: np.ndarray,
    n_bins: int = 15,
) -> float:
    """Compute Expected Calibration Error.

    Args:
        y_true: Ground truth labels.
        y_score: Predicted probabilities.
        n_bins: Number of bins.

    Returns:
        ECE value.
    """
    bin_edges = np.linspace(0, 1, n_bins + 1)
    ece = 0.0

    for i in range(n_bins):
        mask = (y_score >= bin_edges[i]) & (y_score < bin_edges[i + 1])
        if mask.sum() == 0:
            continue

        bin_acc = y_true[mask].mean()
        bin_conf = y_score[mask].mean()
        bin_size = mask.sum() / len(y_true)

        ece += bin_size * abs(bin_acc - bin_conf)

    return float(ece)


def compute_robustness_drop(
    clean_metrics: Dict[str, float],
    degraded_metrics: Dict[str, float],
    metric_name: str = "auc",
) -> float:
    """Compute robustness drop between clean and degraded performance.

    Args:
        clean_metrics: Metrics on clean images.
        degraded_metrics: Metrics on degraded images.
        metric_name: Metric to compute drop for.

    Returns:
        Robustness drop value (positive = performance decrease).
    """
    return clean_metrics[metric_name] - degraded_metrics[metric_name]


def compute_robustness_drops(
    clean_metrics: Dict[str, float],
    all_degraded_metrics: Dict[str, Dict[str, float]],
    metric_name: str = "auc",
) -> Dict[str, float]:
    """Compute robustness drops for multiple degradation types.

    Args:
        clean_metrics: Metrics on clean images.
        all_degraded_metrics: Dict mapping degradation name to metrics.
        metric_name: Metric to compute drop for.

    Returns:
        Dict mapping degradation name to robustness drop.
    """
    drops = {}
    for deg_name, deg_metrics in all_degraded_metrics.items():
        drops[deg_name] = compute_robustness_drop(clean_metrics, deg_metrics, metric_name)
    return drops


def find_optimal_threshold(
    y_true: np.ndarray,
    y_score: np.ndarray,
    metric: str = "f1",
) -> Tuple[float, float]:
    """Find optimal classification threshold.

    Args:
        y_true: Ground truth labels.
        y_score: Predicted probabilities.
        metric: Metric to optimize ('f1', 'accuracy', 'youden').

    Returns:
        Tuple of (optimal_threshold, best_metric_value).
    """
    precisions, recalls, thresholds = precision_recall_curve(y_true, y_score)

    if metric == "f1":
        # F1 = 2 * precision * recall / (precision + recall)
        f1_scores = 2 * precisions * recalls / (precisions + recalls + 1e-8)
        best_idx = np.argmax(f1_scores)
        return thresholds[best_idx], f1_scores[best_idx]

    elif metric == "youden":
        # Youden's J = sensitivity + specificity - 1
        fpr, tpr, thresholds_roc = _roc_curve(y_true, y_score)
        j_scores = tpr - fpr
        best_idx = np.argmax(j_scores)
        return thresholds_roc[best_idx], j_scores[best_idx]

    else:
        # Accuracy
        best_acc = 0
        best_thresh = 0.5
        for thresh in np.arange(0.1, 0.9, 0.05):
            y_pred = (y_score >= thresh).astype(int)
            acc = accuracy_score(y_true, y_pred)
            if acc > best_acc:
                best_acc = acc
                best_thresh = thresh
        return best_thresh, best_acc


def _roc_curve(y_true, y_score):
    """Compute ROC curve."""
    from sklearn.metrics import roc_curve
    fpr, tpr, thresholds = roc_curve(y_true, y_score)
    return fpr, tpr, thresholds


def format_metrics_table(
    results: Dict[str, Dict[str, float]],
    metrics: List[str] = None,
) -> str:
    """Format metrics as a readable table string.

    Args:
        results: Dict mapping method/degradation to metrics.
        metrics: List of metrics to include.

    Returns:
        Formatted table string.
    """
    if metrics is None:
        metrics = ["auc", "ap", "f1", "accuracy", "ece"]

    header = f"{'Method/Degradation':<25}"
    for m in metrics:
        header += f"{m:>10}"
    lines = [header, "-" * len(header)]

    for name, m in results.items():
        line = f"{name:<25}"
        for metric in metrics:
            val = m.get(metric, float("nan"))
            line += f"{val:>10.4f}"
        lines.append(line)

    return "\n".join(lines)
