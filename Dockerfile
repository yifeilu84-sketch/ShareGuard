FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV SHAREGUARD_MODEL_CACHE=/models
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

EXPOSE 7860

CMD ["sh", "-c", "python -m shareguard.platform.app --host 0.0.0.0 --port ${PORT:-7860} --backend ${SHAREGUARD_BACKEND:-mock} ${CHECKPOINT:+--checkpoint \"$CHECKPOINT\"} ${MODEL_URL:+--model-url \"$MODEL_URL\"} --model-cache ${SHAREGUARD_MODEL_CACHE:-/models} ${BUNDLE:+--bundle \"$BUNDLE\"} ${BUNDLE_URL:+--bundle-url \"$BUNDLE_URL\"} --bundle-cache ${SHAREGUARD_MODEL_CACHE:-/models}"]
