"""Audit experiment protocol for ShareGuard."""

import argparse
import json
from pathlib import Path
from typing import Dict

import pandas as pd

from hash_manifest import hash_manifest
from check_source_leakage import check_source_leakage
from check_class_balance import check_class_balance


def audit_experiment_protocol(
    project_dir: str,
    train_manifest: str = None,
    val_manifest: str = None,
    test_manifests: list = None,
) -> Dict:
    """Audit the experiment protocol.

    Args:
        project_dir: Root directory of the project.
        train_manifest: Path to train manifest.
        val_manifest: Path to val manifest.
        test_manifests: List of test manifest paths.

    Returns:
        Audit report dictionary.
    """
    project_dir = Path(project_dir)

    report = {
        "project_dir": str(project_dir),
        "audit_time": pd.Timestamp.now().isoformat(),
        "manifest_hashes": {},
        "leakage_check": {},
        "class_balance": {},
        "issues": [],
        "recommendations": [],
    }

    # 1. Hash manifests
    manifests_to_check = []
    if train_manifest:
        manifests_to_check.append(train_manifest)
    if val_manifest:
        manifests_to_check.append(val_manifest)
    if test_manifests:
        manifests_to_check.extend(test_manifests)

    for manifest in manifests_to_check:
        report["manifest_hashes"][Path(manifest).name] = hash_manifest(manifest)

    # 2. Check source leakage
    if train_manifest and val_manifest:
        leakage = check_source_leakage(train_manifest, val_manifest,
                                        test_manifests[0] if test_manifests else None)
        report["leakage_check"] = leakage

        if leakage.get("has_leakage"):
            report["issues"].append("SOURCE LEAKAGE DETECTED: Same source images appear in multiple splits")

    # 3. Check class balance
    for manifest in manifests_to_check:
        balance = check_class_balance(manifest)
        report["class_balance"][Path(manifest).name] = balance

        if not balance.get("is_balanced", True):
            report["issues"].append(f"CLASS IMBALANCE in {Path(manifest).name}")

    # 4. Check threshold usage
    report["threshold_analysis"] = {
        "fixed_threshold": 0.5,
        "per_degradation_tuning": False,
        "note": "Threshold is fixed at 0.5 for all evaluations. find_optimal_threshold() exists but is never called.",
    }

    # 5. Recommendations
    if not report["issues"]:
        report["recommendations"].append("Protocol looks clean. No critical issues found.")
    else:
        report["recommendations"].append("Fix all issues before running final experiments.")

    return report


def generate_protocol_audit_md(report: Dict, output_path: str):
    """Generate markdown audit report."""
    lines = [
        "# Experiment Protocol Audit Report",
        "",
        f"**Audit Time:** {report['audit_time']}",
        f"**Project Directory:** {report['project_dir']}",
        "",
        "## 1. Manifest Hashes",
        "",
    ]

    for name, info in report.get("manifest_hashes", {}).items():
        if info.get("exists"):
            lines.append(f"- **{name}**: `{info['sha256'][:16]}...` ({info['num_rows']} rows)")
        else:
            lines.append(f"- **{name}**: NOT FOUND")

    lines.extend([
        "",
        "## 2. Source Leakage Check",
        "",
    ])

    leakage = report.get("leakage_check", {})
    if leakage:
        lines.append(f"- Train/Val leakage: {leakage.get('train_val_leakage_count', 'N/A')} sources")
        if "train_test_leakage_count" in leakage:
            lines.append(f"- Train/Test leakage: {leakage.get('train_test_leakage_count', 'N/A')} sources")
            lines.append(f"- Val/Test leakage: {leakage.get('val_test_leakage_count', 'N/A')} sources")
        lines.append(f"- **Has leakage: {leakage.get('has_leakage', 'N/A')}**")
    else:
        lines.append("No leakage check performed.")

    lines.extend([
        "",
        "## 3. Class Balance",
        "",
    ])

    for name, balance in report.get("class_balance", {}).items():
        lines.append(f"### {name}")
        lines.append(f"- Total: {balance.get('total', 'N/A')}")
        if "label_counts" in balance:
            lines.append(f"- Labels: {balance['label_counts']}")
        lines.append("")

    lines.extend([
        "## 4. Threshold Analysis",
        "",
        f"- Fixed threshold: {report.get('threshold_analysis', {}).get('fixed_threshold', 'N/A')}",
        f"- Per-degradation tuning: {report.get('threshold_analysis', {}).get('per_degradation_tuning', 'N/A')}",
        f"- Note: {report.get('threshold_analysis', {}).get('note', '')}",
        "",
        "## 5. Issues",
        "",
    ])

    if report.get("issues"):
        for issue in report["issues"]:
            lines.append(f"- ⚠️ {issue}")
    else:
        lines.append("- ✅ No critical issues found.")

    lines.extend([
        "",
        "## 6. Recommendations",
        "",
    ])

    for rec in report.get("recommendations", []):
        lines.append(f"- {rec}")

    # Write
    Path(output_path).parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w") as f:
        f.write("\n".join(lines))

    print(f"Audit report saved to {output_path}")


def main():
    parser = argparse.ArgumentParser(description="Audit experiment protocol")
    parser.add_argument("--project-dir", type=str, default=".", help="Project directory")
    parser.add_argument("--train", type=str, default=None, help="Train manifest")
    parser.add_argument("--val", type=str, default=None, help="Val manifest")
    parser.add_argument("--test", nargs="+", default=None, help="Test manifests")
    parser.add_argument("--output", type=str, default="reports/protocol_audit.md")
    args = parser.parse_args()

    report = audit_experiment_protocol(args.project_dir, args.train, args.val, args.test)
    generate_protocol_audit_md(report, args.output)

    # Print summary
    print("\n=== Audit Summary ===")
    print(f"Issues found: {len(report['issues'])}")
    for issue in report["issues"]:
        print(f"  ⚠️ {issue}")
    print(f"Recommendations: {len(report['recommendations'])}")
    for rec in report["recommendations"]:
        print(f"  - {rec}")


if __name__ == "__main__":
    main()
