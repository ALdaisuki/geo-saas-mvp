# AIMedia 源码深度评估与 GEO 映射

日期：2026-08-03
研究对象：[Anning01/AIMedia](https://github.com/Anning01/AIMedia)，源码快照 `e4e8891c9d787a2ebfe97bb8ebce3cf50498e440`
目标：判断 AIMedia 是否适合作为 GEO 的多平台内容生产与自动分发参考实现，覆盖热点、AI 创作、账号登录、凭据、平台变体、发布、调度重试、UI、测试、安全和许可。

## 结论

**AIMedia 适合作为“用户流程和平台浏览器动作样板”，不适合作为 GEO 的架构底座，也不应整体移植。**

最值得学习的有三点：

1. 从热点分类到账号目标再到发布任务的运营闭环，产品路径直观。
2. 头条号、百家号、企鹅号、微信公众号的扫码登录、Cookie 获取和页面发布脚本，能帮助 GEO 识别各平台接入所需的真实交互步骤。
3. 热点源分类表覆盖 8 个新闻来源和约 210 个栏目，适合转化为一批受治理的 source adapter fixture 和验收样本。

但它不具备 GEO 所需的生产可靠性边界：平台 Cookie 直接进入业务数据库；同一篇文章原样交给各平台；任务靠桌面线程、无限循环和 `sleep` 驱动；异常大量吞掉；发布成功主要由页面元素推断，没有幂等键、租约、提交不确定态、独立回读或可审计回执；测试文件为空；并且源码存在多项严重凭据与租户隔离风险。

因此建议采取 **clean-room 学习**：记录平台流程、状态探针和样本页面，重新实现为 GEO 的受限 adapter；不要复制其账号模型、任务循环、Cookie 存储、状态机和异常处理。

## 总体评分

| 维度         |         完成度 | 对 GEO 的价值 | 判断                                                                |
| ------------ | -------------: | ------------: | ------------------------------------------------------------------- |
| 热点采集     |           6/10 |            高 | 来源和栏目丰富，但无统一 adapter 合同、证据治理、稳定调度与质量评分 |
| AI 文章创作  |           4/10 |            中 | 有 GLM/Kimi、提示词和临时知识库路径，但只是单篇改写                 |
| 账号登录     |           6/10 |            高 | 平台扫码和会话探测流程有参考价值                                    |
| 凭据保存     |           1/10 |      负面教材 | Cookie、JWT、模型 Key 的保存与日志策略不可采用                      |
| 平台内容变体 |           1/10 |            低 | 实际不存在；同一 article 直接投给不同平台                           |
| 自动发布     |           5/10 |          中高 | 四个平台页面动作可用于接入调研，不能直接作为生产 connector          |
| 调度与重试   |           2/10 |            低 | 进程内循环，无 durable job、幂等、退避、租约和不确定态              |
| UI           |           5/10 |            中 | 信息架构可参考；视觉较旧、样式分散，几乎没有过渡动画                |
| 测试         |           1/10 |            低 | 两个测试文件为空；仅可确认 Python 源码可编译                        |
| 安全         |           1/10 |      负面教材 | 存在密钥、TLS、Cookie、跨用户账号归属等高风险问题                   |
| 许可         | 可使用但需谨慎 |            中 | 根许可证为 Apache-2.0；缺 NOTICE，许可证附录版权模板未填写          |

## 1. 真实架构，不以 README 为准

AIMedia 是两部分混合系统：

- Django 后端保存用户、会员、渠道账号、Cookie、抓取文章和 AI 用量。
- PySide6 桌面端直接执行热点抓取、模型调用、图片处理和 Selenium 浏览器发布。

它不是“后端任务调度 + 无状态发布 Worker”的分布式系统。核心自动化发生在桌面端 `TaskService` 内，后端主要承担 CRUD、会员额度和内容状态保存。README 所说的“企业级任务调度”并没有对应的 durable scheduler；依赖中虽有 APScheduler，但核心发布链未使用它。

源码证据：

- [`TaskService.start_auto_publish_task`](https://github.com/Anning01/AIMedia/blob/e4e8891c9d787a2ebfe97bb8ebce3cf50498e440/pyside/utils/task_service.py#L249-L363) 在桌面进程中无限轮询。
- [`AutoPublishThread`](https://github.com/Anning01/AIMedia/blob/e4e8891c9d787a2ebfe97bb8ebce3cf50498e440/pyside/components/auto_publish_widget.py#L51-L82) 只是 Qt 线程包装。
- 后端 [`AccountNews`](https://github.com/Anning01/AIMedia/blob/e4e8891c9d787a2ebfe97bb8ebce3cf50498e440/back/apps/users/models.py#L136-L174) 只有粗粒度文章状态，没有 attempt、lease、receipt、reconciliation 等交付实体。

## 2. 热点采集

### 已实现

- `HotSpotService.PLATFORM_CONFIG` 定义了网易、澎湃、中国日报、搜狐、腾讯体育、腾讯新闻、新浪国际、IT 之家 8 个来源及分类映射。该数据可以作为 GEO 首批来源目录和抓取验收样本。[源码](https://github.com/Anning01/AIMedia/blob/e4e8891c9d787a2ebfe97bb8ebce3cf50498e440/pyside/utils/hot_spot_service.py#L6-L388)
- 每个来源有列表与详情抓取器，产出基本一致的 `title/article_url/date_str/article_info/img_list` 数据。[统一分派](https://github.com/Anning01/AIMedia/blob/e4e8891c9d787a2ebfe97bb8ebce3cf50498e440/pyside/crawlers/spider_all.py#L15-L117)
- 自动托管会把账号目标分类映射到来源栏目，只挑近期文章，抓详情后入库。[源码](https://github.com/Anning01/AIMedia/blob/e4e8891c9d787a2ebfe97bb8ebce3cf50498e440/pyside/utils/task_service.py#L90-L109)、[源码](https://github.com/Anning01/AIMedia/blob/e4e8891c9d787a2ebfe97bb8ebce3cf50498e440/pyside/utils/task_service.py#L288-L338)

### 缺失与风险

- `if/elif` 分派和平台名字符串是隐式接口，新增来源要同时改多个 UI/服务文件。
- 没有来源健康度、抓取版本、解析器版本、原始响应摘要、内容指纹、跨源聚类、热度分数、可信度或重复新闻合并。
- 网络请求普遍缺超时、重试、限流、robots/来源政策和结构漂移诊断；XPath 失败经常被宽泛异常吞掉。
- “热点”实际主要是栏目最新文章，不是多源热度计算。`is_less_than_2_minutes` 名称与注释写 2 分钟，实际判断 30 分钟，说明时间策略没有合同测试。[源码](https://github.com/Anning01/AIMedia/blob/e4e8891c9d787a2ebfe97bb8ebce3cf50498e440/pyside/crawlers/spider_all.py#L120-L150)
- GUI 读取热点时会先拉取所有用户新闻标题做字符串去重，既昂贵也无法处理同题不同稿。[源码](https://github.com/Anning01/AIMedia/blob/e4e8891c9d787a2ebfe97bb8ebce3cf50498e440/pyside/components/hot_spot_widget.py#L347-L374)

### 可借鉴

- 来源、栏目、统一内容字段的目录设计。
- “账号内容目标 -> 来源栏目”的配置体验。
- 真实页面样本和解析选择器，可作为 adapter fixture，不作为长期接口。

### 不可照搬

- 按中文平台名写死的分派器。
- 直接从抓取结果进入生成和发布的单链路。
- 把抓到的新闻正文当作可自由改写和再发布的素材；还需单独处理版权、来源许可、引用比例和平台规则。

## 3. AI 创作

### 已实现

- 支持 GLM 与 Kimi 两条模型路径，自定义 prompt，记录 token 估算。[源码](https://github.com/Anning01/AIMedia/blob/e4e8891c9d787a2ebfe97bb8ebce3cf50498e440/pyside/ai_model/writing_assistant.py#L12-L49)
- 把来源正文临时写入本地知识库，检索背景后生成约 1300 字文章，随后删除临时文档。[源码](https://github.com/Anning01/AIMedia/blob/e4e8891c9d787a2ebfe97bb8ebce3cf50498e440/pyside/ai_model/writing_assistant.py#L50-L179)
- 生成后把原文、新文和 token 用量上报后端。[源码](https://github.com/Anning01/AIMedia/blob/e4e8891c9d787a2ebfe97bb8ebce3cf50498e440/pyside/utils/task_service.py#L156-L225)

### 缺失与风险

- 这是单次“热点正文改写”，没有事实抽取、主张与证据绑定、研究计划、内容版本、人工审阅或平台政策审计。
- 生成结果只用长度大于 500 作为有效性信号；模型报错文本也可能以 `content` 返回，缺少结构化 schema 和质量门禁。
- UI 提供“其他模型”配置，但 `WritingAssistant` 对其他值把 `self.llm` 设为 `None`，功能面与实现不一致。[源码](https://github.com/Anning01/AIMedia/blob/e4e8891c9d787a2ebfe97bb8ebce3cf50498e440/pyside/ai_model/writing_assistant.py#L28-L48)
- 没有短视频脚本、分镜、配音、字幕、素材编排、渲染、审核或平台视频变体模型。
- 提示词强调“原创度 100%”“去 AI 化”，但没有相似度或事实一致性验证；不能把提示词约束当治理证据。

### GEO 判断

GEO 现有 `content_versions -> publication_variants -> audit_artifacts -> grants` 比 AIMedia 更接近正确底座。应学习其“一键从热点进入草稿”的体验，不要退化为单 prompt + 单字符串文章。

## 4. 账号登录与凭据

### 可借鉴的登录流程

账号绑定会启动浏览器，让用户在平台页面完成扫码/登录，再读取昵称、UID 与 Cookie。头条、百家、企鹅、微信分别有专用探测器。[入口](https://github.com/Anning01/AIMedia/blob/e4e8891c9d787a2ebfe97bb8ebce3cf50498e440/pyside/components/account_manager_widget.py#L120-L181)

这对 GEO 有两类价值：

1. **账号登录交接 UI**：显示“等待扫码 -> 已识别账号 -> 会话可用 -> 需要重新认证”。
2. **平台状态探针**：从登录后页面提取稳定的账号标识，不把“页面打开”误判为会话有效。

### 不可照搬的凭据设计

- 完整平台 Cookie 直接存于 Django `Accounts.cookie` JSON 字段。[源码](https://github.com/Anning01/AIMedia/blob/e4e8891c9d787a2ebfe97bb8ebce3cf50498e440/back/apps/users/models.py#L98-L125)
- 本地 SQLite 账号表也为 Cookie 保留明文字段。[源码](https://github.com/Anning01/AIMedia/blob/e4e8891c9d787a2ebfe97bb8ebce3cf50498e440/pyside/utils/local_data.py#L55-L69)
- 应用 JWT 使用 `QSettings` 保存，没有系统钥匙串或硬件保护。[源码](https://github.com/Anning01/AIMedia/blob/e4e8891c9d787a2ebfe97bb8ebce3cf50498e440/pyside/utils/auth_service.py#L135-L145)
- 模型 API Key 明文写入 `opt.json`。[源码](https://github.com/Anning01/AIMedia/blob/e4e8891c9d787a2ebfe97bb8ebce3cf50498e440/pyside/utils/model_service.py#L77-L85)
- 客户端 API 基址是固定 HTTP localhost，登录请求又显式关闭 TLS 证书验证。[源码](https://github.com/Anning01/AIMedia/blob/e4e8891c9d787a2ebfe97bb8ebce3cf50498e440/pyside/api/request_handler.py#L11-L28)、[源码](https://github.com/Anning01/AIMedia/blob/e4e8891c9d787a2ebfe97bb8ebce3cf50498e440/pyside/utils/auth_service.py#L19-L31)

GEO 应保持当前边界：`channel_account` 只是租户拥有的平台身份，原始 Cookie/Token 只留在隔离 Browser Host 或 secret store；API 只保存 opaque profile/runtime binding、会话状态和过期时间。

## 5. 平台变体

**AIMedia 没有真正的平台内容变体层。**

生成阶段只生成一个 `article` 字符串，`publish_content` 根据平台选择浏览器脚本，但文章内容没有按平台再次渲染。[源码](https://github.com/Anning01/AIMedia/blob/e4e8891c9d787a2ebfe97bb8ebce3cf50498e440/pyside/utils/task_service.py#L121-L137)、[源码](https://github.com/Anning01/AIMedia/blob/e4e8891c9d787a2ebfe97bb8ebce3cf50498e440/pyside/utils/task_service.py#L231-L247)

`AccountNews.platform_data` 虽被注释为平台详细数据，但主链路未把它建设成不可变、可审计的平台 payload。[源码](https://github.com/Anning01/AIMedia/blob/e4e8891c9d787a2ebfe97bb8ebce3cf50498e440/back/apps/users/models.py#L145-L153)

对 GEO 的含义：

- 不要从 AIMedia 学平台变体；GEO 现有 `renderPlatformPublicationVariant`、payload hash、平台审计和冻结机制明显更成熟。
- 新平台应新增 `PlatformProfile`：标题/正文长度、标签、封面/正文图、联系方式、链接、声明、敏感词、视频尺寸与元数据等；同一 canonical content 渲染出独立 variant。
- 将来短视频不是在 `article` 上加一个 URL，而应是同一 campaign 下的另一种 canonical content/output family，包含 script、shot list、voice、caption、asset timeline 与 render manifest，再生成平台视频 variant。

## 6. 自动发布

### 已实现

- `AutoTools.publish` 覆盖头条号、百家号、微信公众号、企鹅号。[源码](https://github.com/Anning01/AIMedia/blob/e4e8891c9d787a2ebfe97bb8ebce3cf50498e440/pyside/auto_browser/auto_base.py#L200-L207)
- 各平台脚本完成 Cookie 注入、标题/正文输入、图片粘贴/上传、发布按钮操作和约两分钟超时。
- 对图片和正文分段插入的页面动作有现实参考意义，尤其适合整理平台 editor contract。

### 生产风险

- 使用大量绝对 XPath、class 文本和剪贴板操作，且大量 `except: pass`；平台改版时只能得到模糊失败。
- Chrome 启动带 `--no-sandbox`，并通过远程调试端口连接；缺少隔离、端口授权和 profile 生命周期治理。[源码](https://github.com/Anning01/AIMedia/blob/e4e8891c9d787a2ebfe97bb8ebce3cf50498e440/pyside/auto_browser/auto_base.py#L42-L117)
- 发布成功主要通过发布后页面元素/文案出现来置 `result["status"] = True`，不是独立公开内容回读。例如百家号处理器直接依据循环内标志返回成功。[源码](https://github.com/Anning01/AIMedia/blob/e4e8891c9d787a2ebfe97bb8ebce3cf50498e440/pyside/auto_browser/baijiahao.py#L280-L320)
- 发布失败会直接删除新闻任务，丢失失败证据和重试上下文。[源码](https://github.com/Anning01/AIMedia/blob/e4e8891c9d787a2ebfe97bb8ebce3cf50498e440/pyside/utils/task_service.py#L237-L247)
- 没有区分“点击前失败”“点击后响应丢失”“平台已接受但页面未更新”。这会造成重复发布风险。

### GEO 应怎样借鉴

- 把每个平台脚本拆成受限的 `SurfaceReader / DraftWriter / SubmitWriter / PublicReadback`，每个动作使用固定 manifest 和版本化 selector contract。
- 先只实现 `browser_draft` 和 `browser_supervised`。最终提交必须一次性 permit，点击后任何不确定结果进入 `uncertain/reconciling`，禁止自动重试。
- AIMedia 的 selector 只能作为初始调研线索，必须在授权账号上重新观察并形成 GEO 自有 fixture、漂移测试和审计证据。

## 7. 调度、重试和状态机

### 实际实现

- 自动托管随机打乱账号/来源任务，每轮只发一篇，然后固定休眠 60 秒。[源码](https://github.com/Anning01/AIMedia/blob/e4e8891c9d787a2ebfe97bb8ebce3cf50498e440/pyside/utils/task_service.py#L264-L350)
- 同账号间隔依据最近发布时间和本地 `publishNum` 判断。
- 循环异常固定等待 60 秒；外层异常 3 秒后递归调用自身。[源码](https://github.com/Anning01/AIMedia/blob/e4e8891c9d787a2ebfe97bb8ebce3cf50498e440/pyside/utils/task_service.py#L352-L363)
- UI 停止线程失败时会强制 `terminate()`。[源码](https://github.com/Anning01/AIMedia/blob/e4e8891c9d787a2ebfe97bb8ebce3cf50498e440/pyside/components/auto_publish_widget.py#L515-L545)

### 判断

这不是可恢复调度器。进程退出后没有 lease/checkpoint；没有指数退避、最大尝试、错误分类、死信、幂等、账号 circuit、平台 Kill Switch 或公平分配。递归重启还可能积累调用栈。GEO 现有 Worker/Producer、持久 cursor、attempt、lease、heartbeat、quota、circuit、readback 明显更强，绝不能替换。

唯一可吸收的是运营概念：账号发布间隔、日限额、按内容分类选择来源、账号运行状态。这些应进入 GEO 的 account control/quota 策略，不进入桌面线程。

## 8. UI 与动画

### 可借鉴

- 左侧导航把实时热点、账号管理、任务中心、一键托管、模型配置、素材导入分成清晰工作区。[源码](https://github.com/Anning01/AIMedia/blob/e4e8891c9d787a2ebfe97bb8ebce3cf50498e440/pyside/views/main_window.py#L226-L298)
- 热点卡片 -> 详情 -> 选择账号，和账号目标配置 -> 启动托管，是容易理解的运营路径。
- 账号表、任务表、日志窗口和发布目标表覆盖了第一版运营人员会寻找的信息。

### 不可照搬

- 视觉是经典 PySide 表格 + 大量组件内联 QSS，颜色、间距和控件规格重复且不统一。[主窗口样式](https://github.com/Anning01/AIMedia/blob/e4e8891c9d787a2ebfe97bb8ebce3cf50498e440/pyside/views/main_window.py#L95-L208)
- 导航图标字段全部为空，缺少视觉层级和平台识别。
- 页面切换直接 `QStackedWidget.setCurrentIndex`；源码中没有 `QPropertyAnimation`、`QEasingCurve`、淡入或共享过渡系统。[源码](https://github.com/Anning01/AIMedia/blob/e4e8891c9d787a2ebfe97bb8ebce3cf50498e440/pyside/views/main_window.py#L360-L383)
- 多处阻塞网络或轮询逻辑与 UI 线程边界不清；空状态、骨架屏、错误恢复和响应式布局有限。

### GEO UI 建议

GEO Web 应保留现有运营控制台，不迁移到 PySide。吸收 AIMedia 的信息架构后，重组为五个主工作区：

1. **今日热点**：趋势流、来源可信度、聚类、热度走势、选题篮。
2. **创作工作室**：研究证据、canonical article、平台变体并排预览；以后同处增加短视频 story board。
3. **分发中心**：账号矩阵、排期日历、批次、各 target 状态和重试/回读。
4. **账号与渠道**：登录交接、会话健康、配额、平台能力、重新认证。
5. **治理与效果**：审计、Kill Switch、发布回读、可见性与内容表现。

动效应服务状态理解：页面 160-220ms 淡入/位移；卡片 hover 120-160ms；任务状态用 layout-stable progress transition；侧栏移动 active indicator；抽屉和对话框使用统一 easing；尊重 `prefers-reduced-motion`。不要让“每个组件有动画”变成所有元素持续移动，表格、数字和关键治理操作必须稳定。

## 9. 测试与可维护性

- `back/apps/users/tests.py` 和 `back/apps/crawlers/tests.py` 只有 Django 默认占位注释。[用户测试](https://github.com/Anning01/AIMedia/blob/e4e8891c9d787a2ebfe97bb8ebce3cf50498e440/back/apps/users/tests.py)、[爬虫测试](https://github.com/Anning01/AIMedia/blob/e4e8891c9d787a2ebfe97bb8ebce3cf50498e440/back/apps/crawlers/tests.py)
- 仓库没有 CI workflow、pytest 配置、selector fixture、平台模拟器、合同测试或端到端测试。
- 本次只读验证中，`python3 -m compileall -q back pyside` 通过；这只证明语法可编译，不证明依赖安装、爬虫、登录或发布可运行。
- `requirements.txt` 有拼接错误：后端末尾出现 `faiss-cpuaiohappyeyeballs...`，部署可复现性存疑。[源码](https://github.com/Anning01/AIMedia/blob/e4e8891c9d787a2ebfe97bb8ebce3cf50498e440/back/requirements.txt)

GEO 若引入新平台，应至少有：payload contract、账号租户隔离、凭据不可见、selector drift、挑战/过期会话、点击前失败、点击后不确定、公开回读匹配/不匹配、幂等重投、平台 Kill Switch、配额与 UI 状态测试。

## 10. 安全审计

以下问题使 AIMedia 不能直接进入生产：

1. Django 提供硬编码开发 `SECRET_KEY` 默认值，且固定 `DEBUG=True`、`ALLOWED_HOSTS=["*"]`。[源码](https://github.com/Anning01/AIMedia/blob/e4e8891c9d787a2ebfe97bb8ebce3cf50498e440/back/ArticleManagePlus/settings.py#L24-L52)
2. 客户端登录请求关闭 TLS 验证，并把完整响应打印到日志；登录 token 或扫码状态可能被记录。[源码](https://github.com/Anning01/AIMedia/blob/e4e8891c9d787a2ebfe97bb8ebce3cf50498e440/pyside/utils/auth_service.py#L19-L31)、[源码](https://github.com/Anning01/AIMedia/blob/e4e8891c9d787a2ebfe97bb8ebce3cf50498e440/pyside/utils/auth_service.py#L61-L73)
3. API 请求处理器打印每个原始响应。[源码](https://github.com/Anning01/AIMedia/blob/e4e8891c9d787a2ebfe97bb8ebce3cf50498e440/pyside/api/request_handler.py#L30-L40)
4. 服务端 AI helper 中存在已提交的密钥形态字符串。本报告不复述该值；应视为已泄露并轮换。[源码位置](https://github.com/Anning01/AIMedia/blob/e4e8891c9d787a2ebfe97bb8ebce3cf50498e440/back/utils/ai_model/writing_assistant.py#L9-L15)
5. 企鹅号脚本注释中提交了一整组真实形态 Cookie/Token 示例。本报告不复述内容；应清理历史并轮换相关会话。[源码位置](https://github.com/Anning01/AIMedia/blob/e4e8891c9d787a2ebfe97bb8ebce3cf50498e440/pyside/auto_browser/qiehao.py#L254-L258)
6. `AccountsViewSet.create` 用全局 `uid` 查询账号；命中后 `perform_update` 会把该记录的 `user` 改为当前请求用户。知道另一用户 UID 的认证用户可能重绑定/覆盖其账号和 Cookie，属于严重跨用户归属漏洞。[源码](https://github.com/Anning01/AIMedia/blob/e4e8891c9d787a2ebfe97bb8ebce3cf50498e440/back/apps/users/views.py#L71-L103)
7. Cookie 作为普通 API 序列化字段返回桌面端，没有密文信封、最小权限、审计访问或 secret reference。
8. Chrome 禁用 sandbox，远程调试端口与本地 profile 使用随机目录，但没有访问控制、归属绑定和安全清理保证。
9. 默认 JWT access token 有效期 7 天，桌面端只保存 access token，未见安全 refresh/撤销流程。[源码](https://github.com/Anning01/AIMedia/blob/e4e8891c9d787a2ebfe97bb8ebce3cf50498e440/back/ArticleManagePlus/settings.py#L167-L179)

GEO 当前租户 RLS、opaque runtime binding、一次性 submit permit、payload/audit hash、Kill Switch 和公开回读边界都应保留。AIMedia 只能帮助完善平台动作，不能改变这些边界。

## 11. 许可与合规

根目录提供 Apache License 2.0 全文，因此在遵守许可证的前提下可以使用、修改和分发代码。[许可证](https://github.com/Anning01/AIMedia/blob/e4e8891c9d787a2ebfe97bb8ebce3cf50498e440/LICENSE)

但有三个注意点：

- 仓库没有 `NOTICE` 文件，许可证 Appendix 的 `Copyright [yyyy] [name]` 仍是模板。不能据此断言每个爬虫、图片资源和第三方片段的权属已经清晰。
- 如果复制代码到 GEO，需要保留 Apache-2.0 许可证文本、版权/归属声明，并对修改作显著说明；若上游后续补 NOTICE，还要同步履行 NOTICE 义务。
- 抓取和再发布新闻正文还涉及来源网站条款、版权和平台政策，Apache-2.0 只覆盖 AIMedia 自身代码，不授予第三方内容再发布权。

鉴于 GEO 已有更严格且不同的 TypeScript/Playwright 架构，推荐只学习行为与接口，重新实现，不直接复制 Python/Selenium 文件。这既减少许可归属复杂度，也避免继承安全和可靠性问题。

## 12. 映射到 GEO `release-work`

GEO 并非只有空框架：它已经具备 AIMedia 最欠缺的治理和交付底座，包括 tenant scope、平台变体、不可变审计、grant、durable job、重试/不确定态、Kill Switch、携程受控 Browser Bridge 和大量测试。AIMedia 对 GEO 的增量价值主要在 **热点产品面** 与 **新增平台真实交互调研**。

### 12.1 热点域：扩展 `@geo/research`，不要另写散落爬虫

现有 `packages/research` 已有 HTTPS/host/robots/重定向/字节限制和页面快照，`apps/api/src/research-service.ts` 能把采集落为证据。建议新增：

- `TrendSourceAdapter`：`listCandidates(cursor) -> RawTrendCandidate[]`、`fetchDetail(ref) -> SourceSnapshot`。
- `trend_sources`：租户来源策略、adapter key/version、栏目、抓取频率、授权/robots 策略。
- `trend_observations`：source item key、content hash、热度原始值、captured_at、evidence source id。
- `trend_clusters`：跨源聚类、canonical topic、velocity、freshness、confidence、risk flags。
- `topic_candidates`：进入创作前的人工/策略选择与状态。

AIMedia 的 8 个来源及栏目先转成 **disabled-by-default catalog + fixture**，逐个确认来源政策后启用。首期优先官方 RSS/API/榜单，HTML adapter 次之。

### 12.2 创作域：热点只是 evidence input

- 把选中的 `trend_cluster` 转为 research bundle 和 `evidence_sources`，不直接拼成 prompt。
- 先提取 claim candidates，再经事实核验进入 `claim_facts`；生成内容只能引用允许的事实快照。
- canonical article 与每个平台 variant 继续使用当前 hash/freeze/audit 路径。
- 增加 `origin_disclosure`、引用与相似度审计，避免把热点新闻改写误当原创。

### 12.3 平台扩展：先解除“枚举散布”，再加 adapter

当前平台在 `packages/contracts/src/index.ts` 的固定枚举，以及多份数据库 `CHECK (platform IN (...))`、core policy、media policy、connectors registry、API schema 和 Web label 中重复。新增百家号、企鹅号、微信公众号前先完成一个显式的平台 onboarding slice：

1. 版本化 `PlatformDefinition`，仍由代码白名单控制，避免任意插件执行。
2. 平台 payload schema、editorial/media limits、账号能力和 execution level。
3. DB migration 扩展平台约束与 tenant/account 外键，不直接删除约束改成任意字符串。
4. `DryRunConnector` + manual package + contract tests。
5. 授权账号 surface review；再实现 draft、supervised submit 和 public readback。
6. 生产证据通过前保持 `manual_only/dry_run`。

推荐顺序：微信公众号官方 API（若账号类型与权限满足）优先于浏览器；百家号/企鹅号/头条优先调查官方/合作方 API，浏览器只作为隔离 bridge；不要因为 AIMedia 有脚本就宣称平台可无人值守。

### 12.4 账号层：复制登录体验，不复制 Cookie

在 `channel-account-directory.tsx` 增加平台 onboarding wizard：

- 选择平台与账号；
- 显示官方 API OAuth 或 Browser Host 扫码交接；
- 后端只收到 `runtimeBindingId/profileRef`；
- 会话探针确认账号 UID 与租户期望账号一致；
- 状态显示 `ready / reauth_required / challenge / drift / disabled`；
- 重新认证不改变 channel account identity；
- 原始 Cookie、localStorage、二维码 token 不进 API、PostgreSQL、日志和截图。

### 12.5 Worker 与发布：保持 GEO 现有状态语义

AIMedia 的 `sleep + retry` 不应进入 GEO。继续使用持久化 job、lease、heartbeat、checkpoint、attempt 和 error budget，并为每个平台定义：

- safe retry before submit；
- ambiguous submit -> `uncertain/reconciling`；
- independent readback -> `confirmed`；
- challenge/session expiry -> account circuit；
- selector drift -> platform circuit；
- payload rejection -> permanent failure/new variant；
- tenant/platform/account Kill Switch 的每阶段复检。

### 12.6 短视频方向

不要把视频塞进文章发布器。建议新增明确的媒体生产模型：

- `video_projects`：源 content version、目标、时长与比例；
- `video_script_versions`：旁白、字幕、事实引用；
- `storyboard_shots`：时间轴、画面意图、素材绑定、转场意图；
- `render_manifests`：模型/字体/音乐/素材许可证、渲染参数与 hash；
- `video_variants`：抖音/视频号/小红书/B 站等平台的标题、封面、话题、尺寸、码率和时长变体；
- 媒体安全、版权、肖像、敏感画面、字幕事实和平台审计。

第一阶段先完成“文章 -> 可审核脚本/分镜 -> 人工导出”，再接 deterministic renderer，最后才接平台视频发布。

## 13. 建议实施优先级

### P0：现在做

1. 新建热点领域合同、表和 fixture，复用 `@geo/research` 安全采集。
2. 把 Web 首页改成真正的运营驾驶舱：今日热点、待审核草稿、待分发、账号异常、发布回读。
3. 建立统一 motion tokens 与页面/抽屉/状态过渡，支持 reduced motion。
4. 完成平台定义/onboarding 设计，收敛当前三平台枚举扩展点。

### P1：文章闭环

1. 上线 2-3 个合规热点源，完成聚类、热度、去重、来源证据。
2. 热点选题进入现有 AI 草稿、事实与平台变体审计。
3. 增加账号登录交接 UI 与 session health contract。
4. 选择一个有官方 API 的平台完成真实 connector；没有官方接口的平台停在 manual/draft。

### P2：更多平台与质量

1. 百家号/企鹅号/微信公众号逐个平台走 onboarding、surface review、dry-run、supervised、readback。
2. 增加平台变体 A/B、内容相似度、来源披露和效果回流。
3. 建立 selector fixture 更新、漂移告警与 adapter version rollout。

### P3：短视频

1. 脚本与分镜工作台。
2. 可追溯素材与 deterministic render manifest。
3. 平台视频变体、审计、人工发布包。
4. 经授权 API/Browser Bridge 的分阶段发布。

## 最终取舍

**抄什么：** 热点目录、账号目标配置、扫码交接、平台页面动作分解、运营工作区的信息架构。
**不抄什么：** Django/PySide 混合部署、Cookie 入库、全局 UID 更新、明文 Key/JWT、Selenium 大循环、`except: pass`、固定休眠、失败即删任务、页面文案即成功、单文章跨平台复用。
**GEO 的正确方向：** 保留现有治理与 durable delivery 底座，在其上新增趋势域、平台 onboarding factory、账号会话交接和更成熟的 Web 运营体验。
