# ShareGuard GitHub 部署方案

## 核心判断

HPC 只负责训练和导出模型，不作为线上推理服务。比赛 Demo 或公开部署应从 GitHub 仓库启动平台代码，并在启动时下载模型 artifact 到本地缓存。

推荐结构：

```text
GitHub repo
  Dockerfile
  requirements-platform.txt
  shareguard/platform/*
  scripts/run_platform.py
  docs/platform_github_deployment.md

Model artifact
  GitHub Release asset / Git LFS / Hugging Face model repo
  推荐：shareguard-noisyshare-fusion-v1.tar.gz
```

不要把大型 `model.pt` 直接提交到普通 git 历史里。GitHub 官方建议仓库保持小型，理想上小于 1GB；Git LFS 可处理更大文件，但 Free/Pro 单文件上限为 2GB，并会消耗 LFS 存储和带宽。

## 从 HPC 导出模型

训练完成后，在 HPC 上固化一个推理模型包。当前最终主方法是：

```text
clip_b_l_score_fusion
= CLIP-B feature-fusion 5-seed ensemble
+ CLIP-L feature-fusion 5-seed ensemble
+ dev-selected score fusion
```

因此不要只拷贝一个 `model.pt`，而是导出完整 bundle：

```bash
cd ~/ShareGuard

~/.conda/envs/shareguard/bin/python scripts/export_noisyshare_fusion_bundle.py \
  --method clip_b_l_score_fusion \
  --out-dir model_artifacts/shareguard-noisyshare-fusion-v1 \
  --archive model_artifacts/shareguard-noisyshare-fusion-v1.tar.gz
```

输出：

```text
model_artifacts/shareguard-noisyshare-fusion-v1/
model_artifacts/shareguard-noisyshare-fusion-v1.tar.gz
model_artifacts/shareguard-noisyshare-fusion-v1.tar.gz.sha256
```

bundle 内含：

- `manifest.json`
- `model_card.json`
- `models/clip_b/seed42..46/model.pt`
- `models/clip_l/seed42..46/model.pt`
- final public baseline table 和 clean-boost 指标

## 上传模型 artifact

选项 A：GitHub Release asset

```bash
gh release create shareguard-noisyshare-fusion-v1 \
  model_artifacts/shareguard-noisyshare-fusion-v1.tar.gz \
  model_artifacts/shareguard-noisyshare-fusion-v1.tar.gz.sha256 \
  --title "ShareGuard NoisyShare-Fusion v1" \
  --notes "Deployable CLIP-B/L feature-fusion ensemble bundle."
```

然后复制 release asset 的下载 URL，作为部署环境变量：

```text
BUNDLE_URL=https://github.com/<owner>/<repo>/releases/download/shareguard-noisyshare-fusion-v1/shareguard-noisyshare-fusion-v1.tar.gz
```

选项 B：Git LFS

```bash
git lfs install
git lfs track "*.pt" "*.pth" "*.safetensors"
git add .gitattributes models/model.pt
git commit -m "Add demo model with Git LFS"
```

选项 C：Hugging Face model repo

适合模型较大或需要公开模型卡时使用。部署时把 `BUNDLE_URL` 指向 raw download URL。

## 本地或云端启动

无模型 smoke：

```bash
python -m shareguard.platform.app --host 127.0.0.1 --port 7860 --backend mock
```

真实模型，本地已有 fusion bundle：

```bash
python -m shareguard.platform.app \
  --host 0.0.0.0 \
  --port 7860 \
  --backend fusion-bundle \
  --bundle /models/shareguard-noisyshare-fusion-v1
```

真实模型，本地已有 `.tar.gz` 压缩包：

```bash
python -m shareguard.platform.app \
  --host 0.0.0.0 \
  --port 7860 \
  --backend fusion-bundle \
  --bundle model_artifacts/shareguard-noisyshare-fusion-v1.tar.gz
```

真实模型，从 URL 下载并解包：

```bash
python -m shareguard.platform.app \
  --host 0.0.0.0 \
  --port 7860 \
  --backend fusion-bundle \
  --bundle-url "$BUNDLE_URL" \
  --bundle-cache "${SHAREGUARD_MODEL_CACHE:-/models}"
```

Docker：

```bash
docker build -t shareguard-platform .
docker run --rm -p 7860:7860 \
  -e SHAREGUARD_BACKEND=fusion-bundle \
  -e BUNDLE_URL="$BUNDLE_URL" \
  shareguard-platform \
  python -m shareguard.platform.app --host 0.0.0.0 --port 7860 --backend fusion-bundle --bundle-url "$BUNDLE_URL"
```

## API

```http
POST /api/analyze
Content-Type: multipart/form-data

field: image
```

返回字段：

```json
{
  "file_name": "example.png",
  "label": "ai_generated",
  "probability_ai_generated": 0.91,
  "confidence": 0.82,
  "risk_level": "high",
  "decision": "hold",
  "uncertainty": "中等",
  "backend": "private-inference",
  "image": {"width": 512, "height": 512, "mode": "RGB"},
  "propagation_views": [],
  "report": {
    "conclusion": "疑似AI生成",
    "summary": "疑似AI生成。系统给出 91.0% 的AI生成风险，置信度为 82.0%。",
    "recommended_action": "进入人工复核流程。",
    "notes": ["建议保留来源和人工复核记录。"],
    "disclaimer": "该结果为技术辅助风险信号，不替代司法鉴定或来源调查。"
  }
}
```

公开 API 只返回产品级结论。模型包路径、子模型分数、融合权重、阈值、`raw` 字段与调试证据不得离开私有推理服务。GitHub Pages 仅发布静态工作流演示；真实模型通过同源 `/api/analyze` 接入，默认不允许任意跨域站点读取结果。

## 比赛 Demo 推荐部署顺序

1. 先用 `--backend mock` 把 GitHub 部署跑通。
2. 在 HPC 上运行 `scripts/export_noisyshare_fusion_bundle.py`。
3. 上传 `shareguard-noisyshare-fusion-v1.tar.gz` 到 GitHub Release 或 Hugging Face。
4. 用 `--backend fusion-bundle --bundle-url "$BUNDLE_URL"` 启动线上 Demo。
5. 截图和录制视频时明确显示这是 `noisyshare-fusion` 后端，不再显示 mock。
