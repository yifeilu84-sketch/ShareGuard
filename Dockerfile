FROM pytorch/pytorch:2.12.1-cuda12.6-cudnn9-runtime@sha256:79c5599719e0b1afdb56ac2d14588b530283752d7ae6ec3c36e18ec9deb8b229

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV SHAREGUARD_HOST=0.0.0.0
ENV SHAREGUARD_MODE=local
ENV SHAREGUARD_BACKEND=mock
ENV SHAREGUARD_MODEL_CACHE=/cache/models
ENV XDG_CACHE_HOME=/cache
ENV HF_HOME=/cache/huggingface
ENV TORCH_HOME=/cache/torch
ENV PORT=7860

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

COPY requirements-platform.txt /app/requirements-platform.txt
RUN pip install --no-cache-dir -r /app/requirements-platform.txt

COPY setup.py README.md /app/
COPY shareguard /app/shareguard
COPY scripts/run_platform.py /app/scripts/run_platform.py

RUN pip install --no-cache-dir -e .

RUN groupadd --system shareguard \
    && useradd --system --gid shareguard --create-home --home-dir /home/shareguard shareguard \
    && mkdir -p /models /cache/models /cache/huggingface /cache/torch \
    && chown -R shareguard:shareguard /app /models /cache /home/shareguard

USER shareguard

EXPOSE 7860

HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
    CMD python -c "import os, urllib.request; urllib.request.urlopen('http://127.0.0.1:' + os.getenv('PORT', '7860') + '/v1/ready', timeout=3).read()"

CMD ["python", "-m", "shareguard.platform.app"]
