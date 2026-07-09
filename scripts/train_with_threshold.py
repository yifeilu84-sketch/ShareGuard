"""Train model with threshold tuning on clean validation set."""

import argparse
import json
import time
from pathlib import Path

import numpy as np
import pandas as pd
import torch
import torch.nn as nn
from PIL import Image
from sklearn.metrics import (
    accuracy_score,
    average_precision_score,
    balanced_accuracy_score,
    f1_score,
    roc_auc_score,
)
from torchvision import transforms
from tqdm import tqdm

from shareguard.degradations.registry import DegradationRegistry
from shareguard.models.shareguard import ShareGuard
from shareguard.losses.shareguard_loss import ShareGuardLoss
from shareguard.utils.experiment_registry import ExperimentRegistry


def find_optimal_threshold(y_true, y_scores, metric="f1"):
    """Find optimal threshold on validation set."""
    thresholds = np.arange(0.1, 0.9, 0.01)
    best_score = 0
    best_threshold = 0.5

    for thresh in thresholds:
        y_pred = (y_scores >= thresh).astype(int)
        if metric == "f1":
            score = f1_score(y_true, y_pred)
        elif metric == "balanced_accuracy":
            score = balanced_accuracy_score(y_true, y_pred)
        elif metric == "accuracy":
            score = accuracy_score(y_true, y_pred)
        else:
            raise ValueError(f"Unknown metric: {metric}")

        if score > best_score:
            best_score = score
            best_threshold = thresh

    return best_threshold, best_score


def evaluate_with_threshold(y_true, y_scores, threshold):
    """Evaluate with a specific threshold."""
    y_pred = (y_scores >= threshold).astype(int)

    metrics = {
        "accuracy": accuracy_score(y_true, y_pred),
        "balanced_accuracy": balanced_accuracy_score(y_true, y_pred),
        "f1": f1_score(y_true, y_pred),
        "auc": roc_auc_score(y_true, y_scores),
        "ap": average_precision_score(y_true, y_scores),
        "threshold": threshold,
    }

    return metrics


def save_predictions(
    image_paths,
    labels,
    scores,
    predictions,
    model_name,
    seed,
    dataset,
    degradation,
    severity,
    output_path,
):
    """Save per-sample predictions to CSV."""
    df = pd.DataFrame({
        "image_id": [Path(p).stem for p in image_paths],
        "source_id": [Path(p).stem.split("_")[-1] for p in image_paths],
        "label": labels,
        "score": scores,
        "prediction": predictions,
        "correct": (predictions == labels).astype(int),
        "model": model_name,
        "seed": seed,
        "dataset": dataset,
        "generator": "unknown",
        "degradation": degradation,
        "severity": severity,
    })

    Path(output_path).parent.mkdir(parents=True, exist_ok=True)
    df.to_csv(output_path, index=False)
    print(f"Predictions saved to {output_path}")

    return df


def main():
    parser = argparse.ArgumentParser(description="Train with threshold tuning")
    parser.add_argument("--config", type=str, required=True, help="Config YAML")
    parser.add_argument("--train-manifest", type=str, required=True, help="Train manifest")
    parser.add_argument("--val-manifest", type=str, required=True, help="Val manifest")
    parser.add_argument("--test-manifest", type=str, required=True, help="Test manifest")
    parser.add_argument("--output-dir", type=str, required=True, help="Output directory")
    parser.add_argument("--seed", type=int, default=42, help="Random seed")
    parser.add_argument("--model-name", type=str, default="shareguard", help="Model name")
    args = parser.parse_args()

    # Set seed
    torch.manual_seed(args.seed)
    np.random.seed(args.seed)

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    print(f"Device: {device}")

    # Create experiment registry
    registry = ExperimentRegistry(args.output_dir)
    run_id = registry.create_run(
        model_name=args.model_name,
        config_path=args.config,
        train_manifest=args.train_manifest,
        val_manifest=args.val_manifest,
        test_manifests=[args.test_manifest],
        seed=args.seed,
    )
    print(f"Run ID: {run_id}")

    # Load data
    train_df = pd.read_csv(args.train_manifest)
    val_df = pd.read_csv(args.val_manifest)
    test_df = pd.read_csv(args.test_manifest)

    print(f"Train: {len(train_df)}, Val: {len(val_df)}, Test: {len(test_df)}")

    # Initialize model
    model = ShareGuard(
        encoder_name="dinov2_vitb14",
        encoder_mode="frozen",
        feat_dim=768,
        use_freq=True,
        use_std=True,
        num_generators=0,
        uncertainty_mode="view_variance",
    ).to(device)

    criterion = ShareGuardLoss(lambda_inv=0.1, lambda_cons=0.1)
    optimizer = torch.optim.Adam(
        [p for p in model.parameters() if p.requires_grad],
        lr=1e-4,
        weight_decay=1e-4,
    )

    transform = transforms.Compose([
        transforms.Resize(518),
        transforms.CenterCrop(518),
        transforms.ToTensor(),
        transforms.Normalize(mean=[0.485, 0.456, 0.406], std=[0.229, 0.224, 0.225]),
    ])

    registry_degradations = DegradationRegistry()
    train_degradations = [
        None,
        registry_degradations.get("jpeg_q75"),
        registry_degradations.get("crop_90"),
        registry_degradations.get("resize_0.75"),
        registry_degradations.get("share_medium"),
    ]

    # Training loop
    num_epochs = 10
    batch_size = 16

    print("\n=== Training ===")
    for epoch in range(num_epochs):
        model.train()
        total_loss = 0
        num_batches = 0

        for idx in tqdm(range(0, len(train_df), batch_size), desc=f"Epoch {epoch+1}"):
            batch_df = train_df.iloc[idx:idx + batch_size]
            views_list, labels_list = [], []

            for _, row in batch_df.iterrows():
                try:
                    img = Image.open(row["image_path"]).convert("RGB")
                    import random
                    view_degs = random.sample(train_degradations, 4)
                    views = [transform(deg(img) if deg else img.copy()) for deg in view_degs]
                    views_list.append(torch.stack(views))
                    labels_list.append(row["label"])
                except:
                    continue

            if not views_list:
                continue

            views = torch.stack(views_list).to(device)
            labels = torch.tensor(labels_list).to(device)
            result = model(views, views[:, 0], return_uncertainty=True)
            losses = criterion(result["logits"], labels, view_probs=result.get("view_probs"))

            optimizer.zero_grad()
            losses["total"].backward()
            optimizer.step()
            total_loss += losses["total"].item()
            num_batches += 1

        print(f"Epoch {epoch+1}: loss={total_loss / max(num_batches, 1):.4f}")

    # Evaluate on clean validation set to find optimal threshold
    print("\n=== Threshold Tuning on Clean Validation ===")
    model.eval()
    val_scores, val_labels = [], []

    for _, row in tqdm(val_df.iterrows(), total=len(val_df), desc="Val"):
        try:
            img = Image.open(row["image_path"]).convert("RGB")
            views = [
                transform(img.copy()),
                transform(registry_degradations.get("jpeg_q95")(img)),
                transform(registry_degradations.get("crop_90")(img)),
                transform(registry_degradations.get("resize_0.75")(img)),
            ]
            views_tensor = torch.stack(views).unsqueeze(0).to(device)
            with torch.no_grad():
                result = model(views_tensor, views_tensor[:, 0], return_uncertainty=False)
                val_scores.append(result["probs"].cpu().item())
                val_labels.append(row["label"])
        except:
            continue

    val_scores = np.array(val_scores)
    val_labels = np.array(val_labels)

    # Find optimal threshold
    optimal_threshold, best_f1 = find_optimal_threshold(val_labels, val_scores, metric="f1")
    print(f"Optimal threshold: {optimal_threshold:.2f} (F1={best_f1:.4f})")

    # Evaluate on validation set with optimal threshold
    val_metrics = evaluate_with_threshold(val_labels, val_scores, optimal_threshold)
    print(f"\nValidation metrics (threshold={optimal_threshold:.2f}):")
    for k, v in val_metrics.items():
        print(f"  {k}: {v:.4f}")

    # Save validation predictions
    val_predictions = (val_scores >= optimal_threshold).astype(int)
    save_predictions(
        val_df["image_path"].tolist(),
        val_labels.tolist(),
        val_scores.tolist(),
        val_predictions.tolist(),
        args.model_name,
        args.seed,
        "val",
        "clean",
        0,
        str(Path(args.output_dir) / run_id / "predictions_val_clean.csv"),
    )

    # Evaluate on test set
    print("\n=== Test Evaluation ===")
    test_scores, test_labels, test_paths = [], [], []

    for _, row in tqdm(test_df.iterrows(), total=len(test_df), desc="Test"):
        try:
            img = Image.open(row["image_path"]).convert("RGB")
            views = [
                transform(img.copy()),
                transform(registry_degradations.get("jpeg_q95")(img)),
                transform(registry_degradations.get("crop_90")(img)),
                transform(registry_degradations.get("resize_0.75")(img)),
            ]
            views_tensor = torch.stack(views).unsqueeze(0).to(device)
            with torch.no_grad():
                result = model(views_tensor, views_tensor[:, 0], return_uncertainty=False)
                test_scores.append(result["probs"].cpu().item())
                test_labels.append(row["label"])
                test_paths.append(row["image_path"])
        except:
            continue

    test_scores = np.array(test_scores)
    test_labels = np.array(test_labels)

    # Evaluate with optimal threshold
    test_metrics = evaluate_with_threshold(test_labels, test_scores, optimal_threshold)
    print(f"\nTest metrics (threshold={optimal_threshold:.2f}):")
    for k, v in test_metrics.items():
        print(f"  {k}: {v:.4f}")

    # Save test predictions
    test_predictions = (test_scores >= optimal_threshold).astype(int)
    save_predictions(
        test_paths,
        test_labels.tolist(),
        test_scores.tolist(),
        test_predictions.tolist(),
        args.model_name,
        args.seed,
        "test",
        "clean",
        0,
        str(Path(args.output_dir) / run_id / "predictions_test_clean.csv"),
    )

    # Save model
    checkpoint_path = str(Path(args.output_dir) / run_id / "model.pt")
    Path(checkpoint_path).parent.mkdir(parents=True, exist_ok=True)
    torch.save(model.state_dict(), checkpoint_path)
    print(f"Model saved to {checkpoint_path}")

    # Update registry
    registry.update_run(
        run_id,
        metrics={
            "val_accuracy": val_metrics["accuracy"],
            "val_balanced_accuracy": val_metrics["balanced_accuracy"],
            "val_f1": val_metrics["f1"],
            "val_auc": val_metrics["auc"],
            "val_ap": val_metrics["ap"],
            "test_accuracy": test_metrics["accuracy"],
            "test_balanced_accuracy": test_metrics["balanced_accuracy"],
            "test_f1": test_metrics["f1"],
            "test_auc": test_metrics["auc"],
            "test_ap": test_metrics["ap"],
            "optimal_threshold": optimal_threshold,
        },
        checkpoint_path=checkpoint_path,
        status="completed",
    )

    print(f"\n=== Run {run_id} completed ===")
    print(f"Optimal threshold: {optimal_threshold:.2f}")
    print(f"Test AUC: {test_metrics['auc']:.4f}")
    print(f"Test F1: {test_metrics['f1']:.4f}")


if __name__ == "__main__":
    main()
