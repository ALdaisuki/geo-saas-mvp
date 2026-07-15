# GEO SaaS

面向多租户、多行业的 GEO 内容治理与 AI 可见性评测平台。首个行业包是旅游，首个租户是中通国际旅行社（24 小时热线 `4001133986`，微信 `ZTGL3411` / `ZTGL6431`）；通用数据模型不把旅行社字段写死，后续行业通过策略包、事实与查询集扩展。

系统把生成、审计、授权和投放分开：Pi/Agent 只能提出动作，确定性服务负责事实校验、租户授权、不可变审计、一次性发布许可、outbox 与 Kill Switch。当前头条号、搜狐号、携程社区只有 `DryRunConnector`，没有已验证的普通公开发文 API；豆包/千问只有 fixture 和人工导入评测，Google 排名不能作为它们的代理指标。

`assisted` / `unattended` 发布请求会在治理评估、消耗 grant、创建 job 或写入 outbox 之前被确定性拒绝。当前“排期”和“回执”均指 Dry-run 预演链，不代表外部平台已接收内容。passed 且未过期的审计可导出独立人工发布包；该包固定标记 `requiresManualAction=true`、`publicationStatus=not_published`，不会触发外部发送。

Compose 中的 `agent-mcp` 进程同时提供认证的 `POST /agent/runs` 和可显式启用的后台自动化 Producer。Producer 按租户身份轮询持久化批次，使用租约、心跳和断点恢复执行“生成 -> 确定性审计 -> Dry-run 预演 -> 回执回读”；一个租户身份失败不会阻塞其他租户。默认 `AGENT_PROVIDER=fixture` 使用确定性的 `FixturePiAgentRunService`；只有 Pi 已登记相应 provider/model 且由 secret 注入 `AGENT_API_KEY` 时，才启动 `RealPiAgentRunService`。真实 Pi 只改变模型编排方式，仍受静态 GEO/治理工具白名单、租户权限和确定性发布门禁约束，不会凭空获得头条/搜狐/携程发文 API 或豆包/千问真实搜索 API。

## 当前能力边界

| 能力                        | 当前状态                                           | 不能据此宣称                                   |
| --------------------------- | -------------------------------------------------- | ---------------------------------------------- |
| PostgreSQL 多租户数据与 RLS | 已实现，需真实 PostgreSQL 验证                     | 单元测试等于生产隔离证明                       |
| 租户会话与切换              | 登录后列出成员租户并重签租户会话                   | 一个会话可跨租户访问                           |
| Kill Switch、撤权与排队取消 | 租户急停、grant revoke、queued/retry cancel 已实现 | 自动撤权、取消已租约作业或停止已发出的外部请求 |
| 发布前审计与一次性 grant    | 已实现确定性路径                                   | 模型可自行批准发布                             |
| 头条/搜狐/携程连接器        | `DRY_RUN`，输出未确认 preview receipt              | 已发文、公开 API 或无人值守投放                |
| 豆包/千问可见性             | fixture + manual import                            | 已调用真实产品搜索或可等同 Google              |
| GEO MCP                     | 7 个静态白名单工具                                 | 任意 MCP 工具访问或 Pi 内建 MCP                |
| Pi Agent 与批次 Producer    | `agent-mcp` 内置；多租户租约恢复，固定 Dry-run     | 已向外部平台实发或绕过发布前审计               |
| Operator 登录               | 显式一次性 bootstrap CLI                           | `db:seed` 后可直接登录或存在共享默认密码       |

`db:seed` 创建两个隔离租户、政策、渠道和 fixture 数据，但 seed 用户是 `disabled`，密码字段为 `seed-disabled`。这是安全默认值，不是演示账号。生产客户不走 seed：先按 [Tenant and Operator Provisioning](docs/ops/operator-provisioning.md) 执行 admin-only `db:provision:tenant`，合并输出的 worker 映射，再对已创建 slug 执行独立的 `db:bootstrap:operator`。租户 owner API 无权跨租户创建客户。

`db:provision:tenant` 会在同一事务中创建 active `geo.audit-policy.v1` 基线策略和 active 豆包/千问基准 query set/version，并把三个 ID 写入不可变 receipt。它不会创建平台凭据、真实发布能力或真实模型搜索调用。

## Pi Agent 运行入口

`POST /agent/runs` 与 `/mcp` 共用 `MCP_PRINCIPALS_JSON` bearer 身份、Host/Origin 白名单和 1 MiB 请求上限，并要求显式 `Content-Length`、拒绝 transfer encoding。同一租户与操作者组合同时只能运行一个请求；并发请求返回 `409 AGENT_RUN_ACTIVE`。run 默认限时 120 秒，可用 `AGENT_RUN_TIMEOUT_MS` 在 1 秒到 15 分钟内调整；超时返回 `504` 并中止 Pi loop，在底层任务真正结束前不会释放并发锁。

- fixture 模式只接受 `{ workflow: "draft_to_publication", tenantId, brandId, campaignId, channelAccountId, platform, topic, idempotencyKey }`，并把执行级别固定为 `dry_run`。
- 真实 Pi 模式只接受 `{ workflow: "prompt", prompt }`，其模型只能调用静态白名单工具；provider 失败返回脱敏 `502`，provider/model/API key 的存在不代表任何平台连接器已上线。

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
- [平台 API Onboarding](docs/api/platform-onboarding.md)
- [MVP 设计](docs/superpowers/specs/2026-07-13-geo-saas-mvp-design.md)
- [典范分析](docs/superpowers/specs/engineering-patterns/2026-07-13-geo-agent-publishing.md)
