"""IO utilities for config and manifest handling."""

import json
from pathlib import Path
from typing import Any, Dict, Optional, Union

import pandas as pd
import yaml


def load_config(path: Union[str, Path]) -> Dict[str, Any]:
    """Load YAML or JSON config file."""
    path = Path(path)
    if path.suffix in (".yaml", ".yml"):
        with open(path, "r", encoding="utf-8") as f:
            return yaml.safe_load(f)
    elif path.suffix == ".json":
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    else:
        raise ValueError(f"Unsupported config format: {path.suffix}")


def save_config(config: Dict[str, Any], path: Union[str, Path]) -> None:
    """Save config to YAML or JSON file."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.suffix in (".yaml", ".yml"):
        with open(path, "w", encoding="utf-8") as f:
            yaml.dump(config, f, default_flow_style=False, allow_unicode=True)
    elif path.suffix == ".json":
        with open(path, "w", encoding="utf-8") as f:
            json.dump(config, f, indent=2, ensure_ascii=False)
    else:
        raise ValueError(f"Unsupported config format: {path.suffix}")


def load_manifest(
    path: Union[str, Path],
    filters: Optional[Dict[str, Any]] = None,
) -> pd.DataFrame:
    """Load CSV manifest with optional filters."""
    df = pd.read_csv(path)
    if filters:
        for col, val in filters.items():
            if col in df.columns:
                if isinstance(val, list):
                    df = df[df[col].isin(val)]
                else:
                    df = df[df[col] == val]
    return df


def save_manifest(df: pd.DataFrame, path: Union[str, Path]) -> None:
    """Save DataFrame to CSV manifest."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    df.to_csv(path, index=False)


def find_images(
    root: Union[str, Path],
    extensions: tuple = (".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tiff"),
) -> list:
    """Recursively find all image files under root."""
    root = Path(root)
    images = []
    for ext in extensions:
        images.extend(root.rglob(f"*{ext}"))
        images.extend(root.rglob(f"*{ext.upper()}"))
    return sorted(set(images))
