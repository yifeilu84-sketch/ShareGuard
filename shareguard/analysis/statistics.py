"""Statistical significance tests for experimental results."""

from typing import Dict, List, Optional, Tuple

import numpy as np
from scipy import stats


def compute_confidence_intervals(
    values: List[float],
    confidence: float = 0.95,
) -> Tuple[float, float, float]:
    """Compute mean and confidence interval.

    Args:
        values: List of metric values (e.g., from multiple seeds).
        confidence: Confidence level (default 95%).

    Returns:
        Tuple of (mean, lower_bound, upper_bound).
    """
    n = len(values)
    mean = np.mean(values)
    se = stats.sem(values)
    h = se * stats.t.ppf((1 + confidence) / 2, n - 1)
    return mean, mean - h, mean + h


def paired_permutation_test(
    values_a: List[float],
    values_b: List[float],
    n_permutations: int = 10000,
    seed: int = 42,
) -> Dict:
    """Paired permutation test for comparing two methods.

    Args:
        values_a: Metric values for method A.
        values_b: Metric values for method B.
        n_permutations: Number of permutations.
        seed: Random seed.

    Returns:
        Dict with p-value, effect size, and significance.
    """
    rng = np.random.RandomState(seed)

    values_a = np.array(values_a)
    values_b = np.array(values_b)
    diffs = values_a - values_b

    observed_diff = diffs.mean()

    # Permutation test
    perm_diffs = []
    for _ in range(n_permutations):
        signs = rng.choice([-1, 1], size=len(diffs))
        perm_diff = (diffs * signs).mean()
        perm_diffs.append(perm_diff)

    perm_diffs = np.array(perm_diffs)
    p_value = np.mean(np.abs(perm_diffs) >= np.abs(observed_diff))

    # Effect size (Cohen's d)
    cohens_d = observed_diff / diffs.std() if diffs.std() > 0 else 0

    return {
        "observed_diff": float(observed_diff),
        "p_value": float(p_value),
        "cohens_d": float(cohens_d),
        "significant_005": p_value < 0.05,
        "significant_001": p_value < 0.01,
    }


def bootstrap_confidence_interval(
    values: List[float],
    statistic=np.mean,
    confidence: float = 0.95,
    n_bootstrap: int = 10000,
    seed: int = 42,
) -> Tuple[float, float, float]:
    """Bootstrap confidence interval.

    Args:
        values: Input values.
        statistic: Statistic to compute (default: mean).
        confidence: Confidence level.
        n_bootstrap: Number of bootstrap samples.
        seed: Random seed.

    Returns:
        Tuple of (statistic_value, lower_bound, upper_bound).
    """
    rng = np.random.RandomState(seed)
    values = np.array(values)

    stat_value = statistic(values)

    bootstrap_stats = []
    for _ in range(n_bootstrap):
        sample = rng.choice(values, size=len(values), replace=True)
        bootstrap_stats.append(statistic(sample))

    bootstrap_stats = np.array(bootstrap_stats)
    alpha = (1 - confidence) / 2
    lower = np.percentile(bootstrap_stats, alpha * 100)
    upper = np.percentile(bootstrap_stats, (1 - alpha) * 100)

    return stat_value, lower, upper


def format_results_table(
    results: Dict[str, Dict[str, List[float]]],
    metrics: List[str] = None,
) -> str:
    """Format results with confidence intervals.

    Args:
        results: Dict mapping method to metric values.
        metrics: Metrics to include.

    Returns:
        Formatted table string.
    """
    if metrics is None:
        metrics = list(next(iter(results.values())).keys())

    lines = []
    header = f"{'Method':<20}"
    for m in metrics:
        header += f"{m:>15}"
    lines.append(header)
    lines.append("-" * len(header))

    for method, metric_values in results.items():
        line = f"{method:<20}"
        for m in metrics:
            values = metric_values.get(m, [])
            if values:
                mean, lower, upper = compute_confidence_intervals(values)
                line += f"{mean:.3f}±{(upper-lower)/2:.3f}"[:15].rjust(15)
            else:
                line += "N/A".rjust(15)
        lines.append(line)

    return "\n".join(lines)
