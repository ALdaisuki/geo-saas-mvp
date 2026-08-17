# SmartMediaHub 源码深度评估与 GEO 映射

日期：2026-08-03
研究对象：[aiseall/SmartMediaHub](https://github.com/aiseall/SmartMediaHub)
固定源码快照：[`73561dd82f3685bfb6b93729e560478f2bd4f5df`](https://github.com/aiseall/SmartMediaHub/commit/73561dd82f3685bfb6b93729e560478f2bd4f5df)，提交时间 2025-11-20
GEO 对照快照：本地 `codex/geo-saas-mvp` 的 `2e13b3cee99bba132494c30b53c08d885c57546f`，同时保留工作区中尚未提交的用户改动
目标：判断该项目对“热点抓取 -> AI 软广文章 -> 平台独立变体 -> 多账号异步发布，最终 5,000 个平台变体/天”的真实参考价值。

## 结论

**SmartMediaHub 是一套展示产品概念的 React/Express 脚手架，不是成熟的多平台发布实现。它可以提供少量信息架构和编辑器交互灵感，但不能提供账号登录层、平台 adapter、异步发布内核或 5,000 变体/天的容量设计。**

README 宣称支持头条号、公众号、抖音、小红书、哔哩哔哩等一键发布、定时发布、数据统计和“一句话创作爆款文章和视频”；源码中实际没有任何平台 publisher/adapter/connector，也没有热点采集、平台登录、持久队列、worker、重试、幂等、回读或平台变体。[README 宣称](https://github.com/aiseall/SmartMediaHub/blob/73561dd82f3685bfb6b93729e560478f2bd4f5df/README.md#L28-L39)与[功能清单](https://github.com/aiseall/SmartMediaHub/blob/73561dd82f3685bfb6b93729e560478f2bd4f5df/README.md#L51-L68)都明显超出实现。

最重要的判断是：

1. **Adopt：** 只吸收“创作、账号、排期、数据”四个运营工作区，以及富媒体工具栏的图标 + Tooltip 交互概念。
2. **Adapt：** 将其简单页面概念改造成 GEO 的热点雷达、创作工作室、变体矩阵、批次分发和账号健康中心；底层继续使用 GEO 已有 tenant、variant、audit、grant、job、lease、receipt、readback 体系。
3. **Avoid：** 不复制后端、账号模型、定时任务、鉴权、依赖管理、统计、生产 Docker 和安全实现。尤其不能部署它的未鉴权依赖管理 API，该 API 可形成远程命令注入。
4. **许可证：** README 只写“MIT”，仓库没有根 `LICENSE`，GitHub API 也未识别许可证，而后端 `package.json` 声明 ISC。直接复制代码前必须让上游明确许可证；当前建议只做 clean-room 行为学习。

## 总体评分

| 维度             | 源码完成度 | 对 GEO 的价值 | 结论                                                                    |
| ---------------- | ---------: | ------------: | ----------------------------------------------------------------------- |
| 热点抓取/聚类    |       0/10 |            无 | 完全没有热点源、采集器、调度或聚类                                      |
| AI 文章创作      |       3/10 |            低 | 有同步模型 HTTP 包装，但前端没有“一句话成文”主链，缺少版本与质量治理    |
| 平台账号登录     |       0/10 |            无 | 只有平台名和用户名；没有 OAuth、扫码、Cookie、会话或身份探针            |
| 平台独立变体     |       0/10 |            无 | 一条内容只有字符串平台数组，没有每平台 payload/version/hash             |
| 多平台发布       |       0/10 |            无 | 没有任何平台 API、浏览器发布脚本或 adapter                              |
| 异步并发/排期    |       0/10 |            无 | “定时发布”只是内存列表或普通 Content 记录，没有 scheduler/worker        |
| 状态、重试、幂等 |       0/10 |            无 | 没有 attempt、lease、heartbeat、backoff、dead letter 或 idempotency key |
| 发布确认/回读    |       0/10 |            无 | 前端统计是硬编码示例，后端统计由调用方任意写入                          |
| UI 信息架构      |       4/10 |          中低 | 模块名称直观，富媒体工具入口可参考；视觉与动效不能直接采用              |
| 测试与交付       |       1/10 |            无 | 项目测试为 0，前端不可复现构建，固定提交 CI 失败                        |
| 安全/多租户      |       0/10 |      负面教材 | 无 API 鉴权/租户边界，并有命令注入、SSRF、固定秘密等风险                |

## 1. 审计方法与可复现证据

本次没有把 README 当实现证据，而是完成了以下检查：

- 通过 GitHub API 固定默认分支 HEAD 为 `73561dd...`，下载该 commit 的完整源码树。
- 逐个阅读 44 个项目 TypeScript/TSX 文件，并检索 platform、publish、adapter、queue、worker、retry、idempotency、readback、hot/trend 等实现。
- 项目源码中测试/规格文件为 **0**，平台 adapter/publisher/connector 文件为 **0**。
- 后端 `npm ci` 后 `npx tsc --noEmit` 通过，但这只证明 TypeScript 可编译。
- 前端 `npm ci` 因 `package.json` 与 lockfile 不一致而失败；用 `npm install` 重建依赖后，`npm run build` 仍因未使用图标和不可能的 `docx` 类型比较失败。[问题源码](https://github.com/aiseall/SmartMediaHub/blob/73561dd82f3685bfb6b93729e560478f2bd4f5df/frontend/src/components/RichMediaEditor.tsx#L5-L10) [类型分支](https://github.com/aiseall/SmartMediaHub/blob/73561dd82f3685bfb6b93729e560478f2bd4f5df/frontend/src/components/RichMediaEditor.tsx#L106-L124)
- 按生产脚本启动 `node app.js` 后，根路径返回 200，但 `POST /api/users/login` 返回 404；原因是生产入口只挂了根路径，没有加载 `app.ts` 中的 API 路由。[生产入口](https://github.com/aiseall/SmartMediaHub/blob/73561dd82f3685bfb6b93729e560478f2bd4f5df/backend/app.js#L1-L17) [脚本配置](https://github.com/aiseall/SmartMediaHub/blob/73561dd82f3685bfb6b93729e560478f2bd4f5df/backend/package.json#L1-L17)
- GitHub Actions 截至快照共有 16 次运行，结论全部为 failure；固定提交对应的[最近一次失败运行](https://github.com/aiseall/SmartMediaHub/actions/runs/19530959678)。Workflow 执行 `grunt`，但根项目没有 Grunt 依赖或配置。[Workflow](https://github.com/aiseall/SmartMediaHub/blob/73561dd82f3685bfb6b93729e560478f2bd4f5df/.github/workflows/npm-grunt.yml#L1-L28)

因此，下文所说“缺失”不是指功能写得简单，而是固定源码树中没有对应执行链。

## 2. README 与真实实现差距

| README 宣称         | 源码实际行为                                                                                       | 判断                   |
| ------------------- | -------------------------------------------------------------------------------------------------- | ---------------------- |
| 多平台一键分发      | 平台只以字符串出现在 UI checkbox 和 `Content.platforms` 数组中；没有任何平台域名、SDK 或 publisher | 未实现                 |
| 平台账号管理        | 前端只在 React 内存中保存 `platform + username`，刷新即丢失；后端模型也只有这两个业务字段          | 展示占位               |
| 定时发布            | 前端只把任务加入本地数组；后端接口只是另存一条带 `scheduledTime` 的 Content                        | 未调度、未发布         |
| 数据统计和趋势      | 前端表格使用四条硬编码数据；后端统计可由调用者直接 upsert                                          | 模拟数据，不是平台回读 |
| 一句话创作文章/视频 | 前端没有文本生成主流程；富媒体编辑器只有若干独立按钮，其中图片按钮调用不存在的路由                 | 不闭环                 |
| 生产 Docker 可运行  | Docker 启动旧的 `app.js`，所有 `/api/*` 都未挂载；MongoDB 也没有应用连接代码                       | 不可用                 |

平台字符串的全部实际使用只出现在[本地定时任务 checkbox](https://github.com/aiseall/SmartMediaHub/blob/73561dd82f3685bfb6b93729e560478f2bd4f5df/frontend/src/pages/ScheduledPublish.tsx#L43-L100)和[硬编码统计](https://github.com/aiseall/SmartMediaHub/blob/73561dd82f3685bfb6b93729e560478f2bd4f5df/frontend/src/pages/DataStatistics.tsx#L11-L23)。这不能作为平台适配成熟度的证据。

## 3. 热点采集

**固定源码中不存在热点采集。**

没有来源目录、RSS/API adapter、网页抓取器、robots 策略、原始证据快照、抓取计划、内容指纹、同题聚类、热度趋势、时效衰减或选题评分。`analytics/trends` 只是读取调用者写入的 `Statistics`，不是热点趋势。[趋势控制器](https://github.com/aiseall/SmartMediaHub/blob/73561dd82f3685bfb6b93729e560478f2bd4f5df/backend/controllers/analyticsController.ts#L1-L8)

GEO 已有更可靠的起点：`ResearchService` 对来源、HTTPS origin、允许主机、robots、页面证据和 sitemap 采集做了能力与租户检查，[服务入口](../../apps/api/src/research-service.ts#L143-L181)和[采集链](../../apps/api/src/research-service.ts#L216-L270)均已存在；数据库也把来源策略和采集记录做成租户隔离、不可删除/追加式记录。[研究治理迁移](../../packages/db/migrations/0013_research_capture_governance.sql#L34-L108) [RLS](../../packages/db/migrations/0013_research_capture_governance.sql#L139-L166)

GEO 的下一步不是从 SmartMediaHub 搬代码，而是在现有 Research 层上补：

1. `HotSourceAdapter`：新闻榜单、搜索趋势、行业站点和授权 API 的统一采集合同。
2. `HotSignalSnapshot`：原始排名、互动量、时间、地域、行业、来源可信度及证据 hash。
3. `TopicCluster`：跨来源去重、语义聚类、热度/时效/品牌相关性评分。
4. `CreativeBrief`：从热点簇生成可追溯选题，不把抓来的原文直接改写发布。
5. 周期调度、限流、来源熔断和结构漂移告警。

## 4. AI 创作与内容谱系

### 实际实现

后端为 DeepSeek、Qwen、OpenAI、Gemini 分别写了同步 Axios 包装。例如 OpenAI 服务直接把 prompt 发送到 `/chat/completions` 并原样返回 provider response。[OpenAI 包装](https://github.com/aiseall/SmartMediaHub/blob/73561dd82f3685bfb6b93729e560478f2bd4f5df/backend/services/openaiService.ts#L1-L31) 其他 provider 也是相同层级的薄封装。[DeepSeek](https://github.com/aiseall/SmartMediaHub/blob/73561dd82f3685bfb6b93729e560478f2bd4f5df/backend/services/deepseekService.ts#L1-L32) [Qwen](https://github.com/aiseall/SmartMediaHub/blob/73561dd82f3685bfb6b93729e560478f2bd4f5df/backend/services/qwenService.ts#L1-L32) [Gemini](https://github.com/aiseall/SmartMediaHub/blob/73561dd82f3685bfb6b93729e560478f2bd4f5df/backend/services/geminiService.ts#L1-L14)

这部分最多能说明“如何发一个 HTTP 请求”，不能视为 AI 创作系统：

- 没有 prompt 模板/version、品牌事实、软广配比、输出 schema、token/cost、超时、重试、provider fallback 或生成记录。
- 没有 canonical article、研究证据、事实主张、生成父子关系和平台派生版本。
- 前端没有调用任何 `/api/*/text` 接口，所以 README 的“一句话创作文章”不在 UI 主链中。
- 富媒体编辑器的 AI 图片按钮调用 `/api/multimodal-image/generate`，后端没有注册该路由；实际注册的是 `/api/openai`、`/api/qwen` 等。[前端调用](https://github.com/aiseall/SmartMediaHub/blob/73561dd82f3685bfb6b93729e560478f2bd4f5df/frontend/src/components/RichMediaEditor.tsx#L41-L53) [后端路由表](https://github.com/aiseall/SmartMediaHub/blob/73561dd82f3685bfb6b93729e560478f2bd4f5df/backend/app.ts#L23-L36)
- 图片转视频只是接收调用方提供的任意 `apiUrl` 和 `apiKey` 后代发 HTTP 请求，不是平台化视频生成 adapter；UI 还传入空 URL/Key，正常情况下无法成功。[服务](https://github.com/aiseall/SmartMediaHub/blob/73561dd82f3685bfb6b93729e560478f2bd4f5df/backend/services/videoGenService.ts#L1-L29) [UI 调用](https://github.com/aiseall/SmartMediaHub/blob/73561dd82f3685bfb6b93729e560478f2bd4f5df/frontend/src/components/RichMediaEditor.tsx#L80-L93)

### 对 GEO 的可用启发

可参考富媒体编辑器把图片、语音、ASR、视频和文件入口集中在工具栏，并使用图标与 Tooltip。[工具栏](https://github.com/aiseall/SmartMediaHub/blob/73561dd82f3685bfb6b93729e560478f2bd4f5df/frontend/src/components/RichMediaEditor.tsx#L126-L149) 但逻辑和视觉都应重写。

GEO 应把用户已确认的软广结构做成**可版本化的租户/活动变量**，例如默认 `70% 实用信息 + 20% 品牌自然植入 + 10% CTA`，而不是写死在 prompt。每次生成至少绑定：

- `briefId + sourceEvidenceHashes`；
- `brandProfileVersion + verifiedClaimSnapshot`；
- `templateVersion + model/provider + parameters`；
- `canonicalContentVersion`；
- 每个平台独立的 `publicationVariant + payloadHash`；
- 轻量机器审核的 policy/version/findings。

## 5. 平台账号登录与凭据边界

SmartMediaHub 没有平台登录层。前端账号页只维护内存数组，字段是 `platform` 和 `username`，没有调用后端。[前端账号页](https://github.com/aiseall/SmartMediaHub/blob/73561dd82f3685bfb6b93729e560478f2bd4f5df/frontend/src/pages/PlatformAccounts.tsx#L1-L65) 后端 `PlatformAccount` 也只有 `userId/platform/username`，没有 credential reference、session profile、external account ID、scope、expiry、health 或 challenge 状态。[账号模型](https://github.com/aiseall/SmartMediaHub/blob/73561dd82f3685bfb6b93729e560478f2bd4f5df/backend/models/PlatformAccount.ts#L1-L10)

后端账号 API 只有未鉴权的新增和按 ID 删除，没有列表、登录或验证；`userId` 由请求体任意提供，删除也不检查用户归属。[账号控制器](https://github.com/aiseall/SmartMediaHub/blob/73561dd82f3685bfb6b93729e560478f2bd4f5df/backend/controllers/platformAccountController.ts#L1-L15)

GEO 现有账号边界明显更成熟：`channel_accounts` 以 tenant + platform + account 复合约束绑定 capability、execution level、opaque `credential_ref` 和能力证据。[现有模型](../../packages/db/migrations/0002_identity_and_tenant.sql#L157-L176) 携程浏览器会话也已经按账号串行、全局容量控制，并只通过 `profileKey` 连接隔离 profile。[会话提供器](../../apps/ctrip-bridge/src/account-browser-session-provider.ts#L9-L60) [串行与容量](../../apps/ctrip-bridge/src/account-browser-session-provider.ts#L63-L115)

新平台应复用这一边界，统一产品状态为：

`未绑定 -> 等待登录 -> 已识别账号 -> 会话可用 -> 需要挑战/重新登录 -> 已停用`

业务数据库只保存 opaque binding、平台账号标识、过期时间、能力和健康证据；Cookie、Token、二维码临时状态不得进入普通 CRUD API、日志或前端状态。

## 6. 平台变体模型

SmartMediaHub 的 `Content` 只有一份 `title/content/fileUrl` 和一个字符串 `platforms[]`。[内容模型](https://github.com/aiseall/SmartMediaHub/blob/73561dd82f3685bfb6b93729e560478f2bd4f5df/backend/models/Content.ts#L1-L14) 它没有为不同平台保存独立标题、正文、标签、封面、媒体 manifest、披露、CTA、长度限制或版本，因此无法支撑“同一母稿，多平台不同变体”。

GEO 已有正确的基础模型：`publication_variants` 按 `content_version + channel_account + platform + variant_version` 建模，拥有独立 payload、hash、冻结状态和租户复合外键。[变体表](../../packages/db/migrations/0003_content_and_governance.sql#L131-L154) 审计 artifact 与 grant 又绑定最终 variant、账号、平台和 payload hash，内容变化会自然使旧审核/授权失效。[审核与授权](../../packages/db/migrations/0003_content_and_governance.sql#L156-L228)

因此 SmartMediaHub 在此维度没有可迁移实现。GEO 应继续把**最终平台变体**作为生成、审核、调度和审计的原子对象，而不是给母稿附一个平台数组。

建议增加 `PlatformContentProfile`，至少描述：

- 标题、正文、摘要、标签和外链限制；
- 品牌出现次数、软广强度、CTA 形式和披露要求；
- 图片数量、比例、尺寸、封面、alt text 与媒体角色；
- 平台敏感表达、禁止绝对化表达和账号级词库；
- adapter capability/version 和渲染器版本。

## 7. 多平台发布、异步并发与状态机

### SmartMediaHub 实际行为

固定源码没有发布动作。后端 `addContent` 只写 Mongo Content；所谓定时发布控制器也只是写同一种 Content 记录。[内容新增](https://github.com/aiseall/SmartMediaHub/blob/73561dd82f3685bfb6b93729e560478f2bd4f5df/backend/controllers/contentController.ts#L1-L15) [定时任务控制器](https://github.com/aiseall/SmartMediaHub/blob/73561dd82f3685bfb6b93729e560478f2bd4f5df/backend/controllers/scheduledPublishController.ts#L1-L15)

前端定时任务甚至没有调用这个后端接口，只在组件 `useState` 中追加对象。[本地任务](https://github.com/aiseall/SmartMediaHub/blob/73561dd82f3685bfb6b93729e560478f2bd4f5df/frontend/src/pages/ScheduledPublish.tsx#L10-L41) 仓库没有 scheduler、cron、queue、worker、原子 claim、并发池或平台账号限速。

同样不存在：

- adapter capability/probe/preflight；
- attempt 与错误分类；
- stable idempotency key；
- lease/heartbeat/checkpoint；
- retry/backoff/dead letter；
- 提交后不确定态和 reconciliation；
- receipt、external ID/URL 与公开回读；
- 账号配额、冷却、熔断或 kill switch。

### GEO 应保持的现有底座

GEO 的 `PlatformConnector` 已明确 tenant/account scope、session validation、render、preflight、draft、publish、poll、reconcile 和 evidence 合同。[connector 合同](../../packages/connectors/src/types.ts#L15-L118) [完整接口](../../packages/connectors/src/types.ts#L162-L173)

交付数据库已经具备：

- job、attempt、receipt 与稳定 idempotency key；[交付表](../../packages/db/migrations/0004_delivery_and_visibility.sql#L1-L84)
- durable outbox/inbox、claim 锁与 dead letter 字段；[outbox/inbox](../../packages/db/migrations/0004_delivery_and_visibility.sql#L86-L124)
- 通用 idempotency records 与 circuit breaker；[幂等/熔断](../../packages/db/migrations/0004_delivery_and_visibility.sql#L126-L158)
- Producer 并发、lease、heartbeat、checkpoint、失败分类和指数退避；[Producer 合同](../../apps/agent-mcp/src/automation-producer.ts#L1-L117) [失败分类与退避](../../apps/agent-mcp/src/automation-producer.ts#L180-L218)
- 只有非 dry-run 且具备 API/platform readback、外部 ID/URL 和发布时间的回执才能算真实确认。[确认规则](../../packages/connectors/src/receipts.ts#L5-L28)

SmartMediaHub 不应替换或简化这些机制。可借的仅是“运营人员想看到排期列表”的产品需求。

## 8. 5,000 个最终变体/天的容量判断

SmartMediaHub 对该目标没有任何可用容量设计。GEO 应把一个 `PublicationTarget` 定义为“一份已冻结、已审核的平台最终变体发往一个具体账号”，5,000/天就是 5,000 个 target 的终态账本，不是 5,000 次按钮点击，也不是 5,000 篇母稿。

### 基础算量

- 24 小时均匀执行：`5,000 / 24 = 208.3` target/小时，即 `3.47` target/分钟。
- 集中在 8 小时：`625` target/小时，即 `10.42` target/分钟。
- 必要并发近似为：`目标数 / 可用秒数 * p95 单任务秒数 * 重试膨胀系数`。
- 若 8 小时窗口、p95 交付耗时 120 秒、重试膨胀 1.2，则持续并发约 `25`；再预留 2 倍峰值，需要约 `50` 个执行槽位。

现有 Producer 单实例上限为 16。[并发上限](../../apps/agent-mcp/src/automation-producer.ts#L1-L1) 16 个槽位在 8 小时内完成 5,000 个 target，要求平均占槽时间低于约 92 秒，而且这是 100% 利用率、无重试、无平台冷却的理论值。对浏览器发布不应依赖这一乐观条件。

正确方案是：

1. Producer/worker 可水平扩展，数据库 claim 保证不重复；并发上限按实例设置，不用一个巨大进程承担全部任务。
2. 账号内默认串行，跨账号并行；平台、租户、账号分别有速率、日配额、冷却和错误预算。
3. 调度器按 tenant/platform/account 做公平分配和时间抖动，不把 5,000 个目标在整点同时释放。
4. 点击/提交后超时进入 `uncertain/readback_pending`，不得为追求量而自动重发。
5. 建立容量仿真：5,000 target、预设失败率/429/掉线/挑战/回读延迟，验收无重复、无跨租户、队列能在窗口内清空。
6. 按年约 182.5 万个最终变体规划 attempts、receipts、readbacks、日志的索引、分区、归档和聚合，不让运营报表扫描全量明细。

首批容量指标应包括：队列 lag、每分钟完成量、平台审核通过率、重试膨胀、重复发布率、提交不确定率、账号掉线/挑战率、每账号配额消耗和 p95 交付时长。

## 9. 发布结果与数据统计

SmartMediaHub 的统计前端明确注明为模拟数据，并硬编码阅读、粉丝和收益。[前端统计](https://github.com/aiseall/SmartMediaHub/blob/73561dd82f3685bfb6b93729e560478f2bd4f5df/frontend/src/pages/DataStatistics.tsx#L11-L23) 后端 `POST /statistics` 接受请求体中的 `userId/platform/views/reads/fans/earnings` 并直接 upsert，没有平台采集或证据。[统计控制器](https://github.com/aiseall/SmartMediaHub/blob/73561dd82f3685bfb6b93729e560478f2bd4f5df/backend/controllers/statisticsController.ts#L1-L18)

这不能作为“平台审核通过”或“文章已发布”的证据。GEO 应区分：

- `submission_observation`：平台编辑器是否接受提交；
- `publication_receipt`：平台 API/页面返回的交付回执；
- `public_readback`：公开内容或官方内容管理页的独立确认；
- `platform_moderation`：待审、通过、驳回、下架；
- `performance_snapshot`：阅读/互动等带来源、采集时间和证据 hash 的快照。

用户的成功口径是“平台单次审核通过”，因此最终业务终态应是 `platform_approved`，不能把 `submit_clicked`、HTTP 200 或本地 Content 记录算成成功。

## 10. 安全与多租户审计

以下问题足以阻止 SmartMediaHub 后端进入任何联网环境。

### 阻断级问题

1. **未鉴权远程命令注入。** `/api/deps/install|upgrade|remove` 把请求体 `name` 直接拼进 shell 命令，并通过 `child_process.exec` 执行。[危险路由](https://github.com/aiseall/SmartMediaHub/blob/73561dd82f3685bfb6b93729e560478f2bd4f5df/backend/routes/depsRoutes.ts#L19-L43) API 没有鉴权中间件，攻击者可构造 shell 元字符执行任意命令。该模块必须整体 Avoid，而不是补一个前端确认框。
2. **API 完全没有身份/租户边界。** `app.ts` 对所有路由开放，`cors()` 允许任意 origin；JWT 只在登录时签发，从未被验证。[路由入口](https://github.com/aiseall/SmartMediaHub/blob/73561dd82f3685bfb6b93729e560478f2bd4f5df/backend/app.ts#L18-L36) 任意调用者可伪造 `userId` 写内容、账号和统计，或按 Mongo ID 删除别人的记录。
3. **固定 JWT secret + 内存用户库。** 注册数据只存进进程数组，重启即丢失；JWT 使用源码中的固定 `your_jwt_secret`，环境里的 `JWT_SECRET` 没有被读取。[用户控制器](https://github.com/aiseall/SmartMediaHub/blob/73561dd82f3685bfb6b93729e560478f2bd4f5df/backend/controllers/userController.ts#L1-L27)
4. **任意目标服务端请求。** video generation 允许未鉴权调用者指定任意 `apiUrl`，后端携带调用者提供的 Bearer key 请求目标，形成 SSRF 和秘密外送面。[视频服务](https://github.com/aiseall/SmartMediaHub/blob/73561dd82f3685bfb6b93729e560478f2bd4f5df/backend/services/videoGenService.ts#L1-L29)

### 其他严重问题

- `mongoose.connect` 在后端源码中不存在，所以配置的 Mongo 服务并未被应用使用。
- 生产 Docker 编译 TypeScript 到 `dist`，却继续启动仓库根部旧 `app.js`；API 路由完全不可达。[Dockerfile](https://github.com/aiseall/SmartMediaHub/blob/73561dd82f3685bfb6b93729e560478f2bd4f5df/backend/Dockerfile#L11-L24)
- 生产 compose 暴露 MongoDB 端口，并硬编码 root 密码和 JWT secret。[生产 compose](https://github.com/aiseall/SmartMediaHub/blob/73561dd82f3685bfb6b93729e560478f2bd4f5df/docker-compose.prod.yml#L14-L40)
- 开发 Mongo 初始化脚本写入源码内固定的明文管理员密码。[初始化脚本](https://github.com/aiseall/SmartMediaHub/blob/73561dd82f3685bfb6b93729e560478f2bd4f5df/mongodb-init.js#L18-L26)
- ASR 上传没有文件大小/类型治理，临时上传文件在转写后也没有删除。[上传路由](https://github.com/aiseall/SmartMediaHub/blob/73561dd82f3685bfb6b93729e560478f2bd4f5df/backend/routes/asrRoutes.ts#L1-L20)
- 前端只检查 `localStorage` 中是否存在任意 token 字符串，且页面路由本身没有保护。[Dashboard 检查](https://github.com/aiseall/SmartMediaHub/blob/73561dd82f3685bfb6b93729e560478f2bd4f5df/frontend/src/pages/Dashboard.tsx#L13-L35) 登录成功还跳转到未定义的 `/dashboard` 路由。[登录跳转](https://github.com/aiseall/SmartMediaHub/blob/73561dd82f3685bfb6b93729e560478f2bd4f5df/frontend/src/pages/Login.tsx#L12-L21) [实际路由](https://github.com/aiseall/SmartMediaHub/blob/73561dd82f3685bfb6b93729e560478f2bd4f5df/frontend/src/App.tsx#L11-L24)

这些不是 GEO 追求大规模无人值守时可以放松的“审核门禁”。内容审核可以轻量，但身份、租户、凭据、幂等和发布证据必须更严格，因为规模会同步放大误发、重复发和账号损失。

## 11. UI、视觉与过渡动画

### 可参考

- 首页用四个入口表达创作、账号、统计和依赖管理，模块名称容易理解。[Dashboard](https://github.com/aiseall/SmartMediaHub/blob/73561dd82f3685bfb6b93729e560478f2bd4f5df/frontend/src/pages/Dashboard.tsx#L67-L107)
- 富媒体编辑器使用 MUI 图标、Tooltip 和对话框，把 AI 图片、语音、ASR、图片转视频、本地图片与文件插入放在同一工具栏。[编辑器工具栏](https://github.com/aiseall/SmartMediaHub/blob/73561dd82f3685bfb6b93729e560478f2bd4f5df/frontend/src/components/RichMediaEditor.tsx#L126-L149)
- 登录和注册表单字段完整，适合作为“简单流程包含哪些状态”的清单，而不是视觉模板。

### 不应复制

- 视觉几乎由深蓝 + 荧光青单色渐变和发光卡片组成，不适合高频运营控制台；大块欢迎文案和卡片入口占用首屏空间。
- 样式大量内联，没有主题 token、统一密度、语义色、状态动效或响应式操作表格。
- Dashboard 卡片没有 hover/press/status transition；项目没有 motion library 或页面过渡系统。`App.css` 中唯一 keyframe 是 Vite 模板 logo-spin，而且 `App.tsx` 未导入该文件，不能算产品动效。[模板 CSS](https://github.com/aiseall/SmartMediaHub/blob/73561dd82f3685bfb6b93729e560478f2bd4f5df/frontend/src/App.css#L1-L42)
- Dashboard 引用 `/assets/logo.svg`，固定源码的前端 public 目录没有该文件。[引用位置](https://github.com/aiseall/SmartMediaHub/blob/73561dd82f3685bfb6b93729e560478f2bd4f5df/frontend/src/pages/Dashboard.tsx#L37-L44)
- 前端当前无法通过构建，不能作为可复用 UI 基座。

### GEO 建议的信息架构

第一屏应直接是运营控制台，而不是入口卡片：

1. **热点雷达：** 来源健康、热点簇、热度曲线、地域/行业筛选、选题篮。
2. **创作工作室：** brief、证据、母稿、软广配比变量、平台变体并排预览。
3. **分发中心：** 批次、账号矩阵、时间窗、队列吞吐、每 target 状态、失败/回读。
4. **账号中心：** 登录交接、会话健康、配额、并发、挑战、重新认证。
5. **治理与效果：** 六类轻审核结果、平台审核状态、公开回读、GEO 可见性和内容表现。

动效应帮助用户理解状态，不应让所有东西持续运动：页面/抽屉 160-220ms，按钮与卡片 120-160ms，状态变化使用颜色 + 图标 + 稳定尺寸的进度过渡，列表新增/移除用短淡入位移，并完整支持 `prefers-reduced-motion`。长任务显示真实阶段和队列位置，不能用循环动画掩盖未知状态。

## 12. Adopt / Adapt / Avoid

### Adopt：吸收概念，不复制代码

1. 创作、账号、排期、统计四类运营工作区的基本命名。
2. 富媒体操作集中工具栏、熟悉图标和 Tooltip。
3. AI provider 作为可替换能力的产品概念。
4. 文章与未来音频/视频在同一 campaign 工作区编排的方向。

### Adapt：按 GEO 现有架构重写

1. 把“平台 checkbox”改成账号矩阵；选择账号后为每个 target 生成、冻结和审核独立 variant。
2. 把“定时任务列表”改成 durable batch/run/target 视图，显示 claim、attempt、lease、retry、uncertain 和 readback 状态。
3. 把“账号名输入框”改成平台登录交接、identity probe、opaque session binding 和健康状态机。
4. 把“模型路由”改成异步 GenerationJob、模板版本、模型路由策略、结构化输出和成本追踪。
5. 把“统计表”改成带 source/evidence/capturedAt 的 platform moderation、readback 和 performance snapshots。
6. 把 Dashboard 的模块概念改造成高密度流水线工作台，并建立统一 motion tokens。

### Avoid：明确禁止采用

1. 整套后端和 Mongo 模型。
2. `platforms: string[]` 作为多平台分发模型。
3. React 本地数组伪装账号或定时任务。
4. 未鉴权 API、客户端提供 `userId`、按裸 ID 删除资源。
5. 固定 JWT secret、明文示例密码和 localStorage 存在即已登录。
6. 动态 npm 安装/升级/卸载功能，尤其是 shell 拼接实现。
7. 调用方提供任意 `apiUrl/apiKey` 的服务端代理。
8. 硬编码/可写统计数据作为平台发布或审核证据。
9. 生产 `app.js`、Docker/compose 和失败的 Grunt CI。
10. 在许可证澄清前直接复制任何源码片段。

## 13. 许可证与复用边界

README 第 125-126 行写“MIT”，但固定源码树没有根 LICENSE/COPYING 文件；GitHub 仓库元数据 `license` 为 null，`GET /repos/aiseall/SmartMediaHub/license` 返回 404。与此同时，[后端 package 声明 ISC](https://github.com/aiseall/SmartMediaHub/blob/73561dd82f3685bfb6b93729e560478f2bd4f5df/backend/package.json#L14-L17)，根 package 没有 license 字段。[README 声明](https://github.com/aiseall/SmartMediaHub/blob/73561dd82f3685bfb6b93729e560478f2bd4f5df/README.md#L122-L126)

仅写许可证名称而没有完整许可文本，会造成版权通知、授权条件和适用范围不明确。对商业 GEO 项目，当前边界应是：

- 可以学习公开展示的功能概念和页面信息架构；
- 不把该仓库作为依赖，不复制源码、样式或资产；
- 若确需复制，先要求上游加入明确的根 LICENSE，并对目标 commit、文件历史和资产权利做第三方清单；
- 平台自动化许可与源码许可是两件事，仍需分别核对平台 API/账号授权和内容权利。

## 14. 推荐实施顺序

SmartMediaHub 不提供可落地代码，但它帮助确认产品表面应覆盖哪些工作区。结合 GEO 现状，建议按以下顺序补齐：

1. **热点纵向切片：** Research source -> capture -> hot signal -> topic cluster -> 选题 UI；先做 2-3 个来源和可审计证据。
2. **AI 软广纵向切片：** brief -> canonical article -> 可调 70/20/10 配比 -> 六类轻审核 -> 一个平台 variant。
3. **多平台变体：** 建立 PlatformContentProfile，批量生成账号级 final variant，并在 UI 并排查看差异和审核结果。
4. **批次分发：** 一个 batch 多账号 target，复用现有 claim/lease/heartbeat/checkpoint/outbox，补容量与失败注入测试。
5. **账号运行时：** 抽象携程已有的 profile/session provider，为新平台实现登录交接、会话健康、账号串行和全局容量。
6. **平台 adapter：** 优先公开/合作 API；浏览器平台从 draft/preflight/readback 开始，能力未验证前保持 dry-run/manual。
7. **5,000/天验收：** 在模拟 adapter 上跑完整日批，证明无重复、无跨租户、可恢复、可回读；再按平台配额逐步放量。
8. **UI 收口：** 热点、创作、分发、账号、治理五个工作区统一视觉、响应式和动效 token，最后做桌面/移动截图验收。

## 最终判断

如果“抄成熟实现”指账号登录、自动发布、异步并发和回读内核，**SmartMediaHub 没有可抄的成熟实现**，其后端反而会让 GEO 从已有的租户隔离、最终变体审计和可靠交付体系退化。

如果“学习”指快速补齐产品地图，它仍有有限价值：用户确实需要创作、账号、排期、统计和富媒体操作这些可见入口。正确用法是把这些入口映射到 GEO 现有的深层模型，再新增热点聚类、AI 生成编排、平台 profile 和规模化调度，而不是复刻 SmartMediaHub 的页面或数据结构。
