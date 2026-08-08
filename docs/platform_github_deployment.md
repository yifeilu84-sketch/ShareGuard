# ShareGuard 私有部署方案

## 部署原则

ShareGuard 使用三个彼此隔离的产品表面：

1. GitHub Pages 发布空白启动的正式前端；它只渲染真实模型响应，拒绝 Mock/演示响应，网关失败时不回填任何静态结论。独立静态案例仅保留在 `public_demo/`。
2. 私有推理网关只允许精确配置的 Pages Origin，并对就绪检查和每次推理执行访问鉴权。
3. 私有 GPU 服务加载模型并返回产品级决策，不向客户端返回模型内部参数。

HPC 只负责训练、评估和导出模型。GitHub 保存源代码、测试和容器配置，不保存权重、私有下载地址、API Token、客户图片或真实环境文件。

## 模型制品

批准的模型制品只能通过以下方式进入推理容器：

- 将已批准的 `.tar.gz` 压缩包作为只读卷挂载到 `/models`。
- 从私有对象存储取得短期签名 URL，下载到部署环境的加密缓存卷。

不要把模型放入公开 Release、公开模型仓库、Git LFS 或普通 Git 历史。Pilot 和 Production 必须配置 `SHAREGUARD_BUNDLE_SHA256`；服务会在解压前校验压缩包，并从已批准归档重新生成解压缓存。已解压目录只允许用于本地开发模式。

## 本地静态与 Mock 验证

```powershell
$env:SHAREGUARD_MODE="local"
$env:SHAREGUARD_BACKEND="mock"
python -m shareguard.platform.app
```

打开 `http://127.0.0.1:7860`。Mock 结果只验证页面和接口，不代表真实检测结论。

## GitHub Pages 连接本机私有模型

公开仓库只包含 `shareguard/platform/static/runtime-config.js` 中的 HTTPS 网关地址。该地址不是凭证；用户名、密码、内部 API Token、模型路径和权重均不进入 Git。Pages 端的访问密码只保存在当前页面的 JavaScript 内存中，刷新或关闭页面后清除。

本机启动时将 Pages Origin 加入精确白名单：

```powershell
.\scripts\local\start_protected_platform.ps1 `
  -PasswordProtected `
  -Offline `
  -AllowedOrigin "https://shareguard.systems"

.\scripts\local\publish_quick_tunnel.ps1
```

Quick Tunnel 适合临时评审演示：本机、网关和 tunnel 进程必须保持运行，URL 会在 tunnel 重建后变化。获得新 URL 后，只更新 `runtime-config.js` 与页面 CSP 的 `connect-src`，不要提交 `secrets/`。长期试点应改用固定域名的命名 Tunnel 或云端私有网关。

浏览器的 CORS 预检不携带凭证，因此网关只对经过 Origin、路由、方法和请求头白名单检查的 `OPTIONS` 返回许可；实际 `/v1/ready` 与 `/v1/analyze` 仍要求鉴权。

## 私有试点容器

安全的环境变量模板位于 `deploy/shareguard.pilot.env.example`。真实的 `deploy/shareguard.pilot.env` 必须留在 Git 之外，并至少配置：

```text
SHAREGUARD_MODE=pilot
SHAREGUARD_BACKEND=fusion-bundle
SHAREGUARD_DEVICE=cuda
BUNDLE=/models/shareguard-noisyshare-fusion-v1.tar.gz
SHAREGUARD_MODEL_CACHE=/cache/models
SHAREGUARD_BUNDLE_SHA256=<approved-archive-sha256>
SHAREGUARD_API_TOKEN=
SHAREGUARD_ALLOWED_ORIGINS=
```

试点工作台应放在身份访问网关之后。浏览器不保存机器 API Token；需要机器调用时再配置 `SHAREGUARD_API_TOKEN`。

`SHAREGUARD_MODEL_DIR` 指向包含批准压缩包的本机私有目录。Compose 只把服务发布到 `127.0.0.1`，应由同机访问网关代理给评委或试点客户：

```powershell
$env:SHAREGUARD_MODEL_DIR="C:\private\ShareGuard_models"
docker compose -f deploy/docker-compose.pilot.yml up --build
```

容器以非 root 用户运行，模型归档只读挂载，根文件系统只读，解压和公开 backbone 缓存写入独立 `/cache` 卷，健康检查使用 `/v1/ready`。Compose 请求一张 NVIDIA GPU；宿主机需安装 NVIDIA 驱动和 Container Toolkit。`SHAREGUARD_DEVICE=cuda` 会在GPU不可用时直接启动失败，避免演示环境静默退回慢速CPU。

## 私有签名地址模式

需要在云端启动时拉取压缩包，可使用：

```text
SHAREGUARD_MODE=production
SHAREGUARD_BACKEND=fusion-bundle
BUNDLE_URL=<short-lived-private-url>
SHAREGUARD_BUNDLE_SHA256=<approved-archive-sha256>
SHAREGUARD_MODEL_CACHE=/cache/models
SHAREGUARD_API_TOKEN=<machine-token>
```

下载先进入临时文件，摘要验证通过后才会原子替换 `/cache/models` 中的缓存制品。CLIP 与 DINOv2 的公开 backbone 也使用 `/cache`；无外网部署需预先填充该缓存卷。

## API

新接入使用：

```http
POST /v1/analyze
Authorization: Bearer <token>
Content-Type: multipart/form-data

field: image
```

平台返回 `allow`、`review` 或 `hold` 三种业务决策，以及风险、置信度、不确定性、处置建议和报告。兼容接口 `/api/analyze` 暂时保留，并返回 `Deprecation: true`。

服务不会返回内部路径、融合参数、阈值、逐子模型分数或原始预测字典。结果是发布风险辅助信号，不是司法鉴定或真实性证书。

## 隐私与运行边界

- 本地 Python 推理服务默认只在内存中处理图片，不持久化原图。
- 正式 Cloudflare 控制面会在推理成功后，以 AES-256-GCM 加密新案件媒体并写入私有 R2；Durable Object 只保存摘要、密文托管元数据、结果和审计事件。
- 正式浏览器只通过鉴权 Worker 取回媒体，并在显示前重新计算 SHA-256；R2 bucket 不公开，媒体密钥与审查链接签名密钥只存在于 Cloudflare Secret。
- 受限审查链接按单一案件授权、可设置期限并可即时撤销；审查者不能读取案件队列、修改工作流、作出最终决定、签封或删除案件。
- 默认禁止跨域；只有精确命中 `SHAREGUARD_ALLOWED_ORIGINS` 才返回 CORS 许可头，预检不会绕过实际接口鉴权。
- 单图默认上限 10 MiB、2500 万像素，仅接受 JPEG、PNG 和 WebP。
- GPU 默认只并行执行一个推理任务，等待队列默认最多八个请求。
- HTTP 请求线程默认最多十六个，避免图片解码流量无限创建线程。
- `/v1/health` 只表示进程存活，`/v1/ready` 表示模型服务可接收任务。
- 日志只记录请求 ID、状态和错误类别，不记录图片内容、Token 或模型内部输出。

正式控制面的 P0 配置还必须包含 `MEDIA_BUCKET`、`MEDIA_ENCRYPTION_KEY_B64`、`REVIEW_TOKEN_SECRET` 与 `MEDIA_CUSTODY_REQUIRED=true`。轮换媒体密钥前，先将仍在保留期内的旧版本密钥写入仅用于解密的 `MEDIA_DECRYPTION_KEYS_JSON` secret，再同时更新当前密钥和 `MEDIA_ENCRYPTION_KEY_VERSION`。密钥只能通过 `wrangler secret put` 安装，不得写入 `wrangler.toml`、环境模板、GitHub Actions 日志或仓库历史。

删除验收必须覆盖三类故障：R2 删除失败时案件保持冻结且可重试；R2 已清理但 Durable Object 提交失败时再次删除能够幂等完成；提交成功但客户端未收到响应时，后续重试通过最小墓碑返回成功。禁止直接绕过 `delete-plan` / `delete-commit` 协议删除 Durable Object 案件记录。

既有案件的新增版本必须先取得 Durable Object 上传预留再写入 R2。上线验收还要模拟案件提交失败与 R2 清理失败的组合，确认遗留对象转为 `cleanup_required`，签封会先清理它，删除计划也会包含它；任何活动预留都必须使签封和删除返回可重试的冲突响应。

还必须模拟 Durable Object 已提交但响应损坏，以及 R2 已删除但预留释放响应失败：前者应从案件状态恢复成功且不得删除已提交媒体；后者必须保留 `cleanup_required` 并允许后续签封或两阶段删除继续收敛。

若监控发现案件长期保留 `active` 上传预留，所有者使用 `POST /v1/cases/{case_id}/ingest-recovery` 收敛，不得直接编辑 Durable Object。验收应确认该路由保留已提交媒体、清理未提交对象、释放预留，并且审查 token 调用时返回拒绝。

## 上线前检查

```powershell
python -m unittest discover -s tests -v
git diff --check
git ls-files | rg "(model_artifacts|\.pt$|\.pth$|\.ckpt$|\.safetensors$|\.tar\.gz$|\.pem$|\.env$)"
```

最后一条命令不应列出任何真实模型或秘密文件。文档中的文字引用不等于制品被跟踪，应结合完整路径复核。

## Modal Serverless 生产入口

需要摆脱本机常驻推理时，使用 `deploy/modal/shareguard_modal.py` 在私有 Modal
Volume 上运行真实模型，并通过流式 Cloudflare Worker 接入固定 API 域名。
逐步上线、真实图片验收、比赛前预热、scale-to-zero 与 Named Tunnel 回滚命令
统一维护在 `deploy/MODAL_SERVERLESS.md`。
