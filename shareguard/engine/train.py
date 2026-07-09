"""Training engine for baselines and RIDE."""

import argparse
from pathlib import Path
from typing import Dict, Optional

import torch
import torch.nn as nn
from torch.utils.data import DataLoader
from tqdm import tqdm

from ..datasets.dataset import NoisyShareDataset, MultiViewDataset, get_default_transform
from ..models.backbones import get_backbone
from ..models.linear_probe import LinearProbe, MLPProbe
from ..models.ride import RIDE, RIDESimple
from ..models.losses import RIDELoss
from ..utils.io import load_config
from ..utils.logger import setup_logger
from ..utils.seed import set_seed
from .metrics import compute_metrics


def train_linear_probe(
    train_features: torch.Tensor,
    train_labels: torch.Tensor,
    val_features: torch.Tensor,
    val_labels: torch.Tensor,
    config: Dict,
) -> LinearProbe:
    """Train a linear probe on cached features.

    Args:
        train_features: Training features [N, D].
        train_labels: Training labels [N].
        val_features: Validation features [N, D].
        val_labels: Validation labels [N].
        config: Training config.

    Returns:
        Trained LinearProbe model.
    """
    logger = setup_logger()
    device = torch.device(config.get("device", "cuda" if torch.cuda.is_available() else "cpu"))

    # Create model
    feat_dim = train_features.shape[1]
    model = LinearProbe(
        in_dim=feat_dim,
        num_classes=config.get("num_classes", 1),
        dropout=config.get("dropout", 0.0),
    ).to(device)

    # Optimizer
    lr = config.get("lr", 1e-3)
    weight_decay = config.get("weight_decay", 1e-4)
    optimizer = torch.optim.AdamW(model.parameters(), lr=lr, weight_decay=weight_decay)

    # Loss
    criterion = nn.BCEWithLogitsLoss()

    # DataLoader
    batch_size = config.get("batch_size", 256)
    train_dataset = torch.utils.data.TensorDataset(train_features, train_labels)
    val_dataset = torch.utils.data.TensorDataset(val_features, val_labels)
    train_loader = DataLoader(train_dataset, batch_size=batch_size, shuffle=True)
    val_loader = DataLoader(val_dataset, batch_size=batch_size, shuffle=False)

    # Training loop
    epochs = config.get("epochs", 20)
    patience = config.get("patience", 5)
    best_val_auc = 0
    patience_counter = 0
    best_state = None

    for epoch in range(epochs):
        # Train
        model.train()
        train_loss = 0
        for features, labels in train_loader:
            features, labels = features.to(device), labels.to(device)
            logits = model(features).squeeze(-1)
            loss = criterion(logits, labels.float())
            optimizer.zero_grad()
            loss.backward()
            optimizer.step()
            train_loss += loss.item()

        train_loss /= len(train_loader)

        # Validate
        model.eval()
        val_scores = []
        val_targets = []
        with torch.no_grad():
            for features, labels in val_loader:
                features = features.to(device)
                logits = model(features).squeeze(-1)
                probs = torch.sigmoid(logits)
                val_scores.append(probs.cpu())
                val_targets.append(labels)

        val_scores = torch.cat(val_scores).numpy()
        val_targets = torch.cat(val_targets).numpy()

        val_metrics = compute_metrics(val_targets, val_scores)
        val_auc = val_metrics["auc"]

        logger.info(f"Epoch {epoch+1}/{epochs}: "
                     f"train_loss={train_loss:.4f}, val_auc={val_auc:.4f}")

        # Early stopping
        if val_auc > best_val_auc:
            best_val_auc = val_auc
            best_state = model.state_dict().copy()
            patience_counter = 0
        else:
            patience_counter += 1
            if patience_counter >= patience:
                logger.info(f"Early stopping at epoch {epoch+1}")
                break

    # Load best model
    if best_state is not None:
        model.load_state_dict(best_state)

    logger.info(f"Best validation AUC: {best_val_auc:.4f}")
    return model


def train_head(
    features_path: str,
    val_features_path: str,
    config_path: str,
    output_path: Optional[str] = None,
) -> nn.Module:
    """Train classification head on pre-cached features.

    Args:
        features_path: Path to training features .pt file.
        val_features_path: Path to validation features .pt file.
        config_path: Path to config YAML.
        output_path: Path to save checkpoint.

    Returns:
        Trained model.
    """
    config = load_config(config_path)
    set_seed(config.get("seed", 42))

    # Load features
    train_data = torch.load(features_path, map_location="cpu")
    val_data = torch.load(val_features_path, map_location="cpu")

    train_features = train_data["features"]
    train_labels = train_data["labels"]
    val_features = val_data["features"]
    val_labels = val_data["labels"]

    # Train
    model = train_linear_probe(train_features, train_labels, val_features, val_labels, config)

    # Save
    if output_path:
        output_path = Path(output_path)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        torch.save({
            "model_state_dict": model.state_dict(),
            "config": config,
        }, output_path)

    return model


def train_ride(
    config: Dict,
    train_manifest: str,
    val_manifest: str,
    output_dir: str,
) -> RIDE:
    """Train RIDE model.

    Args:
        config: Training configuration.
        train_manifest: Path to training manifest CSV.
        val_manifest: Path to validation manifest CSV.
        output_dir: Directory for checkpoints and logs.

    Returns:
        Trained RIDE model.
    """
    logger = setup_logger(log_file=Path(output_dir) / "train.log")
    device = torch.device(config.get("device", "cuda" if torch.cuda.is_available() else "cpu"))
    set_seed(config.get("seed", 42))

    # Create datasets
    image_size = config.get("image_size", 512)
    transform = get_default_transform(image_size, backbone=config.get("backbone", "dinov2"))

    # For RIDE, we need multi-view dataset
    from ..degradations.compose import get_degradation

    view_degradation_names = config.get("view_degradations", [
        "identity", "resize_0.75", "jpeg_q95", "crop_90"
    ])
    view_degradations = []
    for name in view_degradation_names:
        if name == "identity":
            view_degradations.append(None)
        else:
            view_degradations.append(get_degradation(name))

    train_dataset = MultiViewDataset(
        manifest_path=train_manifest,
        transform=transform,
        view_degradations=view_degradations,
        num_views=config.get("num_views", 4),
    )
    val_dataset = NoisyShareDataset(
        manifest_path=val_manifest,
        transform=transform,
    )

    batch_size = config.get("batch_size", 32)
    train_loader = DataLoader(
        train_dataset,
        batch_size=batch_size,
        shuffle=True,
        num_workers=config.get("num_workers", 4),
        pin_memory=True,
    )
    val_loader = DataLoader(
        val_dataset,
        batch_size=batch_size,
        shuffle=False,
        num_workers=config.get("num_workers", 4),
    )

    # Create model
    model = RIDE(
        backbone=config.get("backbone", "dinov2_vitb14"),
        feat_dim=config.get("feat_dim", 768),
        freq_dim=config.get("freq_dim", 128),
        hidden_dim=config.get("hidden_dim", 512),
        dropout=config.get("dropout", 0.2),
        use_freq=config.get("use_freq", True),
        use_std=config.get("use_std", True),
    ).to(device)

    # Loss
    criterion = RIDELoss(
        lambda_cons=config.get("lambda_cons", 0.1),
        pos_weight=config.get("pos_weight", None),
        cons_type=config.get("cons_type", "variance"),
    )

    # Optimizer (only classifier and freq branch parameters)
    trainable_params = [p for p in model.parameters() if p.requires_grad]
    optimizer = torch.optim.AdamW(
        trainable_params,
        lr=config.get("lr", 1e-4),
        weight_decay=config.get("weight_decay", 1e-4),
    )
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(
        optimizer,
        T_max=config.get("epochs", 30),
    )

    # Training loop
    epochs = config.get("epochs", 30)
    patience = config.get("patience", 5)
    best_val_auc = 0
    patience_counter = 0
    best_state = None

    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    for epoch in range(epochs):
        # Train
        model.train()
        train_loss_total = 0
        train_cls_total = 0
        train_cons_total = 0

        for views, labels in tqdm(train_loader, desc=f"Epoch {epoch+1}"):
            views, labels = views.to(device), labels.to(device)

            # Forward pass
            # Get final prediction (mean of views)
            B, K, C, H, W = views.shape
            x = views.reshape(B * K, C, H, W)
            with torch.no_grad():
                z = model.backbone(x)
            z = z.reshape(B, K, -1)
            z_mean = z.mean(dim=1)
            z_std = z.std(dim=1)
            z_max = z.max(dim=1).values
            z_agg = torch.cat([z_mean, z_std, z_max], dim=1)

            if model.use_freq:
                from ..models.frequency_branch import extract_frequency_features_batch
                freq_feat = extract_frequency_features_batch(views[:, 0])
                f_freq = model.freq_branch(freq_feat)
                h = torch.cat([z_agg, f_freq], dim=1)
            else:
                h = z_agg

            logit = model.classifier(h).squeeze(-1)

            # Get per-view predictions for consistency loss
            z_per_view = z.reshape(B * K, -1)
            view_logits = model.classifier(z_per_view).reshape(B, K, -1)

            # Compute loss
            losses = criterion(logit, labels, view_logits)

            optimizer.zero_grad()
            losses["total"].backward()
            optimizer.step()

            train_loss_total += losses["total"].item()
            train_cls_total += losses["cls"].item()
            train_cons_total += losses["cons"].item()

        scheduler.step()

        train_loss_total /= len(train_loader)
        train_cls_total /= len(train_loader)
        train_cons_total /= len(train_loader)

        # Validate
        model.eval()
        val_scores = []
        val_targets = []
        with torch.no_grad():
            for images, labels in val_loader:
                images = images.to(device)
                # Single view prediction for validation
                views = images.unsqueeze(1)  # [B, 1, C, H, W]
                logit = model(views)
                probs = torch.sigmoid(logit.squeeze(-1))
                val_scores.append(probs.cpu())
                val_targets.append(labels)

        val_scores = torch.cat(val_scores).numpy()
        val_targets = torch.cat(val_targets).numpy()
        val_metrics = compute_metrics(val_targets, val_scores)

        logger.info(
            f"Epoch {epoch+1}/{epochs}: "
            f"train_loss={train_loss_total:.4f} (cls={train_cls_total:.4f}, cons={train_cons_total:.4f}), "
            f"val_auc={val_metrics['auc']:.4f}, val_ece={val_metrics['ece']:.4f}"
        )

        # Save checkpoint
        if val_metrics["auc"] > best_val_auc:
            best_val_auc = val_metrics["auc"]
            best_state = model.state_dict().copy()
            patience_counter = 0

            torch.save({
                "epoch": epoch,
                "model_state_dict": model.state_dict(),
                "optimizer_state_dict": optimizer.state_dict(),
                "val_auc": best_val_auc,
                "config": config,
            }, output_dir / "best.pt")
        else:
            patience_counter += 1
            if patience_counter >= patience:
                logger.info(f"Early stopping at epoch {epoch+1}")
                break

    # Load best model
    if best_state is not None:
        model.load_state_dict(best_state)

    logger.info(f"Training complete. Best val AUC: {best_val_auc:.4f}")
    return model


def main():
    parser = argparse.ArgumentParser(description="Train model")
    parser.add_argument("--config", type=str, required=True, help="Config YAML path")
    parser.add_argument("--train_manifest", type=str, required=True, help="Training manifest")
    parser.add_argument("--val_manifest", type=str, required=True, help="Validation manifest")
    parser.add_argument("--output_dir", type=str, default="outputs/checkpoints", help="Output directory")
    args = parser.parse_args()

    config = load_config(args.config)

    if config.get("model_type", "linear") == "ride":
        train_ride(config, args.train_manifest, args.val_manifest, args.output_dir)
    else:
        # Linear probe training
        train_head(
            config.get("train_features"),
            config.get("val_features"),
            args.config,
            Path(args.output_dir) / "best.pt",
        )


if __name__ == "__main__":
    main()
