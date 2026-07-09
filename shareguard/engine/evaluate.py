"""Evaluation engine."""

import argparse
from pathlib import Path
from typing import Dict, List, Optional

import numpy as np
import pandas as pd
import torch
from torch.utils.data import DataLoader
from tqdm import tqdm

from ..datasets.dataset import NoisyShareDataset, get_default_transform
from ..models.backbones import get_backbone
from ..models.linear_probe import LinearProbe
from ..models.ride import RIDE
from ..utils.io import load_config, save_config
from ..utils.logger import setup_logger
from ..utils.seed import set_seed
from .metrics import compute_metrics, compute_robustness_drops, format_metrics_table


def evaluate_model(
    model: torch.nn.Module,
    test_loader: DataLoader,
    device: torch.device,
    model_type: str = "linear",
) -> Dict[str, float]:
    """Evaluate model on a test set.

    Args:
        model: Model to evaluate.
        test_loader: Test data loader.
        device: Device to use.
        model_type: Type of model ('linear', 'ride', 'feature_extractor').

    Returns:
        Dict with metrics.
    """
    model.eval()
    all_scores = []
    all_labels = []

    with torch.no_grad():
        for batch in tqdm(test_loader, desc="Evaluating"):
            if len(batch) == 3:
                images, labels, metadata = batch
            else:
                images, labels = batch

            images = images.to(device)

            if model_type == "ride":
                # RIDE expects multi-view input
                if images.dim() == 4:
                    images = images.unsqueeze(1)  # Add view dimension
                logits = model(images)
                probs = torch.sigmoid(logits.squeeze(-1))
            elif model_type == "linear":
                logits = model(images).squeeze(-1)
                probs = torch.sigmoid(logits)
            else:
                probs = model(images)

            all_scores.append(probs.cpu().numpy())
            all_labels.append(labels.numpy())

    scores = np.concatenate(all_scores)
    labels = np.concatenate(all_labels)

    return compute_metrics(labels, scores)


def evaluate_with_backbone(
    backbone_name: str,
    classifier_path: str,
    test_manifest: str,
    config: Dict,
    device: torch.device,
) -> Dict[str, float]:
    """Evaluate with backbone + linear classifier.

    Args:
        backbone_name: Backbone model name.
        classifier_path: Path to classifier checkpoint.
        test_manifest: Path to test manifest.
        config: Evaluation config.
        device: Device to use.

    Returns:
        Dict with metrics.
    """
    # Load backbone
    backbone = get_backbone(backbone_name, freeze=True)
    feat_dim = backbone.feat_dim

    # Load classifier
    checkpoint = torch.load(classifier_path, map_location=device)
    classifier = LinearProbe(in_dim=feat_dim, num_classes=1)
    classifier.load_state_dict(checkpoint["model_state_dict"])
    classifier = classifier.to(device)

    # Create dataset
    transform = get_default_transform(config.get("image_size", 512), backbone=backbone_name)
    dataset = NoisyShareDataset(manifest_path=test_manifest, transform=transform)
    loader = DataLoader(
        dataset,
        batch_size=config.get("batch_size", 64),
        shuffle=False,
        num_workers=config.get("num_workers", 4),
    )

    # Evaluate
    backbone.eval()
    classifier.eval()

    all_scores = []
    all_labels = []

    with torch.no_grad():
        for images, labels in tqdm(loader, desc="Evaluating"):
            images = images.to(device)
            features = backbone(images)
            logits = classifier(features).squeeze(-1)
            probs = torch.sigmoid(logits)
            all_scores.append(probs.cpu().numpy())
            all_labels.append(labels.numpy())

    scores = np.concatenate(all_scores)
    labels = np.concatenate(all_labels)

    return compute_metrics(labels, scores)


def evaluate_all_degradations(
    model_path: str,
    base_manifest: str,
    degradation_manifests: Dict[str, str],
    config: Dict,
    output_dir: str,
) -> Dict[str, Dict[str, float]]:
    """Evaluate model on clean and all degraded test sets.

    Args:
        model_path: Path to model checkpoint.
        base_manifest: Path to clean test manifest.
        degradation_manifests: Dict mapping degradation name to manifest path.
        config: Evaluation config.
        output_dir: Directory to save results.

    Returns:
        Dict mapping degradation name to metrics.
    """
    logger = setup_logger()
    device = torch.device(config.get("device", "cuda" if torch.cuda.is_available() else "cpu"))
    set_seed(config.get("seed", 42))

    # Load model
    checkpoint = torch.load(model_path, map_location=device)
    model_config = checkpoint.get("config", config)

    model_type = model_config.get("model_type", "linear")
    if model_type == "ride":
        model = RIDE(
            backbone=model_config.get("backbone", "dinov2_vitb14"),
            feat_dim=model_config.get("feat_dim", 768),
            freq_dim=model_config.get("freq_dim", 128),
            hidden_dim=model_config.get("hidden_dim", 512),
            use_freq=model_config.get("use_freq", True),
            use_std=model_config.get("use_std", True),
        )
        model.load_state_dict(checkpoint["model_state_dict"])
        model = model.to(device)
    else:
        backbone_name = model_config.get("backbone", "dinov2_vitb14")
        backbone = get_backbone(backbone_name, freeze=True)
        classifier = LinearProbe(in_dim=backbone.feat_dim, num_classes=1)
        classifier.load_state_dict(checkpoint["model_state_dict"])
        model = (backbone, classifier)
        backbone = backbone.to(device)
        classifier = classifier.to(device)

    # Create transforms
    transform = get_default_transform(
        config.get("image_size", 512),
        backbone=model_config.get("backbone", "dinov2"),
    )

    # Evaluate on clean set
    logger.info("Evaluating on clean test set...")
    clean_dataset = NoisyShareDataset(manifest_path=base_manifest, transform=transform)
    clean_loader = DataLoader(
        clean_dataset,
        batch_size=config.get("batch_size", 64),
        shuffle=False,
        num_workers=config.get("num_workers", 4),
    )

    if model_type == "ride":
        clean_metrics = evaluate_model(model, clean_loader, device, "ride")
    else:
        all_scores = []
        all_labels = []
        backbone_model, classifier_model = model
        with torch.no_grad():
            for images, labels in tqdm(clean_loader, desc="Clean"):
                images = images.to(device)
                features = backbone_model(images)
                logits = classifier_model(features).squeeze(-1)
                probs = torch.sigmoid(logits)
                all_scores.append(probs.cpu().numpy())
                all_labels.append(labels.numpy())
        scores = np.concatenate(all_scores)
        labels = np.concatenate(all_labels)
        clean_metrics = compute_metrics(labels, scores)

    logger.info(f"Clean metrics: {clean_metrics}")

    # Evaluate on degraded sets
    all_results = {"clean": clean_metrics}

    for deg_name, deg_manifest in degradation_manifests.items():
        logger.info(f"Evaluating on {deg_name}...")
        deg_dataset = NoisyShareDataset(manifest_path=deg_manifest, transform=transform)
        deg_loader = DataLoader(
            deg_dataset,
            batch_size=config.get("batch_size", 64),
            shuffle=False,
            num_workers=config.get("num_workers", 4),
        )

        if model_type == "ride":
            deg_metrics = evaluate_model(model, deg_loader, device, "ride")
        else:
            all_scores = []
            all_labels = []
            with torch.no_grad():
                for images, labels in tqdm(deg_loader, desc=deg_name):
                    images = images.to(device)
                    features = backbone_model(images)
                    logits = classifier_model(features).squeeze(-1)
                    probs = torch.sigmoid(logits)
                    all_scores.append(probs.cpu().numpy())
                    all_labels.append(labels.numpy())
            scores = np.concatenate(all_scores)
            labels = np.concatenate(all_labels)
            deg_metrics = compute_metrics(labels, scores)

        all_results[deg_name] = deg_metrics
        logger.info(f"{deg_name} metrics: {deg_metrics}")

    # Compute robustness drops
    drops = compute_robustness_drops(clean_metrics, {
        k: v for k, v in all_results.items() if k != "clean"
    })
    logger.info(f"Robustness drops: {drops}")

    # Save results
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    results_df = pd.DataFrame(all_results).T
    results_df.to_csv(output_dir / "evaluation_results.csv")

    save_config({"clean": clean_metrics, "drops": drops}, output_dir / "summary.yaml")

    logger.info(f"\n{format_metrics_table(all_results)}")

    return all_results


def main():
    parser = argparse.ArgumentParser(description="Evaluate model")
    parser.add_argument("--checkpoint", type=str, required=True, help="Model checkpoint path")
    parser.add_argument("--test_manifests", type=str, nargs="+", required=True,
                        help="Test manifest paths (first is clean, rest are degraded)")
    parser.add_argument("--output_dir", type=str, default="outputs/tables", help="Output directory")
    parser.add_argument("--config", type=str, default=None, help="Config YAML")
    args = parser.parse_args()

    config = load_config(args.config) if args.config else {}

    base_manifest = args.test_manifests[0]
    degradation_manifests = {
        Path(m).stem: m for m in args.test_manifests[1:]
    }

    evaluate_all_degradations(
        args.checkpoint,
        base_manifest,
        degradation_manifests,
        config,
        args.output_dir,
    )


if __name__ == "__main__":
    main()
