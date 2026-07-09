"""Export the final NoisyShare-Fusion ensemble into a deployable bundle.

Run this on HPC after `fuse_feature_fusion_clean_boost.py` and
`make_final_public_baseline_table.py` have completed.
"""

import argparse
import hashlib
import json
import shutil
import tarfile
from pathlib import Path

import pandas as pd


SEEDS = [42, 43, 44, 45, 46]
VARIANT = "clip_dino_freq_aug_mlp"


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def find_runs(root: Path):
    runs = {}
    for p in sorted(root.glob(f"{VARIANT}_*/metrics_summary.json")):
        meta = json.loads(p.read_text())
        seed = int(meta["seed"])
        if seed in SEEDS:
            runs[seed] = {"run_dir": p.parent, "summary": meta}
    missing = sorted(set(SEEDS) - set(runs))
    if missing:
        raise RuntimeError(f"Missing seeds in {root}: {missing}")
    return runs


def selected_fusion_params(path: Path, method: str):
    df = pd.read_csv(path)
    row = df[df["method"] == method]
    if row.empty:
        raise RuntimeError(f"Method {method!r} not found in {path}")
    item = row.iloc[0]
    return {
        "alpha_clip_l": float(item["alpha_clip_l"]),
        "threshold": float(item["dev_threshold"]),
        "test5k_balanced_accuracy": float(item["balanced_accuracy"]),
        "test5k_auc": float(item["auc"]),
        "test5k_ap": float(item["ap"]),
    }


def copy_group(bundle: Path, group_name: str, runs):
    default_clip_model = {
        "clip_b": "vit_base_patch16_clip_224.openai",
        "clip_l": "vit_large_patch14_clip_224.openai",
    }[group_name]
    entries = []
    for seed in SEEDS:
        run = runs[seed]
        src = run["run_dir"] / "model.pt"
        if not src.exists():
            raise FileNotFoundError(src)
        dst_dir = bundle / "models" / group_name / f"seed{seed}"
        dst_dir.mkdir(parents=True, exist_ok=True)
        dst = dst_dir / "model.pt"
        shutil.copy2(src, dst)
        summary_src = run["run_dir"] / "metrics_summary.json"
        if summary_src.exists():
            shutil.copy2(summary_src, dst_dir / "metrics_summary.json")
        summary = run["summary"]
        entries.append({
            "seed": seed,
            "checkpoint": f"models/{group_name}/seed{seed}/model.pt",
            "checkpoint_sha256": sha256(dst),
            "clip_model": summary.get("clip_model") or summary.get("clip_model_name") or summary.get("config", {}).get("clip_model") or default_clip_model,
            "clip_image_size": summary.get("clip_image_size") or summary.get("config", {}).get("clip_image_size", 224),
            "run_id": summary.get("run_id"),
        })
    return entries


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--clip-b-root", default="outputs/experiments/feature_fusion_multiseed")
    parser.add_argument("--clip-l-root", default="outputs/experiments/feature_fusion_clipl_aug_multiseed")
    parser.add_argument("--fusion-metrics", default="reports/public_baselines/clean_boost_test5k_metrics.csv")
    parser.add_argument("--final-table", default="reports/public_baselines/final_public_baseline_table.md")
    parser.add_argument("--method", default="clip_b_l_score_fusion")
    parser.add_argument("--out-dir", default="model_artifacts/shareguard-noisyshare-fusion-v1")
    parser.add_argument("--archive", default="model_artifacts/shareguard-noisyshare-fusion-v1.tar.gz")
    args = parser.parse_args()

    bundle = Path(args.out_dir)
    archive = Path(args.archive)
    if bundle.exists():
        shutil.rmtree(bundle)
    bundle.mkdir(parents=True)
    archive.parent.mkdir(parents=True, exist_ok=True)

    clip_b_runs = find_runs(Path(args.clip_b_root))
    clip_l_runs = find_runs(Path(args.clip_l_root))
    params = selected_fusion_params(Path(args.fusion_metrics), args.method)

    reports = bundle / "reports"
    reports.mkdir()
    for src in [
        Path(args.fusion_metrics),
        Path(args.final_table),
        Path("reports/public_baselines/final_public_baseline_table.csv"),
    ]:
        if src.exists():
            shutil.copy2(src, reports / src.name)

    manifest = {
        "bundle_type": "noisyshare_fusion",
        "name": "shareguard-noisyshare-fusion-v1",
        "version": 1,
        "method": args.method,
        "variant": VARIANT,
        "dino_model": "vit_base_patch14_dinov2.lvd142m",
        "alpha_clip_l": params["alpha_clip_l"],
        "threshold": params["threshold"],
        "metrics": {
            "test5k_balanced_accuracy": params["test5k_balanced_accuracy"],
            "test5k_auc": params["test5k_auc"],
            "test5k_ap": params["test5k_ap"],
        },
        "groups": {
            "clip_b": copy_group(bundle, "clip_b", clip_b_runs),
            "clip_l": copy_group(bundle, "clip_l", clip_l_runs),
        },
        "serving": {
            "backend": "fusion-bundle",
            "entrypoint": "python -m shareguard.platform.app --backend fusion-bundle --bundle /models/shareguard-noisyshare-fusion-v1",
        },
    }
    (bundle / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")

    model_card = {
        "name": manifest["name"],
        "intended_use": "AI-generated image screening under real-world sharing degradations.",
        "not_for": "Final forensic or legal judgment without human review.",
        "protocol": "Fusion weights and threshold selected on external dev only; frozen for test5k and degradation matrix.",
    }
    (bundle / "model_card.json").write_text(json.dumps(model_card, indent=2), encoding="utf-8")

    if archive.exists():
        archive.unlink()
    with tarfile.open(archive, "w:gz") as tf:
        tf.add(bundle, arcname=bundle.name)

    checksum = sha256(archive)
    archive.with_suffix(archive.suffix + ".sha256").write_text(f"{checksum}  {archive.name}\n")
    print(json.dumps({
        "bundle": str(bundle),
        "archive": str(archive),
        "archive_sha256": checksum,
        "method": args.method,
        **params,
    }, indent=2))


if __name__ == "__main__":
    main()
