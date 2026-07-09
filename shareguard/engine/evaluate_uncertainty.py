"""Uncertainty evaluation for ShareGuard."""

import argparse
from pathlib import Path
from typing import Dict, List, Optional

import numpy as np
import torch
from torch.utils.data import DataLoader
from tqdm import tqdm

from ..datasets.dataset import NoisyShareDataset, get_default_transform
from ..models.shareguard import ShareGuard
from ..models.uncertainty import compute_risk_coverage, SelectivePredictor
from ..utils.io import load_config
from ..utils.logger import setup_logger
from .metrics import compute_ece


def evaluate_uncertainty(
    model: ShareGuard,
    test_loader: DataLoader,
    device: torch.device,
    uncertainty_thresholds: List[float] = None,
) -> Dict:
    """Evaluate uncertainty estimation quality.

    Args:
        model: ShareGuard model.
        test_loader: Test data loader.
        device: Device to use.
        uncertainty_thresholds: Thresholds for selective prediction.

    Returns:
        Dict with uncertainty metrics.
    """
    model.eval()

    all_probs = []
    all_uncertainties = []
    all_labels = []

    with torch.no_grad():
        for batch in tqdm(test_loader, desc="Evaluating uncertainty"):
            if len(batch) == 3:
                images, labels, metadata = batch
            else:
                images, labels = batch

            images = images.to(device)
            views = images.unsqueeze(1)  # Single view for now

            result = model(views, return_uncertainty=True)
            all_probs.append(result["probs"].cpu())
            all_uncertainties.append(result["uncertainty"].cpu())
            all_labels.append(labels)

    probs = torch.cat(all_probs).numpy()
    uncertainties = torch.cat(all_uncertainties).numpy()
    labels = torch.cat(all_labels).numpy()

    # Basic metrics
    predictions = (probs >= 0.5).astype(int)
    accuracy = (predictions == labels).mean()

    # ECE
    ece = compute_ece(labels, probs)

    # Risk-coverage analysis
    risk_coverage = compute_risk_coverage(
        torch.tensor(labels),
        torch.tensor(predictions),
        torch.tensor(uncertainties),
    )

    # Selective prediction at different thresholds
    if uncertainty_thresholds is None:
        uncertainty_thresholds = [0.05, 0.1, 0.15, 0.2, 0.3, 0.5]

    selective_results = {}
    predictor = SelectivePredictor()
    for threshold in uncertainty_thresholds:
        predictor.threshold = threshold
        result = predictor.predict(
            torch.tensor(probs),
            uncertainty=torch.tensor(uncertainties),
        )
        decision = result["decision"].numpy()

        # Compute accuracy on accepted predictions
        accepted = decision != 2
        if accepted.sum() > 0:
            accepted_acc = (predictions[accepted] == labels[accepted]).mean()
            coverage = accepted.mean()
        else:
            accepted_acc = 0.0
            coverage = 0.0

        selective_results[threshold] = {
            "accuracy": float(accepted_acc),
            "coverage": float(coverage),
        }

    return {
        "accuracy": float(accuracy),
        "ece": float(ece),
        "aurc": risk_coverage["aurc"],
        "failure_auroc": risk_coverage["failure_auroc"],
        "risk_coverage": risk_coverage,
        "selective": selective_results,
        "mean_uncertainty": float(uncertainties.mean()),
    }


def main():
    parser = argparse.ArgumentParser(description="Evaluate uncertainty")
    parser.add_argument("--checkpoint", type=str, required=True, help="Model checkpoint")
    parser.add_argument("--test-manifest", type=str, required=True, help="Test manifest")
    parser.add_argument("--output", type=str, default=None, help="Output YAML path")
    parser.add_argument("--config", type=str, default=None, help="Config YAML")
    args = parser.parse_args()

    config = load_config(args.config) if args.config else {}
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")

    # Load model
    checkpoint = torch.load(args.checkpoint, map_location=device)
    model_config = checkpoint.get("config", config)

    model = ShareGuard(
        encoder_name=model_config.get("encoder", "dinov2_vitb14"),
        encoder_mode="frozen",
        feat_dim=model_config.get("feat_dim", 768),
        use_freq=model_config.get("use_freq", True),
        use_std=model_config.get("use_std", True),
    )
    model.load_state_dict(checkpoint["model_state_dict"])
    model = model.to(device)

    # Create dataset
    transform = get_default_transform(model_config.get("image_size", 512))
    dataset = NoisyShareDataset(manifest_path=args.test_manifest, transform=transform)
    loader = DataLoader(dataset, batch_size=32, shuffle=False, num_workers=4)

    # Evaluate
    results = evaluate_uncertainty(model, loader, device)

    print(f"Accuracy: {results['accuracy']:.4f}")
    print(f"ECE: {results['ece']:.4f}")
    print(f"AURC: {results['aurc']:.4f}")
    print(f"Failure AUROC: {results['failure_auroc']:.4f}")

    if args.output:
        import yaml
        Path(args.output).parent.mkdir(parents=True, exist_ok=True)
        with open(args.output, "w") as f:
            yaml.dump(results, f, default_flow_style=False)


if __name__ == "__main__":
    main()
