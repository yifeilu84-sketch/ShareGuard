"""Inference engine for single image or batch prediction."""

import argparse
from pathlib import Path
from typing import Dict, List, Optional, Tuple, Union

import numpy as np
import torch
from PIL import Image

from ..datasets.dataset import get_default_transform
from ..models.backbones import get_backbone
from ..models.linear_probe import LinearProbe
from ..models.ride import RIDE
from ..utils.io import load_config


class Detector:
    """AI-generated image detector.

    Args:
        model_path: Path to model checkpoint.
        device: Device to use.
    """

    def __init__(
        self,
        model_path: str,
        device: Optional[str] = None,
    ):
        self.device = torch.device(
            device or ("cuda" if torch.cuda.is_available() else "cpu")
        )

        # Load checkpoint
        checkpoint = torch.load(model_path, map_location=self.device)
        config = checkpoint.get("config", {})

        model_type = config.get("model_type", "linear")

        if model_type == "ride":
            self.model = RIDE(
                backbone=config.get("backbone", "dinov2_vitb14"),
                feat_dim=config.get("feat_dim", 768),
                freq_dim=config.get("freq_dim", 128),
                hidden_dim=config.get("hidden_dim", 512),
                use_freq=config.get("use_freq", True),
                use_std=config.get("use_std", True),
            )
            self.model.load_state_dict(checkpoint["model_state_dict"])
            self.model = self.model.to(self.device)
            self.model.eval()
        else:
            backbone_name = config.get("backbone", "dinov2_vitb14")
            self.backbone = get_backbone(backbone_name, freeze=True).to(self.device)
            self.classifier = LinearProbe(in_dim=self.backbone.feat_dim, num_classes=1)
            self.classifier.load_state_dict(checkpoint["model_state_dict"])
            self.classifier = self.classifier.to(self.device)
            self.backbone.eval()
            self.classifier.eval()

        self.model_type = model_type
        self.transform = get_default_transform(
            config.get("image_size", 512),
            backbone=config.get("backbone", "dinov2"),
        )

    @torch.no_grad()
    def predict(self, image: Union[str, Path, Image.Image]) -> Dict[str, float]:
        """Predict if an image is AI-generated.

        Args:
            image: Input image (path or PIL Image).

        Returns:
            Dict with 'probability' (0-1) and 'prediction' ('real' or 'fake').
        """
        if isinstance(image, (str, Path)):
            image = Image.open(image).convert("RGB")

        # Preprocess
        tensor = self.transform(image).unsqueeze(0).to(self.device)

        if self.model_type == "ride":
            views = tensor.unsqueeze(1)  # [1, 1, C, H, W]
            logit = self.model(views)
        else:
            features = self.backbone(tensor)
            logit = self.classifier(features)

        prob = torch.sigmoid(logit).item()

        return {
            "probability": prob,
            "prediction": "fake" if prob >= 0.5 else "real",
            "confidence": abs(prob - 0.5) * 2,
        }

    @torch.no_grad()
    def predict_batch(
        self,
        images: List[Union[str, Path, Image.Image]],
        batch_size: int = 32,
    ) -> List[Dict[str, float]]:
        """Predict on a batch of images.

        Args:
            images: List of images (paths or PIL Images).
            batch_size: Batch size for inference.

        Returns:
            List of prediction dicts.
        """
        results = []

        for i in range(0, len(images), batch_size):
            batch = images[i:i + batch_size]

            # Load and preprocess
            tensors = []
            for img in batch:
                if isinstance(img, (str, Path)):
                    img = Image.open(img).convert("RGB")
                tensors.append(self.transform(img))

            batch_tensor = torch.stack(tensors).to(self.device)

            if self.model_type == "ride":
                views = batch_tensor.unsqueeze(1)
                logits = self.model(views).squeeze(-1)
            else:
                features = self.backbone(batch_tensor)
                logits = self.classifier(features).squeeze(-1)

            probs = torch.sigmoid(logits).cpu().numpy()

            for prob in probs:
                results.append({
                    "probability": float(prob),
                    "prediction": "fake" if prob >= 0.5 else "real",
                    "confidence": float(abs(prob - 0.5) * 2),
                })

        return results


def main():
    parser = argparse.ArgumentParser(description="Run inference")
    parser.add_argument("--checkpoint", type=str, required=True, help="Model checkpoint")
    parser.add_argument("--input", type=str, required=True, help="Input image or directory")
    parser.add_argument("--output", type=str, default=None, help="Output CSV path")
    parser.add_argument("--batch_size", type=int, default=32, help="Batch size")
    args = parser.parse_args()

    detector = Detector(args.checkpoint)

    input_path = Path(args.input)
    if input_path.is_dir():
        # Process directory
        images = list(input_path.glob("*.jpg")) + list(input_path.glob("*.png"))
        results = detector.predict_batch(images, args.batch_size)
        for img, res in zip(images, results):
            res["image_path"] = str(img)
    else:
        # Single image
        results = [detector.predict(input_path)]
        results[0]["image_path"] = str(input_path)

    # Print results
    for res in results:
        print(f"{res.get('image_path', 'image')}: {res['prediction']} "
              f"(prob={res['probability']:.4f}, conf={res['confidence']:.4f})")

    # Save to CSV
    if args.output:
        import pandas as pd
        df = pd.DataFrame(results)
        df.to_csv(args.output, index=False)
        print(f"Results saved to {args.output}")


if __name__ == "__main__":
    main()
