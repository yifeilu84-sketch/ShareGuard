"""Modal deployment adapter for the private ShareGuard inference service."""

from pathlib import Path
import os
import subprocess
import sys

import modal


ROOT = Path(__file__).resolve().parents[2]
PORT = 7860
MODEL_ARCHIVE = "/models/shareguard-noisyshare-fusion-v1-safe.tar.gz"

MODEL_VOLUME = modal.Volume.from_name(
    "shareguard-models",
    create_if_missing=True,
)
CACHE_VOLUME = modal.Volume.from_name(
    "shareguard-backbone-cache",
    create_if_missing=True,
)
RUNTIME_SECRET = modal.Secret.from_name("shareguard-production")

IMAGE = (
    modal.Image.from_registry(
        "pytorch/pytorch:2.12.1-cuda12.6-cudnn9-runtime@sha256:"
        "79c5599719e0b1afdb56ac2d14588b530283752d7ae6ec3c36e18ec9deb8b229"
    )
    .apt_install("libgl1", "libglib2.0-0")
    .pip_install_from_requirements(str(ROOT / "requirements-platform.txt"))
    .add_local_dir(str(ROOT / "shareguard"), remote_path="/app/shareguard")
    .workdir("/app")
    .env(
        {
            "PYTHONDONTWRITEBYTECODE": "1",
            "PYTHONUNBUFFERED": "1",
            "SHAREGUARD_MODE": "production",
            "SHAREGUARD_BACKEND": "fusion-bundle",
            "SHAREGUARD_HOST": "0.0.0.0",
            "SHAREGUARD_DEVICE": "cuda",
            "SHAREGUARD_MODEL_CACHE": "/cache/models",
            "SHAREGUARD_MODEL_VERSION": "shareguard-private-v1",
            "SHAREGUARD_ALLOWED_ORIGINS": "https://shareguard.systems",
            "SHAREGUARD_RATE_LIMIT_PER_MINUTE": "3",
            "SHAREGUARD_DAILY_QUOTA": "30",
            "SHAREGUARD_PUBLIC_SCORE_DECIMALS": "2",
            "SHAREGUARD_INCLUDE_PROPAGATION_VIEWS": "false",
            "SHAREGUARD_MAX_UPLOAD_BYTES": "10485760",
            "SHAREGUARD_MAX_IMAGE_PIXELS": "25000000",
            "SHAREGUARD_MAX_INFERENCE_CONCURRENCY": "1",
            "SHAREGUARD_MAX_WAITING_REQUESTS": "8",
            "SHAREGUARD_MAX_HTTP_WORKERS": "16",
            "XDG_CACHE_HOME": "/cache",
            "HF_HOME": "/cache/huggingface",
            "TORCH_HOME": "/cache/torch",
            "BUNDLE": MODEL_ARCHIVE,
            "PORT": str(PORT),
        }
    )
)

app = modal.App("shareguard-private-inference")


@app.function(
    image=IMAGE,
    gpu="T4",
    cpu=2.0,
    memory=8192,
    secrets=[RUNTIME_SECRET],
    volumes={
        "/models": MODEL_VOLUME.read_only(),
        "/cache": CACHE_VOLUME,
    },
    min_containers=0,
    max_containers=1,
    scaledown_window=300,
    timeout=900,
)
@modal.concurrent(max_inputs=16)
@modal.web_server(PORT, startup_timeout=600)
def serve():
    subprocess.Popen(
        [sys.executable, "-m", "shareguard.platform.app"],
        cwd="/app",
        env=os.environ.copy(),
    )
