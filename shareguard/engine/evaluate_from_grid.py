"""Grid-based evaluation dispatcher.

Reads eval_grid.yaml and evaluates all model/dataset/degradation combinations.
Supports SLURM array jobs for parallel evaluation.
"""

import argparse
from pathlib import Path
from typing import Dict, List, Optional

import pandas as pd
import torch
import yaml
from torch.utils.data import DataLoader
from tqdm import tqdm

from ..datasets.dataset import NoisyShareDataset, get_default_transform
from ..models.encoders import get_encoder
from ..models.linear_probe import LinearProbe
from ..models.shareguard import ShareGuard
from .metrics import compute_metrics


def load_model(model_config: Dict, device: torch.device):
    """Load a model from config.

    Args:
        model_config: Model configuration dict.
        device: Torch device.

    Returns:
        Loaded model.
    """
    checkpoint_path = model_config["checkpoint"]
    checkpoint = torch.load(checkpoint_path, map_location=device)
    config = checkpoint.get("config", {})

    model_type = config.get("model_type", "linear")

    if model_type == "shareguard":
        model = ShareGuard(
            encoder_name=config.get("encoder", "dinov2_vitb14"),
            encoder_mode="frozen",
            feat_dim=config.get("feat_dim", 768),
            use_freq=config.get("use_freq", True),
            use_std=config.get("use_std", True),
        )
        model.load_state_dict(checkpoint["model_state_dict"])
    elif model_type == "linear":
        backbone_name = config.get("backbone", "dinov2_vitb14")
        backbone = get_encoder(backbone_name, mode="frozen")
        classifier = LinearProbe(in_dim=backbone.feat_dim, num_classes=1)
        classifier.load_state_dict(checkpoint["model_state_dict"])
        model = (backbone, classifier)
    else:
        raise ValueError(f"Unknown model type: {model_type}")

    return model, model_type, config


def evaluate_single(
    model,
    model_type: str,
    test_manifest: str,
    image_size: int,
    device: torch.device,
    batch_size: int = 64,
) -> Dict[str, float]:
    """Evaluate a single model on a single test set.

    Args:
        model: Loaded model.
        model_type: Type of model.
        test_manifest: Path to test manifest.
        image_size: Image size.
        device: Torch device.
        batch_size: Batch size.

    Returns:
        Dict with metrics.
    """
    transform = get_default_transform(image_size)
    dataset = NoisyShareDataset(manifest_path=test_manifest, transform=transform)
    loader = DataLoader(dataset, batch_size=batch_size, shuffle=False, num_workers=4)

    all_scores = []
    all_labels = []

    if model_type == "shareguard":
        model = model.to(device)
        model.eval()
        with torch.no_grad():
            for images, labels in tqdm(loader, desc="Evaluating"):
                images = images.to(device)
                views = images.unsqueeze(1)
                result = model(views, return_uncertainty=False)
                all_scores.append(result["probs"].cpu())
                all_labels.append(labels)
    else:
        backbone, classifier = model
        backbone = backbone.to(device)
        classifier = classifier.to(device)
        backbone.eval()
        classifier.eval()
        with torch.no_grad():
            for images, labels in tqdm(loader, desc="Evaluating"):
                images = images.to(device)
                features = backbone(images)
                logits = classifier(features).squeeze(-1)
                probs = torch.sigmoid(logits)
                all_scores.append(probs.cpu())
                all_labels.append(labels)

    scores = torch.cat(all_scores).numpy()
    labels = torch.cat(all_labels).numpy()

    return compute_metrics(labels, scores)


def enumerate_grid(grid_config: Dict) -> List[Dict]:
    """Enumerate all evaluation combinations.

    Args:
        grid_config: Evaluation grid configuration.

    Returns:
        List of evaluation tasks.
    """
    tasks = []
    models = grid_config.get("models", [])
    datasets = grid_config.get("datasets", [])
    degradations = grid_config.get("degradations", [])

    for model in models:
        for dataset in datasets:
            for deg in degradations:
                # Build manifest path
                base_manifest = dataset["manifest"].replace(".csv", "")
                suffix = deg.get("manifest_suffix", "")
                manifest = f"{base_manifest}{suffix}.csv"

                tasks.append({
                    "model_name": model["name"],
                    "model_config": model,
                    "dataset_name": dataset["name"],
                    "degradation_name": deg["name"],
                    "manifest": manifest,
                })

    return tasks


def main():
    parser = argparse.ArgumentParser(description="Evaluate from grid config")
    parser.add_argument("--grid", type=str, required=True, help="Grid config YAML")
    parser.add_argument("--job-index", type=int, default=None, help="Job index for array jobs")
    parser.add_argument("--output-dir", type=str, required=True, help="Output directory")
    parser.add_argument("--batch-size", type=int, default=64, help="Batch size")
    args = parser.parse_args()

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")

    # Load grid config
    with open(args.grid, "r") as f:
        grid_config = yaml.safe_load(f)

    # Enumerate tasks
    tasks = enumerate_grid(grid_config)

    if args.job_index is not None:
        if args.job_index >= len(tasks):
            print(f"Job index {args.job_index} out of range (total: {len(tasks)})")
            return
        tasks = [tasks[args.job_index]]

    # Run evaluations
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    results = []
    for task in tasks:
        print(f"\nEvaluating: {task['model_name']} on {task['dataset_name']} - {task['degradation_name']}")

        # Check if manifest exists
        if not Path(task["manifest"]).exists():
            print(f"  Warning: Manifest not found: {task['manifest']}")
            continue

        # Load model
        model, model_type, model_config = load_model(task["model_config"], device)
        image_size = model_config.get("image_size", 512)

        # Evaluate
        metrics = evaluate_single(
            model, model_type, task["manifest"],
            image_size, device, args.batch_size,
        )

        result = {
            "model": task["model_name"],
            "dataset": task["dataset_name"],
            "degradation": task["degradation_name"],
            **metrics,
        }
        results.append(result)
        print(f"  AUC: {metrics['auc']:.4f}, AP: {metrics['ap']:.4f}")

    # Save results
    if results:
        results_df = pd.DataFrame(results)
        output_path = output_dir / f"results_{args.job_index:04d}.csv" if args.job_index is not None else output_dir / "results.csv"
        results_df.to_csv(output_path, index=False)
        print(f"\nSaved results to {output_path}")


if __name__ == "__main__":
    main()
