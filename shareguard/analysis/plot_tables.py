"""Table and figure generation for paper."""

from pathlib import Path
from typing import Dict, List, Optional

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd


def plot_main_table(
    results: Dict[str, Dict[str, float]],
    methods: List[str],
    degradations: List[str],
    metric: str = "auc",
    output_path: str = "main_table.png",
):
    """Generate a visual table for the main results.

    Args:
        results: Nested dict: results[method][degradation] = metric_value.
        methods: List of method names.
        degradations: List of degradation names.
        metric: Metric to display.
        output_path: Path to save figure.
    """
    n_methods = len(methods)
    n_degradations = len(degradations)

    # Build data matrix
    data = np.zeros((n_methods, n_degradations))
    for i, method in enumerate(methods):
        for j, deg in enumerate(degradations):
            data[i, j] = results.get(method, {}).get(deg, {}).get(metric, 0)

    fig, ax = plt.subplots(figsize=(max(8, n_degradations * 1.5), max(4, n_methods * 0.6)))

    # Create heatmap
    im = ax.imshow(data, cmap="YlOrRd", aspect="auto", vmin=0.5, vmax=1.0)

    # Add text annotations
    for i in range(n_methods):
        for j in range(n_degradations):
            text = f"{data[i, j]:.3f}"
            color = "white" if data[i, j] < 0.7 else "black"
            ax.text(j, i, text, ha="center", va="center", color=color, fontsize=10)

    ax.set_xticks(range(n_degradations))
    ax.set_xticklabels(degradations, rotation=45, ha="right", fontsize=10)
    ax.set_yticks(range(n_methods))
    ax.set_yticklabels(methods, fontsize=10)

    ax.set_title(f"{metric.upper()} by Method and Degradation", fontsize=14)
    plt.colorbar(im, ax=ax, label=metric.upper())

    plt.tight_layout()
    Path(output_path).parent.mkdir(parents=True, exist_ok=True)
    plt.savefig(output_path, dpi=150, bbox_inches="tight")
    plt.close()


def generate_latex_table(
    results: Dict[str, Dict[str, float]],
    methods: List[str],
    degradations: List[str],
    metric: str = "auc",
    output_path: Optional[str] = None,
) -> str:
    """Generate LaTeX table for paper.

    Args:
        results: Nested dict of results.
        methods: List of method names.
        degradations: List of degradation names.
        metric: Metric to display.
        output_path: Path to save .tex file.

    Returns:
        LaTeX table string.
    """
    lines = [
        "\\begin{table}[t]",
        "\\centering",
        "\\caption{Detection performance (AUC) under different degradations.}",
        "\\label{tab:main}",
        "\\small",
        f"\\begin{{tabular}}{{l{'c' * len(degradations)}}}",
        "\\toprule",
        f"Method & {' & '.join(degradations)} \\\\",
        "\\midrule",
    ]

    for method in methods:
        values = []
        for deg in degradations:
            val = results.get(method, {}).get(deg, {}).get(metric, 0)
            values.append(f"{val:.3f}")
        lines.append(f"{method} & {' & '.join(values)} \\\\")

    lines.extend([
        "\\bottomrule",
        "\\end{tabular}",
        "\\end{table}",
    ])

    latex = "\n".join(lines)

    if output_path:
        Path(output_path).parent.mkdir(parents=True, exist_ok=True)
        with open(output_path, "w") as f:
            f.write(latex)

    return latex


def generate_robustness_drop_table(
    clean_results: Dict[str, float],
    degraded_results: Dict[str, Dict[str, float]],
    methods: List[str],
    metric: str = "auc",
    output_path: Optional[str] = None,
) -> str:
    """Generate robustness drop table.

    Args:
        clean_results: Clean metrics per method.
        degraded_results: Degraded metrics: degraded_results[method][deg] = value.
        methods: List of method names.
        metric: Metric name.
        output_path: Path to save.

    Returns:
        LaTeX table string.
    """
    degradations = list(next(iter(degraded_results.values())).keys())

    lines = [
        "\\begin{table}[t]",
        "\\centering",
        "\\caption{Robustness drop ($\\Delta$AUC) under degradations. Lower is better.}",
        "\\label{tab:robustness}",
        "\\small",
        f"\\begin{{tabular}}{{l{'c' * len(degradations)}}}",
        "\\toprule",
        f"Method & {' & '.join(degradations)} \\\\",
        "\\midrule",
    ]

    for method in methods:
        clean_val = clean_results.get(method, {}).get(metric, 0)
        values = []
        for deg in degradations:
            deg_val = degraded_results.get(method, {}).get(deg, {}).get(metric, 0)
            drop = clean_val - deg_val
            values.append(f"{drop:.3f}")
        lines.append(f"{method} & {' & '.join(values)} \\\\")

    lines.extend([
        "\\bottomrule",
        "\\end{tabular}",
        "\\end{table}",
    ])

    latex = "\n".join(lines)

    if output_path:
        Path(output_path).parent.mkdir(parents=True, exist_ok=True)
        with open(output_path, "w") as f:
            f.write(latex)

    return latex
