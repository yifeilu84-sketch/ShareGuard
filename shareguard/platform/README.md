# ShareGuard Platform 接入说明

这个平台层用于比赛 Demo 和后续产品化接入。当前部署原则是：

- HPC 只负责训练、评估和导出最终模型包。
- GitHub 仓库负责托管平台代码、Dockerfile、测试、导出脚本和部署说明。
- 线上部署环境启动时通过 `--bundle-url` 下载融合模型包到本地缓存，再加载检测模型。

## 当前主模型

当前建议用于比赛和工程部署的模型不是单个 `model.pt`，而是：

```text
NoisyShare-Fusion / clip_b_l_score_fusion
```

它由 CLIP-B feature-fusion 多种子、CLIP-L feature-fusion 多种子、DINOv2 特征和频域特征组成，并使用开发集上冻结的融合权重与阈值。部署时请使用 `fusion-bundle` 后端。

## 本地无模型 Demo

```bash
python -m shareguard.platform.app --host 127.0.0.1 --port 7860 --backend mock
```

打开：

```text
http://127.0.0.1:7860
```

`mock` 只用于验证页面和接口，不代表真实检测结果。

## 从 HPC 导出模型包

在 HPC 的 ShareGuard 项目目录中运行：

```bash
python scripts/export_noisyshare_fusion_bundle.py \
  --method clip_b_l_score_fusion \
  --out-dir model_artifacts/shareguard-noisyshare-fusion-v1 \
  --archive model_artifacts/shareguard-noisyshare-fusion-v1.tar.gz
```

导出结果包含：

- `manifest.json`：融合权重、阈值、子模型清单和指标摘要。
- `models/clip_b/seed42..46/model.pt`：CLIP-B 多种子 checkpoint。
- `models/clip_l/seed42..46/model.pt`：CLIP-L 多种子 checkpoint。
- `reports/`：公开基线表和鲁棒性报告副本。
- `model_card.json`：用于比赛和部署交接的模型说明。

不要把大型 `model.pt` 直接提交到普通 git 历史。大型模型包建议上传到 GitHub Release、Git LFS 或 Hugging Face。

## 真实模型接入

本地已有解压后的 bundle：

```bash
python -m shareguard.platform.app \
  --host 0.0.0.0 \
  --port 7860 \
  --backend fusion-bundle \
  --bundle /models/shareguard-noisyshare-fusion-v1
```

本地只有 `.tar.gz` 压缩包时也可以直接传给 `--bundle`，平台会自动解压：

```bash
python -m shareguard.platform.app \
  --host 0.0.0.0 \
  --port 7860 \
  --backend fusion-bundle \
  --bundle model_artifacts/shareguard-noisyshare-fusion-v1.tar.gz
```

从 GitHub Release、Git LFS raw URL 或 Hugging Face URL 下载压缩包：

```bash
python -m shareguard.platform.app \
  --host 0.0.0.0 \
  --port 7860 \
  --backend fusion-bundle \
  --bundle-url "$BUNDLE_URL" \
  --bundle-cache "${SHAREGUARD_MODEL_CACHE:-/models}"
```

平台会把模型包下载并解压到缓存目录，之后重复启动会复用已有文件。

## 单 checkpoint 兼容模式

`shareguard` 后端仍保留给旧版单 checkpoint 或 `shareguard.engine.infer.Detector` 兼容模型：

```bash
python -m shareguard.platform.app \
  --host 0.0.0.0 \
  --port 7860 \
  --backend shareguard \
  --checkpoint /models/model.pt
```

当前最终模型请优先使用 `fusion-bundle`，不要把融合模型拆成单 checkpoint 部署。

## GitHub 部署

仓库需要包含：

- `Dockerfile`
- `requirements-platform.txt`
- `shareguard/platform/*`
- `scripts/export_noisyshare_fusion_bundle.py`
- `docs/platform_github_deployment.md`
- `tests/test_platform_backend.py`

Docker 启动示例：

```bash
docker run --rm -p 7860:7860 \
  -e SHAREGUARD_BACKEND=fusion-bundle \
  -e BUNDLE_URL="$BUNDLE_URL" \
  shareguard-platform
```

## API 协议

请求：

```http
POST /api/analyze
Content-Type: multipart/form-data

field: image
```

响应：

```json
{
  "file_name": "example.png",
  "label": "ai_generated",
  "probability_ai_generated": 0.91,
  "confidence": 0.82,
  "risk_level": "high",
  "backend": "noisyshare-fusion",
  "image": {
    "width": 512,
    "height": 512,
    "mode": "RGB"
  },
  "evidence": [
    "bundle: /models/shareguard-noisyshare-fusion-v1",
    "method: clip_b_l_score_fusion"
  ],
  "raw": {
    "probability": 0.91,
    "prediction": "fake",
    "threshold": 0.5
  }
}
```

## 重要注意事项

- `fusion-bundle` 会加载 CLIP-B、CLIP-L 和 DINOv2 backbone；部署环境需要可用的权重缓存或网络下载能力。
- 真实推理建议使用 GPU 环境；CPU 可用于小规模演示但延迟会明显更高。
- `RemoteDetectorBackend` 仅保留作内网联调或测试兼容，不作为比赛部署主方案。
