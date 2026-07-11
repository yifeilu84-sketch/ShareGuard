# ShareGuard Public API Contract

公开仓库只声明产品级接口边界，不包含模型权重、内部实现或真实服务凭证。

## Analyze Image

`POST /v1/analyze`

请求使用 `multipart/form-data`，图片字段名为 `image`。配置机器 Token 后，请求还需包含：

```http
Authorization: Bearer <token>
```

成功响应示例：

```json
{
  "request_id": "sg_req_demo",
  "model_version": "shareguard-private-v1",
  "decision": "review",
  "decision_label": "需要人工复核",
  "risk_level": "medium",
  "ai_probability": 0.71,
  "confidence": 0.64,
  "uncertainty": "medium",
  "recommended_action": "建议暂缓公开使用，并结合来源信息进行人工复核。",
  "image": {
    "width": 1200,
    "height": 800,
    "mode": "RGB",
    "format": "JPEG"
  },
  "report": {
    "report_id": "SG-20260710-DEMO",
    "report_type": "真实传播链路鉴真报告",
    "summary": "建议暂缓公开使用，并结合来源信息进行人工复核。"
  },
  "warnings": [
    "本结果为技术辅助，不替代司法鉴定或最终法律结论。"
  ],
  "latency_ms": 850
}
```

实际响应还可以包含供工作台显示的传播退化视图和完整报告章节。

## Health

`GET /v1/health`

```json
{
  "request_id": "sg_req_demo",
  "status": "ok",
  "model_version": "shareguard-private-v1",
  "routes": ["/", "/v1/health", "/v1/ready", "/v1/analyze"]
}
```

## Readiness

`GET /v1/ready`

```json
{
  "request_id": "sg_req_demo",
  "status": "ready",
  "model_version": "shareguard-private-v1"
}
```

模型未就绪时返回 HTTP `503` 和 `status: not_ready`。

## Error

```json
{
  "request_id": "sg_req_demo",
  "error": {
    "code": "unsupported_image",
    "message": "请上传 JPEG、PNG 或 WebP 图片。"
  }
}
```

公开接口不返回内部路径、模型组成、融合参数、训练配置、逐模型分数或调试字典。
