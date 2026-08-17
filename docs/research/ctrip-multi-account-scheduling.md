# 携程社区多账号分发与调度调研

日期：2026-07-29
范围：单租户下的多个携程社区账号。本文只定义合规的账号管理与任务调度模式；不包含规避平台限制、共享登录态、验证码处理或绕过平台规则的方法。

## 结论

应把每个携程账号视为一个独立、可暂停的投放分区，而不是一组可互换的浏览器凭据：

- 一个账号对应一个受限的持久浏览器 profile、一条串行的外部写入队列和一组独立配额、健康状态与熔断器。
- 批次先产生待分配的内容槽位；调度器只从 `eligible` 账号中按确定性公平策略选出一个账号，再创建绑定该账号的最终变体、审计与发布请求。
- 提交点击后的结果不确定时只能做该账号的公开回读，不能自动改投另一账号或再次提交。现有审计对象、grant 和 handoff 都已绑定 `channelAccountId`，这也应保持不变。
- 未经可复核的平台授权、每账号能力证据和人工登录，不应把账号加入无人值守候选池。当前仓库没有已验证的携程普通公开发文 API，不能把浏览器成功登录当作 API 或无人值守授权证据。[平台接入清单](../api/platform-onboarding.md)

## 外部一手依据

| 主题           | 一手资料                                                                                                                                | 对本设计的约束                                                                                                                                                         |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 独立浏览器会话 | [Playwright `launchPersistentContext`](https://playwright.dev/docs/api/class-browsertype#browser-type-launch-persistent-context)        | `userDataDir` 承载 cookie 和 local storage，且浏览器不允许多个实例同时使用同一目录。因此一个账号只能绑定一个独立 profile，且同一 profile 同时只能有一个 Bridge owner。 |
| 并发领取       | [PostgreSQL `SELECT ... FOR UPDATE SKIP LOCKED`](https://www.postgresql.org/docs/current/sql-select.html#SQL-FOR-UPDATE-SHARE)          | `SKIP LOCKED` 适合多个消费者领取队列工作，但会产生不一致视图；只能配合明确的 `ORDER BY`、短租约和幂等状态转换用于队列，不能用于普通业务读取。                          |
| 租约与恢复     | [Amazon SQS visibility timeout](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-visibility-timeout.html) | 消费者处理期间其他消费者不可见；超时后任务重新可见。对应实现需要心跳续租、明确完成确认和失败任务隔离，而非无限占用账号槽位。                                           |
| 账号限流       | [Amazon API Gateway throttling](https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-request-throttling.html)       | 令牌桶将稳定速率与突发容量分开，并可在多个粒度叠加。这里借用该算法表达本地保守配额，不将 AWS 数值或任何推测值当作携程限额。                                            |
| 可观测性       | [OpenTelemetry Messaging semantic conventions](https://opentelemetry.io/docs/specs/semconv/messaging/messaging-spans/)                  | 每条工作应有稳定消息标识和低基数错误类型；队列名、操作类型和处理结果可用于跨 Producer/Bridge/readback 关联。                                                           |

## 目标模型

### 1. 账号与会话所有权

`channel_accounts` 继续作为租户内账号的权威目录。为携程账号补充独立的运行时绑定（不保存 cookie、密码或原始 token）：

| 字段/概念                      | 用途                                                                                                                                                 |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `accountId` + `tenantId`       | 所有排队、审计、配额和浏览器操作的不可变分区键。                                                                                                     |
| `profileRef`                   | 仅指向服务器受保护 profile 目录的 opaque reference；不可通过 API 返回真实路径、cookie 或 storage。                                                   |
| `sessionState`                 | `unbound`、`session_required`、`ready`、`challenge_required`、`disabled`。只允许人工通过受监督 Browser Host 使其从 `session_required` 变为 `ready`。 |
| `capabilityEvidence` / `phase` | 账号级、带过期时间的能力证据；缺失、过期或 Phase 不足时排除出无人值守候选池。                                                                        |
| `health`                       | 由 session、最近一次适配器证据、circuit、最近公开回读和配额共同导出；不是一个可手工伪造的绿色状态。                                                  |

禁止多账号复用同一个 profile、跨租户绑定 profile，或以账号 A 的登录态向账号 B 投放。`session_required`、challenge、selector drift、公开回读不匹配必须只打开该账号的 circuit；其他健康账号可以继续处理自己的队列。

### 2. 分配、排队与公平性

批次不应要求人工编辑每一个槽位。创建批次时只保存数量、主题约束、允许账号集合、最早开始时间和执行级别；服务端为每个槽位持久化调度决策：

```text
slot -> candidate filter -> deterministic account selection -> account-bound variant/audit/grant -> account queue
```

候选条件必须全部成立：账号属于当前 tenant、`active`、能力与 Phase 支持目标执行级别、session `ready`、没有 account circuit、令牌可用、冷却已结束、没有活跃外部写入租约。

推荐策略：账号队列内 FIFO（`scheduledFor, slotId`），跨账号使用加权轮转。初版权重固定为 1；后续只允许由可审计配置改变。选择时保存 `selectedAccountId`、候选快照、被排除原因、权重、令牌/冷却判定和算法版本。这样账户暂不可用时是 `deferred_account_unavailable`，而不是误报为文章生产失败。

单账号并发数应固定为 `1`，直至平台提供经验证的并行写入能力。生成、审计和媒体准备可并行；草稿写入、提交、状态查询/公开回读按账号串行。领取使用带 `ORDER BY` 的数据库 claim + lease token + heartbeat；lease 失效后仅把尚未跨越提交边界的工作重新排队。

### 3. 配额、冷却与重试

每个账号配置独立的本地保守上限：`maxConcurrent=1`、`perMinute`、`perDay`、`cooldownSeconds`、`errorBudget`。平台未书面确认的数值必须是操作员设置的保守业务限制，不得标注为平台限额。

令牌桶控制分钟速率和突发；发布成功或已受理后写入账号冷却窗口；日配额按一个固定、显示在 UI 中的业务时区计算。账号 circuit 或 session 不可用时不消耗令牌。收到明确 429/限额、登录失效或适配器 drift 时，将该账号进入退避或 circuit，保留其它账号的容量。

重试分三类：

- **提交前可重试**：网络超时、可证实尚未执行的浏览器步骤，采用有上限的指数退避和抖动；每次保留同一账号与 idempotency key。
- **提交后不确定**：禁止自动再次提交；进入 `readback_pending` 或 `needs_review`，仅做该账号的回读与人工处理。
- **永久或账号级失败**：账号 circuit 打开，未开始的槽位延后；不把已绑定的审核版本静默迁移给别的账号。

### 4. 重复防护

重复检测要在生成提示词和确定性门禁两层执行：按 `tenantId + accountId + platform` 对标题、摘要、正文 canonical hash、主题 key 和近似度窗口做检查；把最近已发布、已受理、待回读和待发布的内容都计入。模板轮换和提示词只用于提高差异性，不能替代硬性 near-duplicate 判定。若命中，标记 `blocked_duplicate` 并重新生成同一槽位的候选，而不是把原文投到另一账号。

### 5. 可观测性与运营界面

账户管理页应显示账号级状态，而非只显示目录字段：session、当前 lease、可用令牌、下一次冷却结束、当日已用/上限、circuit 原因、证据到期时间、队列深度、最久等待时长和最近一次外部结果。操作员可新增账号记录、绑定/重新登录 profile、暂停账号、设置保守容量、查看失败与恢复；不能编辑或导出会话秘密。

建议为每个槽位贯穿记录 `batchId`、`slotId`、`accountId`、`variantId`、`auditId`、`grantId`、`handoffId`、`publicationJobId` 与 `readbackId`。事件使用低基数错误码（如 `SESSION_REQUIRED`、`ACCOUNT_COOLDOWN`、`PLATFORM_RATE_LIMIT`、`READBACK_PENDING`），日志与指标不得写入浏览器会话、密码、cookie、请求正文或 URL 中的私密参数。

## 对现有仓库的落差与实施顺序

现有目录已具备租户内创建/更新 `channel_accounts` 的 API 和前端入口；自动化 Producer 也已有 run lease、heartbeat、账号级 circuit 和 `channelAccountId` 绑定。当前显式单账号约束在 [`packages/db/src/ctrip-bridge-commissioning.ts`](../../packages/db/src/ctrip-bridge-commissioning.ts) 的 `resolveCtripAccount()`：它要求“exactly one active Ctrip channel account”。这必须先改为显式 account-to-profile binding，不能简单删除检查。

1. **账号接入**：添加真实的“添加携程账号”向导，创建目录记录后分配独立 profile ref，要求人工登录并校验该 profile 的账号身份；未通过前只显示 `session_required`，不可调度。
2. **多账号 Bridge**：把启动/commissioning、会话检查、draft/submit/readback lease 改为按 `channelAccountId` 定位 binding；强制每账号单 owner，并保留现有 tenant scope 与 Phase 门禁。
3. **分发器**：实现持久化账号选择和 per-account FIFO queue，附加令牌桶、冷却和账号级 deferred 状态；不要让一个账号故障终止整批。
4. **重复和回读**：将账号历史纳入 slot 生成与发布前 hard gate；不确定提交只进入回读，永不跨账号自动重投。
5. **验收**：至少覆盖两账号的会话隔离、账号 A 断路但账号 B 继续、同账号串行与公平轮转、过期 lease 恢复、配额/冷却、近重复拦截、提交后不重试和日志脱敏。所有真实携程操作仍须遵守当前 Phase、能力证据和平台授权边界。

## 非目标

- 不猜测或规避携程的频率、审核、登录、验证码或风控规则。
- 不共享、导出、复制或从应用读取浏览器 cookie/密码。
- 不因账号数增加而降低现有审计、一次性提交许可、Kill Switch 或独立公开回读要求。
