# ShareGuard Modal Serverless 上线手册

本手册把真实 ShareGuard 融合模型部署到 Modal T4，并由 Cloudflare Worker
在 `https://api.shareguard.systems` 提供稳定入口。GitHub 只保存代码和部署契约；
模型归档、Modal Token、HTTP Basic 凭据和实际 Modal URL 均不得提交。

## 0. 上线边界

- 保留现有 Named Tunnel，直到 Modal 直连和 Worker 预览均完成真实图片推理。
- 模型只上传到私有 Modal Volume，不进入 Git、GitHub Release 或容器镜像。
- Worker 不读取上传内容，不缓存响应，只流式转发两个公开 API 路径。
- `api.shareguard.systems` 切换前记录现有 Tunnel、DNS 和启动方式。
- 所有命令都从仓库根目录执行；PowerShell 会话结束后清除进程环境变量。

## 1. 安装并授权 Modal

```powershell
py -3.11 -m venv .venv-modal
.\.venv-modal\Scripts\python.exe -m pip install --upgrade pip
.\.venv-modal\Scripts\python.exe -m pip install -r requirements-modal.txt

.\.venv-modal\Scripts\python.exe -m modal token info
```

如果最后一条命令提示没有有效身份，执行浏览器授权，再复查：

```powershell
.\.venv-modal\Scripts\python.exe -m modal token new --verify
.\.venv-modal\Scripts\python.exe -m modal token info
```

不要运行会显示未脱敏 Token 的诊断命令，也不要把 Modal 配置复制进仓库。

## 2. 创建私有 Volume

```powershell
.\.venv-modal\Scripts\python.exe -m modal volume create shareguard-models
.\.venv-modal\Scripts\python.exe -m modal volume create shareguard-backbone-cache
```

如果 Volume 已存在，先用 `modal volume list` 确认名称，不删除现有内容。
`shareguard-models` 在推理容器中只读挂载；公开 backbone 下载缓存写入独立
`shareguard-backbone-cache`。

## 3. 创建运行 Secret

新建被 `.gitignore` 排除的 `deploy/modal/.env`，只写入以下三项：

```dotenv
SHAREGUARD_BUNDLE_SHA256=9f48b64d4a90a0ae815711f2769216e16fac990e45114d3ed5256e536aeb5d82
SHAREGUARD_HTTP_BASIC_USERNAME=
SHAREGUARD_HTTP_BASIC_PASSWORD=
```

不要同时设置 `SHAREGUARD_API_TOKEN`，因为它与 HTTP Basic 共用
`Authorization` 请求头。请在本机填入现有演示用户名与至少 20 位的私有密码，
再将文件装入 Modal Secret：

```powershell
.\.venv-modal\Scripts\python.exe -m modal secret create shareguard-production `
  --from-dotenv deploy/modal/.env `
  --force
```

## 4. 校验并上传模型

安全制品应位于本机被忽略的 `model_artifacts` 目录，或使用同一文件的绝对路径。
上传器先校验 SHA-256、归档路径、manifest 和全部 safetensors 检查点，再调用
Modal；它不会在本机解压或执行模型内容。

```powershell
$Archive = (Resolve-Path `
  "model_artifacts\shareguard-noisyshare-fusion-v1-safe.tar.gz").Path
$Digest = "9f48b64d4a90a0ae815711f2769216e16fac990e45114d3ed5256e536aeb5d82"

.\.venv-modal\Scripts\python.exe scripts/modal/upload_private_bundle.py `
  --archive $Archive `
  --sha256 $Digest `
  --volume shareguard-models `
  --remote-name shareguard-noisyshare-fusion-v1-safe.tar.gz
```

上传后只核对文件名与大小，不下载或公开 Volume 内容：

```powershell
.\.venv-modal\Scripts\python.exe -m modal volume ls shareguard-models
```

## 5. 部署并直连验证 Modal

```powershell
.\.venv-modal\Scripts\python.exe -m modal deploy deploy/modal/shareguard_modal.py
```

把命令返回的 HTTPS Web Server origin 临时放入当前 PowerShell 进程，不写文件：

```powershell
$env:MODAL_ORIGIN = Read-Host "Modal HTTPS origin"
```

从本地 Secret 文件加载 Basic 凭据到当前进程；以下代码不会打印值：

```powershell
Get-Content deploy/modal/.env | Where-Object {
  $_ -match '^[A-Za-z_][A-Za-z0-9_]*='
} | ForEach-Object {
  $Name, $Value = $_ -split '=', 2
  [Environment]::SetEnvironmentVariable($Name, $Value, 'Process')
}
```

使用仓库内真实示例图验证匿名 `401`、鉴权就绪、真实推理和响应脱敏：

```powershell
.\.venv-modal\Scripts\python.exe scripts/modal/verify_cloud_endpoint.py `
  --base-url $env:MODAL_ORIGIN `
  --image shareguard/platform/static/assets/flagship-event.jpg
```

只有命令输出 `ready_latency_ms`、`inference_latency_ms`、`model_version` 和
`decision` 四个字段且退出码为 0，才进入下一步。

## 6. 部署 Worker 预览

```powershell
npm install --prefix deploy/cloudflare-worker
npm test --prefix deploy/cloudflare-worker
Push-Location deploy/cloudflare-worker
npx wrangler login
npx wrangler secret put MODAL_ORIGIN --config wrangler.preview.toml
npx wrangler deploy --config wrangler.preview.toml
Pop-Location
```

在 `wrangler secret put MODAL_ORIGIN` 的交互提示中粘贴 Modal origin。该值作为
Cloudflare 加密 Secret 保存，不得加入 `wrangler.toml`。把部署返回的
`workers.dev` origin 临时保存并运行同一验证：

Cloudflare 账户首次发布 Worker 时可能要求注册免费的 `workers.dev` 子域名。
在 Dashboard 打开 **Workers & Pages** 完成一次初始化后重新部署即可；该步骤不
购买套餐，也不会修改 `shareguard.systems` 的 DNS。预览使用独立的
`shareguard-api-gateway-preview` Worker，不会提前接管正式 API 域名。

```powershell
$env:WORKER_ORIGIN = Read-Host "Worker HTTPS origin"
.\.venv-modal\Scripts\python.exe scripts/modal/verify_cloud_endpoint.py `
  --base-url $env:WORKER_ORIGIN `
  --image shareguard/platform/static/assets/flagship-event.jpg
```

再确认 CORS 预检与拒绝来源：

```powershell
Invoke-WebRequest -Method Options `
  -Uri "$env:WORKER_ORIGIN/v1/analyze" `
  -Headers @{
    Origin = "https://shareguard.systems"
    "Access-Control-Request-Method" = "POST"
    "Access-Control-Request-Headers" = "authorization, content-type"
  }

try {
  Invoke-WebRequest -Uri "$env:WORKER_ORIGIN/v1/ready" `
    -Headers @{ Origin = "https://untrusted.example" }
  throw "Untrusted origin was not rejected"
} catch {
  if ($_.Exception.Response.StatusCode.value__ -ne 403) { throw }
}
```

## 7. 比赛前预热与恢复按需计费

部署函数名是 `serve`。路演前将最小容器数临时设为 1，并运行一次验证器：

```powershell
@'
import modal
function = modal.Function.from_name("shareguard-private-inference", "serve")
function.update_autoscaler(min_containers=1)
'@ | .\.venv-modal\Scripts\python.exe -
```

确认演示结束后立即恢复 scale-to-zero：

```powershell
@'
import modal
function = modal.Function.from_name("shareguard-private-inference", "serve")
function.update_autoscaler(min_containers=0)
'@ | .\.venv-modal\Scripts\python.exe -
```

代码还将 `max_containers=1`、`scaledown_window=300` 固定在部署契约中，避免演示
流量意外扩容。重新部署会恢复代码中声明的 autoscaler 设置。

## 8. 切换固定域名

先保留 `api.shareguard.systems` 当前指向 Named Tunnel 的橙云 DNS 记录。Worker
Route 会在到达 Tunnel 前接管请求，因此既不需要公开 Modal origin，也保留快速
回滚能力。

在 Modal 直连和 Worker 预览均通过后执行：

```powershell
Push-Location deploy/cloudflare-worker
npx wrangler secret put MODAL_ORIGIN
npx wrangler deploy
Pop-Location

.\.venv-modal\Scripts\python.exe scripts/modal/verify_cloud_endpoint.py `
  --base-url https://api.shareguard.systems `
  --image shareguard/platform/static/assets/flagship-event.jpg
```

正式 `wrangler.toml` 已固定 `api.shareguard.systems/*` 路由，并关闭默认
`workers.dev` 与部署预览 URL；Modal origin 只存在于 Cloudflare Secret 中。
原 Named Tunnel 的橙云 DNS 记录继续保留，作为不改 DNS 的回滚入口。

随后在 `https://shareguard.systems` 完成一次浏览器上传，确认页面显示真实判定且
网络响应没有 `alpha_clip_l`、`group_scores`、`checkpoint`、`model_artifacts`
或 `raw` 字段。

## 9. 断开本机后的验收

固定域名验证通过后再停止本地模型、网关和 cloudflared：

```powershell
.\scripts\local\stop_protected_platform.ps1

Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
  Where-Object LocalPort -In 7860, 7861

.\.venv-modal\Scripts\python.exe scripts/modal/verify_cloud_endpoint.py `
  --base-url https://api.shareguard.systems `
  --image shareguard/platform/static/assets/flagship-event.jpg
```

端口查询应无输出，而固定域名推理仍应成功。至此网站不再依赖本机开机。

## 10. 回滚到 Named Tunnel

1. 先重新启动切换前保存的本地 ShareGuard 与 Named Tunnel 配置，并用本机
   `127.0.0.1:7860/v1/ready` 验证其就绪。
2. 在 Cloudflare Dashboard 的 Worker `shareguard-api-gateway` 中打开
   **Settings > Domains & Routes**，删除 `api.shareguard.systems/*` Worker Route。
3. 不删除原有 Tunnel DNS 记录；Route 删除后流量会重新落到 Named Tunnel。
4. 验证 `https://api.shareguard.systems/v1/ready` 和一次真实图片上传。
5. 排查云端问题期间保留 Modal Volume，不要重新上传未知模型包。

使用仓库现有脚本恢复 Access 保护的本地基线时：

```powershell
.\scripts\local\start_protected_platform.ps1 `
  -AccessProtected `
  -Offline `
  -AllowedOrigin "https://shareguard.systems"
.\scripts\local\publish_cloudflare_tunnel.ps1 -AccessPolicyConfirmed
```

若切换前使用的是 HTTP Basic 模式，必须沿用已记录的 Basic 启动参数和同一凭据，
不要在事故处理中临时更换浏览器认证方式。

## 11. 收尾

```powershell
Remove-Item Env:MODAL_ORIGIN -ErrorAction SilentlyContinue
Remove-Item Env:WORKER_ORIGIN -ErrorAction SilentlyContinue
Remove-Item Env:SHAREGUARD_HTTP_BASIC_USERNAME -ErrorAction SilentlyContinue
Remove-Item Env:SHAREGUARD_HTTP_BASIC_PASSWORD -ErrorAction SilentlyContinue

git status --short
git ls-files | rg "(model_artifacts|\.safetensors$|\.tar\.gz$|\.env$)"
```

最后一条命令不得列出真实模型或 Secret 文件。`deploy/modal/.env` 必须始终保持
未跟踪状态。
