"""Robustness analysis and visualization."""

from pathlib import Path
from typing import Dict, List, Optional

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd


def plot_robustness_curves(
    results_df: pd.DataFrame,
    metric: str = "auc",
    output_path: str = "robustness_curves.png",
):
    """Plot robustness curves showing performance under different degradations.

    Args:
        results_df: DataFrame with columns: method, degradation, metric values.
        metric: Metric column to plot.
        output_path: Path to save figure.
    """
    methods = results_df["method"].unique()
    degradations = results_df["degradation"].unique()

    fig, ax = plt.subplots(figsize=(12, 6))

    colors = plt.cm.Set1(np.linspace(0, 1, len(methods)))
    markers = ["o", "s", "^", "D", "v", "P", "*"]

    x = np.arange(len(degradations))

    for i, method in enumerate(methods):
        method_data = results_df[results_df["method"] == method]
        values = [method_data[method_data["degradation"] == d][metric].values[0]
                  for d in degradations if d in method_data["degradation"].values]

        if len(values) > 0:
            ax.plot(x[:len(values)], values, marker=markers[i % len(markers)],
                   color=colors[i], label=method, linewidth=2, markersize=8)

    ax.set_xticks(x)
    ax.set_xticklabels(degradations, rotation=45, ha="right", fontsize=10)
    ax.set_ylabel(metric.upper(), fontsize=12)
    ax.set_title(f"{metric.upper()} Across Degradations", fontsize=14)
    ax.legend(fontsize=10)
    ax.grid(True, alpha=0.3)

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
        severities: Severity values (x-axis).
        metrics_per_method: Dict mapping method to metric values.
        severity_label: X-axis label.
        metric: Y-axis label.
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


def compute_robustness_drop_table(
    results_df: pd.DataFrame,
    clean_degradation: str = "clean",
    metric: str = "auc",
) -> pd.DataFrame:
    """Compute robustness drop table.

    Args:
        results_df: DataFrame with method, degradation, and metric columns.
        clean_degradation: Name of clean degradation.
        metric: Metric to compute drop for.

    Returns:
        DataFrame with robustness drops.
    """
    methods = results_df["method"].unique()
    degradations = [d for d in results_df["degradation"].unique() if d != clean_degradation]

    rows = []
    for method in methods:
        method_data = results_df[results_df["method"] == method]
        clean_val = method_data[method_data["degradation"] == clean_degradation][metric].values

        if len(clean_val) == 0:
            continue

        clean_val = clean_val[0]
        row = {"method": method, "clean": clean_val}

        for deg in degradations:
            deg_val = method_data[method_data["degradation"] == deg][metric].values
            if len(deg_val) > 0:
                row[deg] = deg_val[0]
                row[f"{deg}_drop"] = clean_val - deg_val[0]

        rows.append(row)

    return pd.DataFrame(rows)
