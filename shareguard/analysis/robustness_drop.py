"""Robustness drop analysis and visualization."""

from pathlib import Path
from typing import Dict, List, Optional

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd


def analyze_robustness_drop(
    results: Dict[str, Dict[str, float]],
    metric: str = "auc",
    output_path: Optional[str] = None,
) -> pd.DataFrame:
    """Analyze and visualize robustness drops across methods and degradations.

    Args:
        results: Dict mapping degradation to metrics dict.
        metric: Metric to analyze.
        output_path: Path to save the figure.

    Returns:
        DataFrame with robustness drop analysis.
    """
    if "clean" not in results:
        raise ValueError("Results must contain 'clean' key")

    clean_auc = results["clean"][metric]
    degradations = [k for k in results.keys() if k != "clean"]

    drops = []
    for deg in degradations:
        deg_auc = results[deg][metric]
        drop = clean_auc - deg_auc
        drops.append({
            "degradation": deg,
            "clean_auc": clean_auc,
            "degraded_auc": deg_auc,
            "robustness_drop": drop,
            "relative_drop": drop / clean_auc * 100 if clean_auc > 0 else 0,
        })

    df = pd.DataFrame(drops).sort_values("robustness_drop", ascending=False)

    if output_path:
        plot_robustness_bars(df, metric, output_path)

    return df


def plot_robustness_bars(
    df: pd.DataFrame,
    metric: str = "auc",
    output_path: str = "robustness_drop.png",
):
    """Plot robustness drop bar chart.

    Args:
        df: DataFrame with robustness drop data.
        metric: Metric name for labels.
        output_path: Path to save figure.
    """
    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(14, 6))

    # Absolute drop
    colors = plt.cm.Reds(np.linspace(0.3, 0.9, len(df)))
    bars = ax1.barh(df["degradation"], df["robustness_drop"], color=colors)
    ax1.set_xlabel(f"Robustness Drop ({metric})")
    ax1.set_title(f"Absolute {metric.upper()} Drop by Degradation")
    ax1.axvline(x=0, color="black", linestyle="-", linewidth=0.5)

    # Add value labels
    for bar, val in zip(bars, df["robustness_drop"]):
        ax1.text(bar.get_width() + 0.005, bar.get_y() + bar.get_height()/2,
                f"{val:.3f}", ha="left", va="center", fontsize=9)

    # Relative drop
    bars2 = ax2.barh(df["degradation"], df["relative_drop"], color=colors)
    ax2.set_xlabel("Relative Drop (%)")
    ax2.set_title(f"Relative {metric.upper()} Drop (%)")
    ax2.axvline(x=0, color="black", linestyle="-", linewidth=0.5)

    for bar, val in zip(bars2, df["relative_drop"]):
        ax2.text(bar.get_width() + 0.5, bar.get_y() + bar.get_height()/2,
                f"{val:.1f}%", ha="left", va="center", fontsize=9)

    plt.tight_layout()
    Path(output_path).parent.mkdir(parents=True, exist_ok=True)
    plt.savefig(output_path, dpi=150, bbox_inches="tight")
    plt.close()


def plot_degradation_curve(
    severities: List[float],
    metrics_per_method: Dict[str, List[float]],
    severity_label: str = "JPEG Quality",
    metric: str = "AUC",
    output_path: str = "degradation_curve.png",
):
    """Plot degradation severity curve.

    Args:
        severities: List of severity values (x-axis).
        metrics_per_method: Dict mapping method name to list of metric values.
        severity_label: Label for x-axis.
        metric: Metric name for y-axis.
        output_path: Path to save figure.
    """
    fig, ax = plt.subplots(figsize=(8, 6))

    markers = ["o", "s", "^", "D", "v", "P", "*"]
    colors = plt.cm.tab10(np.linspace(0, 1, len(metrics_per_method)))

    for i, (method, values) in enumerate(metrics_per_method.items()):
        ax.plot(severities, values, marker=markers[i % len(markers)],
                color=colors[i], label=method, linewidth=2, markersize=8)

    ax.set_xlabel(severity_label, fontsize=12)
    ax.set_ylabel(metric, fontsize=12)
    ax.set_title(f"{metric} vs {severity_label}", fontsize=14)
    ax.legend(fontsize=10)
    ax.grid(True, alpha=0.3)

    plt.tight_layout()
    Path(output_path).parent.mkdir(parents=True, exist_ok=True)
    plt.savefig(output_path, dpi=150, bbox_inches="tight")
    plt.close()


def plot_multi_method_comparison(
    results: Dict[str, Dict[str, float]],
    methods: List[str],
    metric: str = "auc",
    output_path: str = "method_comparison.png",
):
    """Plot grouped bar chart comparing methods across degradations.

    Args:
        results: Dict mapping degradation to method metrics.
        methods: List of method names.
        metric: Metric to compare.
        output_path: Path to save figure.
    """
    degradations = list(results.keys())
    x = np.arange(len(degradations))
    width = 0.8 / len(methods)

    fig, ax = plt.subplots(figsize=(12, 6))
    colors = plt.cm.Set2(np.linspace(0, 1, len(methods)))

    for i, method in enumerate(methods):
        values = [results[deg].get(method, {}).get(metric, 0) for deg in degradations]
        offset = (i - len(methods)/2 + 0.5) * width
        bars = ax.bar(x + offset, values, width, label=method, color=colors[i])

    ax.set_xlabel("Degradation", fontsize=12)
    ax.set_ylabel(metric.upper(), fontsize=12)
    ax.set_title(f"Method Comparison: {metric.upper()}", fontsize=14)
    ax.set_xticks(x)
    ax.set_xticklabels(degradations, rotation=45, ha="right")
    ax.legend(fontsize=10)
    ax.grid(True, alpha=0.3, axis="y")

    plt.tight_layout()
    Path(output_path).parent.mkdir(parents=True, exist_ok=True)
    plt.savefig(output_path, dpi=150, bbox_inches="tight")
    plt.close()
