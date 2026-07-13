# GEO SaaS

面向多客户、多行业的 GEO 内容运营与 AI 可见性评测平台。首个行业包是旅游，首个租户是中通国际旅行社；核心系统不把旅行社字段硬编码到通用模型中。

当前实现目标包括：多租户隔离、内容版本与平台变体、发布前审计、一次性发布许可、事务 outbox、头条号/搜狐号/携程社区连接器、豆包/千问专项评测，以及 Pi Agent + MCP 编排。

平台发布能力会明确标记为 `DRY_RUN`、`MANUAL_ONLY`、`BROWSER_ASSISTED`、`PARTNER_API` 或 `PUBLIC_API`。在取得平台可核验授权前，不会把浏览器自动化包装成公开 API 或无人值守能力。

## 本地要求

- Node.js 24
- pnpm 10
- PostgreSQL 16+
- Redis 7+（限速与 worker 热路径；数据库保留硬底线）

具体设计和实施证据见：

- `docs/superpowers/specs/2026-07-13-geo-saas-mvp-design.md`
- `docs/superpowers/specs/engineering-patterns/2026-07-13-geo-agent-publishing.md`
- `docs/superpowers/plans/2026-07-13-geo-saas-mvp.md`
