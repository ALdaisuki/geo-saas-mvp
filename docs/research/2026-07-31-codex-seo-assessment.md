# `AgriciDaniel/codex-seo` 对 GEO SaaS 的适用性评估

日期：2026-07-31

评估对象：[`AgriciDaniel/codex-seo`](https://github.com/AgriciDaniel/codex-seo)，固定到提交
[`97c59bcdac3c9538bf0e3ae456c1e73aa387f85a`](https://github.com/AgriciDaniel/codex-seo/tree/97c59bcdac3c9538bf0e3ae456c1e73aa387f85a)。

## 结论

这个项目对我们有帮助，但当前价值主要是**补全能力地图和验证产品方向**，不是直接引入代码。

它擅长面向公开网站的经典 SEO 与网页 GEO 审计：技术 SEO、Schema、Sitemap、Core Web
Vitals、内容质量、AI 爬虫可访问性、关键词聚类、外链、漂移监控和报告生成。我们的平台擅长的则是多租户事实治理、版本化内容、确定性审计、发布许可、渠道投放和豆包/千问可见性证据。两者上游分析能力互补，但运行模型和信任边界明显不同。

当前建议是：

1. **P0：先解决许可证冲突。** 在得到明确书面授权前，不安装到生产、不复制脚本、不改造成我们的商业功能。
2. **P1：基于公开标准自行实现只读站点审计和发布后漂移检测。** 复用我们现有的租户隔离、研究采集、证据哈希和 PostgreSQL 真相源。
3. **P2：把关键词/主题聚类结果接入现有 Query Set 和 Campaign，而不是另建本地缓存体系。**
4. **P3：按 provider 接入 PageSpeed、CrUX、GSC、DataForSEO 或 Firecrawl。** 每项能力独立授权、独立计费并保留证据类别。

## 许可证门禁

上游仓库存在严重且未解释的许可证矛盾：

- README、`pyproject.toml`、插件清单和多个技能文件声明 MIT。
- 根目录 [`LICENSE`](https://github.com/AgriciDaniel/codex-seo/blob/97c59bcdac3c9538bf0e3ae456c1e73aa387f85a/LICENSE#L1-L25)
  实际是 `Proprietary Software License`，版权人为 `Avalon Reset`，并限制复制、修改、再分发和用于竞争产品。
- GitHub 仓库 API 在评估时返回的许可证标识为 `NOASSERTION`，与上述矛盾一致。

因此不能把 README 的 MIT 徽章当成足够授权。对我们的商业 GEO SaaS 来说，这不是普通的归属标注问题，而是代码复用的阻断项。需要维护者明确说明：

- 哪个许可证控制整个仓库；
- 维护者是否有权对这些文件授予 MIT；
- 是否允许商业 SaaS 使用、修改、部署和再分发衍生物；
- 从 `claude-seo` 同步而来的内容各自适用什么许可证。

在此之前，只能把功能分类当作市场与产品研究输入。任何实现都应依据官方 SEO/平台文档独立设计，并保留来源和设计记录。这不是法律意见；正式引入前应完成许可证审查。

## 上游项目是什么

它不是一个可部署的多租户 SEO SaaS，而是一套本地 Codex 工作流：

- 1 个主路由技能、26 个专项技能和 24 个 TOML Agent 配置；
- Python 确定性分析脚本和本地 `.seo-cache`；
- 可选 DataForSEO、Google API、Firecrawl 和图片生成集成；
- Markdown、JSON、HTML/PDF 审计报告输出。

这些边界由上游
[`README`](https://github.com/AgriciDaniel/codex-seo/blob/97c59bcdac3c9538bf0e3ae456c1e73aa387f85a/README.md)
和
[`docs/ARCHITECTURE.md`](https://github.com/AgriciDaniel/codex-seo/blob/97c59bcdac3c9538bf0e3ae456c1e73aa387f85a/docs/ARCHITECTURE.md)
明确描述。它的优势是快速、覆盖面广、可在 Codex 中按自然语言路由；缺少的是租户模型、RBAC、持久化审计、不可变证据、幂等作业和发布授权。

## 与现有 GEO SaaS 的关系

| 能力                            | `codex-seo`                                           | 我们当前平台                                                                      | 判断                              |
| ------------------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------- | --------------------------------- |
| 技术 SEO / Schema / Sitemap     | 有确定性脚本                                          | 研究采集已能保存 HTML、结构化数据、robots 和 sitemap，但尚未形成完整 SEO 评分产品 | 高价值补充                        |
| 网页 GEO 信号                   | AI crawler、`llms.txt`、段落结构等启发式检查          | 发布前检查直接回答、实体清晰、证据、新鲜度；另有豆包/千问 Query Set               | 可补充，不能替代真实可见性测量    |
| 关键词与主题聚类                | SERP/DataForSEO 驱动的聚类工作流                      | 已有版本化 Query Set、Campaign、21 套文章模板                                     | 高价值输入，需映射到现有模型      |
| 内容审计                        | E-E-A-T、可读性、页面结构                             | 事实闭合、联系方式、禁用词、重复度、平台限制和证据审计                            | 互补；我们的确定性门禁继续为准    |
| 漂移监控                        | 标题、meta、canonical、schema、robots、链接和正文基线 | 已有内容哈希、平台回读和不可变证据                                                | 很适合扩展为发布后站点/落地页监控 |
| Google / DataForSEO / Firecrawl | 本地凭据和可选 MCP/API                                | 尚未形成这些 provider 的正式生产适配器                                            | 中期 provider 机会                |
| 多租户与治理                    | 无                                                    | PostgreSQL、RLS、租户权限、Kill Switch、配额、审计、授权                          | 不可采用上游运行模型替换          |
| 发布自动化                      | 不是核心能力                                          | 已有受治理的发布与携程分阶段路径                                                  | 几乎无直接帮助                    |

我们的权威范围见
[`docs/superpowers/specs/2026-07-13-geo-saas-mvp-design.md`](../superpowers/specs/2026-07-13-geo-saas-mvp-design.md)
和 [`docs/mvp-status.md`](../mvp-status.md)。现有 [`ResearchCollector`](../../packages/research/src/collector.ts)
已经包含 HTTPS/允许域、DNS 公网地址校验、重定向限制、robots、响应大小和内容哈希，这比上游的本地脚本更接近生产基础。

## 最值得吸收的五项能力

### 1. 只读站点审计

为每个租户增加 `Site Audit`，产出版本化、可追溯的 `SiteAuditSnapshot`：

- robots、meta robots、canonical、状态码、重定向；
- XML sitemap 覆盖和异常 URL；
- JSON-LD 类型、解析错误与必要字段；
- 标题、描述、H1/H2、内部链接和图片元数据；
- 可选 PageSpeed/CrUX 真实指标。

数据采集应继续走现有 Research Source Policy 和租户权限，结果写 PostgreSQL 与证据表，不使用 `.seo-cache` 作为真相源。

### 2. 发布后漂移检测

上游 drift 思路适合补强我们的公开回读。对客户官网、落地页或可稳定读取的平台页面记录基线，比较：

- 标题、正文、canonical、robots 和结构化数据；
- 关键事实、联系方式和品牌实体；
- 页面内容哈希与已审计版本哈希；
- 可见性下降前后的页面变更。

漂移只产生告警和复核任务，不能自动证明排名或 AI 引用变化的因果关系。

### 3. Query Set 发现与聚类

把关键词、搜索意图和竞品页面研究规范化成候选 Query Set：

```text
SERP / 关键词证据
  -> 意图分类与主题聚类
  -> 人工审核候选问题
  -> Query Set 新版本
  -> Campaign / 模板分配
  -> 豆包、千问重复采样
```

这能补足当前旅行 Query Set 主要依靠预设问题的局限，同时保留现有负向/空白对照和版本激活流程。

### 4. 外部 SEO 数据 Provider

按价值排序建议：

1. PageSpeed Insights / CrUX：成本低、证据定义清晰，适合官网性能审计。
2. Google Search Console：只针对客户已验证站点，提供点击、曝光、查询和索引证据。
3. DataForSEO：补关键词、SERP、竞品和外链数据，但需先验证中国市场覆盖与成本。
4. Firecrawl：只在现有采集器无法处理必要的 JS 页面时启用，并继续应用允许域、大小、超时和证据哈希边界。

Provider 返回值必须标注来源、时间、区域、设备、模型/接口版本和失败状态；任何 Google 指标都不能代理豆包或千问结果。

### 5. 客户报告层

上游的 Markdown/JSON/HTML/PDF 报告组织方式可用于产品设计参考。我们的报告应从已保存证据生成，明确区分：

- 确定性站点检查；
- 第三方 API 指标；
- 模型启发式建议；
- 豆包/千问真实、人工导入或 fixture 观察；
- 已发布、仅草稿、preview 和未知状态。

## 不应直接采用的部分

### 本地 `.seo-cache`

上游缓存契约以当前工作目录为作用域，适合个人 Codex 任务，不具备租户隔离、RLS、生命周期治理和并发一致性。我们的 PostgreSQL 仍应是唯一真相源。

### Agent TOML 与安装脚本

这些文件配置用户级 `~/.codex` 环境和本地 Python 运行时，不能成为生产服务依赖，也不应写入 Linux 生产主机的运营环境。生产编排继续通过受限 MCP 工具和 API 权限完成。

### GEO 综合分数

上游
[`scripts/analyze_geo.py`](https://github.com/AgriciDaniel/codex-seo/blob/97c59bcdac3c9538bf0e3ae456c1e73aa387f85a/scripts/analyze_geo.py#L154-L174)
使用固定段落长度、问题标题、`llms.txt`、作者/日期和爬虫规则等启发式信号，并据此生成平台分数。这类分数适合页面检查清单，不是 ChatGPT、Google AI Overview、豆包或千问的真实曝光数据。

独立烟测也印证了这一点：对 `https://www.python.org` 运行 `seo-geo` 工作流得到 52/100，主要扣分来自缺少 `llms.txt`、没有 134-167 词段落和作者/日期信号。这个结果可以指导页面复核，但不能被解释成 Python 官网只有 52 分的真实 AI 可见性。

### 图片生成和发布动作

上游图片工作流、Google Indexing 或其他带写入能力的集成不能绕过我们的事实绑定、媒体审计、账号能力、Publication Grant、Kill Switch 和平台回读要求。

## 建议实施顺序

### 阶段 A：零代码复用试点

1. 解决或确认上游许可证，不安装插件。
2. 从官方规范定义 `SiteAuditSnapshot` 和证据类别。
3. 基于现有 ResearchCollector 自行实现 canonical、robots、Schema、Sitemap 和页面结构检查。
4. 在运营台展示一次站点快照和一次 drift 对比。

验收标准：所有结果携带 tenant、source policy、URL、采集时间、内容哈希、检查器版本和限制说明；任何外部失败均 fail closed 或明确标记 unavailable。

### 阶段 B：搜索需求闭环

1. 增加关键词/问题候选导入接口。
2. 人工审核后创建 Query Set 新版本。
3. 将 Query Set 与 Campaign、模板轮换和可见性运行关联。
4. 对发布前后至少两个时间点做豆包/千问直接采样。

### 阶段 C：受治理 Provider

先接 PageSpeed/CrUX，再评估 GSC 和 DataForSEO。每个 provider 单独做凭据权限、租户范围、配额、成本、审计、重试和证据契约，不把本地 Codex 配置带入生产。

## 验证记录

- 固定提交：`97c59bcdac3c9538bf0e3ae456c1e73aa387f85a`。
- 仓库规模：319 个跟踪文件，27 个 `SKILL.md`，24 个 TOML Agent 配置。
- 在隔离的 Python 3.12 环境安装核心依赖后执行上游测试：`56 passed`。
- `seo-geo` 对 `https://www.python.org` 的独立烟测成功并生成 Markdown、JSON 和缓存产物。
- 未安装该插件，未修改用户级 Codex 配置，未复制上游代码到本仓库。

## 最终判断

**产品方向帮助：高。代码直接复用价值：许可证澄清前为零。**

它清楚展示了我们下一步可以补上的“站点 SEO/GEO 诊断层”和“搜索需求发现层”；我们的优势则是它没有的多租户治理、证据链和发布闭环。正确路线是把这些能力纳入现有架构，而不是把本地技能套件嵌进生产系统。
