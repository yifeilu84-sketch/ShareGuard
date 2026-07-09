"""Experiment registry for tracking runs."""

import hashlib
import json
import os
import subprocess
import time
from pathlib import Path
from typing import Any, Dict, Optional


def get_git_commit() -> str:
    """Get current git commit hash."""
    try:
        result = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            capture_output=True, text=True, cwd=Path(__file__).parent.parent.parent
        )
        return result.stdout.strip()
    except Exception:
        return "unknown"


def get_gpu_info() -> str:
    """Get GPU info from nvidia-smi."""
    try:
        result = subprocess.run(
            ["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader"],
            capture_output=True, text=True
        )
        return result.stdout.strip()
    except Exception:
        return "unknown"


def hash_file(filepath: str) -> str:
    """Compute SHA256 hash of a file."""
    if not Path(filepath).exists():
        return "file_not_found"
    sha256 = hashlib.sha256()
    with open(filepath, "rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            sha256.update(chunk)
    return sha256.hexdigest()


class ExperimentRegistry:
    """Registry for tracking experiments.

    Usage:
        registry = ExperimentRegistry("outputs/experiments")
        run_id = registry.create_run(
            model_name="shareguard_aug",
            config_path="configs/train/shareguard_dinov2b.yaml",
            train_manifest="data/manifests/tiny_genimage_all.csv",
            val_manifest="data/manifests/tiny_genimage_val.csv",
            test_manifests=["data/manifests/tiny_genimage_test.csv"],
            seed=42,
        )
        # ... run experiment ...
        registry.update_run(run_id, metrics={"accuracy": 0.89, "auc": 0.95})
    """

    def __init__(self, base_dir: str):
        self.base_dir = Path(base_dir)
        self.base_dir.mkdir(parents=True, exist_ok=True)

    def create_run(
        self,
        model_name: str,
        config_path: str,
        train_manifest: str,
        val_manifest: str,
        test_manifests: list,
        seed: int = 42,
        notes: str = "",
    ) -> str:
        """Create a new experiment run."""
        run_id = f"{model_name}_{int(time.time())}_{seed}"
        run_dir = self.base_dir / run_id
        run_dir.mkdir(parents=True, exist_ok=True)

        run_info = {
            "run_id": run_id,
            "model_name": model_name,
            "git_commit": get_git_commit(),
            "config_path": config_path,
            "config_hash": hash_file(config_path),
            "train_manifest": train_manifest,
            "train_manifest_hash": hash_file(train_manifest),
            "val_manifest": val_manifest,
            "val_manifest_hash": hash_file(val_manifest),
            "test_manifests": test_manifests,
            "test_manifest_hashes": {m: hash_file(m) for m in test_manifests},
            "seed": seed,
            "gpu_info": get_gpu_info(),
            "start_time": time.strftime("%Y-%m-%d %H:%M:%S"),
            "end_time": None,
            "status": "running",
            "metrics": {},
            "notes": notes,
        }

        # Save run info
        with open(run_dir / "run_info.json", "w") as f:
            json.dump(run_info, f, indent=2)

        return run_id

    def update_run(
        self,
        run_id: str,
        metrics: Dict[str, Any] = None,
        checkpoint_path: str = None,
        predictions_path: str = None,
        status: str = None,
        notes: str = None,
    ):
        """Update an existing run."""
        run_dir = self.base_dir / run_id
        run_info_path = run_dir / "run_info.json"

        if not run_info_path.exists():
            raise ValueError(f"Run {run_id} not found")

        with open(run_info_path) as f:
            run_info = json.load(f)

        if metrics:
            run_info["metrics"].update(metrics)
        if checkpoint_path:
            run_info["checkpoint_path"] = checkpoint_path
            run_info["checkpoint_hash"] = hash_file(checkpoint_path)
        if predictions_path:
            run_info["predictions_path"] = predictions_path
            run_info["predictions_hash"] = hash_file(predictions_path)
        if status:
            run_info["status"] = status
        if notes:
            run_info["notes"] = notes

        if status == "completed":
            run_info["end_time"] = time.strftime("%Y-%m-%d %H:%M:%S")

        with open(run_info_path, "w") as f:
            json.dump(run_info, f, indent=2)

    def get_run(self, run_id: str) -> Dict:
        """Get run info."""
        run_dir = self.base_dir / run_id
        run_info_path = run_dir / "run_info.json"

        if not run_info_path.exists():
            return None

        with open(run_info_path) as f:
            return json.load(f)

    def list_runs(self, model_name: str = None) -> list:
        """List all runs, optionally filtered by model name."""
        runs = []
        for run_dir in self.base_dir.iterdir():
            if run_dir.is_dir():
                run_info_path = run_dir / "run_info.json"
                if run_info_path.exists():
                    with open(run_info_path) as f:
                        run_info = json.load(f)
                    if model_name is None or run_info.get("model_name") == model_name:
                        runs.append(run_info)
        return sorted(runs, key=lambda x: x.get("start_time", ""), reverse=True)

    def get_best_run(
        self,
        model_name: str,
        metric: str = "auc",
        higher_is_better: bool = True,
    ) -> Optional[Dict]:
        """Get the best run for a model based on a metric."""
        runs = self.list_runs(model_name)
        if not runs:
            return None

        completed_runs = [r for r in runs if r.get("status") == "completed"]
        if not completed_runs:
            return None

        def get_metric(run):
            return run.get("metrics", {}).get(metric, float("-inf") if higher_is_better else float("inf"))

        return max(completed_runs, key=get_metric) if higher_is_better else min(completed_runs, key=get_metric)
