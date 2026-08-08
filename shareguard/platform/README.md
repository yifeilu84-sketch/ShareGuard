# ShareGuard Platform 接入说明

ShareGuard 将图像级筛查信号接入真实的媒体发布与证据复核流程，输出三种机器建议：

- `allow`：可进入后续发布流程；
- `review`：需要结合来源材料进行人工复核；
- `hold`：建议暂缓发布并进一步取证。

模型分数是技术辅助信号，不是“图片为 AI 生成的事实概率”，也不替代人工决定、司法鉴定或法律结论。当前在线检测器、私有研究模型与比赛结果的边界见 `docs/model-disclosure.md`。

## 正式工作台 P0

`shareguard/platform/static/` 是空白启动的正式工作台，只接受真实 `/v1` 响应。当前 P0 已落地：

- 持久案件雷达：案件状态、优先级、负责人、SLA、任务、筛选、分页与自动刷新；
- 私有媒体托管：新案件原件先以 AES-256-GCM 加密，再写入私有 R2；浏览器取回后重新核对 SHA-256；
- 真实版本比较：只比较同一案件中实际上传的原件与观察版本，不生成或伪装传播版本；
- 来源证据图谱：仅使用上传版本和人工提交的关系，明确区分 `DIGEST VERIFIED` 与 `DECLARED / UNVERIFIED`；
- 受控协作：案件所有者可签发有期限、可撤销、仅限单一案件的审查链接；审查者只能查看媒体、评论和提交人工框选标注；
- 正式处置：人工决定、依据、反馈和每次变更均写入哈希链接审计链；
- `.sgd` v3：服务器签名的案件快照、事件链、来源图谱、媒体清单和符合上限的内嵌媒体；浏览器可选择本地口令加密，并可离线验证。

组织级 RBAC、SSO/MFA、KMS/HSM、外部可信时间戳、模型漂移治理和面向第三方平台的托管审核 API 属于 P1，本版本不宣称已经提供。

## 演示与生产边界

- `public_demo/`：独立静态案例，只用于讲解产品流程；
- `shareguard/platform/static/`：正式工作台，不回填静态结论，不接受 `mock` 或 `X-ShareGuard-Demo` 响应；
- 当前在线服务：通过 Cloudflare Worker 访问受保护推理源站，检测器详情与第三方许可在 `docs/model-disclosure.md` 和 `THIRD_PARTY_NOTICES.md` 中披露；
- 私有研究模型：权重、融合参数、阈值、模型归档和私有下载地址不进入 GitHub、Pages 或浏览器。

正式界面不会伪造模型定位框、图像重建、传播拓扑或已验证来源。界面中的框选区域只能来自人工审查标注。

## 正式 API

推理与案件：

- `GET /v1/health`
- `GET /v1/ready`
- `POST /v1/analyze`
- `GET /v1/cases`
- `GET|DELETE /v1/cases/{case_id}`
- `POST /v1/cases/{case_id}/workflow`
- `POST /v1/cases/{case_id}/decision`
- `POST /v1/cases/{case_id}/feedback`
- `POST /v1/cases/{case_id}/provenance`
- `POST /v1/cases/{case_id}/annotations`
- `POST /v1/cases/{case_id}/comments`
- `GET /v1/cases/{case_id}/versions/{version_id}/media`

协作与证据：

- `POST /v1/cases/{case_id}/review-grants`
- `POST /v1/cases/{case_id}/review-grants/{grant_id}/revoke`
- `GET /v1/review/case`
- `GET /v1/review/media/{version_id}`
- `POST /v1/review/comments`
- `POST /v1/review/annotations`
- `POST /v1/cases/{case_id}/seal`
- `GET /v1/trust-root`

正式所有者路由使用受保护的 Basic 凭据。受控审查路由使用短时 Bearer token；token 只放在链接 fragment 中，页面读取后立即从可见 URL 与浏览器历史状态移除，并只保存在当前页面内存。

## 私有媒体与密钥

Cloudflare Worker 生产配置必须提供：

- `MEDIA_BUCKET`：私有 R2 binding；
- `MEDIA_ENCRYPTION_KEY_B64`：32 字节随机媒体加密密钥，Cloudflare Secret；
- `REVIEW_TOKEN_SECRET`：审查链接 HMAC 密钥，Cloudflare Secret；
- `SGD_SIGNING_PRIVATE_JWK`：证据包签名私钥，Cloudflare Secret；
- `MEDIA_CUSTODY_REQUIRED=true`：媒体无法加密持久化时，分析请求失败关闭。

这些值不得写入 Git、`wrangler.toml`、前端运行时配置或构建日志。R2 对象不公开；删除未签封案件时，同时删除对应密文对象。历史摘要-only案件仍可打开元数据与审计链，也可重新关联 SHA-256 匹配的本地原件。

## 本地开发

Mock 仅用于页面、API 和自动化测试：

```powershell
$env:SHAREGUARD_MODE="local"
$env:SHAREGUARD_BACKEND="mock"
python -m shareguard.platform.app
```

访问 `http://127.0.0.1:7860`。Mock 结果不代表真实检测结论。

本地私有 bundle 开发：

```powershell
$env:SHAREGUARD_MODE="local"
$env:SHAREGUARD_BACKEND="fusion-bundle"
$env:BUNDLE="C:\private\ShareGuard_models\shareguard-noisyshare-fusion-v1"
python -m shareguard.platform.app
```

Pilot 与 Production 的私有模型归档必须在解压前校验 `SHAREGUARD_BUNDLE_SHA256`，并放在 Git 之外。完整部署说明见 `docs/platform_github_deployment.md`、`deploy/MODAL_SERVERLESS.md` 和 `deploy/cloudflare-worker/README.md`。

## 上线验证

```powershell
python -m unittest discover -s tests -v
python tests/run_production_workbench_e2e.py
cd deploy/cloudflare-worker
npm test
npx wrangler deploy
```

上线前还需确认仓库不包含模型权重、`.env`、私钥、媒体加密密钥、审查密钥、真实用户媒体或私有推理源站地址。
