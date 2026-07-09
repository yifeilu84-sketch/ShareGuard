"""Product-facing ShareGuard report and propagation-view helpers."""

import base64
from datetime import datetime, timezone
from io import BytesIO
from typing import Any, Dict, List
from uuid import uuid4

from PIL import Image, ImageDraw, ImageFilter, ImageOps


PROPAGATION_VIEW_LABELS = {
    "jpeg_q50": "JPEG压缩",
    "resize_384": "缩放转发",
    "screenshot_like": "截图传播",
    "share_heavy": "重度分享",
    "meme_like": "图文拼贴",
}


def make_propagation_views(image: Image.Image) -> List[Dict[str, Any]]:
    """Build lightweight visual previews of common real-sharing degradations."""

    rgb = image.convert("RGB")
    views = [
        ("jpeg_q50", _jpeg_roundtrip(rgb, quality=50)),
        ("resize_384", _resize_preview(rgb, max_edge=384)),
        ("screenshot_like", _screenshot_like(rgb)),
        ("share_heavy", _share_heavy(rgb)),
        ("meme_like", _meme_like(rgb)),
    ]
    return [
        {
            "id": view_id,
            "label": PROPAGATION_VIEW_LABELS[view_id],
            "width": int(view.width),
            "height": int(view.height),
            "image_data_url": _image_data_url(view),
        }
        for view_id, view in views
    ]


def build_authenticity_report(payload: Dict[str, Any]) -> Dict[str, Any]:
    """Translate detector output into a concise product report."""

    probability = float(payload.get("probability_ai_generated", 0.0))
    confidence = float(payload.get("confidence", 0.0))
    risk_level = payload.get("risk_level", "uncertain")
    label = payload.get("label", "real")
    now = datetime.now(timezone.utc).replace(microsecond=0)
    generated_at = now.isoformat().replace("+00:00", "Z")
    report_id = f"SG-{now.strftime('%Y%m%d')}-{uuid4().hex[:8].upper()}"
    image_info = payload.get("image") or {}
    width = image_info.get("width")
    height = image_info.get("height")
    image_size = f"{width}x{height}" if width and height else "-"
    propagation_count = len(payload.get("propagation_views") or [])

    if risk_level == "uncertain" or confidence < 0.2:
        conclusion = "需人工复核"
        action = "模型置信度较低，建议结合来源、上下文和人工审核后再使用。"
        uncertainty = "高"
    elif label == "ai_generated":
        conclusion = "疑似AI生成"
        action = "建议暂缓公开使用，进入人工复核或进一步取证流程。"
        uncertainty = "低" if confidence >= 0.6 else "中"
    else:
        conclusion = "倾向真实"
        action = "可作为低风险样本进入后续流程，但仍建议保留来源记录。"
        uncertainty = "低" if confidence >= 0.6 else "中"

    return {
        "product": "ShareGuard影像鉴真",
        "report_type": "真实传播链路鉴真报告",
        "report_id": report_id,
        "generated_at": generated_at,
        "subject": {
            "file_name": payload.get("file_name", "upload"),
            "image_size": image_size,
            "backend": payload.get("backend", "unknown"),
        },
        "conclusion": conclusion,
        "risk_level": risk_level,
        "ai_probability": probability,
        "confidence": confidence,
        "uncertainty": uncertainty,
        "recommended_action": action,
        "sections": [
            {
                "title": "检测结论",
                "items": [
                    f"综合结论：{conclusion}",
                    f"AI生成概率：{probability * 100:.1f}%",
                    f"风险等级：{risk_level}",
                ],
            },
            {
                "title": "传播链路证据",
                "items": [
                    f"已生成{propagation_count}种传播退化视图用于对照复核。",
                    "覆盖JPEG压缩、缩放转发、截图传播、重度分享和图文拼贴等常见场景。",
                ],
            },
            {
                "title": "处置建议",
                "items": [
                    action,
                    "建议将报告编号、原始图像来源和人工复核记录一并归档。",
                ],
            },
        ],
        "export_highlights": [
            "单图鉴真结论可直接复制给审核、媒体或风控人员。",
            "传播链路视图可作为客户演示和人工复核证据。",
            "报告编号和生成时间便于平台归档与后续追踪。",
        ],
        "review_notes": [
            "系统面向压缩、截图、转发和二次编辑后的真实传播图像。",
            "风险等级由模型分数、置信度和不确定性共同决定。",
            "建议保留原始来源、上传时间和人工复核记录。",
        ],
        "disclaimer": "本报告为技术辅助鉴真结果，不替代司法鉴定或最终法律结论。",
    }


def _jpeg_roundtrip(image: Image.Image, quality: int) -> Image.Image:
    buf = BytesIO()
    image.save(buf, format="JPEG", quality=quality, optimize=True)
    buf.seek(0)
    return Image.open(buf).convert("RGB")


def _resize_preview(image: Image.Image, max_edge: int) -> Image.Image:
    out = image.copy()
    out.thumbnail((max_edge, max_edge), Image.Resampling.BICUBIC)
    return out.convert("RGB")


def _screenshot_like(image: Image.Image) -> Image.Image:
    preview = _resize_preview(image, 520)
    pad = 28
    bar = 46
    canvas = Image.new("RGB", (preview.width + pad * 2, preview.height + pad * 2 + bar), "#edf1f5")
    draw = ImageDraw.Draw(canvas)
    draw.rounded_rectangle((pad, pad, canvas.width - pad, canvas.height - pad), radius=8, fill="#ffffff")
    draw.rectangle((pad, pad, canvas.width - pad, pad + bar), fill="#e5e9ef")
    line_left = pad + 12
    line_right = canvas.width - pad - 12
    if line_right > line_left:
        draw.rectangle((line_left, pad + 17, line_right, pad + 25), fill="#c2cad5")
    canvas.paste(preview, (pad, pad + bar))
    return canvas


def _share_heavy(image: Image.Image) -> Image.Image:
    degraded = _resize_preview(image, 448)
    degraded = _jpeg_roundtrip(degraded, quality=35)
    degraded = degraded.filter(ImageFilter.GaussianBlur(radius=0.35))
    return ImageOps.autocontrast(degraded, cutoff=1)


def _meme_like(image: Image.Image) -> Image.Image:
    preview = _resize_preview(image, 480)
    band = max(36, preview.height // 8)
    canvas = Image.new("RGB", (preview.width, preview.height + band * 2), "#ffffff")
    canvas.paste(preview, (0, band))
    draw = ImageDraw.Draw(canvas)
    draw.rectangle((0, 0, canvas.width, band), outline="#d7dde6")
    draw.rectangle((0, canvas.height - band, canvas.width, canvas.height), outline="#d7dde6")
    return canvas


def _image_data_url(image: Image.Image) -> str:
    buf = BytesIO()
    image.save(buf, format="JPEG", quality=82, optimize=True)
    data = base64.b64encode(buf.getvalue()).decode("ascii")
    return f"data:image/jpeg;base64,{data}"
