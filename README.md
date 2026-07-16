# GEO SaaS

面向多租户、多行业的 GEO 内容治理与 AI 可见性评测平台。首个行业包是旅游，首个租户是中通国际旅行社（24 小时热线 `4001133986`，微信 `ZTGL3411` / `ZTGL6431`）；通用数据模型不把旅行社字段写死，后续行业通过策略包、事实与查询集扩展。

系统把生成、审计、授权和投放分开：Pi/Agent 只能提出动作，确定性服务负责事实校验、租户授权、不可变审计、一次性发布许可、outbox 与 Kill Switch。默认头条号、搜狐号、携程社区仍使用 `DryRunConnector`，没有已验证的普通公开发文 API；经书面授权、账号证据复核和精确租户/账号映射后，携程 `assisted` 请求只能自动创建内部人工接管 handoff，不会操作浏览器或声称已发布。豆包/千问只有 fixture 和人工导入评测，Google 排名不能作为它们的代理指标。

全部 `unattended` 和非携程 `assisted` 发布请求会在治理评估或创建 job 前被确定性拒绝。合格的携程 `assisted` 请求会经过 Plastic Promise、数据库账号证据、审计、控制面和熔断器复核，再由 Worker 生成确定性预览并创建 durable handoff；handoff 不是回执或发布确认。passed 且未过期的审计仍可导出独立人工发布包；该包固定标记 `requiresManualAction=true`、`publicationStatus=not_published`，不会触发外部发送。

图片生产默认由 `GEO_MEDIA_PROVIDER=disabled` 关闭；唯一可启用的 `fixture` provider 只生成确定性 PNG，用于验证 VisualBrief、事实绑定、OCR/版权/来源审计、内容寻址存储和 successor 内容版本，不是可投放的生产图片，也不访问网络。带图的人工发布包会附带 `media-manifest.json` 和逐字节校验的 base64 附件；真实生图 provider 仍未实现，`live` 配置会在启动时被拒绝。

Compose 中的 `agent-mcp` 进程同时提供认证的 `POST /agent/runs` 和可显式启用的后台自动化 Producer。Producer 按租户身份轮询持久化批次，使用租约、心跳和断点恢复执行“生成 -> 确定性审计 -> Dry-run 预演 -> 回执回读”；一个租户身份失败不会阻塞其他租户。默认 `AGENT_PROVIDER=fixture` 使用确定性的 `FixturePiAgentRunService`；Pi 注册表中的 provider/model，或显式配置为 `openai-compatible` 且实现 OpenAI Responses 协议的 HTTPS 端点，在 secret 注入 `AGENT_API_KEY` 后可启动 `RealPiAgentRunService`。真实 Pi 只改变模型编排方式，仍受静态 GEO/治理工具白名单、租户权限和确定性发布门禁约束，不会凭空获得头条/搜狐/携程发文 API 或豆包/千问真实搜索 API。

## 当前能力边界

| 能力                        | 当前状态                                              | 不能据此宣称                                 |
| --------------------------- | ----------------------------------------------------- | -------------------------------------------- |
| PostgreSQL 多租户数据与 RLS | 已实现，需真实 PostgreSQL 验证                        | 单元测试等于生产隔离证明                     |
| 租户会话与切换              | 登录后列出成员租户并重签租户会话                      | 一个会话可跨租户访问                         |
| 自动化控制与急停            | 租户模式、五维配额、Kill Switch、撤权和排队取消已实现 | 模式变更会提升平台能力或停止已发出的外部请求 |
| 发布前审计与一次性 grant    | 已实现确定性路径                                      | 模型可自行批准发布                           |
| 图文生产与附件导出          | 默认关闭；fixture 可验证完整性与审计链                | 已接入真实生图 API 或图片可直接生产投放      |
| GEO 文章模板目录            | 21 套共享 V1 模板贯通 Web、HTTP API、Pi 与 MCP        | 模板可绕过事实、策略或最终变体审计           |
| Brand Agent Profile         | 品牌级不可变版本贯通 Web、HTTP API、Pi、MCP 与审计    | Profile 是事实来源或可绕过正文闭合与审计     |
| 头条/搜狐/携程连接器        | 默认 `DRY_RUN`；携程可创建受审计的 `assisted` handoff | 已发文、公开 API、浏览器已接通或无人值守投放 |
| 豆包/千问可见性             | fixture + manual import                               | 已调用真实产品搜索或可等同 Google            |
| 品牌记忆正负反馈闭环        | 未纳入第一版；当前只保留显式治理上下文                | 系统会依据文章或审计结果自动改写长期记忆     |
| GEO MCP                     | 11 个静态白名单工具                                   | 任意 MCP 工具访问或 Pi 内建 MCP              |
| Pi Agent 与批次 Producer    | Web 实时入口 + 多租户服务端网关；固定 Dry-run         | bearer 已下发浏览器、已实发或绕过审计        |
| Operator 登录               | 显式一次性 bootstrap CLI                              | `db:seed` 后可直接登录或存在共享默认密码     |

`db:seed` 创建两个隔离租户、政策、渠道和 fixture 数据，但 seed 用户是 `disabled`，密码字段为 `seed-disabled`。这是安全默认值，不是演示账号。生产客户不走 seed：先按 [Tenant and Operator Provisioning](docs/ops/operator-provisioning.md) 执行 admin-only `db:provision:tenant`，合并输出的 worker 映射，再对已创建 slug 执行独立的 `db:bootstrap:operator`。租户 owner API 无权跨租户创建客户。

`db:provision:tenant` 会在同一事务中创建 active `baseline-v1` 审计策略、active 豆包/千问基准 query set/version 和初始 active Brand Agent Profile，并把策略、查询集、Profile ID 与 Profile 文档哈希写入不可变 receipt。它不会创建平台凭据、真实发布能力或真实模型搜索调用。

## Pi Agent 运行入口

运营台调用 `GET /api/agent/capability` 和 `POST /api/agent/runs`。两者使用普通租户 Session；写请求必须通过 CSRF，浏览器不会持有 MCP bearer。API 只从 `AGENT_GATEWAY_CREDENTIALS_JSON` 按当前 Session 的 tenant UUID 选择一个 token，再通过 loopback 调用 `agent-mcp`。未配置当前租户、Agent 服务不可用、并发冲突、provider 失败和超时都 fail closed；返回内容刷新文章工作区，但不会把 preview 表示成实发。

`POST /agent/runs` 与 `/mcp` 共用 `MCP_PRINCIPALS_JSON` bearer 身份、Host/Origin 白名单和 1 MiB 请求上限，并要求显式 `Content-Length`、拒绝 transfer encoding。同一租户与操作者组合同时只能运行一个请求；并发请求返回 `409 AGENT_RUN_ACTIVE`。run 默认限时 120 秒，可用 `AGENT_RUN_TIMEOUT_MS` 在 1 秒到 15 分钟内调整；超时返回 `504` 并中止 Pi loop，在底层任务真正结束前不会释放并发锁。

- fixture 模式接受 `{ workflow: "draft_to_publication", tenantId, brandId, campaignId, channelAccountId, platform, topic, articleTemplateId?, idempotencyKey }`，并把执行级别固定为 `dry_run`。Web 网关始终提交客户选择的模板；省略模板只为旧自动化调用保留兼容。
- 真实 Pi 模式接受 `{ workflow: "prompt", prompt, brandId? }`。提供 `brandId` 时，服务在模型调用前读取该品牌的 active Profile，把 Profile ID、版本、哈希和结构化文档注入 system prompt；缺失、跨品牌或非 active Profile 会 fail closed。模型仍只能调用静态白名单工具，Profile 也不能绕过事实、闭合正文、确定性审计或发布边界。

后台批次由 `AUTOMATION_PRODUCER_ENABLED` 显式开启。标准 `.env.example` 将它设为 `true`，因为本 MVP 的无人值守范围只覆盖 Dry-run 链；删除该变量或直接运行进程时仍默认关闭。`AUTOMATION_PRODUCER_ID` 应在重启间保持稳定，并发最多 16。Producer 只使用 `MCP_PRINCIPALS_JSON` 中具备 `automation:execute` 的租户身份，所有 claim、heartbeat、checkpoint 和 reconcile 都再次经过 API 权限、租户状态、Campaign 状态、Kill Switch 与 circuit gate。`GET /health/live` 返回不含凭据的 Producer 状态。

完整请求示例、响应与两阶段发布审计说明见 [GEO MCP 与证据边界](docs/api/mcp-tools.md)。

## Compose 启动

要求 Docker Engine 与 Docker Compose v2。仓库锁定 Node、pnpm、Nginx 和 PostgreSQL 版本/镜像 digest；当前开发机没有可用 Docker，因此 Compose 仅完成静态解析，真实镜像 build/up 仍是部署门禁。

```powershell
Copy-Item .env.example .env
# 替换所有 replace-* 值，把 APP_ORIGIN/MCP_ALLOWED_* 改为真实 HTTPS 域名，
# 为每个自动化租户配置具备 automation:execute 的专用 MCP principal，
# 并确保 PLASTIC_PROMISE_MCP_URL 已从 API 容器可达。
docker compose config --quiet
docker compose up -d --build
docker compose ps --all
```

Plastic Promise MCP 是 API 与 `agent-mcp` 的必需外部治理依赖。两者在绑定端口前分别建立连接；端点不可达或握手失败时对应进程不会提供服务并由 Compose 重启，发布时治理调用失败也会 fail closed。非 loopback 端点必须使用 HTTPS，可选授权头只通过 `PLASTIC_PROMISE_MCP_AUTHORIZATION` secret 注入。

启动链为 `Plastic Promise(外部) + postgres -> db-migrate -> db-bootstrap -> api/worker -> agent-mcp/web`。`db-seed` 属于显式 `fixture-seed` profile，不在生产重启链中；它会写入示例租户并重置示例自动化控制，只能在全新演示数据库上按需执行：`docker compose --profile fixture-seed run --rm db-seed`。默认只绑定 `127.0.0.1`：web `4173`、API `4100`、MCP `9021`。生产 API 强制 Secure Cookie，必须由外部 TLS 入口访问；直接 HTTP 端口只用于本机健康诊断，不能作为登录入口。

携程 bridge 默认不启动，API 也不配置 gateway。仅本地仿真时，先在 `.env` 同时设置 `CTRIP_BRIDGE_GATEWAY_URL`、`CTRIP_BRIDGE_GATEWAY_CREDENTIALS_JSON` 与 `CTRIP_BRIDGE_TENANTS_JSON`，确保两个 JSON 使用同一租户 token 和已激活的 `ctrip_bridge` principal，再显式运行 `docker compose --profile ctrip-simulator up -d --build`。该 profile 只加载 `ctrip-community-simulator-v1`，与 API 共享 loopback 网络命名空间，没有真实携程适配器或外部发布能力；仿真 readback 只能进入 `needs_review`。

```powershell
Invoke-RestMethod http://127.0.0.1:4100/health/live
Invoke-RestMethod http://127.0.0.1:4100/health/ready
Invoke-RestMethod http://127.0.0.1:9021/health/live
Invoke-WebRequest http://127.0.0.1:4173/healthz
```

Redis 和 MinIO 不在 Compose 中，因为当前源码没有消费它们。只有在限流/队列或对象存储适配器落地并有契约测试后，才应作为可选 profile 引入。

## 本地开发

- Node.js `24.x`
- pnpm `10.32.1`
- PostgreSQL `16+`

应用不会自动加载 `.env`；直接运行 pnpm 命令时需在 shell 中显式设置数据库 URL 和服务变量。

```powershell
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm test

# 完整 MVP 交付门禁（含 PostgreSQL、后端与浏览器 E2E）
pnpm verify:mvp
```

## 文档

- [生产部署](docs/ops/deployment.md)
- [备份与恢复](docs/ops/backup-restore.md)
- [Kill Switch](docs/ops/kill-switch.md)
- [Operator Provisioning](docs/ops/operator-provisioning.md)
- [威胁模型](docs/security/threat-model.md)
- [HTTP API](docs/api/http-api.md)
- [GEO MCP 与证据边界](docs/api/mcp-tools.md)
- [Brand Agent Profile 设计](docs/superpowers/specs/2026-07-16-brand-agent-profile-design.md)
- [平台 API Onboarding](docs/api/platform-onboarding.md)
- [MVP 设计](docs/superpowers/specs/2026-07-13-geo-saas-mvp-design.md)
- [典范分析](docs/superpowers/specs/engineering-patterns/2026-07-13-geo-agent-publishing.md)
