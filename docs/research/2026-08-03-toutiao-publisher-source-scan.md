# 头条号发布实现源码扫描与 GEO 接入建议

日期：2026-08-03

范围：只研究公开源码和头条号公开页面，不执行真实发布，不修改产品代码。重点核对登录会话、文章编辑、正文图片、封面、最终提交、审核状态、公开回读、许可证和商业复用边界。

## 结论

当前能找到的公开实现中，**没有一个达到 GEO 可直接采用的生产标准**。最有价值的源码分别承担四种不同角色：

- `guanyang/super-publisher` 是目前最完整的端到端执行样本：有受保护页面登录探针、持久会话、标题和富文本正文、正文图片、封面、草稿确认以及两段式提交，而且找不到页面成功信号时会失败；但它仍只信任页面成功信号，没有内容管理页精确核对、审核轮询、公开 URL 或独立回读。会话以明文 `state.json` 保存，并使用 Patchright/自动化隐藏手段，只能作为 clean-room 行为参考。
- `xiaohao80/toutiao-auto-publisher` 是最深入的头条页面逆向笔记，覆盖持久登录、键盘输入、正文配图、原生封面上传、声明和草稿页检查；但没有许可证，依赖反检测、认证态私有接口、DOM/Fiber 注入，并在确认按钮点击后无条件返回成功。
- `yanfishrider/social-publisher` 是覆盖最广的多平台 UI 样本，头条实现包含真实 Edge/CDP、原生封面上传和两段式发布；但它共享浏览器 profile、伪造浏览器指纹、默认可自动提交，且把 toast、页面跳转、正文出现“审核中”甚至超时后的“不明确”都当作成功。项目 README 还自述头条账号在测试中被永久封禁。
- `addozhang/omnipub` 最适合做私有响应侦察：它先保存草稿，再用 `pgc_id` 发布，并同时检查响应 `code` 和非空 `pgc_id`；但直接调用受保护的浏览器内部接口，基础发布器在 `afterFill()` 返回后立即上报成功，状态模型也只有 pending/published/failed。`code=0 + pgc_id` 最多只能证明请求被平台受理，不能证明审核通过或公开可见。

其余仓库适合补充局部线索，不适合作为成熟实现：

- `InterestWatcher-Xiaofeng/toutiao-auto-publisher` 有按账号保存 `storage_state` 的雏形，但项目自称未完成，登录判断和发布成功判断均不可靠。
- `axdlee/toutiao-publish` 有 MIT 许可证和一份两段发布流程说明，但实际脚本仍包含待人工替换的动态 `ref` 占位符，内容通过字符串拼接注入 JavaScript，不能视为可执行产品实现。
- `zzx33522/toutiao_publisher` 只会发布草稿箱第一篇文章，明文保存 cookie pickle，没有内容编辑、媒体上传、审核跟踪或公开回读。
- `OceanBBBBbb/auto_write_toutiaohao` 只有路线图 README，没有实现。

所有候选都缺少四项生产闭环：

1. 在内容管理页按准确账号、标题、时间窗和内容指纹唯一匹配本次提交；
2. 持续读取审核中、通过、拒绝、下架及拒绝原因；
3. 提取并持久化稳定 external ID 和 public URL；
4. 在不携带创作者会话的独立上下文中公开回读并核对账号、标题和正文。

因此，GEO 应继续把头条号注册为 `manual_only + dry_run`。在获得头条书面授权或可核验的公开/合作方发布 API 前，只能把这些项目当作**页面侦察资料**。即使未来启用浏览器辅助，也必须在 GEO 现有租户、账号、审计、一次性 grant、提交后不确定态和独立公开回读合同内做 clean-room 实现，不能复制反检测和私有接口方案。

## 固定版本与许可证

| 仓库                                              | 固定 commit                                                                                                                                                    | 固定版本内容                                                             | 许可证判断                                                                                                                              | 商业复用结论                                                                                   |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `guanyang/super-publisher`                        | [`ee7466c6a83f1c9af520410849f40bb2c92ba08a`](https://github.com/guanyang/super-publisher/tree/ee7466c6a83f1c9af520410849f40bb2c92ba08a)                        | 多平台 skills 项目；头条 skill 包含独立认证管理器和发布器                | [MIT](https://github.com/guanyang/super-publisher/blob/ee7466c6a83f1c9af520410849f40bb2c92ba08a/LICENSE#L1-L21)                         | 许可证允许评估复用；Patchright、自动化隐藏和平台页面动作仍应 clean-room 重写并单独取得平台授权 |
| `InterestWatcher-Xiaofeng/toutiao-auto-publisher` | [`f7ecae585caa659e20dd2630370cfafb78e596ff`](https://github.com/InterestWatcher-Xiaofeng/toutiao-auto-publisher/tree/f7ecae585caa659e20dd2630370cfafb78e596ff) | 26 个跟踪文件，含 3 个交互式测试/调试脚本                                | 固定源码树无 LICENSE；README 只有一句 “MIT License”                                                                                     | 不复制源码或选择器清单；若需复用必须先取得完整授权文本并核对历史来源                           |
| `xiaohao80/toutiao-auto-publisher`                | [`c716fb8c3e3852555057cd04fe8a49aead71f23c`](https://github.com/xiaohao80/toutiao-auto-publisher/tree/c716fb8c3e3852555057cd04fe8a49aead71f23c)                | 4 个文件，核心脚本约 1,456 行，无测试                                    | 无 LICENSE/COPYING/NOTICE                                                                                                               | 只能做行为侦察，禁止直接复制代码                                                               |
| `zzx33522/toutiao_publisher`                      | [`7ba17b8111ef10a1f871176844eb59c4dd58e238`](https://github.com/zzx33522/toutiao_publisher/tree/7ba17b8111ef10a1f871176844eb59c4dd58e238)                      | 2 个文件，无测试                                                         | 无许可证                                                                                                                                | 不可直接商用复用                                                                               |
| `axdlee/toutiao-publish`                          | [`62b22f02f0eead8858a3265813f7ac53f5c46e36`](https://github.com/axdlee/toutiao-publish/tree/62b22f02f0eead8858a3265813f7ac53f5c46e36)                          | 9 个文件，1 个交互式测试脚本                                             | [MIT](https://github.com/axdlee/toutiao-publish/blob/62b22f02f0eead8858a3265813f7ac53f5c46e36/LICENSE#L1-L21)                           | 法律上可评估复用，分发时保留版权和许可证；技术上仍建议重写                                     |
| `yanfishrider/social-publisher`                   | [`72a9929ea558827eff3566f1bbbe376ad6c91c0f`](https://github.com/yanfishrider/social-publisher/tree/72a9929ea558827eff3566f1bbbe376ad6c91c0f)                   | 33 个文件，六平台发布器，无自动化测试                                    | [MIT + 研究用途免责声明](https://github.com/yanfishrider/social-publisher/blob/72a9929ea558827eff3566f1bbbe376ad6c91c0f/LICENSE#L1-L28) | MIT 授权存在，但平台合规、反检测实现和依赖仍需单独审查；不应整体引入                           |
| `addozhang/omnipub`                               | [`826113566edab01276e9f7004758eaf37965c916`](https://github.com/addozhang/omnipub/tree/826113566edab01276e9f7004758eaf37965c916)                               | 浏览器扩展 + FastAPI/Vue；头条 content script 含图片迁移、草稿和发布逻辑 | [MIT](https://github.com/addozhang/omnipub/blob/826113566edab01276e9f7004758eaf37965c916/LICENSE#L1-L21)                                | 可参考响应结构和幂等意图；认证态私有接口与成功语义不能进入 GEO 生产实现                        |
| `OceanBBBBbb/auto_write_toutiaohao`               | [`bbfa74d40ebac93331ac62d2573c5f2c21b8231e`](https://github.com/OceanBBBBbb/auto_write_toutiaohao/tree/bbfa74d40ebac93331ac62d2573c5f2c21b8231e)               | 仅 README                                                                | 无许可证                                                                                                                                | 无可复用实现                                                                                   |

许可证只回答源码授权，不代表头条允许自动化发布。平台授权、账号授权、内容权利和源码许可证是四个独立门槛。

搜索还覆盖了 `toutiao-ops`、`MultiPost-Extension`、`artipub`、`blogSync`、PostBot 的历史发布器、AIMedia 等相关实现。它们分别受无根许可证、只到预览、实现残缺、GPL/包许可证冲突、附加商业限制、点击后立即成功或明文 cookie 存储等问题影响，没有补齐上述四项证据，因此不提升生产结论。

## 能力核对矩阵

| 仓库             | 登录/会话                                           | 标题与正文                            | 图片/封面                                              | 最终提交                             | 审核/状态                              | 独立公开回读                        | 判断                                                    |
| ---------------- | --------------------------------------------------- | ------------------------------------- | ------------------------------------------------------ | ------------------------------------ | -------------------------------------- | ----------------------------------- | ------------------------------------------------------- |
| super-publisher  | 受保护页面探针 + 人工登录；明文 `state.json` 持久化 | 标题 + 富文本正文，并等待草稿保存确认 | 正文图片和封面均有上传流程                             | 两段点击；无页面成功信号则失败       | 只看页面成功信号，无管理页核对         | 无                                  | 端到端行为覆盖最完整；会话、Patchright 和成功语义需重写 |
| xiaohao          | Chromium persistent profile；扫码登录               | 键盘输入标题和 ProseMirror 正文       | 正文走 `/spice/image` + `execCommand`；封面优先原生 UI | 两段点击                             | 草稿只检查总数；发布无可靠状态         | 无                                  | 头条行为资料最丰富；生产禁用其私有接口和注入手段        |
| social-publisher | 共享 Edge CDP 或本地 persistent profile             | 模拟真人逐字输入                      | 原生 file input 上传封面                               | 两段点击                             | toast/body/URL 关键字；超时也不失败    | 无                                  | 可参考模块形状和原生上传；成功语义、会话和反检测不可用  |
| InterestWatcher  | 按账号 context + `storage_state.json`               | `fill()` 标题与正文                   | 从素材库选第一张                                       | 两段点击                             | 固定等待后直接成功                     | 无                                  | 可参考账号目录和 context 分组；实现未完成               |
| axdlee           | 假设浏览器已登录，无会话层                          | 动态 ref + `innerHTML` 注入           | AI 推荐图库/免费图库                                   | 两段点击                             | 仅 URL 是否离开发布页                  | README 声称一个公开 URL，脚本未验证 | 工作流说明，不是成熟执行器                              |
| zzx              | cookie pickle + 人工登录                            | 不编辑内容，只开第一篇草稿            | 无                                                     | 单次点击草稿发布按钮                 | 等待“发布成功/完成”文字                | 无                                  | 过时的窄脚本                                            |
| omnipub          | 复用扩展所在浏览器的登录态                          | 标题 + HTML/Markdown                  | 私有上传后批量替换 CDN URL；默认无封面                 | 私有接口先存草稿，再用 `pgc_id` 发布 | 只检查响应 `code + pgc_id`；全局仅三态 | 无                                  | 仅适合受理响应侦察，不是可采用的 API connector          |
| Ocean            | 无                                                  | 无                                    | 无                                                     | 无                                   | 无                                     | 无                                  | 路线图而非实现                                          |

## 1. 登录与账号会话

### super-publisher：端到端最完整，但 state 与隐匿机制不能搬

`auth_manager.py` 会探测头条受保护页面，未认证时停在人工登录流程，并把浏览器状态写入 `state.json`；文件尝试设置为 `0600`。[登录、受保护页面探针和状态文件](https://github.com/guanyang/super-publisher/blob/ee7466c6a83f1c9af520410849f40bb2c92ba08a/skills/toutiao-publisher/scripts/auth_manager.py#L37-L47) 这比每次重新登录或散发 cookie 更接近可用的会话生命周期，但仍是本地明文 cookies/localStorage，权限位不能替代加密、租户隔离、密钥轮换和账号身份绑定。

该项目使用 Patchright 及自动化隐藏配置来操作页面。它可以作为“登录 -> readiness -> 编辑 -> 提交”的流程观察样本，不能作为 GEO 的反检测实现。源码也没有证明登录后读取了头条唯一账号 ID 并与业务账号绑定。

**GEO 取舍：** 只吸收受保护页面探针、人工登录和持久会话的产品概念；状态必须由账号绑定的 opaque profile provider 管理，不能让调用方提供路径或拿到 `state.json`，也不能引入 Patchright、stealth、指纹伪装或其它规避平台检测的机制。

### xiaohao：持久 profile 有用，但反检测与路径模型不可采用

脚本通过 `launch_persistent_context(user_data_dir=...)` 保存完整浏览器状态，并支持为不同账号指定不同目录；这是比单独导出 cookie 更完整的会话载体。[启动与 profile](https://github.com/xiaohao80/toutiao-auto-publisher/blob/c716fb8c3e3852555057cd04fe8a49aead71f23c/toutiao_publisher.py#L59-L102) 登录检查会访问首页和发布页，扫码登录后等待 URL 离开 `login/sso`。[登录检查](https://github.com/xiaohao80/toutiao-auto-publisher/blob/c716fb8c3e3852555057cd04fe8a49aead71f23c/toutiao_publisher.py#L166-L237)

但它把“不是登录 URL、页面没有可见登录按钮”视为有效登录，没有核对平台账号 ID、昵称和预期账号绑定。profile 路径由命令行任意传入，脚本还主动删除 Chromium 锁文件，无法证明同一账号只有一个 owner。[profile 与锁文件](https://github.com/xiaohao80/toutiao-auto-publisher/blob/c716fb8c3e3852555057cd04fe8a49aead71f23c/toutiao_publisher.py#L66-L93) 更重要的是，它明确依赖 `playwright-stealth` 隐藏自动化特征。[stealth](https://github.com/xiaohao80/toutiao-auto-publisher/blob/c716fb8c3e3852555057cd04fe8a49aead71f23c/toutiao_publisher.py#L95-L98)

**GEO 取舍：** 只吸收“完整 profile 比裸 cookie 更适合持久会话”这一概念。profile 必须由服务端按 `tenantId + channelAccountId` 分配 opaque key，路径不可由调用方提供；同账号串行、全局容量受控、登录后必须回读准确账号身份。不得加入 stealth、锁文件强删或浏览器指纹伪装。

### InterestWatcher：最接近账号隔离雏形，但仍是本地明文状态

`BrowserManager` 用 `account_id` 缓存独立 context/page，并把每个账号的 `storage_state.json` 放到各自 `profile_dir`。[账号 context](https://github.com/InterestWatcher-Xiaofeng/toutiao-auto-publisher/blob/f7ecae585caa659e20dd2630370cfafb78e596ff/src/browser/browser_manager.py#L116-L165) [状态保存](https://github.com/InterestWatcher-Xiaofeng/toutiao-auto-publisher/blob/f7ecae585caa659e20dd2630370cfafb78e596ff/src/browser/browser_manager.py#L186-L195) 这个结构比共享所有账号 cookie 更清楚。

问题是 `storage_state.json` 仍是普通本地文件，`profile_dir` 来自可编辑 JSON 配置，没有租户边界、加密引用、文件权限、单 owner 或账号身份绑定；删除账号还会按配置路径递归删除目录。头条登录判断只看当前 URL 是否包含 `login/auth`，任何其它页面都可被误判为已登录。[登录判断](https://github.com/InterestWatcher-Xiaofeng/toutiao-auto-publisher/blob/f7ecae585caa659e20dd2630370cfafb78e596ff/src/adapters/toutiao_adapter.py#L63-L96)

**GEO 取舍：** 可参考“账号目录 -> 独立浏览器上下文”的形状，不复用本地路径和明文状态实现。GEO 已有更强的账号会话提供器：按账号串行、全局容量限制、profile key 与账号 ID 校验和显式 session state。[现有会话提供器](../../apps/ctrip-bridge/src/account-browser-session-provider.ts#L9-L115) [profile 绑定校验](../../apps/ctrip-bridge/src/browser-review-session.ts#L87-L153)

### social-publisher：共享 profile 是产品级风险

头条发布器通过 CDP 连接 `localhost:9222` 的第一个 Edge context，并在同一个 context 上注入随机浏览器指纹和 Shadow DOM 改写。[CDP 与注入](https://github.com/yanfishrider/social-publisher/blob/72a9929ea558827eff3566f1bbbe376ad6c91c0f/platforms/toutiao.py#L25-L44) 非 Edge 模式也只有一个用户指定的 persistent profile。[BrowserManager](https://github.com/yanfishrider/social-publisher/blob/72a9929ea558827eff3566f1bbbe376ad6c91c0f/browser_manager.py#L11-L34) README 明确说 `edge-profile/` 包含所有平台登录 cookie。[安全提示](https://github.com/yanfishrider/social-publisher/blob/72a9929ea558827eff3566f1bbbe376ad6c91c0f/README.md#L267-L276)

这不具备账号级隔离：无法证明当前页面属于哪个租户/账号，也不能避免两个任务并发控制同一个 profile。登录检查还有 `body` 文本超过 100 字即视为已登录的兜底。[登录判断](https://github.com/yanfishrider/social-publisher/blob/72a9929ea558827eff3566f1bbbe376ad6c91c0f/platforms/toutiao.py#L123-L130)

**GEO 取舍：** 不共享 profile，不从第一个 CDP context 猜账号，不注入随机指纹。Pi Agent 只生成变体和申请操作；实际浏览器动作必须由账号绑定的 Bridge 在一次性 grant 下执行。

### zzx：cookie pickle 不应进入任何服务端设计

该脚本把完整 cookie 以 Python pickle 保存到 `toutiao_cookies.pkl`，随后直接 `pickle.load()` 并注入浏览器。[cookie 保存与加载](https://github.com/zzx33522/toutiao_publisher/blob/7ba17b8111ef10a1f871176844eb59c4dd58e238/toutiao_publisher.py#L67-L106) 这同时带来凭据明文落盘和篡改 pickle 导致本地代码执行的风险；Chrome 还使用 `--no-sandbox`。[浏览器参数](https://github.com/zzx33522/toutiao_publisher/blob/7ba17b8111ef10a1f871176844eb59c4dd58e238/toutiao_publisher.py#L33-L48)

**GEO 取舍：** 完全避免。

## 2. 标题、正文与媒体

### super-publisher：字段、正文图片和封面流程覆盖最全

头条 skill 对标题、富文本正文和草稿保存有连续的页面动作与回读/等待逻辑。[标题、富文本正文和草稿确认](https://github.com/guanyang/super-publisher/blob/ee7466c6a83f1c9af520410849f40bb2c92ba08a/skills/toutiao-publisher/scripts/publisher.py#L604-L740) 正文图片和封面也有独立上传步骤。[正文图片上传](https://github.com/guanyang/super-publisher/blob/ee7466c6a83f1c9af520410849f40bb2c92ba08a/skills/toutiao-publisher/scripts/publisher.py#L306-L371) [封面上传](https://github.com/guanyang/super-publisher/blob/ee7466c6a83f1c9af520410849f40bb2c92ba08a/skills/toutiao-publisher/scripts/publisher.py#L769-L841)

这份实现最适合帮助 GEO 补齐“填充后回读 -> 保存草稿 -> 人工检查”的页面契约；它仍没有把最终平台变体与 GEO audit hash 绑定，也没有证明上传后的媒体在管理页或公开页可追溯。草稿保存成功只能证明编辑器状态被接受，不能证明文章已提交、审核通过或公开可见。

**GEO 取舍：** 参考其步骤拆分和失败时停止的形状，重写为版本化 surface manifest、结构化 payload、媒体 hash 和 tenant-scoped evidence；不复制选择器、Patchright 或任何内部接口调用。

### 可借鉴：真实输入、输入后校验、原生文件上传

xiaohao 识别标题为 `textarea`，优先用键盘输入触发前端状态，并在输入后回读值检查丢字。[标题输入与校验](https://github.com/xiaohao80/toutiao-auto-publisher/blob/c716fb8c3e3852555057cd04fe8a49aead71f23c/toutiao_publisher.py#L319-L370) 正文也通过 ProseMirror 焦点和键盘逐段输入。[正文输入](https://github.com/xiaohao80/toutiao-auto-publisher/blob/c716fb8c3e3852555057cd04fe8a49aead71f23c/toutiao_publisher.py#L374-L459) 这些做法说明：平台编辑器的视觉内容不一定等于其内部可保存状态，GEO 的 `prepareDraft` 必须在填写后回读标题、正文摘要、字数和媒体槽位，而不是只看元素存在。

xiaohao 和 social-publisher 都证明封面更适合走平台原生 UI：点击封面区域、切换上传 tab、给真实 file input 设置文件、等待上传提示、点击确定。[xiaohao 原生封面流程](https://github.com/xiaohao80/toutiao-auto-publisher/blob/c716fb8c3e3852555057cd04fe8a49aead71f23c/toutiao_publisher.py#L1060-L1197) [social-publisher 封面流程](https://github.com/yanfishrider/social-publisher/blob/72a9929ea558827eff3566f1bbbe376ad6c91c0f/platforms/toutiao.py#L165-L200)

**GEO 取舍：** 标题/正文优先使用语义定位和真实输入，媒体只走可见的原生 UI file input。每一步都要回读实际值并形成证据；封面失败必须阻断或回到人工选择，不能静默改成正文首图。

### 禁止采用：认证态私有上传、`execCommand`、Fiber 回调和删除平台 UI

xiaohao 把本地图片 base64 带入浏览器，在认证态页面直接调用未公开的 `/spice/image`，读取私有 CDN URL。[正文图片私有上传](https://github.com/xiaohao80/toutiao-auto-publisher/blob/c716fb8c3e3852555057cd04fe8a49aead71f23c/toutiao_publisher.py#L505-L582) 随后用已废弃的 `document.execCommand('insertHTML')` 把图片 HTML 插入 ProseMirror。[图片 DOM 注入](https://github.com/xiaohao80/toutiao-auto-publisher/blob/c716fb8c3e3852555057cd04fe8a49aead71f23c/toutiao_publisher.py#L584-L630) 封面 UI 失败时，它还会调用同类私有接口，并遍历 React internals、给猜测出的回调传多种参数。[封面私有上传](https://github.com/xiaohao80/toutiao-auto-publisher/blob/c716fb8c3e3852555057cd04fe8a49aead71f23c/toutiao_publisher.py#L794-L858) [Fiber 注入](https://github.com/xiaohao80/toutiao-auto-publisher/blob/c716fb8c3e3852555057cd04fe8a49aead71f23c/toutiao_publisher.py#L860-L1058)

脚本还会直接删除 AI 抽屉、modal、遮罩、tooltip 和所有包含 message/toast 的节点，其中包括可能显示“保存失败”的平台反馈。[删除平台 UI](https://github.com/xiaohao80/toutiao-auto-publisher/blob/c716fb8c3e3852555057cd04fe8a49aead71f23c/toutiao_publisher.py#L118-L162)

这些技术有三类不可接受的问题：

1. 私有端点没有公开兼容性或授权合同，不能成为商业 SaaS 依赖。
2. DOM/Fiber 注入绕过平台组件状态机，源码自己也记录了“看起来成功但草稿未持久化”的失败。
3. 删除平台提示和遮罩会掩盖挑战、错误、声明或安全提醒，破坏证据可信度。

**GEO 取舍：** 页面契约必须显式禁止 `/spice/image`、`/mp/agw/article/publish` 直调、React internals、`execCommand`、任意 DOM 状态注入、移除安全/挑战 UI 和浏览器指纹伪装。若正文图片没有稳定的原生 UI 流程，该能力就保持 `manual_only`。

### axdlee：说明书里的流程不能等同于可执行实现

脚本中的标题、AI 图片和封面动作仍使用 `"标题框 ref"`、`"AI 创作 ref"`、`"封面区域 ref"` 等占位符，注释也要求每次 snapshot 后人工替换。[动态 ref 占位符](https://github.com/axdlee/toutiao-publish/blob/62b22f02f0eead8858a3265813f7ac53f5c46e36/publish-toutiao.sh#L21-L140) 正文被直接拼进 JavaScript template literal 和 JSON 字符串，没有结构化转义，内容中的引号、反斜杠或反引号可能破坏请求甚至形成页面脚本注入。[正文注入](https://github.com/axdlee/toutiao-publish/blob/62b22f02f0eead8858a3265813f7ac53f5c46e36/publish-toutiao.sh#L42-L64)

**GEO 取舍：** 可把其“snapshot -> 语义 ref -> 动作”的思路用于页面探针，但 payload 必须通过结构化 API 传递，禁止把用户内容拼进 JavaScript/JSON/命令字符串。

## 3. 最终提交与成功判定

所有候选实现的共同缺陷是：**提交动作和发布成功没有被分开建模。**

### super-publisher：两段提交的最佳行为样本，仍不构成回执

该实现先完成草稿/预览，再执行最终确认；提交逻辑会等待页面成功信号，若在预算内没有观察到信号则返回失败。[两段提交与无成功信号失败](https://github.com/guanyang/super-publisher/blob/ee7466c6a83f1c9af520410849f40bb2c92ba08a/skills/toutiao-publisher/scripts/publisher.py#L863-L959) 这比“点击确认按钮即成功”严谨，但它仍只观察当前页面的按钮、toast 或跳转，没有外部 ID、管理页唯一匹配、审核轮询或独立公开回读；页面信号最多代表 `accepted/uncertain`，不应映射为 `confirmed`。

**GEO 取舍：** 保留“最终确认是不可逆边界”和“未观察到信号即停止”的原则。确认后若出现超时、关闭、跳转、toast 或“审核中”，统一进入 `uncertain -> reconciling`，禁止自动重试。

### xiaohao：找到确认按钮就返回 true，找不到也返回 true

第一步点击“预览并发布”，第二步尝试“确认发布/确定/发布”；点击到第二步就立即返回 `True`。如果没有确认按钮，只检查一次“发布成功”文字，最后仍然返回 `True`。[提交逻辑](https://github.com/xiaohao80/toutiao-auto-publisher/blob/c716fb8c3e3852555057cd04fe8a49aead71f23c/toutiao_publisher.py#L1260-L1303) 上层随后打印“文章已发布”。[上层成功输出](https://github.com/xiaohao80/toutiao-auto-publisher/blob/c716fb8c3e3852555057cd04fe8a49aead71f23c/toutiao_publisher.py#L294-L317)

草稿验证也只检查草稿箱“共 X 条”是否大于零，不核对标题、账号、时间或保存前后的数量差；只要账号原本有任意草稿就可能假阳性。[草稿验证](https://github.com/xiaohao80/toutiao-auto-publisher/blob/c716fb8c3e3852555057cd04fe8a49aead71f23c/toutiao_publisher.py#L1305-L1359)

### social-publisher：审核中、跳转和超时都可能被当作成功

头条发布器两段点击后，成功关键字同时包含“发布成功”“提交成功”“审核中”“待审核”“已发布”；页面离开 editor 也直接算成功。[提交与状态检测](https://github.com/yanfishrider/social-publisher/blob/72a9929ea558827eff3566f1bbbe376ad6c91c0f/platforms/toutiao.py#L210-L284) 超时只打印“请手动确认”，不抛错；上层仍继续打印“发布成功”并返回 `True`。[上层成功返回](https://github.com/yanfishrider/social-publisher/blob/72a9929ea558827eff3566f1bbbe376ad6c91c0f/platforms/toutiao.py#L103-L109)

Web 服务在自动模式下等待子进程退出后无条件调用 `record_publish()`，没有读取稳定的机器结果、进程返回码、外部 ID 或 URL。[服务端记录](https://github.com/yanfishrider/social-publisher/blob/72a9929ea558827eff3566f1bbbe376ad6c91c0f/server.py#L192-L228) CLI 的 `all` 模式只要任一平台结果带成功标记就返回零，而不是要求所有目标完成。[批量汇总](https://github.com/yanfishrider/social-publisher/blob/72a9929ea558827eff3566f1bbbe376ad6c91c0f/main.py#L217-L269)

### InterestWatcher 与 axdlee：固定延迟/URL 跳转不是证据

InterestWatcher 在确认按钮后只等待几秒，随后直接返回 `{"success": true}`，没有响应、内容管理页、external ID 或公开 URL。[发布完成判定](https://github.com/InterestWatcher-Xiaofeng/toutiao-auto-publisher/blob/f7ecae585caa659e20dd2630370cfafb78e596ff/src/adapters/toutiao_adapter.py#L272-L308)

axdlee 只检查 URL 是否进入 `/manage/content` 或 `/graphic/articles`，并把这种跳转写成“发布成功”。[URL 判定](https://github.com/axdlee/toutiao-publish/blob/62b22f02f0eead8858a3265813f7ac53f5c46e36/publish-toutiao.sh#L194-L254) SKILL 文档声称有一篇公开文章，但脚本没有把当前提交与该 URL 建立身份关系，也没有做公开内容回读。[自述公开链接](https://github.com/axdlee/toutiao-publish/blob/62b22f02f0eead8858a3265813f7ac53f5c46e36/SKILL.md#L18-L45) 2026-08-03 对该 URL 做未登录 HTTP 获取时只得到空 HTML shell，无法独立证明标题、作者、正文或当前可见状态；这不等于文章不存在，只说明 README URL 不能替代可重复的公开 readback。

### zzx：平台文字只证明一次 UI 观察

zzx 打开草稿箱第一篇，点击固定 XPath，然后等待“发布成功/发布完成”文字。[草稿发布](https://github.com/zzx33522/toutiao_publisher/blob/7ba17b8111ef10a1f871176844eb59c4dd58e238/toutiao_publisher.py#L108-L179) 它没有记录文章身份、审核状态、外部 ID/URL 或公开可见性。

### omnipub：`code=0 + pgc_id` 只证明受理

头条 content script 会并发上传外部图片并把成功返回的 CDN URL 替换回 HTML/Markdown。[图片上传与 URL 替换](https://github.com/addozhang/omnipub/blob/826113566edab01276e9f7004758eaf37965c916/extension/content-scripts/publishers/toutiao.js#L418-L496) 它随后调用认证态的 `/mp/agw/article/publish`：先以 `save=1, pgc_id=0` 保存草稿，再以返回的 `pgc_id` 发送 `save=0` 发布请求，并同时检查 `code/err_no` 和非空 `pgc_id`。[响应检查](https://github.com/addozhang/omnipub/blob/826113566edab01276e9f7004758eaf37965c916/extension/content-scripts/publishers/toutiao.js#L775-L789) [草稿与发布请求](https://github.com/addozhang/omnipub/blob/826113566edab01276e9f7004758eaf37965c916/extension/content-scripts/publishers/toutiao.js#L838-L970)

这是研究“平台受理响应里可能出现什么字段”的有用线索，但端点属于创作者站点内部合同，不能直接变成 GEO connector。基础发布器在 `afterFill()` 返回后立即报告 success。[立即上报成功](https://github.com/addozhang/omnipub/blob/826113566edab01276e9f7004758eaf37965c916/extension/content-scripts/common/base-publisher.js#L703-L731) 后端 `PublicationStatus` 也只有 `pending/published/failed`。[状态模型](https://github.com/addozhang/omnipub/blob/826113566edab01276e9f7004758eaf37965c916/app/models/publication.py#L12-L15) 因而 `code=0 + pgc_id` 只能记录为 `submissionOutcome=accepted`，不能写成审核通过、公开成功或 GEO 的 `confirmed`。

## 4. 头条公开页面与接口边界

本次只确认了以下一手事实：

- 头条号登录页公开链接到[用户协议](https://mp.toutiao.com/profile_v4_public/public/protocol/agreement)、[隐私政策](https://mp.toutiao.com/profile_v4_public/public/protocol/privacy)和运营规范入口；这些页面和创作者后台是官方来源。
- 用户协议中关于账号所有权与安全、不得未经授权使用第三方工具、以及机器人/爬虫限制的条款（当前页面的 2.3、2.4、4.1、5.1、5.2、8.1 等章节）与[运营规范](https://mp.toutiao.com/profile_v4_public/public/protocol/opsspecs)共同构成平台边界；运营规范还限制异常批量、重复、低质机器生产内容和规避治理行为。具体条文应在上线审查时重新固定快照，不能只依据仓库 README 或技术可行性。
- 头条号官方页面加载的安全 SDK 配置把 `/mp/agw/article/publish`、`/mp/agw/article/wtt` 和草稿保存等路径列为受保护浏览器端请求。它们是创作者站点内部接口的证据，不是公开开发者发布 API 的授权文件。[头条号公开协议页](https://mp.toutiao.com/profile_v4_public/public/protocol/agreement)
- 本次没有找到由头条官方公开、面向第三方 SaaS、包含认证、配额、幂等、发布和状态查询合同的文章发布 API 文档。候选仓库使用的 `/spice/image` 也只来自页面逆向观察。

因此不能因为内部端点能在登录浏览器里调用，就把它标为 `public_api` 或 `partner_api`。上线前必须由平台商务/法务确认浏览器辅助或合作接口权限；缺少书面依据时保持 `manual_only`。

## 5. GEO 的 clean-room 实现路线

GEO 已经有比候选项目更可靠的边界：connector 输入携带 `tenantId + channelAccountId + executionLevel`，接口分为 session、render、preflight、draft、publish、poll、reconcile 和 evidence。[connector 合同](../../packages/connectors/src/types.ts#L15-L173) 头条当前明确注册为 `DryRunConnector`，手工包也注明预览不是发布回执。[注册表](../../packages/connectors/src/registry.ts#L6-L87)

建议按以下顺序实现，不另建第二套发布框架。

### 阶段 0：先扩展真实交付状态合同

当前 `PublishResult`、`PollStatusResult` 和 `ReconcileResult` 仍只表达预览/人工确认。[当前结果类型](../../packages/connectors/src/types.ts#L73-L118) 在接入任何真实平台前，应统一增加：

- `submissionOutcome`: `not_submitted | accepted | rejected | uncertain`；
- `moderationState`: `unknown | submitted | reviewing | approved | rejected | removed`；
- `readbackState`: `not_attempted | pending | matched | mismatched | not_found`；
- `externalId`、`externalUrl`、平台原始状态摘要和证据 hash；
- 明确 `confirmed=true` 只能来自独立 readback，不得由提交点击或管理页跳转产生。

平台审核应作为独立维度，不要把“审核中”压成成功。现有 `uncertain -> reconciling -> confirmed/needs_review` 状态机正好可承接提交后未知结果。[发布状态机](../../packages/core/src/publication-state.ts#L31-L101)

### 阶段 1：账号级头条浏览器会话

复用携程 Bridge 的账户会话模型，抽成平台无关 provider：

- profile key 必须由 `tenantId + channelAccountId` 派生并在服务端校验；
- 同账号一次只允许一个写操作，跨账号受全局容量限制；
- 状态至少包括 `unbound`、`session_required`、`authenticated`、`ready`、`challenge_required`、`unavailable`、`disabled`；
- 登录必须人工完成，登录后读取头条账号唯一标识和昵称，与数据库 binding 精确匹配；
- profile 内容不进入业务数据库、API、日志或前端；日志只记录 opaque ref 和低基数状态；
- challenge、账号不匹配和 selector drift 只打开该账号 circuit，不影响其它账号。

### 阶段 2：版本化页面契约与 readiness probe

为头条建立独立 `surface manifest`，至少包含：

- adapter version、观察时间、允许 origin/path 和页面版本指纹；
- 登录、账号身份、challenge、封禁、权限不足和账号资料未完成探针；
- 标题、正文、正文图片、封面、声明、预览、确认发布控件；
- 每个控件的语义定位、有限 fallback、期望前后状态和超时预算；
- 内容管理页的标题、账号、状态、时间、拒绝原因、external ID/URL 探针；
- 公开页的 canonical URL、标题、作者、正文摘要和可见状态探针；
- 截图、DOM 摘要、URL、响应元数据和 hash 的证据要求；
- 明确禁止私有 API、Fiber/DOM state 注入、删除安全 UI、stealth 和任意脚本拼接。

manifest 变更必须版本化、审核和做 canary；页面指纹不匹配时 fail closed，不能无限扩大文本/CSS fallback。

### 阶段 3：只准备草稿，不提交

实现 `prepareDraft`：

1. 打开官方编辑页并完成 readiness。
2. 输入标题和正文，回读精确值、字符数和规范化摘要 hash。
3. 仅通过原生 UI 上传媒体；上传后回读缩略图数量、封面槽位和文件摘要。
4. 读取声明、原创、AI 辅助等选项的实际状态；没有明确业务输入时不得自动勾选“头条首发”或其它法律声明。
5. 生成截图和 DOM 证据，供运营人员审阅。

任何字段或媒体变化都会改变最终平台变体，旧 audit/grant 必须失效。浏览器内临时改写不能绕开 GEO 的变体哈希。

### 阶段 4：受监督的两段提交

只有以下条件同时成立时，Bridge 才能进入最终提交：

- 账号身份、payload hash、媒体 manifest、audit hash 和一次性 grant 全部匹配；
- preflight 回读值与已审核平台变体一致；
- 页面未出现 challenge、保存失败、权限变化或 selector drift；
- 操作员明确批准当前预览。

“预览并发布”仍可视为可恢复步骤；“确认发布”是不可逆提交边界。点击确认后出现超时、页面关闭、跳转、toast 或“审核中”，统一进入 `uncertain/reconciling`，绝不自动再点一次。

### 阶段 5：管理页状态与独立公开回读

提交后分两条证据链：

1. **管理页 reconciliation**：按精确账号、标题、提交时间窗和内容指纹定位唯一条目，读取平台审核状态、拒绝原因、external ID 和 URL。只有模糊标题匹配或多条候选时转 `needs_review`。
2. **公开 readback**：在不携带创作者 profile 的独立浏览器上下文打开 public URL，校验允许 host、canonical item ID、标题、作者/账号和正文摘要。公开页面不可访问、内容不匹配或仍需登录时，不得确认成功。

建议状态映射：

| 平台观察                            | GEO 处理                                                        |
| ----------------------------------- | --------------------------------------------------------------- |
| 未点击最终确认                      | 可证明未提交，允许同一 attempt 恢复                             |
| 点击确认后无明确结果                | `uncertain -> reconciling`，禁止重新提交                        |
| 管理页显示审核中/待审               | moderation=`reviewing`，继续低频回读，不算成功                  |
| 管理页明确拒绝                      | moderation=`rejected`，保存原因，进入 `needs_review` 或永久失败 |
| 管理页显示已发布但无公开证据        | 继续 `reconciling`                                              |
| 公开 URL 与账号、标题、内容全部匹配 | moderation=`approved`、readback=`matched`，才可 `confirmed`     |
| 多条候选、内容不匹配、状态互相矛盾  | `needs_review`，禁止自动重发                                    |

## 6. 运营与安全门禁

### 必须保留

- 每租户、每平台、每账号独立 profile、队列、配额、circuit 和证据。
- 同账号外部写入并发固定为 1；生成、审核和媒体准备可并行。
- 提交前可证明未执行的错误才可重试；提交后未知只做 reconciliation。
- 每个 target 使用稳定 idempotency key；成功平台的结果保留，只修复失败 target，不能重复提交已成功平台。
- 日志、截图和 DOM 证据必须脱敏、按 tenant scope 存储并有保留期；不得包含 cookie、token、二维码、完整 local storage 或私密 URL 参数。
- UI 必须区分“草稿已准备”“等待人工确认”“平台已受理”“审核中”“审核拒绝”“公开已确认”，不能只显示绿色“发布成功”。

### 明确禁止

- 读取、导出或通过普通 API 分发 cookie/storage state。
- 多账号或多租户共享浏览器 profile。
- `--no-sandbox`、stealth、指纹伪造、Shadow DOM 劫持和模拟真人浏览以规避检测。
- 直接调用认证态内部发布/上传端点，除非头条提供书面、版本化的合作接口合同。
- `innerHTML`、`execCommand`、React Fiber、任意 `evaluate` 改写平台业务状态。
- 删除 challenge、modal、toast、声明或平台安全提示。
- 根据按钮点击、固定延迟、URL 跳转、toast、“审核中”或 HTTP 200 直接确认发布。
- 把 README 的公开 URL、自述成功率或交互截图当作可重复生产证据。

## 7. 候选项目的最终 Adopt / Adapt / Avoid

### Adopt：只吸收明确的产品概念

1. 账号需要持久会话，而不是每次重新输入密码或散发 cookie。
2. 每个平台维护独立页面适配器和字段/媒体约束。
3. 头条是两段提交，最终确认前应提供人工预览。
4. 原生 UI file input 比私有上传接口和 DOM 注入更接近平台真实状态。
5. 页面操作后必须回读实际值，尤其是 React/ProseMirror 编辑器。
6. `super-publisher` 的“找不到明确成功信号就停止”和草稿确认，可作为失败闭环与人工交接的行为样本。

### Adapt：在 GEO 现有合同内重写

1. 将 InterestWatcher 的账号 context 概念改成租户/账号绑定的 opaque profile provider。
2. 将 xiaohao 的标题、正文和封面操作经验改成版本化 surface manifest 与 drift probe。
3. 将 social-publisher 的一平台一模块和两段提交改成 `prepare -> verify -> supervised submit -> reconcile -> public readback`。
4. 将候选项目的简单间隔限制改成账号级保守配额、冷却、租约和 durable queue。
5. 将截图/日志改成有 hash、tenant scope、脱敏和保留期的 evidence artifact。
6. 将 `omnipub` 的 `code + external-id` 受理记录改成 GEO 的 `accepted` 证据字段，后续必须接管理页审核状态和独立公开回读。

### Avoid：不进入 GEO 代码库

1. xiaohao 的 stealth、`/spice/image`、`execCommand`、Fiber 注入和删除 UI。
2. social-publisher 的共享 Edge profile、随机指纹、模拟真人行为和成功关键字模型。
3. InterestWatcher 的 URL 登录判断、明文 `storage_state.json` 路径模型和固定等待成功。
4. axdlee 的动态 ref 占位符、JavaScript 字符串拼接和 URL 跳转成功。
5. zzx 的 pickle cookie、`--no-sandbox`、固定 XPath 和草稿箱第一篇批量发布。
6. `super-publisher` 的明文 `state.json`、Patchright/自动化隐藏、页面信号即成功和缺少审核/公开回读。
7. `omnipub` 的认证态 `/mp/agw/article/publish` 直调、扩展共享登录态和三态发布模型。
8. 所有仓库的“点击即成功”、提交后自动重试和缺少独立公开回读的做法。

## 8. 验收顺序

在平台书面授权缺失时，验收只能提升 `dry_run/manual` 质量，不能单凭技术成功切到无人值守。

1. **Fixture/DOM replay**：测试页面契约、字段回读、挑战检测、证据脱敏和 selector drift fail-closed。
2. **人工登录 dry run**：在测试账号中只填充草稿，不点最终确认，验证账号身份、payload/媒体/audit hash 一致。
3. **单次受监督 canary**：仅在授权和一次性 grant 完整时提交；点击后不做自动重试。
4. **审核 reconciliation**：管理页精确定位唯一条目，保留审核状态和原因。
5. **独立公开 readback**：新上下文确认 URL、账号、标题、正文和公开可见性。
6. **故障演练**：确认点击后断网、页面漂移、账号掉线、challenge、多候选、公开页不匹配时都不会重复发布或误报成功。
7. **能力评审**：只有公开/合作 API 文档、账号级能力证据、法务/安全批准和连续 canary 证据共同满足时，才重新评估 `browser_assisted` 或更高执行级别；技术 canary 本身不构成平台授权。

## 最终建议

头条方向没有可“抄成生产代码”的成熟开源实现。最好的策略是：

- 用 `super-publisher` 做端到端页面阶段和失败信号侦察；
- 用 xiaohao 做字段和封面流程侦察；
- 用 social-publisher 参考模块拆分和两段 UI 流程；
- 用 omnipub 仅研究受理响应中的 `code/pgc_id` 形状，不调用其私有接口；
- 用 InterestWatcher 参考账号 context 的产品形状；
- 坚持 GEO 自己的租户/账号 scope、最终变体审计、一次性 grant、提交不确定态和独立公开 readback；
- 在没有官方发布合同前保持 `manual_only + dry_run`，把真正的自动化投入放在页面 readiness、草稿准备、证据和人工交接，而不是反检测和私有接口。
