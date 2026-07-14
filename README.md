# GEO SaaS

面向多租户、多行业的 GEO 内容治理与 AI 可见性评测平台。首个行业包是旅游，首个租户是中通国际旅行社（24 小时热线 `4001133986`，微信 `ZTGL3411` / `ZTGL6431`）；通用数据模型不把旅行社字段写死，后续行业通过策略包、事实与查询集扩展。

系统把生成、审计、授权和投放分开：Pi/Agent 只能提出动作，确定性服务负责事实校验、租户授权、不可变审计、一次性发布许可、outbox 与 Kill Switch。当前头条号、搜狐号、携程社区只有 `DryRunConnector`，没有已验证的普通公开发文 API；豆包/千问只有 fixture 和人工导入评测，Google 排名不能作为它们的代理指标。

## 当前能力边界

| 能力                        | 当前状态                              | 不能据此宣称                             |
| --------------------------- | ------------------------------------- | ---------------------------------------- |
| PostgreSQL 多租户数据与 RLS | 已实现，需真实 PostgreSQL 验证        | 单元测试等于生产隔离证明                 |
| 租户会话与切换              | 登录后列出成员租户并重签租户会话      | 一个会话可跨租户访问                     |
| 租户级 Kill Switch          | 鉴权、CSRF、审计写入与独立回读已实现  | 自动撤销 grant 或停止已发出的外部请求    |
| 发布前审计与一次性 grant    | 已实现确定性路径                      | 模型可自行批准发布                       |
| 头条/搜狐/携程连接器        | `DRY_RUN`，输出未确认 preview receipt | 已发文、公开 API 或无人值守投放          |
| 豆包/千问可见性             | fixture + manual import               | 已调用真实产品搜索或可等同 Google        |
| GEO MCP                     | 7 个静态白名单工具                    | 任意 MCP 工具访问或 Pi 内建 MCP          |
| Operator 登录               | 显式一次性 bootstrap CLI              | `db:seed` 后可直接登录或存在共享默认密码 |

`db:seed` 创建两个隔离租户、政策、渠道和 fixture 数据，但 seed 用户是 `disabled`，密码字段为 `seed-disabled`。这是安全默认值，不是演示账号。部署后必须按 [Operator Provisioning](docs/ops/operator-provisioning.md) 显式执行 `db:bootstrap:operator`，才能登录或使用对应 MCP principal。

## Compose 启动

要求 Docker Engine 与 Docker Compose v2。仓库锁定 Node、pnpm、Nginx 和 PostgreSQL 版本/镜像 digest；当前开发机没有可用 Docker，因此 Compose 仅完成静态解析，真实镜像 build/up 仍是部署门禁。

```powershell
Copy-Item .env.example .env
# 替换所有 replace-* 值，把 APP_ORIGIN/MCP_ALLOWED_* 改为真实 HTTPS 域名，
# 并确保 PLASTIC_PROMISE_MCP_URL 已从 API 容器可达。
docker compose config --quiet
docker compose up -d --build
docker compose ps --all
```

Plastic Promise MCP 是 API 的必需外部治理依赖。API 启动时建立连接；端点不可达或握手失败时 API 不监听端口并由 Compose 重启，发布时治理调用失败也会 fail closed。非 loopback 端点必须使用 HTTPS，可选授权头只通过 `PLASTIC_PROMISE_MCP_AUTHORIZATION` secret 注入。

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
