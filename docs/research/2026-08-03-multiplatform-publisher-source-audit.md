# 多平台内容发布参考项目源代码审查

日期：2026-08-03
目标：判断 `dorisoy/ShortVideo.AutoPublisher` 与 `Anning01/AIMedia` 中哪些实现值得 GEO SaaS 在扩展更多平台时借鉴，重点覆盖账号登录与会话持久化、多账号隔离、平台适配器、内容变体、任务调度/幂等/重试、发布结果确认、安全和许可证。

## 审查范围与版本

- ShortVideo.AutoPublisher：commit [`d066bd337974149ecc2d1e4380ecc5847286af0e`](https://github.com/dorisoy/ShortVideo.AutoPublisher/tree/d066bd337974149ecc2d1e4380ecc5847286af0e)，提交日期 2026-04-13。
- AIMedia：commit [`e4e8891c9d787a2ebfe97bb8ebce3cf50498e440`](https://github.com/Anning01/AIMedia/tree/e4e8891c9d787a2ebfe97bb8ebce3cf50498e440)，提交日期 2026-07-15。
- 结论来自上述版本的实体、仓储、服务、调度器、浏览器自动化、API、客户端和许可证源文件，而非 README 的功能宣称。
- 本地静态验证：AIMedia 的 Python 文件通过 `compileall`；ShortVideo.AutoPublisher 未能构建，因为审查环境没有 `dotnet`。两个项目都没有可执行的发布流程自动化测试；ShortVideo.AutoPublisher 没有跟踪任何测试文件，AIMedia 的两个 `tests.py` 只有占位注释。

## 结论摘要

**两者都不适合直接成为 GEO 的多平台发布内核。** 它们适合充当平台页面调研样本和产品流程参考，不适合复制其登录、调度、成功判定或安全实现。

- ShortVideo.AutoPublisher 的优点是 C# 代码边界较清楚：`IAiAgent` 定义初始化、上传、元数据、封面、发布步骤，`AgentFactory` 集中选择平台实现。这种“平台步骤接口 + 显式注册”的形状值得借鉴。但实际调度器没有调用上传和元数据步骤，只在初始化后点击发布；多账号实际退化为每个平台一个默认账号；重试会无条件重做提交；成功只靠页面文字或 URL 片段。
- AIMedia 的优点是已经把用户、平台账号、文章任务、每日发布量和本地发布配置组织成一个产品流程，并覆盖头条号、百家号、企鹅号和微信公众号四类文章平台。它还能保留原文与 AI 改写结果，说明“采集 -> 生成 -> 图片处理 -> 发布”的编排方向。但它存储和下发原始 cookie，依赖随机轮询和进程内线程，没有原子领取、租约、幂等键或提交后不确定状态；各平台代码点击按钮后直接报告成功。
- GEO 当前的 `PlatformConnector`、租户/账号作用域、平台变体、账号独立 profile、串行会话、一次性提交和独立公开回读已经比两个参考项目成熟。正确方向是**把参考项目的平台 DOM 经验移植进 GEO 现有合同**，而不是用它们替换现有合同。
- 平台顺序上，GEO 当前是文章发布产品，优先研究头条号、百家号、微信公众号比抖音/小红书更贴合现有 `PublicationVariantPayload`。AIMedia 可用于这三类页面字段和交互的侦察；ShortVideo.AutoPublisher 的抖音/小红书代码应留到视频内容模型、视频媒体审计和平台授权就绪之后。

## 成熟度矩阵

评分含义：`可借鉴` 表示可吸收设计思路；`仅侦察` 表示只能辅助理解页面；`不可采用` 表示不能进入 GEO 的生产信任边界。

| 维度       | ShortVideo.AutoPublisher                                     | AIMedia                                                                    | 对 GEO 的判断                                                |
| ---------- | ------------------------------------------------------------ | -------------------------------------------------------------------------- | ------------------------------------------------------------ |
| 登录与会话 | 原始 cookie JSON 写入 SQLite，每次任务创建临时浏览器 context | 人工网页登录后抓 cookie，原样上传 Django `JSONField`，发布时再下发客户端   | 仅可参考人工绑定流程；禁止复制凭据存储方式                   |
| 多账号     | 有 `CookieSession` 实体，但创建任务只选择平台默认账号        | 服务端用户-账号外键和按用户查询较完整，但存在跨用户账号接管漏洞            | 借鉴账号目录字段，不借鉴所有权实现                           |
| 平台适配   | 两个类实现共同接口；枚举声称五个平台但工厂只支持两个         | 一个总入口分派四个平台函数，平台代码高度过程化                             | 借鉴显式注册和平台模块拆分；必须接入 GEO 现有 connector 合同 |
| 内容变体   | 单个 `VideoContent` 直接复用于所有平台                       | 保存原文/改写文，但实际发布仍是平台无关字符串                              | 借鉴原文-改写追踪，不可替代 GEO 平台变体与审计哈希           |
| 调度与限额 | SQLite 状态轮询、定时字段、固定 5 秒自动重试                 | 随机账号顺序、最近发布时间冷却、每日计数                                   | 产品概念可参考；执行机制不可采用                             |
| 幂等与重试 | 无幂等键、无领取锁、失败统一重试                             | 无幂等键/租约；失败时删除任务                                              | 不可采用                                                     |
| 发布确认   | DOM 文案或 URL 片段即成功                                    | 点击发布后设 `status=True`                                                 | 不可采用，必须保留 GEO 独立 readback                         |
| 安全       | 明文 cookie、CLI 参数传 cookie、反检测脚本、`--no-sandbox`   | 明文 cookie/JWT、响应日志、关闭 TLS 校验、宽松 Django 配置、源码含会话样例 | 不可采用                                                     |
| 许可证     | MIT，可商用修改，需保留版权与许可声明                        | Apache-2.0，含专利许可，分发修改文件需标注变更并保留声明                   | 法律上可评估复用，但仍需逐文件来源审查和依赖清单             |

## 1. 账号登录与会话持久化

### ShortVideo.AutoPublisher

`CookieSession` 保存平台、账号名、账号 ID、cookie、有效/默认标记和最后验证时间，但 `CookieData` 是普通字符串，没有加密引用或外部 secret store；SQLite 表同样直接存 `CookieData TEXT`。[实体源码](https://github.com/dorisoy/ShortVideo.AutoPublisher/blob/d066bd337974149ecc2d1e4380ecc5847286af0e/src/ShortVideo.AutoPublisher.Core/Domain/Entities/Entities.cs#L64-L84) [建表源码](https://github.com/dorisoy/ShortVideo.AutoPublisher/blob/d066bd337974149ecc2d1e4380ecc5847286af0e/src/ShortVideo.AutoPublisher.Core/Infrastructure/Data/AppDbContext.cs#L81-L92)

会话恢复使用 Playwright 新建隔离 context 后 `AddCookiesAsync`。它在单进程内能避免不同任务共享同一浏览器 context，这是可借鉴的最小隔离意识；但只恢复 cookie，不覆盖 local storage、IndexedDB、设备绑定、挑战状态或持久 profile，也没有账号身份回读。[BrowserManager](https://github.com/dorisoy/ShortVideo.AutoPublisher/blob/d066bd337974149ecc2d1e4380ecc5847286af0e/src/ShortVideo.AutoPublisher.Core/OpenClaw/Browser/BrowserManager.cs#L47-L87)

所谓“验证账号”只是检查 cookie 字符串非空，然后更新时间，并没有访问平台或验证当前登录身份。[CookieSessionService](https://github.com/dorisoy/ShortVideo.AutoPublisher/blob/d066bd337974149ecc2d1e4380ecc5847286af0e/src/ShortVideo.AutoPublisher.Core/Services/AppServices.cs#L113-L122) CLI 还要求把 cookie 直接放进命令行参数，容易进入 shell history 和进程列表。[AccountCommand](https://github.com/dorisoy/ShortVideo.AutoPublisher/blob/d066bd337974149ecc2d1e4380ecc5847286af0e/src/ShortVideo.AutoPublisher.Cli/Commands/AccountCommand.cs#L23-L40)

**判断：** 可参考“一任务一浏览器 context”的局部做法，不能采用 cookie 作为账号目录字段、非空即有效或命令行导入秘密。GEO 应继续使用 `channelAccountId -> opaque profileKey` 绑定、人工登录、账号身份核验、session/challenge 状态和 profile 单 owner。

### AIMedia

账号接入流程在桌面端启动真实浏览器，等待用户登录，抓取昵称、UID 和全部 cookie，然后通过 API 上传服务端。[账号接入线程](https://github.com/Anning01/AIMedia/blob/e4e8891c9d787a2ebfe97bb8ebce3cf50498e440/pyside/components/account_manager_widget.py#L126-L180) 服务端 `Accounts.cookie` 是普通 `JSONField`，序列化器使用 `fields = "__all__"`，因此 cookie 会随账号 API 返回客户端。[模型](https://github.com/Anning01/AIMedia/blob/e4e8891c9d787a2ebfe97bb8ebce3cf50498e440/back/apps/users/models.py#L98-L125) [序列化器](https://github.com/Anning01/AIMedia/blob/e4e8891c9d787a2ebfe97bb8ebce3cf50498e440/back/apps/users/serializers.py#L12-L23)

发布时客户端再次读取账号完整记录、提取 cookie、创建全新 WebDriver 并逐个 `add_cookie`。这不是会话隔离，只是凭据复制；多台客户端可同时拿到并使用同一账号会话。[任务发布路径](https://github.com/Anning01/AIMedia/blob/e4e8891c9d787a2ebfe97bb8ebce3cf50498e440/pyside/components/task_center_widget.py#L263-L282) [浏览器分派](https://github.com/Anning01/AIMedia/blob/e4e8891c9d787a2ebfe97bb8ebce3cf50498e440/pyside/auto_browser/auto_base.py#L464-L506)

AIMedia 自身用户登录比平台账号登录稍完整：Django 校验密码并签发 access/refresh JWT；但桌面端只保存 access token 到 `QSettings`，没有 OS keychain、refresh/rotation 逻辑，默认有效期七天。[登录 API](https://github.com/Anning01/AIMedia/blob/e4e8891c9d787a2ebfe97bb8ebce3cf50498e440/back/apps/users/views.py#L46-L60) [客户端持久化](https://github.com/Anning01/AIMedia/blob/e4e8891c9d787a2ebfe97bb8ebce3cf50498e440/pyside/utils/auth_service.py#L135-L157) [JWT 设置](https://github.com/Anning01/AIMedia/blob/e4e8891c9d787a2ebfe97bb8ebce3cf50498e440/back/ArticleManagePlus/settings.py#L167-L179)

**判断：** “人工浏览器登录 -> 提取账号身份 -> 建立账号记录”的产品体验值得借鉴；技术实现必须改成服务端受保护 profile，API 只返回 session 状态和 opaque reference，永不返回 cookie、storage state 或真实目录。

## 2. 多账号隔离与所有权

ShortVideo.AutoPublisher 可以保存多个会话，任务也记录 `SessionId`，这是正确的数据关联起点。[PublishTask](https://github.com/dorisoy/ShortVideo.AutoPublisher/blob/d066bd337974149ecc2d1e4380ecc5847286af0e/src/ShortVideo.AutoPublisher.Core/Domain/Entities/Entities.cs#L31-L49) 但任务创建总是 `GetDefaultByPlatformAsync`，API 没有显式账号选择；默认标记也没有数据库唯一约束或事务，多个并发写入可能留下多个默认账号。[PublishService](https://github.com/dorisoy/ShortVideo.AutoPublisher/blob/d066bd337974149ecc2d1e4380ecc5847286af0e/src/ShortVideo.AutoPublisher.Core/Services/PublishService.cs#L121-L149) [仓储](https://github.com/dorisoy/ShortVideo.AutoPublisher/blob/d066bd337974149ecc2d1e4380ecc5847286af0e/src/ShortVideo.AutoPublisher.Core/Infrastructure/Data/Repositories/Repositories.cs#L78-L100) 它没有租户概念、账号级队列、配额、熔断或 profile owner。

AIMedia 的 `Accounts.user` 外键、账号状态、到期时间、每日发布量和 `AccountNews.account` 是更接近 SaaS 的目录模型；查询也通常按 `request.user` 过滤，文章创建时会拒绝绑定别人的账号。[模型](https://github.com/Anning01/AIMedia/blob/e4e8891c9d787a2ebfe97bb8ebce3cf50498e440/back/apps/users/models.py#L98-L162) [文章所有权验证](https://github.com/Anning01/AIMedia/blob/e4e8891c9d787a2ebfe97bb8ebce3cf50498e440/back/apps/users/serializers.py#L35-L65) [查询隔离](https://github.com/Anning01/AIMedia/blob/e4e8891c9d787a2ebfe97bb8ebce3cf50498e440/back/apps/users/views.py#L102-L125)

但账号创建存在严重越权：代码先按全局唯一 UID 查询账号，不限制当前用户；命中后用请求数据更新记录，`perform_update()` 还把 `user` 改成当前请求用户。知道另一个账号 UID 的已认证用户可以尝试把该账号连同 cookie 转移给自己。[AccountsViewSet](https://github.com/Anning01/AIMedia/blob/e4e8891c9d787a2ebfe97bb8ebce3cf50498e440/back/apps/users/views.py#L71-L100) 此外，“每日发布量”只在创建文章时按 `date_str` 计数，不是并发安全的发布配额，也没有预约/已受理/待回读占用量。[配额检查](https://github.com/Anning01/AIMedia/blob/e4e8891c9d787a2ebfe97bb8ebce3cf50498e440/back/apps/users/serializers.py#L56-L65)

**判断：** 可借鉴账号状态、到期时间、每日业务上限和账号-内容关联字段；不可复制全局 UID upsert、cookie API 或应用层计数。GEO 的所有账号唯一性、更新、配额和领取都必须以 `tenantId + platform + channelAccountId` 为边界，并由数据库约束/事务证明。

## 3. 平台适配器结构

ShortVideo.AutoPublisher 的 `IAiAgent` 把发布流程拆成初始化、视频上传、元数据、封面和最终发布，`AgentFactory` 用平台枚举集中实例化实现。这是两个项目中最清楚、最值得参考的代码边界。[接口](https://github.com/dorisoy/ShortVideo.AutoPublisher/blob/d066bd337974149ecc2d1e4380ecc5847286af0e/src/ShortVideo.AutoPublisher.Core/OpenClaw/Abstractions/Abstractions.cs#L68-L91) [工厂](https://github.com/dorisoy/ShortVideo.AutoPublisher/blob/d066bd337974149ecc2d1e4380ecc5847286af0e/src/ShortVideo.AutoPublisher.Core/OpenClaw/Agents/AgentFactory.cs#L26-L33)

它的成熟度仍有限：平台枚举和 CLI 声称支持抖音、小红书、百家号、视频号、头条五个平台，但工厂只有抖音和小红书两个实现；选择器是大量模糊 CSS/text fallback，没有版本、页面契约探针或 selector drift 证据。[平台枚举](https://github.com/dorisoy/ShortVideo.AutoPublisher/blob/d066bd337974149ecc2d1e4380ecc5847286af0e/src/ShortVideo.AutoPublisher.Core/Domain/Enums/PlatformType.cs#L6-L31) [小红书选择器](https://github.com/dorisoy/ShortVideo.AutoPublisher/blob/d066bd337974149ecc2d1e4380ecc5847286af0e/src/ShortVideo.AutoPublisher.Core/OpenClaw/Agents/XiaohongshuAgent.cs#L18-L87)

更严重的是接口没有被调度器正确编排：`ExecuteTaskAsync` 取到账号后只执行 `InitializeAsync` 和 `PublishAsync`，没有加载 `VideoContent`，也没有调用 `UploadVideoAsync`、`SetVideoMetadataAsync` 或 `SetCoverImageAsync`。当前调度路径会直接在空发布页上点击发布。[调度器](https://github.com/dorisoy/ShortVideo.AutoPublisher/blob/d066bd337974149ecc2d1e4380ecc5847286af0e/src/ShortVideo.AutoPublisher.Core/OpenClaw/TaskScheduler/PublishTaskScheduler.cs#L149-L181)

AIMedia 的 `AutoTools.publish()` 是一个平台分派器：头条逻辑内联，百家号、微信公众号、企鹅号分别调用平台函数。[分派源码](https://github.com/Anning01/AIMedia/blob/e4e8891c9d787a2ebfe97bb8ebce3cf50498e440/pyside/auto_browser/auto_base.py#L200-L206) [分支源码](https://github.com/Anning01/AIMedia/blob/e4e8891c9d787a2ebfe97bb8ebce3cf50498e440/pyside/auto_browser/auto_base.py#L464-L506) 这有利于定位平台代码，但没有公共适配器接口、能力声明、输入校验、平台版本、preflight、submit/readback 分离或契约测试；新增平台仍要修改中央 `if/elif`。

**判断：** 从 ShortVideo.AutoPublisher 借鉴“细步骤接口”和显式工厂，从 AIMedia 借鉴“一平台一模块”的文件组织；实现时必须落入 GEO 现有 `PlatformConnector` 的 `probeCapabilities -> validateSession -> renderDraft -> preflight -> submit/publish -> pollStatus -> reconcile -> captureEvidence` 合同，不新增第二套 agent 抽象。浏览器部分继续用 Bridge 的 `prepare/verifySubmit/submit/readback` 子合同，并给每个平台单独 adapter version 和 surface contract。

## 4. 内容变体与自动分发

ShortVideo.AutoPublisher 只有一份 `VideoContent` 标题、描述、标签和文件路径；批量发布只是为同一视频循环创建不同平台任务，没有生成或冻结平台变体。[视频实体](https://github.com/dorisoy/ShortVideo.AutoPublisher/blob/d066bd337974149ecc2d1e4380ecc5847286af0e/src/ShortVideo.AutoPublisher.Core/Domain/Entities/Entities.cs#L5-L29) [批量任务](https://github.com/dorisoy/ShortVideo.AutoPublisher/blob/d066bd337974149ecc2d1e4380ecc5847286af0e/src/ShortVideo.AutoPublisher.Core/Services/PublishService.cs#L155-L180)

AIMedia 会保存 `AiArticle` 的原始标题/正文、新标题/正文、图片和 token 使用量，值得借鉴为生成溯源。[AiArticle](https://github.com/Anning01/AIMedia/blob/e4e8891c9d787a2ebfe97bb8ebce3cf50498e440/back/apps/users/models.py#L279-L294) 生产流程也清楚地表达了“原内容 -> AI 改写 -> 图片处理 -> 账号 cookie -> 发布”。[TaskService](https://github.com/Anning01/AIMedia/blob/e4e8891c9d787a2ebfe97bb8ebce3cf50498e440/pyside/utils/task_service.py#L111-L147) 但发布输入只是用换行拆分标题和正文的普通字符串，平台之间没有不同边界、媒体 manifest、内容版本或审核绑定。[头条内容拆分](https://github.com/Anning01/AIMedia/blob/e4e8891c9d787a2ebfe97bb8ebce3cf50498e440/pyside/auto_browser/auto_base.py#L243-L255)

`AccountNews` 对标题和来源 URL 使用全局唯一约束，可挡住完全相同的抓取项，但它既不是租户内去重，也不能识别近重复或不同来源的同文；全局唯一还会让不同租户互相影响。[AccountNews](https://github.com/Anning01/AIMedia/blob/e4e8891c9d787a2ebfe97bb8ebce3cf50498e440/back/apps/users/models.py#L145-L162)

**判断：** 只借鉴“保存输入和生成输出的谱系”。GEO 继续以不可变 `contentVersion -> platform variant -> payloadHash -> audit -> grant -> handoff` 为主线；每个平台从同一 canonical source 生成自己的标题、正文、标签、媒体角色和限制验证。账号分配必须先持久化，再基于已选账号生成最终变体，不能在浏览器函数内临时改写。

## 5. 调度、幂等与重试

ShortVideo.AutoPublisher 把任务状态、计划时间、重试次数、错误和发布 URL 持久化到 SQLite，作为桌面工具的最小任务账本是合理的。[任务表](https://github.com/dorisoy/ShortVideo.AutoPublisher/blob/d066bd337974149ecc2d1e4380ecc5847286af0e/src/ShortVideo.AutoPublisher.Core/Infrastructure/Data/AppDbContext.cs#L94-L109) 调度器每五秒查全部 `Pending` 并串行执行，启动时把状态更新为 `Running`。[调度循环](https://github.com/dorisoy/ShortVideo.AutoPublisher/blob/d066bd337974149ecc2d1e4380ecc5847286af0e/src/ShortVideo.AutoPublisher.Core/OpenClaw/TaskScheduler/PublishTaskScheduler.cs#L117-L157)

这不是可靠队列：没有事务 claim、lease owner、heartbeat、启动恢复或并发排他；两个进程可领取同一任务，崩溃会把任务永久留在 `Running`。失败事件用 `async void` 等五秒后把任务重置为 `Pending`，不区分提交前失败、平台拒绝和点击后的不确定结果，也没有指数退避/抖动或稳定幂等键。[自动重试](https://github.com/dorisoy/ShortVideo.AutoPublisher/blob/d066bd337974149ecc2d1e4380ecc5847286af0e/src/ShortVideo.AutoPublisher.Core/Services/PublishService.cs#L39-L64) [重置任务](https://github.com/dorisoy/ShortVideo.AutoPublisher/blob/d066bd337974149ecc2d1e4380ecc5847286af0e/src/ShortVideo.AutoPublisher.Core/OpenClaw/TaskScheduler/PublishTaskScheduler.cs#L101-L115)

AIMedia 有两个可借鉴的产品概念：账号级每日发布量，以及根据账号最近 `published_at` 做冷却。自动托管会随机打乱账号候选，每轮最多选择一个账号/文章。[账号冷却与选择](https://github.com/Anning01/AIMedia/blob/e4e8891c9d787a2ebfe97bb8ebce3cf50498e440/pyside/utils/task_service.py#L264-L332) 但执行由本地 `QThread` 和无限循环完成，没有数据库原子领取；任何客户端都能读到状态 0/1 的任务并同时发布。[任务线程](https://github.com/Anning01/AIMedia/blob/e4e8891c9d787a2ebfe97bb8ebce3cf50498e440/pyside/components/task_center_widget.py#L193-L235) 顶层异常还递归调用自身重启，长期运行可能堆积调用栈。[托管重启](https://github.com/Anning01/AIMedia/blob/e4e8891c9d787a2ebfe97bb8ebce3cf50498e440/pyside/utils/task_service.py#L348-L363)

失败处理尤其危险：发布返回 false 时直接删除服务端新闻任务，不保留失败状态、证据或重试上下文。[publish_content](https://github.com/Anning01/AIMedia/blob/e4e8891c9d787a2ebfe97bb8ebce3cf50498e440/pyside/utils/task_service.py#L231-L247)

**判断：** 借鉴“账号冷却、每日业务上限、任务可视化”的需求，不复制轮询器。GEO 应继续使用数据库 claim + lease token + heartbeat；账号内 FIFO 串行，跨账号确定性公平分配；所有尝试携带稳定 idempotency key。只有能证明尚未越过提交边界的错误可自动重试，点击后超时必须进入 `submitted_unconfirmed/readback_pending/needs_review`，不得重提或换账号。

## 6. 发布结果确认

ShortVideo.AutoPublisher 的抖音实现等待包含 `success`/“发布成功”/“已发布”的宽泛选择器，或只要 URL 含 `success`/`manage` 就返回成功，而且不返回外部 ID/URL。[抖音发布](https://github.com/dorisoy/ShortVideo.AutoPublisher/blob/d066bd337974149ecc2d1e4380ecc5847286af0e/src/ShortVideo.AutoPublisher.Core/OpenClaw/Agents/DouyinAgent.cs#L298-L347) 小红书同样把 URL 含 `note` 当成功。[小红书发布](https://github.com/dorisoy/ShortVideo.AutoPublisher/blob/d066bd337974149ecc2d1e4380ecc5847286af0e/src/ShortVideo.AutoPublisher.Core/OpenClaw/Agents/XiaohongshuAgent.cs#L266-L311) `PublishResult` 虽有 `PublishedUrl` 和截图字段，但平台实现没有填充，调度器仍会把任务标成完成。[结果类型](https://github.com/dorisoy/ShortVideo.AutoPublisher/blob/d066bd337974149ecc2d1e4380ecc5847286af0e/src/ShortVideo.AutoPublisher.Core/OpenClaw/Abstractions/Abstractions.cs#L23-L32)

AIMedia 更弱：百家号和企鹅号在按钮点击后等待五秒就把 `out_flag` 设为 true；微信公众号看到“继续发表”按钮并点击后即成功，没有读取公开文章或核对内容。[百家号](https://github.com/Anning01/AIMedia/blob/e4e8891c9d787a2ebfe97bb8ebce3cf50498e440/pyside/auto_browser/baijiahao.py#L289-L320) [企鹅号](https://github.com/Anning01/AIMedia/blob/e4e8891c9d787a2ebfe97bb8ebce3cf50498e440/pyside/auto_browser/qiehao.py#L223-L249) [微信公众号](https://github.com/Anning01/AIMedia/blob/e4e8891c9d787a2ebfe97bb8ebce3cf50498e440/pyside/auto_browser/weixin.py#L333-L384)

**判断：** 这些只能当 UI 操作是否推进的弱观察，不能生成 GEO `confirmed` 回执。每个平台接入必须有独立于提交响应/页面的公开或官方状态 readback，绑定同一账号、外部 ID/URL、标题/正文/媒体哈希和发布时间。没有 readback 能力的平台最高保持 `manual_only` 或 `browser_assisted`，不能仅凭按钮点击升级为 unattended。

## 7. 安全审查

### ShortVideo.AutoPublisher

- cookie 明文进入 SQLite，并可从 CLI 参数注入；没有 secret reference、加密、权限分区或日志脱敏合同。
- Chromium 使用 `--no-sandbox`，并注入覆盖 `navigator.webdriver`、plugins、languages 的反检测脚本。[BrowserManager](https://github.com/dorisoy/ShortVideo.AutoPublisher/blob/d066bd337974149ecc2d1e4380ecc5847286af0e/src/ShortVideo.AutoPublisher.Core/OpenClaw/Browser/BrowserManager.cs#L32-L67) 这既扩大本机浏览器风险，也可能违反平台条款；不能进入 GEO 的合规实现。
- `EnsureBrowserAsync()` 没有并发锁；共享 singleton 在并发首次调用时可能重复启动浏览器。配置声明的 `MaxConcurrentTasks` 和 Polly 依赖并未进入实际调度路径。

### AIMedia

- Django 默认配置包含硬编码 fallback secret，`DEBUG=True`、`ALLOWED_HOSTS=["*"]`，默认数据库为 SQLite。[settings](https://github.com/Anning01/AIMedia/blob/e4e8891c9d787a2ebfe97bb8ebce3cf50498e440/back/ArticleManagePlus/settings.py#L24-L52)
- 桌面 API 默认走 `http://127.0.0.1`；扫码和密码登录显式 `verify=False`，并打印响应头、响应正文、二维码 URL/state。通用请求处理器也打印每个原始响应，可能记录 JWT、cookie 或用户内容。[请求处理器](https://github.com/Anning01/AIMedia/blob/e4e8891c9d787a2ebfe97bb8ebce3cf50498e440/pyside/api/request_handler.py#L11-L40) [AuthService](https://github.com/Anning01/AIMedia/blob/e4e8891c9d787a2ebfe97bb8ebce3cf50498e440/pyside/utils/auth_service.py#L19-L31)
- 平台 cookie 通过 API 双向传输且可被任意桌面客户端复用；access token 明文进入 `QSettings`。
- 源码注释中包含完整会话 cookie/JWT 样例。即使样例已经过期，这也说明项目缺少 secret scanning 和凭据卫生，不应复制相关文件内容。
- 大量裸 `except` 静默吞掉页面错误，使 selector drift、登录挑战和内容校验失败难以被分类、审计或熔断。
- 前述按全局 UID 更新账号的路径是实际租户隔离漏洞，必须视为阻断级风险。

**判断：** 两个项目的浏览器代码都只能在隔离的研究环境中阅读和重新实现，不应作为依赖包直接加载，也不应运行在持有 GEO 生产凭据的主机上。移植选择器前需要平台授权审查、重新捕获当前 DOM、写负向测试、启用日志脱敏和 Kill Switch。

## 8. 许可证与复用边界

ShortVideo.AutoPublisher 使用 MIT 许可证，允许使用、修改、分发和商业化，但复制“全部或 substantial portions”时必须保留版权和许可声明。[LICENSE](https://github.com/dorisoy/ShortVideo.AutoPublisher/blob/d066bd337974149ecc2d1e4380ecc5847286af0e/LICENSE#L1-L20) 许可证版权人为 `mschen_`，与当前 GitHub 仓库所有者名称不同；这不自动否定许可，但直接复制前应核对仓库来源/分叉关系和目标文件历史。

AIMedia 使用 Apache License 2.0，包含版权和专利许可；分发衍生代码时需附许可证、标注修改文件并保留适用声明。[版权/专利许可](https://github.com/Anning01/AIMedia/blob/e4e8891c9d787a2ebfe97bb8ebce3cf50498e440/LICENSE#L66-L87) [再分发条件](https://github.com/Anning01/AIMedia/blob/e4e8891c9d787a2ebfe97bb8ebce3cf50498e440/LICENSE#L89-L121) 当前仓库没有 `NOTICE` 文件，但 GEO 若复制代码，仍应在 third-party inventory 中记录来源、commit、文件、修改和许可证。

许可证允许不等于平台允许自动化。浏览器脚本是否可用于生产发布仍取决于各平台条款、账号授权、接口能力证据、内容/媒体权利和地区规则。建议优先**重新实现行为而非复制代码**；若确需复制，单独做法律与依赖审查，不把上游 cookie 样例、反检测逻辑或硬编码 selector 原样带入。

## 对 GEO 的具体采用建议

### 可吸收

1. **平台模块的可发现性。** 采用 ShortVideo.AutoPublisher 的显式工厂思路和 AIMedia 的一平台一文件组织，但注册到 GEO `ConnectorRegistry`；新增平台必须实现完整 connector/bridge 合同和 capability report。
2. **账号目录的运营字段。** 吸收 AIMedia 的账号状态、到期时间、每日发布量和内容-账号关联概念，映射为 GEO 的 session state、保守 quota、cooldown、circuit、evidence expiry 和 queue depth，而不是直接增加一个可编辑 `status` 数字。
3. **生成谱系。** 吸收 AIMedia 同时保存原始内容与 AI 改写结果的思路，把它接入 GEO 的 canonical source、content version、platform variant、fact snapshot 和 audit artifact。
4. **页面侦察样本。** 头条、百家号、微信公众号、企鹅号、抖音和小红书的登录页、编辑器字段与发布步骤可作为选择器发现清单；所有选择器需在当前授权账号中重新验证并写 surface contract fixture。
5. **任务运营视图。** 参考两者的任务状态、错误、计划时间、重试次数和账号发布量 UI，但后台状态必须来自 GEO 的 durable job/handoff/readback 状态机。

### 必须重写

1. 登录态：改为每账号独立持久 profile + opaque binding，秘密不进业务表/API/日志。
2. 平台执行：拆分 prepare、submit boundary、submit observation、public/API readback，保留 adapter version 和内容绑定证据。
3. 调度：数据库原子 claim、短租约、heartbeat、账号内串行、跨账号确定性公平、配额/冷却/熔断。
4. 重试：按提交前、提交后不确定、永久失败分类；稳定幂等键贯穿 job/attempt/receipt/readback。
5. 结果：只有独立 readback 满足账号、内容哈希、外部 ID/URL 与时间要求，才能生成 confirmed live receipt。
6. 安全：TLS、OS/服务端 secret store、最小权限、租户约束、日志脱敏、secret scanning、浏览器沙箱和 Kill Switch。

### 不应采用

- cookie JSON 作为账号 API 字段或命令行参数；
- `navigator.webdriver` 伪装、随机延迟等规避检测逻辑；
- 点击发布按钮后直接标记成功；
- `async void`/裸 `except` 驱动的自动重试；
- 随机打乱账号作为公平调度；
- 发布失败就删除任务；
- 全局 UID upsert 或应用层查询后计数作为租户/配额保证；
- 把同一标题/正文直接投往所有平台。

## 推荐接入顺序

1. **头条号**：GEO 已有 `toutiao` dry-run connector，AIMedia 提供了文章编辑页面的完整过程样本。先做当前 DOM/条款/授权调研，再补 `browser_preflight` 和人工 draft；没有独立 readback 前保持 manual/assisted。
2. **百家号**：内容形态与 GEO 文章模型相近，AIMedia 有独立模块。重新实现 editor surface contract、账号 identity probe 和发布后详情回读，不复制其点击即成功逻辑。
3. **微信公众号**：价值高但发布/群发、原创声明、草稿和账号权限语义更复杂。先确认官方 API 或合规浏览器边界，再做草稿而非直接无人值守发布。
4. **企鹅号**：可作为下一批文章渠道，但先验证平台当前可用性、官方能力和业务价值；参考代码的 selectors 可能已经过时。
5. **抖音/小红书**：等 GEO 建立视频资产、转码、封面、标签、版权审核和视频发布回读合同后再接。ShortVideo.AutoPublisher 的接口可帮助列步骤，现有实现不能作为成功证据。

## GEO 现有架构应保持的基线

- `packages/connectors/src/types.ts` 已把 tenant/account scope、能力探测、session 验证、render/preflight/submit/publish/poll/reconcile/evidence 设为统一合同；新增平台应扩展它，不另建简化发布服务。
- `packages/core/src/platform-variant.ts` 已校验平台变体边界并绑定 canonical source；不要退回“一份字符串发所有平台”。
- `apps/ctrip-bridge/src/account-browser-session-provider.ts` 已按账号 profile 绑定、账号内串行和全局容量控制会话；应抽成可复用的 browser account runtime，而不是恢复原始 cookie。
- `apps/ctrip-bridge/src/types.ts` 已区分 `accepted/uncertain/rejected` 和 `confirmed/not_found/mismatch/unavailable`，并有 claim/lease/readback 控制面；这应成为新平台的状态模型模板。
- `packages/connectors/src/receipts.ts` 明确只有非 dry-run、独立 API/platform readback、外部 ID/URL 和发布时间齐备才能确认真实发布；参考项目的 DOM 成功提示不得降低这一门槛。

## 最终判断

如果“抄”指**复制成熟生产实现**，答案是否定的：两个项目在账号秘密、租户隔离、任务领取、幂等、提交不确定性和发布确认上都低于 GEO 的现有基线。

如果“抄”指**缩短平台研究和产品设计时间**，答案是肯定的：ShortVideo.AutoPublisher 的细步骤 agent 接口、AIMedia 的账号/任务产品模型和四个平台页面流程值得作为输入。最佳用法是提取页面动作清单、账号运营字段和生成谱系，再按 GEO 的 connector、variant、lease、grant、readback 和 security contract 重新实现。
