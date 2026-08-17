# GEO SaaS

生产拓扑采用“开发工作站 + 远程 Linux 运行主机”。开发工作站只执行源码检查和发布编排，不运行生产 Docker daemon；镜像构建、Compose 校验、迁移和容器操作均在通过 SSH 配置的 `geo-production-host` 上完成。接手与部署分别从 [工作站到 Linux 主机交接](docs/WORKSTATION_SERVER_HANDOFF.md) 和 [Linux 服务器部署](docs/SERVER_DEPLOYMENT.md) 开始，携程分阶段验收见 [携程生产验收手册](docs/CTRIP_PRODUCTION_RUNBOOK.md)。

仓库保留面向独立演示环境的 [演示环境使用说明](./演示环境使用说明.md) 和桌面启动器，但它们只用于 `customer_demo` 非生产路径，不属于 Linux 生产部署，也不得作为生产验收证据。

面向多租户、多行业的 GEO 内容治理与 AI 可见性评测平台。仓库内置的旅游行业数据仅为合成 fixture，例如“示例国际旅行服务”和合成演示联系方式；通用数据模型不绑定任何真实客户，后续行业通过策略包、事实与查询集扩展。

系统把生成、审计、授权和投放分开：Pi/Agent 只能提出动作，确定性服务负责事实校验、租户授权、不可变审计、一次性发布许可、outbox 与 Kill Switch。头条、搜狐、百家、网易和携程社区的外发都由账号能力矩阵决定：普通 `DryRunConnector` 或人工账号只能预演/交接，只有声明为 `browser_assisted`、支持 `unattended`、控制面为无人值守且运行时已认证的账号才会进入批量发送池。任何账号能力都必须经过数据库门禁和公开回读证据，不会因容器健康或修改环境变量就声称已发布。豆包/千问只有 fixture 和人工导入评测，Google 排名不能作为它们的代理指标。

`assisted` 与 `unattended` 请求不会绕过治理评估、账号控制、熔断、配额或公开回读要求。浏览器账号的批量发送必须同时满足平台能力、账号状态、`browser_assisted` 能力声明、无人值守控制和 `authenticated/ready` 会话条件；不满足时创建阶段直接返回具体阻断原因。携程仍采用 A/B/C 阶段证据链，其他平台沿用相同的 capability-gated browser 流程。任何 handoff、草稿或点击观察都不是公开发布回执，结果不确定时禁止自动重试。passed 且未过期的审计仍可导出独立人工发布包；该包固定标记 `requiresManualAction=true`、`publicationStatus=not_published`，不会触发外部发送。

图片生产默认由 `GEO_MEDIA_PROVIDER=disabled` 关闭；唯一可启用的 `fixture` provider 只生成确定性 PNG，用于验证 VisualBrief、事实绑定、OCR/版权/来源审计、内容寻址存储和 successor 内容版本，不是可投放的生产图片，也不访问网络。`fixture` 仅允许客户演示环境，外部/服务器部署会在启动时拒绝它。带图的人工发布包会附带 `media-manifest.json` 和逐字节校验的 base64 附件；真实生图 provider 仍未实现，未知 provider 配置会被 schema 拒绝。
携程社区账号变体遵循平台表达边界：正文和图片不放电话、微信、二维码等联系方式，联系方式只在允许的平台变体或租户资料中使用；标题和摘要不出现品牌，正文按平台规则控制品牌露出，避免重复推广。该规则在变体渲染、Pi 提示词和发布前审计三处同时生效。

Compose 中的 `agent-mcp` 进程同时提供认证的 `POST /agent/runs` 和可显式启用的后台自动化 Producer。Producer 按租户身份轮询持久化批次，使用租约、心跳和断点恢复执行“生成 -> 确定性审计 -> Dry-run 预演 -> 回执回读”；一个租户身份失败不会阻塞其他租户。默认 `AGENT_PROVIDER=fixture` 使用确定性的 `FixturePiAgentRunService`；Pi 注册表中的 provider/model，或显式配置为 `openai-compatible` 且实现 OpenAI Responses 协议的 HTTPS 端点，在 secret 注入 `AGENT_API_KEY` 后可启动 `RealPiAgentRunService`。真实 Pi 只改变模型编排方式，仍受静态 GEO/治理工具白名单、租户权限和确定性发布门禁约束，不会凭空获得头条/搜狐/携程发文 API 或豆包/千问真实搜索 API。

## 当前能力边界

| 能力                           | 当前状态                                                                                 | 不能据此宣称                                 |
| ------------------------------ | ---------------------------------------------------------------------------------------- | -------------------------------------------- |
| PostgreSQL 多租户数据与 RLS    | 已实现，需真实 PostgreSQL 验证                                                           | 单元测试等于生产隔离证明                     |
| 租户会话与切换                 | 登录后列出成员租户并重签租户会话                                                         | 一个会话可跨租户访问                         |
| 自动化控制与急停               | 租户模式、五维配额、Kill Switch、撤权和排队取消已实现                                    | 模式变更会提升平台能力或停止已发出的外部请求 |
| 发布前审计与一次性 grant       | 已实现确定性路径                                                                         | 模型可自行批准发布                           |
| 图文生产与附件导出             | 默认关闭；fixture 可验证完整性与审计链                                                   | 已接入真实生图 API 或图片可直接生产投放      |
| GEO 文章模板目录               | 21 套共享 V1 模板贯通 Web、HTTP API、Pi 与 MCP                                           | 模板可绕过事实、策略或最终变体审计           |
| Brand Agent Profile            | 品牌级不可变版本贯通 Web、HTTP API、Pi、MCP 与审计                                       | Profile 是事实来源或可绕过正文闭合与审计     |
| 头条/搜狐/百家/网易/携程连接器 | 由账号 capability、控制面、运行时会话和回读证据共同决定；未就绪账号保持 Dry-run/人工交接 | 已完成生产验收、已发文或已获无人值守授权     |
| 豆包/千问可见性                | fixture + manual import                                                                  | 已调用真实产品搜索或可等同 Google            |
| 品牌记忆正负反馈闭环           | 未纳入第一版；当前只保留显式治理上下文                                                   | 系统会依据文章或审计结果自动改写长期记忆     |
| GEO MCP                        | 11 个静态白名单工具                                                                      | 任意 MCP 工具访问或 Pi 内建 MCP              |
| Pi Agent 与批次 Producer       | Web 实时入口 + 多租户服务端网关；Producer 默认关闭                                       | 后台发布已启用、已实发或可绕过阶段门禁       |
| Operator 登录                  | 显式一次性 bootstrap CLI                                                                 | `db:seed` 后可直接登录或存在共享默认密码     |

`db:seed` 创建两个隔离租户、政策、渠道和 fixture 数据，但 seed 用户是 `disabled`，密码字段为 `seed-disabled`。这是安全默认值，不是演示账号。生产客户不走 seed：先按 [Tenant and Operator Provisioning](docs/ops/operator-provisioning.md) 执行 admin-only `db:provision:tenant`，合并输出的 worker 映射，再对已创建 slug 执行独立的 `db:bootstrap:operator`。租户 owner API 无权跨租户创建客户。

`db:provision:tenant` 会在同一事务中创建 active `baseline-v1` 审计策略、active 豆包/千问基准 query set/version 和初始 active Brand Agent Profile，并把策略、查询集、Profile ID 与 Profile 文档哈希写入不可变 receipt。它不会创建平台凭据、真实发布能力或真实模型搜索调用。

## Pi Agent 运行入口

运营台调用 `GET /api/agent/capability` 和 `POST /api/agent/runs`。两者使用普通租户 Session；写请求必须通过 CSRF，浏览器不会持有 MCP bearer。API 只从 `AGENT_GATEWAY_CREDENTIALS_JSON` 按当前 Session 的 tenant UUID 选择一个 token，再通过 loopback 调用 `agent-mcp`。未配置当前租户、Agent 服务不可用、并发冲突、provider 失败和超时都 fail closed；返回内容刷新文章工作区，但不会把 preview 表示成实发。

`POST /agent/runs` 与 `/mcp` 共用 `MCP_PRINCIPALS_JSON` bearer 身份、Host/Origin 白名单和 1 MiB 请求上限，并要求显式 `Content-Length`、拒绝 transfer encoding。同一租户与操作者组合同时只能运行一个请求；并发请求返回 `409 AGENT_RUN_ACTIVE`。run 默认限时 120 秒，可用 `AGENT_RUN_TIMEOUT_MS` 在 1 秒到 15 分钟内调整；生产示例为 Agent 900 秒、API 网关 910 秒，Web 仅对 `/api/agent/runs` 放宽到 920 秒。超时或浏览器断开会向下游传播取消；超时后在底层任务真正结束前不会释放并发锁。`GET /health/live` 的 `agentRuns.active` 可用于确认是否仍有活动运行。

- fixture 模式接受 `{ workflow: "draft_to_publication", tenantId, brandId, campaignId, channelAccountId, platform, topic, articleTemplateId?, idempotencyKey }`，并把执行级别固定为 `dry_run`。Web 网关始终提交客户选择的模板；省略模板只为旧自动化调用保留兼容。
- 真实 Pi 模式接受 `{ workflow: "prompt", prompt, brandId? }`。提供 `brandId` 时，服务在模型调用前读取该品牌的 active Profile，把 Profile ID、版本、哈希和结构化文档注入 system prompt；缺失、跨品牌或非 active Profile 会 fail closed。模型仍只能调用静态白名单工具，Profile 也不能绕过事实、闭合正文、确定性审计或发布边界。

后台批次由 `AUTOMATION_PRODUCER_ENABLED` 显式开启。批次创建默认 `dry_run`；显式 `unattended` 会按平台轮换账号池，并在仓储和数据库 target 插入边界双重要求账号具备 `browser_assisted`、无人值守控制和已认证运行时。标准 `.env.example` 和 Linux 生产 Compose 都将 Producer 设为 `false`；逐个平台启用仍必须以 canary 的公开回读和单独批准为依据。删除该变量或直接运行进程时同样默认关闭。`AUTOMATION_PRODUCER_ID` 应在重启间保持稳定，并发最多 16。Producer 只使用 `MCP_PRINCIPALS_JSON` 中具备 `automation:execute` 的租户身份，所有 claim、heartbeat、checkpoint 和 reconcile 都再次经过 API 权限、租户状态、Campaign 状态、Kill Switch 与 circuit gate。Pi 草稿阶段由 `AUTOMATION_DRAFT_TIMEOUT_MS` 单独限制，默认 10 分钟，避免模型响应体停滞时仍靠租约心跳无限占用运行槽位；超时会取消本次生成并进入幂等安全重试。`GET /health/live` 返回不含凭据的 Producer 状态。

完整请求示例、响应与发布治理审计说明见 [GEO MCP 与证据边界](docs/api/mcp-tools.md)。

## Linux 生产部署

开发工作站只负责源代码、非容器测试和通过 SSH 编排远程主机。Linux 生产主机 `geo-production-host` 需要提供 Docker Engine 与 Docker Compose v2；仓库锁定 Node、pnpm、Nginx、PostgreSQL 和 Browser Host 的版本或镜像 digest。

```bash
ssh geo-production-host '/srv/geo-saas/app/current/scripts/start-production.sh'
```

该入口只允许在生产 Secret、租户 principal、真实 Pi provider、外部治理依赖和持久目录全部就绪后使用。它会在 `geo-production-host` 上执行配置预检、构建镜像并启动服务；镜像构建成功本身不代表 Phase A 完成，更不代表携程已经提交。发布前必须按交接、部署和携程验收文档逐项核对。

Plastic Promise MCP 是 API 与 `agent-mcp` 的必需外部治理依赖。两者在绑定端口前分别建立连接；端点不可达或握手失败时对应进程不会提供服务并由 Compose 重启，发布时治理调用失败也会 fail closed。非 loopback 端点必须使用 HTTPS，可选授权头只通过 `PLASTIC_PROMISE_MCP_AUTHORIZATION` secret 注入。

启动链为 `Plastic Promise(外部) + postgres -> db-migrate -> db-bootstrap -> api/worker -> agent-mcp/web`。`db-seed` 属于显式 `fixture-seed` profile，不在生产重启链中；它会写入示例租户并重置示例自动化控制，只能在全新演示数据库上按需执行。Linux 生产的宿主机端口只绑定 `127.0.0.1` 的 `10000+` 端口；生产 API 强制 Secure Cookie，必须由外部 TLS 入口访问，直接 HTTP 端口只用于服务器本机健康诊断，不能作为登录入口。

生产携程 Bridge 默认以 `browser_draft` 启动，后台 Producer 默认关闭。Browser Host 使用服务器上的 headed Chromium + Xvfb 和租户独立持久 profile；原始 noVNC 端口只允许通过开发工作站到 `geo-production-host` 的 SSH 隧道访问，公网运营台则通过同源 HTTPS、会话鉴权和账号归属校验后的 `/ctrip-vnc/accounts/<account-id>/` 路由访问。Phase A 必须停在真实提交之前，Phase B/C 需要独立的用户批准和数据库证据。

## 独立演示环境（非生产）

桌面 Docker 启动器、PowerShell 脚本、`customer_demo` Compose profile 和 `ctrip-simulator` 仅用于隔离演示或仿真。它们不得用于 `geo-production-host` 生产部署，不得迁移生产 Cookie/Secret，也不能作为真实 Pi、真实携程提交、公开回读或 Phase A/B/C 的验收证据。具体操作见 [演示环境使用说明](./演示环境使用说明.md)。

Redis 和 MinIO 不在 Compose 中，因为当前源码没有消费它们。只有在限流/队列或对象存储适配器落地并有契约测试后，才应作为可选 profile 引入。

## 开发工作站（无生产 Docker）

- Node.js `24.x`
- pnpm `10.32.1`
- PostgreSQL `16+`

应用不会自动加载 `.env`；直接运行 pnpm 命令时需在 shell 中显式设置数据库 URL 和服务变量。

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm test

# 完整 MVP 交付门禁（含 PostgreSQL、后端与浏览器 E2E）
pnpm verify:mvp
```

## 文档

- [工作站到 Linux 主机交接](docs/WORKSTATION_SERVER_HANDOFF.md)
- [Linux 服务器部署](docs/SERVER_DEPLOYMENT.md)
- [携程生产验收手册](docs/CTRIP_PRODUCTION_RUNBOOK.md)
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
