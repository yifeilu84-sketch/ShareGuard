# ShareGuard Platform 接入说明

平台层把私有检测模型转换为可用于媒体与品牌发布流程的三级决策：

- `allow`：可进入后续发布流程。
- `review`：需要结合来源信息进行人工复核。
- `hold`：建议暂缓发布并进一步取证。

系统输出是技术辅助信号，不替代司法鉴定或最终法律结论。

## 三种运行表面

- `public_demo/` 与 GitHub Pages：仅包含安全静态案例，不连接模型。
- 私有 Web 工作台：与 API 同源，部署在访问网关之后。
- 私有模型服务：常驻 GPU 进程，加载只读模型归档或私有签名制品。

GitHub 不保存模型权重、私有 URL、真实环境文件和客户图片。Pilot 与 Production 只接受带 `SHAREGUARD_BUNDLE_SHA256` 的只读压缩包或私有签名 URL；已解压目录只用于本地开发。

## 本地 Mock

```powershell
$env:SHAREGUARD_MODE="local"
$env:SHAREGUARD_BACKEND="mock"
python -m shareguard.platform.app
```

访问 `http://127.0.0.1:7860`。Mock 只用于页面、API和自动化测试。

## 私有 Bundle

本地开发可直接使用已解压目录：

```powershell
$env:SHAREGUARD_MODE="local"
$env:SHAREGUARD_BACKEND="fusion-bundle"
$env:BUNDLE="C:\private\ShareGuard_models\shareguard-noisyshare-fusion-v1"
python -m shareguard.platform.app
```

Pilot 使用只读归档；私有签名 URL 的 Production 配置相同，只需将 `BUNDLE` 换为 `BUNDLE_URL`：

```powershell
$env:SHAREGUARD_MODE="pilot"
$env:SHAREGUARD_BACKEND="fusion-bundle"
$env:SHAREGUARD_DEVICE="cuda"
$env:BUNDLE="C:\private\ShareGuard_models\shareguard-noisyshare-fusion-v1.tar.gz"
$env:SHAREGUARD_MODEL_CACHE="C:\private\ShareGuard_cache\models"
$env:SHAREGUARD_BUNDLE_SHA256="<approved-sha256>"
python -m shareguard.platform.app
```

Pilot 与 Production 均在解压前验证摘要，并从批准归档重新生成解压缓存。CLIP 与 DINOv2 的公开 backbone 需要可写缓存；无外网环境应提前准备缓存卷。

## 接口

- `GET /v1/health`：进程存活。
- `GET /v1/ready`：模型可接收请求。
- `POST /v1/analyze`：产品级脱敏响应。
- `POST /api/analyze`：当前页面兼容接口，带 `Deprecation: true`。

`POST /v1/analyze` 接受 `multipart/form-data` 的 `image` 字段，也接受带正确图片字节的原始请求体。仅支持单帧 JPEG、PNG 和 WebP。

机器客户端通过 `Authorization: Bearer <token>` 调用。浏览器工作台不嵌入机器 Token，应由同源部署和外层访问网关保护。

## 运行约束

- 默认最大文件 10 MiB、最大 2500 万像素。
- 默认禁止跨域，允许来源由 `SHAREGUARD_ALLOWED_ORIGINS` 精确配置。
- 默认一个 GPU 推理并发和八个等待请求，超限返回 `429 service_busy`。
- 默认最多十六个 HTTP 请求线程，队列满时先拒绝再解码图片。
- Pilot 与 Production 启动时预热模型；就绪前 `/v1/ready` 返回 `503`。
- 响应不包含模型路径、内部阈值、融合权重、逐模型分数或后端原始字典。

完整容器与环境变量说明见 `docs/platform_github_deployment.md`。
