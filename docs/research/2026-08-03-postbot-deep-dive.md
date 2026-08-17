# PostBot 源码深度评估与 GEO 映射

日期：2026-08-03
研究对象：[gitcoffee-os/postbot](https://github.com/gitcoffee-os/postbot)
源码快照：当前 `main` 为 `5d03c2977714017952e758c96528991af09a1679`；README 指向的稳定分支 `1.1.20` 为 `b988d0dddcde6e32c810db6186f8902e90947ac8`
目标：判断 PostBot 在账号登录、多平台内容适配、浏览器发布、并行分发、UI 与扩展机制方面，哪些实现适合 GEO 学习，哪些必须重做。

## 结论

**PostBot 适合作为浏览器端平台交互目录和登录交接体验的研究样本，不适合作为 GEO 的发布内核，也不能直接复制到 GEO 的多租户商业服务。**

最值得采用的有四点：

1. 浏览器本地登录态复用：用户在平台原生页面完成登录，扩展不要求把平台密码上传云端。
2. 按 `内容类型 × 平台` 组织能力和 publisher，源码明确区分文章、动态、视频、音频。
3. 网页正文、选区和图片提取，以及侧边栏、浮动入口、Shadow DOM 隔离组成的浏览器工作流。
4. 大量平台发布 URL、账号状态探针和页面 selector，可作为 GEO 建立自有 adapter fixture 的调研线索。

但其核心交付模型与 GEO 的目标不匹配：同一份 `data` 原样发送给各平台；一个浏览器 profile 每个平台只有一个当前登录身份；稳定版串行创建标签页；publisher 点击按钮后没有完成回执；不存在 durable queue、租约、幂等键、账号级配额、提交不确定态或公开回读。点击发布按钮或跳转内容管理页就结束，无法证明内容已公开。

对于 **5,000 个平台最终变体/天**，PostBot 的标签页模型只能作为个人桌面辅助，不应承担调度。GEO 应继续以服务端持久化 target 队列、租户/平台/账号分层限流和账号隔离 Browser Host 为主；PostBot 只帮助完善平台动作和登录体验。

## 总体评分

| 维度           | 完成度 | 对 GEO 的价值 | 判断                                                        |
| -------------- | -----: | ------------: | ----------------------------------------------------------- |
| 浏览器登录交接 |   7/10 |            高 | 本地会话复用体验好，身份与会话治理不足                      |
| 平台覆盖目录   |   8/10 |            高 | 文章 14、动态 12、视频 9、音频 6 个目标，适合做接入调研清单 |
| 平台内容变体   |   1/10 |            低 | 同一份数据扇出，没有独立 variant、hash 和审计               |
| 自动发布动作   |   6/10 |          中高 | 页面填充脚本丰富，但没有结果合同和独立回读                  |
| 多账号         |   1/10 |            低 | 当前 Chrome profile 下每个平台只有一个身份                  |
| 并行与调度     |   2/10 |            低 | 标签页驱动，无持久队列、背压、租约和公平调度                |
| 幂等与重试     |   1/10 |            低 | 无 idempotency key；提交后不确定状态无法处理                |
| UI 工作流      |   6/10 |          中高 | 侧边栏、正文/选区提取实用；任务视图和动效较弱               |
| 扩展机制       |   4/10 |            中 | 目录清晰，但接口过浅、全局合并且无版本治理                  |
| 测试与可复现性 |   1/10 |            低 | 无测试和 CI；两个审计版本均无法 frozen install              |
| 权限与凭据安全 |   3/10 |          中低 | 不上传密码是优点，但权限过宽且会话信息可能进入日志          |
| 许可适配       | 高风险 |      负面边界 | 修改许可证明确限制未经授权的多租户源码运营                  |

## 1. 研究范围与方法

本次不是只读 README，而是对两个固定提交做源码级对照：

- 当前 `main` 用于判断项目今天公开了什么。它已把发布、内容、事件、状态和插件能力大量迁入 `@gitcoffee/*` 包。[依赖清单](https://github.com/gitcoffee-os/postbot/blob/5d03c2977714017952e758c96528991af09a1679/package.json#L12-L46)
- `1.1.20` 用于审计仍保留在公开仓库中的完整 publisher、插件、标签页和侧边栏实现。
- 静态检查覆盖消息流、账号探针、平台目录、publisher、插件注入、权限、UI 和许可证。
- 可复现检查分别尝试 frozen install 和非 frozen install；没有使用真实平台账号执行外部发布，也没有把 selector 当前仍可用作为事实。

限制需要先说明：当前 `main` 的公开仓库只是部分壳层。publisher 入口直接导入 `@gitcoffee/postbot-publisher-cn`、`-it` 和 `-industry`，[源码](https://github.com/gitcoffee-os/postbot/blob/5d03c2977714017952e758c96528991af09a1679/src/media/publisher/publisher.script.ts#L16-L37)；公开 npm 又无法取得审计时所需的若干 `@gitcoffee/*` 包。因此 README 对当前版本的完整能力不能仅靠该仓库独立复现或审计。以下对具体发布动作的判断，以仍公开完整源码的 `1.1.20` 为主要证据。

## 2. 真实架构

PostBot 是 Plasmo + Vue 的 Chrome 扩展，主流程是：

```text
网页内容脚本 / 云端页面消息
  -> background 保存同一份 contentData
  -> 根据用户勾选的平台生成标签页
  -> 页面加载完成后注入对应 publisher 函数
  -> publisher 操作 DOM、填充内容、可选点击发布
```

它不是服务端任务系统，也不是多租户 publisher worker。稳定版 `PUBLISH_NOW` 将被勾选的平台和同一个 `data` 交给 `windowPublish`，[源码](https://github.com/gitcoffee-os/postbot/blob/b988d0dddcde6e32c810db6186f8902e90947ac8/src/background/message.background.ts#L74-L94)；随后浏览器创建平台标签页并注入脚本。任务的真实生命周期存在于标签页和页面 DOM 中，而不是持久化状态机。

当前 `main` 保留同样的外层形态：选中平台后构造 `{ platforms, data }`，[源码](https://github.com/gitcoffee-os/postbot/blob/5d03c2977714017952e758c96528991af09a1679/src/background/message.background.ts#L48-L61)；标签页创建和发布引擎则转入私有包。

这决定了它的合理定位：**个人浏览器同步工具**。若把它直接放到 GEO 后端，会把账号隔离、任务恢复和发布确认三个关键问题都留给偶然存活的浏览器标签页。

## 3. README 与实现差距

README 声称“一次编辑排版、一键同步至多平台自动发布”“同时发布至所有已登录平台”和“自动优化内容适配”。[说明](https://github.com/gitcoffee-os/postbot/blob/5d03c2977714017952e758c96528991af09a1679/README.md#L56-L80)

源码支持“打开多个已登录平台并填充/点击”，但没有证据支持生产意义上的“自动适配”和“发布成功”：

1. 所有勾选平台共享同一个 `data` 对象，没有每个平台独立保存的最终 payload。
2. publisher 内可能截断标题、换 selector 或处理图片，但这些变化只发生在浏览器执行时，没有形成可预览、可审核、不可变的 platform variant。
3. 没有平台内容 ID、公开 URL、回读结果或提交回执。
4. 没有“平台接受”“审核中”“公开成功”“被拒绝”“结果不确定”的状态区分。

因此，PostBot 的“一键同步”可以理解为一个 UI 操作；不能把它等同于 GEO 所需的可审计交付保证。

## 4. 账号登录与会话

### 值得采用的思路

PostBot 复用用户已经登录的浏览器会话，README 也明确把“不上传账号信息、使用浏览器本地登录状态”作为卖点。[说明](https://github.com/gitcoffee-os/postbot/blob/5d03c2977714017952e758c96528991af09a1679/README.md#L62-L70)

这适合 GEO 的账号绑定体验：

```text
打开平台官方登录页
  -> 用户扫码/登录
  -> SessionProbe 识别平台账号 ID 和昵称
  -> 绑定到 tenant-owned ChannelAccount
  -> 只保存 opaque runtime/profile reference
```

它比让用户把平台密码交给 GEO 更合适，也适合页面出现验证码、扫码确认或账号保护时的人工交接。

### 不能采用的账号模型

稳定版的 `metaInfoList` 是按平台 code 建立的单例 map，一个平台只对应一个当前身份。[源码](https://github.com/gitcoffee-os/postbot/blob/b988d0dddcde6e32c810db6186f8902e90947ac8/src/media/meta/index.ts#L33-L80) 这意味着：

- 同一 Chrome profile 不能稳定承载同平台账号池；切换账号会改变整个 cookie jar 的含义。
- `platform -> metaInfo` 没有 tenant、channel account、profile binding 或 ownership proof。
- 无法把任务永久绑定到明确账号，也无法保证提交后回读仍使用同一身份。

GEO 应保持现有 `ChannelAccount` 语义：平台身份是租户拥有的授权、健康、配额和发布历史单位；浏览器 profile 只是该账号的运行时绑定。一个运行时 profile 只能绑定一个 `tenant + platform + channel_account`，不能作为共享账号容器。

### 会话探针风险

平台探针本身有调研价值，但不能原样生产化。例如微信探针从页面脚本解析 token、ticket、昵称和账号，并把完整 `userInfo` 打到控制台。[源码](https://github.com/gitcoffee-os/postbot/blob/b988d0dddcde6e32c810db6186f8902e90947ac8/src/media/meta/weixin.meta.ts#L28-L56)

GEO 的 `SessionProbe` 应只返回最小状态：

```ts
type SessionProbeResult = {
  state: "ready" | "logged_out" | "challenge" | "identity_mismatch" | "unknown";
  platformAccountId?: string;
  displayName?: string;
  observedAt: string;
  adapterVersion: string;
};
```

原始 Cookie、token、ticket、localStorage 和页面脚本不得进入 API、业务日志或任务 payload；账号标识必须与预期 `ChannelAccount` 比对，身份不一致直接停止。

## 5. 平台能力与 adapter 组织

### 可借鉴的目录

PostBot 把平台能力按内容类型分类。当前公开目录定义：

- 文章：14 个目标，包括公众号、头条、知乎、微博、百家号、企鹅号、抖音、快手、B 站等。[源码](https://github.com/gitcoffee-os/postbot/blob/5d03c2977714017952e758c96528991af09a1679/src/media/platform/index.ts#L309-L397)
- 动态：12 个目标。[源码](https://github.com/gitcoffee-os/postbot/blob/5d03c2977714017952e758c96528991af09a1679/src/media/platform/index.ts#L398-L471)
- 视频：9 个目标。[源码](https://github.com/gitcoffee-os/postbot/blob/5d03c2977714017952e758c96528991af09a1679/src/media/platform/index.ts#L472-L527)
- 音频：6 个目标。[源码](https://github.com/gitcoffee-os/postbot/blob/5d03c2977714017952e758c96528991af09a1679/src/media/platform/index.ts#L528-L572)

每个平台、每种内容类型一个 publisher 文件，便于定位页面差异。这一组织方式可以采用，但 GEO 需要把“文件存在”升级为版本化能力合同。

### GEO 应实现的可变量 `PlatformDefinition`

平台差异不应散落在 UI 条件判断中，也不能让运营人员直接修改可执行脚本。建议把快速变更面收敛为经过 schema 校验、版本化、可回滚的配置：

```ts
type PlatformDefinition = {
  key: string;
  version: number;
  status: "disabled" | "draft_only" | "supervised" | "unattended";
  contentTypes: Array<"article" | "moment" | "video" | "audio">;
  publishSurface: {
    entryUrl: string;
    allowedOrigins: string[];
    selectorContractVersion: string;
  };
  payload: {
    titleMin: number;
    titleMax: number;
    bodyMax: number;
    tagMax: number;
    imageMin: number;
    imageMax: number;
    linkPolicy: "allowed" | "restricted" | "forbidden";
    supportedMediaTypes: string[];
  };
  delivery: {
    accountConcurrency: number;
    accountDailyLimit: number;
    minIntervalSeconds: number;
    readbackMode: "public_url" | "creator_center" | "manual";
  };
  adapter: {
    key: string;
    version: string;
    reviewedAt: string;
  };
};
```

标题长度、标签数、图片限制、入口 URL、平台开关、账号并发、发布间隔和软广呈现规则可以快速改动；`tenant isolation`、账号绑定、payload hash、提交幂等、一次性 permit 和不确定态禁止重试必须是代码与数据库硬约束，不能成为可关闭的变量。

## 6. 平台内容变体

**PostBot 没有 GEO 所需的最终平台变体层。**

当前消息处理器把同一个 `data` 放进所有目标，[源码](https://github.com/gitcoffee-os/postbot/blob/5d03c2977714017952e758c96528991af09a1679/src/background/message.background.ts#L48-L61)；稳定版也是同一行为。[源码](https://github.com/gitcoffee-os/postbot/blob/b988d0dddcde6e32c810db6186f8902e90947ac8/src/background/message.background.ts#L74-L94) 即使某个 publisher 在 DOM 填充前裁剪字段，它也没有形成独立资源。

GEO 应保留：

```text
Campaign / Topic
  -> CanonicalContentVersion
  -> PlatformVariant(platform, account?, strategyVersion)
  -> policy audit + payload hash
  -> frozen target
  -> publication job
```

每个平台最终变体至少应保存：标题、摘要、正文、标签、软广强度、品牌提及方式、行动引导、链接、图片/视频 manifest、来源声明、平台规则版本、生成 prompt/strategy 版本和 payload hash。不同平台应生成不同措辞和结构，而不是在发布脚本里临时截断同一篇文章。

### 软广策略也应是可变量

用户要求最终内容必须是软广，因此建议增加版本化 `PromotionStrategy`，与平台硬限制分开：

```ts
type PromotionStrategy = {
  key: string;
  version: number;
  intensity: "light" | "balanced" | "strong";
  brandMentionMin: number;
  brandMentionMax: number;
  directCallToAction: "none" | "subtle" | "explicit";
  productPlacement: "opening" | "middle" | "ending" | "distributed";
  disclosureTemplateKey?: string;
  platformOverrides: Record<string, Partial<PromotionStrategy>>;
};
```

该配置可快速换模板、强度和平台差异，但每次变更都要生成新版本；已经冻结或进入发布队列的 variant 不得被后台配置静默改写。

审核规则也应由版本化 policy pack 表达，至少覆盖违法商品、伪造资质、绝对化功效、冒充官方、恶意诽谤和隐私泄露。规则阈值、关键词、例外和处置可以更新，命中证据与当时的 policy version 必须随 variant 保存。PostBot 没有这层能力，不应从其“一键发布”设计反推治理边界。

## 7. 发布 adapter：采用动作，重做合同

PostBot 的 publisher 文件包含大量真实页面知识：入口 URL、编辑器 selector、粘贴事件、图片上传、封面设置、发布按钮与确认弹窗。它们适合转化为调研 checklist 和测试 fixture。

但生产 adapter 应拆为五个受限组件：

```text
SessionProbe   只读：确认会话与账号身份
SurfaceReader 只读：确认页面、编辑器版本、挑战与 selector 合同
DraftWriter   写草稿：填充并逐字段回读，不点击最终发布
SubmitWriter  单次提交：消费 permit，只执行一次最终动作
PublicReadback 只读：独立确认公开 URL、平台内容 ID 和内容绑定
```

这比 PostBot 的单个 `publisher(data): Promise<void>` 深得多。稳定版插件接口只有 `getMediaInfo`、`getPublishUrl` 和 `publisher(data)` 等松散方法，[源码](https://github.com/gitcoffee-os/postbot/blob/b988d0dddcde6e32c810db6186f8902e90947ac8/src/plugins/types.ts#L65-L93)；没有 prepare/submit/readback 权限边界，也没有标准结果。

### 发布成功判断不可采用

两个例子足以说明风险：

- 头条文章 publisher 找到按钮后点击“预览并发布”和确认按钮，没有等待平台内容 ID、公开 URL或独立回读。[源码](https://github.com/gitcoffee-os/postbot/blob/b988d0dddcde6e32c810db6186f8902e90947ac8/src/media/publisher/platform/article/toutiao.publisher.ts#L327-L364)
- 小红书动态 publisher 点击发布，固定等待 5 秒，然后跳转内容管理页。[源码](https://github.com/gitcoffee-os/postbot/blob/b988d0dddcde6e32c810db6186f8902e90947ac8/src/media/publisher/platform/moment/xiaohongshu.publisher.ts#L247-L256)

页面跳转不是成功证据。GEO 必须把结果分成：

```text
not_submitted
accepted_unconfirmed
uncertain
rejected
confirmed
needs_review
```

只有与冻结 payload 绑定的独立回读才能进入 `confirmed`。最终点击后网络断开、页面超时或响应无法解析时必须进入 `uncertain -> reconciling`，禁止再次点击发布。

## 8. 并行、多任务与 5,000 变体/天

### PostBot 实际并发模型

稳定版使用双层 `for...of`：创建一个 tab、注入脚本、激活、分组，并等待该 tab 加载完成后，才继续下一个 URL。[源码](https://github.com/gitcoffee-os/postbot/blob/b988d0dddcde6e32c810db6186f8902e90947ac8/src/tabs/index.ts#L83-L130) publisher 执行后没有 completion 回传，标签页是否完成也不会更新一个持久任务记录。

当前 `main` 把标签页细节转入 `@gitcoffee/postbot-tabs`，[源码](https://github.com/gitcoffee-os/postbot/blob/5d03c2977714017952e758c96528991af09a1679/src/tabs/index.ts#L1-L30)，公开源码无法证明其已经补齐持久调度、账号池或回读。

### 容量判断

5,000 个最终平台变体/天的全天平均吞吐约为：

```text
5000 / 86400 = 0.0579 target/second
```

纯计算吞吐并不高。真正约束是平台限额、账号数量、页面操作时延、热点峰值、登录挑战和审核延迟。例如一个目标平均占用浏览器 60 秒，理论上持续吞吐 0.058/s 只需约 4 个执行槽；但平台账号日限额和峰值会让所需账号及槽位远高于这个平均值。因此必须做账号级规划，而不是简单同时打开 100 个 tab。

### GEO 目标调度形态

```text
Variant Planner
  -> durable PublicationTarget rows
  -> fair scheduler by tenant/platform/account
  -> account quota + interval + circuit check
  -> leased Browser Host execution slot
  -> prepare checkpoint
  -> one-time submit
  -> independent reconciliation/readback
```

需要的硬能力：

- 每个 target 独立状态、payload hash、idempotency key 和 account binding。
- `tenant -> platform -> account` 三层并发与 token bucket 限流。
- 公平调度，防止一个大租户或单平台占满全部 Browser Host。
- lease、heartbeat、checkpoint、重启恢复、指数退避、最大尝试和 dead letter。
- `pre_submit` 失败可按错误分类重试；`post_submit` 不确定只允许回读。
- 平台、租户、账号三级 Kill Switch 与 circuit breaker。

PostBot 没有这些能力，因此不能作为扩容起点。

## 9. 插件机制

稳定版定义了 publisher、AI、tool、extension 四类插件和一个注册表，[类型](https://github.com/gitcoffee-os/postbot/blob/b988d0dddcde6e32c810db6186f8902e90947ac8/src/plugins/types.ts#L17-L93)、[注册表](https://github.com/gitcoffee-os/postbot/blob/b988d0dddcde6e32c810db6186f8902e90947ac8/src/plugins/registry.ts#L20-L59)。平台插件注册后把 metadata、platform、metaInfo 和 publisher 用 `Object.assign` 合并到全局 reactive map。[注入器](https://github.com/gitcoffee-os/postbot/blob/b988d0dddcde6e32c810db6186f8902e90947ac8/src/plugins/injector.ts#L24-L80)

可借鉴的是“一个平台包携带元数据、会话探针和 publisher”的打包思想。不可借鉴的是运行时任意合并：

- 同名 key 后注册者覆盖前者，没有冲突诊断。
- 没有 JSON schema、adapter API version、迁移或兼容范围。
- 没有插件签名、权限清单、租户范围、隔离进程或资源预算。
- `publisher(data): Promise<void>` 无法表达结果、回执和不确定态。

GEO 首期不需要开放任意第三方插件。先做内部 `PlatformAdapterManifest` 注册表，构建时注册可执行 adapter，运行时只读取签名、版本化的平台配置；配置可快速改，执行代码仍需 review、测试和发布。

## 10. 浏览器侧边栏、提取与动效

### 值得采用

PostBot 的浏览器体验比它的后端模型更有参考价值：

- 使用 Mozilla Readability 从网页克隆中提取标题和正文，并支持读取用户选区。[源码](https://github.com/gitcoffee-os/postbot/blob/5d03c2977714017952e758c96528991af09a1679/src/media/reader/index.ts#L13-L112)
- 内容脚本持续收集选区 HTML 和图片，并通过消息传给扩展。[源码](https://github.com/gitcoffee-os/postbot/blob/5d03c2977714017952e758c96528991af09a1679/src/contents/index.ts#L93-L140)
- 扩展 UI 挂到 Shadow DOM，隔离宿主网页样式。[源码](https://github.com/gitcoffee-os/postbot/blob/5d03c2977714017952e758c96528991af09a1679/src/contents/index.ts#L36-L60)
- 稳定版侧边栏把同步任务、提取正文、选区、正文图片和选区图片组织为五个 tab。[源码](https://github.com/gitcoffee-os/postbot/blob/b988d0dddcde6e32c810db6186f8902e90947ac8/src/components/sidepanel/TabsManage.vue#L27-L132)

这些能力可以成为 GEO 的“浏览器研究助手”：用户在任意页面把候选事实、选区和图片送入热点/研究工作台，但不能绕过来源授权、证据快照、相似度和版权策略直接进入发布。

### UI 不应照搬

稳定版任务列表主要显示任务名称；“加载更多”没有递增 `pageNo`，会重复请求同一页。[源码](https://github.com/gitcoffee-os/postbot/blob/b988d0dddcde6e32c810db6186f8902e90947ac8/src/components/sidepanel/TaskList.vue#L68-L102) 除浮动按钮位置过渡外，源码几乎没有自定义 motion system。它不能满足 GEO “界面美观、大气、组件有过渡”的要求。

GEO Web 应围绕五个工作区组织：

1. **热点雷达**：多源聚类、热度走势、来源可信度、选题篮。
2. **AI 创作室**：证据、canonical article、软广策略和平台变体并排预览。
3. **分发中心**：批次、账号矩阵、排期、并行 target 状态、失败与回读。
4. **账号与渠道**：登录交接、会话健康、账号限额、平台能力和重新认证。
5. **治理与效果**：审核规则版本、审计证据、Kill Switch、发布确认和效果分析。

动效参数也做成设计 token，方便快速调整：

```css
--motion-fast: 140ms;
--motion-base: 190ms;
--motion-slow: 260ms;
--motion-ease-standard: cubic-bezier(0.2, 0, 0, 1);
--motion-ease-emphasized: cubic-bezier(0.2, 0, 0, 1.2);
```

组件进入、状态切换、抽屉、tab indicator 和列表重排可以有过渡；任务表、配额数字和发布按钮必须布局稳定。统一支持 `prefers-reduced-motion`。不要让“每个组件有动画”变成持续晃动或影响批量运营扫描。

## 11. 权限、消息桥与安全

当前 manifest 请求 `https://*/*`、tabs、clipboard、scripting、downloads 等广泛权限，[源码](https://github.com/gitcoffee-os/postbot/blob/5d03c2977714017952e758c96528991af09a1679/package.json#L59-L77)；内容脚本匹配 `<all_urls>`。[源码](https://github.com/gitcoffee-os/postbot/blob/5d03c2977714017952e758c96528991af09a1679/src/contents/index.ts#L22-L24) 对个人工具这能减少配置工作，但对 GEO 商业产品权限面过大。

稳定版网页消息桥只检查 hostname 是否以 `.exmay.com` 结尾，再把 action 转发到扩展 runtime。[源码](https://github.com/gitcoffee-os/postbot/blob/b988d0dddcde6e32c810db6186f8902e90947ac8/src/contents/messageEventListener.ts#L19-L59) 这比完全接受任意 origin 好，但仍缺少：

- 明确的 exact-origin allowlist 与环境区分。
- 消息 schema、action capability、nonce、过期时间和重放保护。
- tenant、账号、variant 和 permit 的不可替换绑定。
- 每个 action 的最小权限与审计。

GEO Browser Host/扩展应按接入平台声明 host permission，能按需授权时不要默认所有站点。网页到扩展的消息必须经过固定 schema、来源、会话 nonce 和 capability 验证；云端不能通过通用 action 直接要求扩展点击任意页面元素。

## 12. 测试、可复现性与维护成本

本次快照未找到 test/spec 文件或 CI workflow，`package.json` 也没有 test、lint、typecheck 脚本。平台 selector、登录探针和提交动作没有合同测试。

依赖复现结果：

- 当前 `main` 执行 frozen install 失败：lockfile 与 `package.json` 不一致，缺少 27 个依赖并有 7 个版本不匹配。
- 当前 `main` 改用非 frozen install 后仍失败：公开 registry 无法取得 `@gitcoffee/postbot-events` 等包。
- `1.1.20` frozen install 也失败：`file-saver`、`jszip` 已写入 `package.json`，未进入其固定 lockfile。

这意味着当前仓库不能作为 GEO 的可复现依赖或 vendor 源。即使获得商业授权，也需要先解决私有包来源、锁文件一致性、供应链和构建证明。

GEO 每新增一个平台至少应有以下测试：

- PlatformDefinition schema、版本迁移与禁用回滚。
- canonical content 到平台 variant 的 golden fixture。
- tenant/account/profile 隔离与身份不匹配。
- 登录过期、验证码/挑战、selector 漂移和页面版本变化。
- prepare 字段回读、点击前失败、点击后超时和重复命令。
- idempotency、lease 过期、worker 重启、账号配额与公平调度。
- public readback 匹配、不匹配、审核中、未找到和最终超时。
- UI 批次、空态、错误态、5,000 target 虚拟列表和 reduced motion。

## 13. 许可证边界

PostBot 根 `LICENSE` 不是原样 Apache-2.0。文件在 Apache 文本后增加 `GitCoffee Open Source License` 条件，并明确：

- 未经 PostBot 书面授权，不得使用 PostBot 源码运营多租户环境。
- 使用其前端时不得移除或修改 Logo、水印、作者和版权信息。
- 文件还声明交互设计受外观专利保护。

[固定版本许可证原文](https://github.com/gitcoffee-os/postbot/blob/5d03c2977714017952e758c96528991af09a1679/LICENSE#L203-L223)

GEO 是多租户商业推广平台，因此结论很直接：

1. 可以学习公开行为、平台流程和通用工程思想。
2. 默认采用 clean-room 重写，不把 PostBot 源文件或 UI 复制进 GEO。
3. 若确实要复制源码、复用私有包或高度复刻前端交互，应先取得书面商业授权并完成法务审查。
4. 上游 selector 和 URL 也只能作为调研线索；GEO 应在自有授权账号、自己的测试 fixture 和 adapter 合同中重新确认。

本报告不是法律意见，但许可证文字已经足够构成工程阻断条件，不能按普通 Apache-2.0 项目处理。

## 14. Adopt / Adapt / Avoid

### Adopt：可以直接采用的产品或组织思想

- 用户在平台官网完成登录，系统只接收会话可用与账号身份结果。
- `平台 × 内容类型` 能力矩阵。
- 每个平台、每种内容类型独立 adapter 包和 selector fixture。
- 浏览器侧边栏、正文提取、选区提取、图片收集和浮动快捷入口。
- Shadow DOM 隔离浏览器注入 UI。
- 平台发布 URL、账号探针和 DOM 操作作为接入调研 checklist。

### Adapt：保留意图，但必须按 GEO 重写

- `platform -> metaInfo` 改为租户级、多账号 `ChannelAccount + RuntimeBinding`。
- 单一 `publisher()` 改为 `SessionProbe -> SurfaceReader -> DraftWriter -> SubmitWriter -> PublicReadback`。
- 静态平台 map 改为版本化 `PlatformDefinition`，把平台限制、速率和状态做成可回滚变量。
- 本地 Chrome 登录态改为每账号独立 opaque profile binding。
- 同一内容扇出改为 canonical content 生成各平台不可变 variant。
- 侧边栏信息架构可以学习，GEO 视觉、动效、批量状态和无障碍重新设计。

### Avoid：明确不要复制

- 不复制 PostBot 的调度器、标签页生命周期、成功判断、重试或账号模型。
- 不把“点击发布按钮”“页面跳转”当发布成功。
- 不在一个浏览器 profile 中轮换或承载同平台大量账号。
- 不让配置覆盖租户隔离、幂等、permit、审计或不确定态规则。
- 不依赖当前 `main` 的私有 `@gitcoffee/*` 包作为 GEO 核心依赖。
- 未取得书面授权前，不复制源码运营 GEO 多租户商业服务。

## 15. 映射到 GEO 的可执行路线

GEO 已具备 PostBot 最欠缺的底座：tenant scope、`ChannelAccount`、账号 runtime binding、canonical content 到 platform variant、payload hash、不可变审计、一次性 grant、durable job、lease/heartbeat/checkpoint、指数退避、账号 quota/circuit、Kill Switch 和 `uncertain -> reconciling -> confirmed/needs_review`。不要为了接入更多平台而退回到标签页即任务的模型。

### P0：先把扩平台的合同做深

1. 建立 `PlatformDefinition` schema、版本表、发布状态、平台限制、账号速率和回读模式；提供变更预览、灰度、回滚和审计。
2. 建立 `PromotionStrategy` 与 `PolicyPack`，把软广强度、品牌提及、平台覆盖以及六类审核标准做成版本化变量；冻结 variant 继续绑定旧版本。
3. 定义统一 adapter manifest 和五段式接口，明确每段权限、输入、输出、错误码和 evidence。
4. 为每个 publication target 固定 `tenant + platform + account + profile + variant hash + adapter version`。
5. 补齐平台/账号公平调度、速率、日限额、Browser Host 槽位和容量观测。
6. UI 先完成账号与渠道、平台能力配置、分发批次和 target 详情，明确显示准备、提交、审核中、回读和不确定状态。

### P1：用 PostBot 线索接首批真实平台

1. 按商业优先级选 2 至 3 个文章平台，不同时铺开 14 个。
2. 在授权测试账号上重做登录探针、账号身份 fixture、草稿写入与逐字段回读。
3. 先上线 `draft_only`，稳定后开 `supervised`；只有回读、挑战、漂移和不确定态测试完整后才评估 `unattended`。
4. 做 GEO Browser Companion：Shadow DOM 浮动入口、正文/选区/图片导入、账号绑定交接，不在扩展中保存平台 token。
5. 建立 selector drift dashboard、adapter version rollout 和平台 Kill Switch。
6. 完成 motion token、页面过渡、批次列表和 reduced-motion 视觉验收。

### P2：扩展内容形态和规模

1. 把短视频建成独立 canonical output family：脚本、分镜、配音、字幕、素材时间线、render manifest 和平台视频 variant。
2. 扩展视频/音频 adapter，但继续复用同一账号、调度、permit 和 readback 合同。
3. 建立 tenant/platform/account 容量模型，根据真实配额计算达到 5,000 变体/天需要的账号池与 Browser Host 槽位。
4. 平台 adapter 足够稳定后再考虑受签名、权限隔离的内部插件包；不急于开放任意第三方执行代码。

## 最终判断

PostBot 对 GEO **有学习价值，但价值在“浏览器最后一公里”，不在发布中台**。

最优路线是：采用它的本地登录交接、能力矩阵、publisher 目录、网页提取和侧边栏体验；把平台元数据升级为可快速变更的版本化配置；所有账号、变体、调度、提交确认和多租户边界继续由 GEO 自己实现。这样既吸收了上游积累的平台页面经验，又不会把个人扩展的可靠性、权限和许可证限制带入 GEO 的商业内核。
