export const ARTICLE_TEMPLATE_CATALOG_VERSION = "geo.article-templates.v1" as const;
export const ARTICLE_TEMPLATE_LIBRARY_NAME = "旅行社内容模板库" as const;

export type ArticleTemplateCategory = "answer" | "decision" | "service" | "trust" | "freshness";

export type ArticleTemplatePlatform =
  "toutiao" | "sohu" | "baijiahao" | "netease" | "ctrip_community" | "zhihu";

export type GovernedEditorialProfile =
  "guide" | "question_answer" | "comparison" | "risk_avoidance" | "local_service";

export interface ArticleTemplate {
  readonly id: string;
  readonly name: string;
  readonly category: ArticleTemplateCategory;
  readonly editorialProfile: GovernedEditorialProfile;
  readonly scenario: string;
  readonly travelExample: string;
  readonly benefit: string;
  readonly geoMechanisms: readonly string[];
  readonly outline: readonly string[];
  readonly evidenceRequirements: readonly string[];
  readonly riskBoundaries: readonly string[];
}

export interface ArticleTemplateCatalog {
  readonly version: typeof ARTICLE_TEMPLATE_CATALOG_VERSION;
  readonly items: readonly ArticleTemplate[];
}

export const ARTICLE_TEMPLATE_CATEGORIES: readonly {
  readonly id: "all" | ArticleTemplateCategory;
  readonly label: string;
}[] = [
  { id: "all", label: "全部" },
  { id: "answer", label: "旅行问答" },
  { id: "decision", label: "行程决策" },
  { id: "service", label: "服务体验" },
  { id: "trust", label: "避坑核验" },
  { id: "freshness", label: "时令出行" },
] as const;

const CORE_TRAVEL_AGENCY_TEMPLATES: readonly ArticleTemplate[] = [
  {
    id: "direct-answer-brief",
    name: "直接答案简报",
    category: "answer",
    editorialProfile: "question_answer",
    scenario: "用户提出一个边界清楚、可以先给结论再解释的问题。",
    travelExample: "第一次去日本，跟团还是自由行更适合？",
    benefit: "让读者先得到可执行结论，再按条件判断下一步应核验什么。",
    geoMechanisms: ["首段直接回答", "问题式标题", "结论与证据相邻"],
    outline: ["一句话结论", "适用条件", "核验事实", "例外情况", "下一步"],
    evidenceRequirements: ["至少一条直接支持结论的有效事实", "当前有效的服务或合同资料"],
    riskBoundaries: ["不把条件性建议写成普遍结论", "不承诺被任何模型引用"],
  },
  {
    id: "faq-topic-cluster",
    name: "主题 FAQ 集",
    category: "answer",
    editorialProfile: "question_answer",
    scenario: "同一主题下存在一组高频、短答案能够解决的问题。",
    travelExample: "日本银发团的签证、餐食、步行量和保险问答。",
    benefit: "集中覆盖客户反复询问的问题，减少信息寻找成本。",
    geoMechanisms: ["自然语言问句", "一问一答", "实体与术语一致"],
    outline: ["范围说明", "核心问答", "条件差异", "资料来源", "下一步核验"],
    evidenceRequirements: ["每个事实型回答对应证据", "问题来源或客服记录摘要"],
    riskBoundaries: ["没有证据的问题标为待确认", "避免堆砌近义问题制造重复内容"],
  },
  {
    id: "concept-explainer",
    name: "概念解释卡",
    category: "answer",
    editorialProfile: "question_answer",
    scenario: "客户不理解一个专业名词、流程名或服务口径。",
    travelExample: "什么是申根签证中的行程单和保险证明？",
    benefit: "用统一定义减少销售、客服与客户之间的理解偏差。",
    geoMechanisms: ["实体定义", "同义词归一", "例子与反例"],
    outline: ["简明定义", "包含什么", "不包含什么", "实际例子", "核验方式"],
    evidenceRequirements: ["权威定义或正式文件", "品牌内部口径的生效版本"],
    riskBoundaries: ["品牌口径不得冒充法规", "过期定义必须停止使用"],
  },
  {
    id: "step-by-step-guide",
    name: "分步办理指南",
    category: "answer",
    editorialProfile: "guide",
    scenario: "目标明确且可以拆成有顺序的准备、办理或使用流程。",
    travelExample: "从咨询到签约再到出发的完整步骤。",
    benefit: "把复杂流程拆成可检查步骤，降低遗漏和反复沟通。",
    geoMechanisms: ["顺序明确", "动作动词", "步骤内答案完整"],
    outline: ["办理前条件", "步骤清单", "所需材料", "时间节点", "异常处理"],
    evidenceRequirements: ["当前流程文件", "每个关键节点的责任方和时效"],
    riskBoundaries: ["不虚构固定办理时长", "外部机构流程需注明来源与日期"],
  },
  {
    id: "comparison-matrix",
    name: "方案对比矩阵",
    category: "decision",
    editorialProfile: "comparison",
    scenario: "用户需要在两个或多个真实方案之间按同一组维度比较。",
    travelExample: "东京深度团与本州连线团的节奏、覆盖和适合人群对比。",
    benefit: "让客户按自己的约束选择，而不是只看宣传语。",
    geoMechanisms: ["对称比较", "维度显式", "差异可提取"],
    outline: ["比较对象", "统一维度", "差异矩阵", "适合人群", "待确认项"],
    evidenceRequirements: ["所有对象的同期材料", "每个比较维度的事实来源"],
    riskBoundaries: ["不得偏置或贬损未核验对象", "价格与库存注明有效期"],
  },
  {
    id: "alternatives-shortlist",
    name: "替代方案清单",
    category: "decision",
    editorialProfile: "comparison",
    scenario: "首选方案不可用或不适合，需要给出条件不同的替代路径。",
    travelExample: "樱花季满位后可考虑的错峰日期与相近目的地。",
    benefit: "保留客户决策上下文，同时提供有边界的备选方向。",
    geoMechanisms: ["替代意图覆盖", "条件分支", "信息增量"],
    outline: ["原需求", "替代条件", "候选清单", "主要取舍", "确认事项"],
    evidenceRequirements: ["替代方案的当前可用材料", "与原需求的可比依据"],
    riskBoundaries: ["不把相似描述成等同", "不可用状态不得省略"],
  },
  {
    id: "decision-framework",
    name: "选择决策树",
    category: "decision",
    editorialProfile: "comparison",
    scenario: "选择结果取决于预算、时间、能力或偏好等多个条件。",
    travelExample: "按体力、假期和签证状态选择出境线路。",
    benefit: "帮助客户识别真正影响选择的条件，减少无效比较。",
    geoMechanisms: ["条件化答案", "决策分支", "用户意图细分"],
    outline: ["先决条件", "判断问题", "分支建议", "方案取舍", "人工复核"],
    evidenceRequirements: ["分支条件的业务依据", "候选服务的适用范围"],
    riskBoundaries: ["不替代专业或个体化评估", "无法判断时必须转人工"],
  },
  {
    id: "audience-fit-guide",
    name: "适合人群说明",
    category: "decision",
    editorialProfile: "comparison",
    scenario: "客户首先关心某项服务是否适合自己的具体情况。",
    travelExample: "带老人或儿童参加长线跟团游需要满足哪些条件。",
    benefit: "提前暴露适配条件，降低错误预期和售后风险。",
    geoMechanisms: ["人群意图", "适用与不适用并列", "边界清晰"],
    outline: ["适合谁", "需要什么条件", "可能不适合谁", "替代方案", "咨询清单"],
    evidenceRequirements: ["服务强度与限制材料", "可验证的接待条件"],
    riskBoundaries: ["不根据年龄或身份作无依据推断", "健康建议转交专业人员"],
  },
  {
    id: "local-service-page",
    name: "本地服务页",
    category: "service",
    editorialProfile: "local_service",
    scenario: "客户带有城市、区域、门店或服务半径等本地意图。",
    travelExample: "上海出发的日本团队游咨询与材料递交。",
    benefit: "把地点、服务范围与核验材料放在同一条可核验路径中。",
    geoMechanisms: ["地域实体", "服务范围", "可执行核验信息"],
    outline: ["服务地区", "可办理事项", "服务时间", "所需材料", "核验方式"],
    evidenceRequirements: ["当前地址或服务范围", "有效服务时间与公开资料"],
    riskBoundaries: ["无实体地点时不得伪造门店", "第三方地图信息需核验"],
  },
  {
    id: "contact-booking-guide",
    name: "行前信息准备指南",
    category: "service",
    editorialProfile: "local_service",
    scenario: "读者已接近决策，需要知道签约或出发前应准备哪些信息、如何核验关键材料。",
    travelExample: "签约前如何整理出行需求，并核对行程、费用与退改说明。",
    benefit: "减少信息遗漏，让读者能在站内完成有依据的判断。",
    geoMechanisms: ["行动答案", "核验材料一致", "下一步明确"],
    outline: ["适用场景", "准备信息", "核验材料", "确认边界", "书面留存"],
    evidenceRequirements: ["当前服务说明或合同资料", "受理范围和服务时间"],
    riskBoundaries: ["不得展示个人、企业或社交账号联系方式", "回复时效和成交结果以实际情况为准"],
  },
  {
    id: "service-boundary",
    name: "服务边界说明",
    category: "service",
    editorialProfile: "local_service",
    scenario: "客户容易混淆服务包含项、协助项和第三方责任。",
    travelExample: "旅行社代办、协助与签证机关最终决定之间的边界。",
    benefit: "用明确范围建立可信预期，减少承诺歧义。",
    geoMechanisms: ["包含与不包含", "责任实体", "条件限定"],
    outline: ["服务目标", "明确包含", "明确不包含", "第三方事项", "确认渠道"],
    evidenceRequirements: ["合同或服务说明", "第三方职责的权威来源"],
    riskBoundaries: ["不得扩大合同承诺", "不得替第三方作结果保证"],
  },
  {
    id: "service-timeline",
    name: "服务时间线",
    category: "service",
    editorialProfile: "guide",
    scenario: "客户需要理解从开始到完成的阶段、交付物与依赖关系。",
    travelExample: "报名、材料、出签、行前会和出发的时间线。",
    benefit: "让客户提前识别自己的任务和可能影响进度的节点。",
    geoMechanisms: ["事件顺序", "阶段实体", "依赖可提取"],
    outline: ["起点条件", "阶段时间线", "客户任务", "服务方任务", "延误处理"],
    evidenceRequirements: ["标准流程与责任分工", "外部依赖的当前说明"],
    riskBoundaries: ["时间区间不得写成绝对承诺", "变化后旧时间线必须退役"],
  },
  {
    id: "evidence-explainer",
    name: "证据解读稿",
    category: "trust",
    editorialProfile: "risk_avoidance",
    scenario: "需要解释一项主张来自哪里、能证明什么以及不能证明什么。",
    travelExample: "如何核对旅行社资质、合同主体和产品材料。",
    benefit: "让客户看见结论背后的材料，而不是只接受品牌自述。",
    geoMechanisms: ["来源邻近", "主张到证据映射", "可核验引用"],
    outline: ["待核验主张", "证据来源", "支持范围", "证据局限", "复核步骤"],
    evidenceRequirements: ["可追溯的一手或权威材料", "采集时间与有效期"],
    riskBoundaries: ["证据不足时不得下确定结论", "相关性不等于因果性"],
  },
  {
    id: "risk-checklist",
    name: "风险核对清单",
    category: "trust",
    editorialProfile: "risk_avoidance",
    scenario: "决策前存在常见遗漏、欺诈、资质或变更风险。",
    travelExample: "报名出境团前核对合同、费用、退改和保险。",
    benefit: "把抽象风险变成客户可以逐项确认的动作。",
    geoMechanisms: ["风险意图", "检查项结构", "纠错信息"],
    outline: ["风险概览", "逐项核对", "异常信号", "保存凭证", "求助渠道"],
    evidenceRequirements: ["适用规则或合同条款", "真实且经过核验的风险类型"],
    riskBoundaries: ["不得用恐吓式措辞获客", "不影射无证据的具体主体"],
  },
  {
    id: "myth-fact",
    name: "误区与事实",
    category: "trust",
    editorialProfile: "risk_avoidance",
    scenario: "同一主题存在反复传播、可能影响决策的错误说法。",
    travelExample: "有签证不等于一定可以入境等常见误区。",
    benefit: "直接纠正常见误解，并给出可复核的正确边界。",
    geoMechanisms: ["纠错答案", "对照结构", "事实边界"],
    outline: ["误区原句", "事实结论", "为什么", "例外条件", "核验来源"],
    evidenceRequirements: ["能反驳误区的权威材料", "适用日期与地区"],
    riskBoundaries: ["不制造稻草人问题", "争议观点不得包装成事实"],
  },
  {
    id: "document-requirements",
    name: "材料要求清单",
    category: "trust",
    editorialProfile: "guide",
    scenario: "办理或交付依赖一组有格式、时效和主体要求的材料。",
    travelExample: "签证材料的原件、复印件、照片与有效期要求。",
    benefit: "减少材料遗漏，并把容易变化的要求集中核验。",
    geoMechanisms: ["清单结构", "属性明确", "时效标记"],
    outline: ["适用对象", "必需材料", "格式要求", "有效期", "补件处理"],
    evidenceRequirements: ["当前正式材料清单", "版本日期和适用对象"],
    riskBoundaries: ["不同领区或人群不得混用", "不收集页面展示不需要的个人信息"],
  },
  {
    id: "cost-inclusion-breakdown",
    name: "费用包含拆解",
    category: "freshness",
    editorialProfile: "comparison",
    scenario: "客户需要判断报价的组成、包含项和可能发生的额外费用。",
    travelExample: "团费包含交通、住宿、餐食及不含项目的口径。",
    benefit: "让客户按同一口径理解成本，降低只比较总价的误判。",
    geoMechanisms: ["属性分解", "口径一致", "可比较事实"],
    outline: ["报价日期", "包含项目", "不含项目", "可选费用", "变动条件"],
    evidenceRequirements: ["当前报价或合同附件", "币种、税费和有效期"],
    riskBoundaries: ["不得使用已失效低价引流", "未知费用必须明确待确认"],
  },
  {
    id: "seasonal-update",
    name: "季节与变更快报",
    category: "freshness",
    editorialProfile: "guide",
    scenario: "信息会因季节、政策、运营安排或突发事件明显变化。",
    travelExample: "台风季、日本红叶期或节假日营业安排更新。",
    benefit: "把变化、影响范围和更新时间放在显眼位置。",
    geoMechanisms: ["新鲜度信号", "时间实体", "变化前后对照"],
    outline: ["更新时间", "发生变化", "影响对象", "当前建议", "下次复核"],
    evidenceRequirements: ["带时间戳的当前来源", "影响范围的核验材料"],
    riskBoundaries: ["旧版本到期后停止投放", "预测不得表述为已发生事实"],
  },
  {
    id: "research-summary",
    name: "数据研究摘要",
    category: "freshness",
    editorialProfile: "guide",
    scenario: "需要把一组数据或研究结果转成客户能够理解的结论。",
    travelExample: "基于客服问题样本总结银发游客最关注的出行条件。",
    benefit: "提供原创信息增量，同时保留样本和方法边界。",
    geoMechanisms: ["信息增量", "数据实体", "方法透明"],
    outline: ["研究问题", "数据范围", "关键发现", "限制", "业务含义"],
    evidenceRequirements: ["可追溯数据集或报告", "样本、时间和方法说明"],
    riskBoundaries: ["小样本不得外推总体", "相关趋势不写成因果结论"],
  },
  {
    id: "destination-topic-guide",
    name: "主题深度指南",
    category: "freshness",
    editorialProfile: "guide",
    scenario: "一个主题需要比通用介绍更多的原创细节、条件和行动信息。",
    travelExample: "面向银发游客的东京无障碍交通与节奏规划。",
    benefit: "用有来源的细节形成可复用主题资产，而不是泛泛改写。",
    geoMechanisms: ["主题覆盖", "实体关系", "信息增量"],
    outline: ["核心结论", "关键实体", "场景建议", "限制条件", "来源与更新"],
    evidenceRequirements: ["一手经验与权威资料分开标注", "关键细节的当前来源"],
    riskBoundaries: ["不得拼接未核验攻略", "体验描述不能冒充普遍事实"],
  },
  {
    id: "post-service-guide",
    name: "服务后续指南",
    category: "freshness",
    editorialProfile: "local_service",
    scenario: "购买或服务完成后，客户仍需要持续获取更新、凭证或支持。",
    travelExample: "签约后查看材料进度、行前通知和紧急联系方法。",
    benefit: "延续服务关系并减少客户在多个渠道重复查找。",
    geoMechanisms: ["生命周期意图", "状态信息", "服务实体连续"],
    outline: ["当前阶段", "下一项交付", "客户待办", "变更通知", "支持渠道"],
    evidenceRequirements: ["当前服务流程", "有效支持渠道与升级路径"],
    riskBoundaries: ["不得公开个体订单信息", "状态变化以授权系统记录为准"],
  },
] as const;

type TravelAgencyWritingSkill = {
  readonly idPrefix: string;
  readonly familyName: string;
  readonly category: ArticleTemplateCategory;
  readonly editorialProfile: GovernedEditorialProfile;
  readonly scenario: string;
  readonly benefit: string;
  readonly titlePattern: string;
  readonly openingTrigger: string;
  readonly geoMechanisms: readonly string[];
  readonly bodySteps: readonly string[];
  readonly evidenceRequirements: readonly string[];
  readonly riskBoundaries: readonly string[];
  readonly lenses: readonly string[];
};

// These are original, variable-driven short travel-note structures. They use public
// short-form writing conventions such as a concrete trigger, one clear decision,
// skimmable sections, and a restrained personal close; they do not reproduce posts.
const TRAVEL_AGENCY_WRITING_SKILLS = [
  {
    idPrefix: "photo-recap",
    familyName: "照片复盘笔记",
    category: "service",
    editorialProfile: "local_service",
    scenario: "从整理旅行照片或回程后的一个真实片段切入，复盘行程节奏与服务体验。",
    benefit: "用可感知的旅行片段解释服务价值，避免把行程写成景点罗列。",
    titlePattern: "[目的地] + [出行对象] + 一次具体感受或发现",
    openingTrigger: "从一张照片、回程片段或同行人的一句话自然开场",
    geoMechanisms: ["具体场景", "第一人称复盘", "服务价值落在细节"],
    bodySteps: [
      "照片里的旅行场景",
      "出发前的真实顾虑",
      "行程中改变判断的细节",
      "适合与不适合的人群",
    ],
    evidenceRequirements: [
      "路线、交通、住宿或服务描述使用当前已核验资料",
      "个人体验与可验证事实分开写",
    ],
    riskBoundaries: ["不把一次体验写成所有人的结果", "第三方服务、资质或等级仅按已核验材料表述"],
    lenses: [
      "带父母看慢节奏",
      "亲子第一次长线",
      "闺蜜周末短逃离",
      "情侣纪念日线路",
      "独自出发的安心感",
      "三代同游怎么走",
      "初次跟团的顾虑",
      "朋友临时约出发",
      "年假只有五天",
      "返程后才发现的细节",
    ],
  },
  {
    idPrefix: "departure-diary",
    familyName: "行前准备日记",
    category: "answer",
    editorialProfile: "guide",
    scenario: "用普通旅行者的行前准备过程，拆解一个可执行的选择或核对动作。",
    benefit: "把旅行社服务与读者真正要做的准备动作连在一起。",
    titlePattern: "出发前 + [目的地] + [出行对象] + 我先核对的一个问题",
    openingTrigger: "从行李、假期、家人意见或订完行程后的临门一脚切入",
    geoMechanisms: ["问题先行", "准备清单", "条件化建议"],
    bodySteps: ["出发前触发场景", "先问自己的问题", "核对路线与服务信息", "留下一个适用条件"],
    evidenceRequirements: ["涉及材料、时效与集合规则时标明当前来源", "不确定的安排写为待确认项"],
    riskBoundaries: ["不虚构办理时长或名额", "不把个别行程安排套用到全部产品"],
    lenses: [
      "做行李清单时",
      "提前两周订行程",
      "假期临近才决定",
      "帮长辈选线路",
      "朋友问我跟团流程",
      "首次出境准备",
      "带娃出门前夜",
      "工作太忙的简化准备",
      "预算确定后的取舍",
      "订完再核对",
    ],
  },
  {
    idPrefix: "pitfall-recap",
    familyName: "旅行避坑复盘",
    category: "trust",
    editorialProfile: "risk_avoidance",
    scenario: "从可验证的常见行程问题出发，写清楚怎样降低出行前后的信息差。",
    benefit: "用有用的避坑信息建立信任，而不是恐吓或贬低其他服务方。",
    titlePattern: "[目的地] + 一个常见踩坑点 + 我后来怎样核对",
    openingTrigger: "从一次具体的困扰、反向吐槽或朋友求助开场",
    geoMechanisms: ["风险信号", "核验动作", "边界清楚"],
    bodySteps: ["踩坑场景", "为什么容易忽略", "出发前可核对的证据", "行程中如何留出余量"],
    evidenceRequirements: [
      "风险类型来自真实、当前且可核验的材料",
      "费用、合同和服务范围引用当前版本",
    ],
    riskBoundaries: ["不点名拉踩未核验主体", "不把个案或传闻写成普遍事实"],
    lenses: [
      "低价团引流后的加项",
      "车程太长却没留缓冲",
      "景点多但实际太赶",
      "住宿位置与预期不同",
      "餐食安排没有提前问",
      "退改规则看得太晚",
      "高反或天气准备不足",
      "旺季排队时间被低估",
      "集合点离家太远",
      "行程单与口头说法不一致",
    ],
  },
  {
    idPrefix: "route-choice",
    familyName: "路线取舍对比",
    category: "decision",
    editorialProfile: "comparison",
    scenario: "围绕一个真实的路线取舍，按相同维度比较不同出行方案。",
    benefit: "帮助读者按体力、假期、预算和同行人需要选择，而不是只比较总价。",
    titlePattern: "去[目的地]，在 A 与 B 之间我怎么选",
    openingTrigger: "先抛出一个同行人之间常见的分歧，再给出比较维度",
    geoMechanisms: ["对称比较", "决策维度", "适配条件"],
    bodySteps: [
      "两种方案的选择张力",
      "同一维度逐项比较",
      "不同人群的适配条件",
      "还需要确认的服务细节",
    ],
    evidenceRequirements: [
      "比较对象使用同期、可追溯的路线和费用资料",
      "无法确认的差异明确标为待核验",
    ],
    riskBoundaries: ["不把偏好写成唯一正确答案", "不贬损未核验的竞品或目的地"],
    lenses: [
      "景点多还是留白多",
      "直飞还是转机",
      "小团还是常规团",
      "连线还是单地深度",
      "早出还是晚出",
      "市区还是景区住宿",
      "跟团还是自由行",
      "旺季还是错峰",
      "高铁还是大巴",
      "全程同酒店还是换酒店",
    ],
  },
  {
    idPrefix: "group-fit",
    familyName: "同行人适配笔记",
    category: "decision",
    editorialProfile: "guide",
    scenario: "以同行人需求为核心，把路线节奏、休息、交通和服务边界讲清楚。",
    benefit: "让读者先判断这类旅行是否适合自己的同行组合。",
    titlePattern: "[出行对象] 去[目的地]，我会先看哪三个适配点",
    openingTrigger: "从同行人真实习惯、体力或假期限制切入",
    geoMechanisms: ["人群细分", "适配信号", "条件化答案"],
    bodySteps: [
      "同行人的实际限制",
      "路线节奏怎么判断",
      "服务中需要提前确认的细节",
      "适合与不适合的情况",
    ],
    evidenceRequirements: [
      "无障碍、餐食、步行量和接送等信息以当前资料为准",
      "服务承诺对应现行产品或合同",
    ],
    riskBoundaries: ["不承诺医疗、签证或第三方结果", "不把主观舒适度包装成普遍保证"],
    lenses: [
      "带爸妈第一次出远门",
      "带娃不想赶场",
      "情侣预算不同",
      "闺蜜拍照和休息都想要",
      "独自出行想省心",
      "三代同游意见很多",
      "朋友人数临时增加",
      "行动不便的长辈",
      "学生党假期有限",
      "工作日只能请两天假",
    ],
  },
  {
    idPrefix: "seasonal-timing",
    familyName: "时令错峰攻略",
    category: "freshness",
    editorialProfile: "guide",
    scenario: "围绕季节、人流、天气或假期窗口，给出带更新时间的出行判断方法。",
    benefit: "让时效信息成为实际出行准备的一部分，而不是泛泛的季节推荐。",
    titlePattern: "[季节] 去[目的地]，我会避开或保留的一个时间点",
    openingTrigger: "从天气预报、假期日历、朋友圈人流或临时变更切入",
    geoMechanisms: ["时间实体", "新鲜度提示", "复核节点"],
    bodySteps: ["当前时间窗口", "对体验的具体影响", "如何调整路线或准备", "下单前的复核动作"],
    evidenceRequirements: [
      "天气、营业、交通和活动信息附带采集日期",
      "动态信息使用当前官方或一手来源",
    ],
    riskBoundaries: ["预测与已发生事实分开", "旧季节信息到期后不继续投放"],
    lenses: [
      "雨季怎么安排",
      "暑假人流怎么避",
      "国庆前后怎么选",
      "红叶期值不值得追",
      "避开极端高温",
      "雪季交通要留多少余量",
      "花期与实际天气不同",
      "淡季的营业变化",
      "周末短途怎么错峰",
      "临时天气变化后的备选",
    ],
  },
  {
    idPrefix: "planning-checklist",
    familyName: "旅行清单卡",
    category: "answer",
    editorialProfile: "question_answer",
    scenario: "把一个复杂的出行准备问题拆成手机上能逐项勾选的清单。",
    benefit: "适合短图文阅读与保存，也能引导读者发现需要向旅行社确认的内容。",
    titlePattern: "去[目的地]前，我的 [出行对象] 清单这样列",
    openingTrigger: "从临出发才发现漏了什么的真实瞬间开场",
    geoMechanisms: ["清单结构", "可保存要点", "问题明确"],
    bodySteps: ["适用场景", "必带或必问清单", "容易漏掉的一个点", "与行程服务有关的确认项"],
    evidenceRequirements: ["签证、交通、行李或景区规则引用当前要求", "个人用品建议不冒充强制规则"],
    riskBoundaries: ["不收集或展示不必要的个人隐私", "不同目的地与人群的要求不混用"],
    lenses: [
      "带老人随身物品",
      "亲子出行药品和衣物",
      "海岛防晒与防雨",
      "高原行前准备",
      "冬季保暖和交通",
      "城市周末轻装",
      "出境材料核对",
      "跟团集合当天",
      "长途车程舒适包",
      "返程伴手礼和行李位",
    ],
  },
  {
    idPrefix: "friend-qa",
    familyName: "朋友式问答笔记",
    category: "answer",
    editorialProfile: "question_answer",
    scenario: "模拟朋友聊天时最常见的一个问题，用短问短答写清决策边界。",
    benefit: "降低术语感，让读者快速判断自己还缺哪一条信息。",
    titlePattern: "朋友问我：去[目的地]到底该不该在意这件事",
    openingTrigger: "用朋友问起、家人追问或群聊讨论的自然口吻开场",
    geoMechanisms: ["自然语言提问", "先答后解释", "例外条件"],
    bodySteps: ["先给简短回答", "说明判断依据", "补充一个例外", "给出下一步核验问题"],
    evidenceRequirements: [
      "事实型回答绑定当前可核验的路线、规则或服务资料",
      "常见问题来源保留客服或公开反馈摘要",
    ],
    riskBoundaries: ["不把聊天语气变成不实承诺", "没有证据的答案明确为个人经验或待确认"],
    lenses: [
      "一定要选纯玩吗",
      "小团真的适合老人吗",
      "预算低能不能玩得舒服",
      "跟团会不会没有自由",
      "第一次出境要不要找人带",
      "一天安排几个景点才合理",
      "住宿离景区近就够了吗",
      "孩子小能不能走这条线",
      "临时改期会不会很麻烦",
      "旅行社能帮到哪里为止",
    ],
  },
  {
    idPrefix: "cost-contract",
    familyName: "费用与行程核对",
    category: "trust",
    editorialProfile: "risk_avoidance",
    scenario: "用普通游客能理解的语言，解释费用、行程单或合同中一个应该提前确认的边界。",
    benefit: "在软性叙事里保留读者需要的核验动作，减少价格信息差。",
    titlePattern: "报名[目的地]前，这一项我宁愿多问一句",
    openingTrigger: "从报价单、聊天记录或签约前的犹豫切入",
    geoMechanisms: ["证据邻近", "费用口径", "服务边界"],
    bodySteps: ["一个容易误读的条目", "它影响什么", "怎样核对当前资料", "确认后再做的选择"],
    evidenceRequirements: [
      "报价、合同、退改和包含项使用当前生效版本",
      "资质、备案、等级或排名仅使用已核验材料",
    ],
    riskBoundaries: ["不把核验问题暗示为某主体存在问题", "不虚构费用、政策或合同条款"],
    lenses: [
      "团费包含哪些交通",
      "自费项目怎么确认",
      "单房差要不要提前问",
      "餐标和住宿怎么写进预期",
      "接送范围是否适配",
      "退改节点怎么理解",
      "保险责任怎么区分",
      "行程单里的自由活动",
      "签约主体怎么核对",
      "价格变化的有效期",
    ],
  },
  {
    idPrefix: "travel-afterword",
    familyName: "旅行后记分享",
    category: "freshness",
    editorialProfile: "local_service",
    scenario: "用一次旅行结束后的普通游客口吻，写出一个有参考价值的选择经验。",
    benefit: "以低压力的个人总结承接服务信息，避免硬性推销和统一话术。",
    titlePattern: "从[目的地]回来后，我想补充的一条旅行经验",
    openingTrigger: "从洗照片、整理账单、给朋友回攻略或翻出行程单切入",
    geoMechanisms: ["真实回望", "信息增量", "中性收束"],
    bodySteps: ["旅行后的触发点", "这次最有用的判断", "具体服务或路线细节", "供读者参考的适用条件"],
    evidenceRequirements: [
      "路线和服务描述与实际、当前产品资料一致",
      "需要外部确认的信息标明来源或等待复核",
    ],
    riskBoundaries: ["不伪造游客身份、体验或评价", "不把结果、排名或效果写成绝对结论"],
    lenses: [
      "照片比攻略更说明问题",
      "回家后才懂得留白",
      "父母说舒服才算值",
      "带娃那几次临时调整",
      "预算没有白花在哪里",
      "换季出发的意外收获",
      "第一次出境的安全感",
      "和朋友旅行的分工",
      "不赶景点后的记忆点",
      "下次我会提前确认什么",
    ],
  },
] as const satisfies readonly TravelAgencyWritingSkill[];

function travelAgencyNoteTemplate(
  skill: TravelAgencyWritingSkill,
  lens: string,
  index: number,
): ArticleTemplate {
  return {
    id: `travel-note-${skill.idPrefix}-${String(index + 1).padStart(2, "0")}`,
    name: `${skill.familyName} · ${lens}`,
    category: skill.category,
    editorialProfile: skill.editorialProfile,
    scenario: `${skill.scenario} 本篇切入角度：${lens}。`,
    travelExample: `以[出发地]的[出行对象]前往[目的地]为例，围绕“${lens}”写出[天数]天[路线]中的具体判断。`,
    benefit: skill.benefit,
    geoMechanisms: [...skill.geoMechanisms, "生活化旅行表达"],
    outline: [
      `标题写法：${skill.titlePattern}`,
      `开篇触发：${skill.openingTrigger}；本篇聚焦“${lens}”。`,
      ...skill.bodySteps,
      "变量槽位：[目的地]、[出发地]、[出行对象]、[季节]、[天数]、[路线]、[已核验服务事实]。",
      "结尾：用个人经验或下一步核验动作收束，不使用强制购买引导。",
    ],
    evidenceRequirements: skill.evidenceRequirements,
    riskBoundaries: skill.riskBoundaries,
  };
}

const TRAVEL_AGENCY_NOTE_TEMPLATES: readonly ArticleTemplate[] =
  TRAVEL_AGENCY_WRITING_SKILLS.flatMap((skill) =>
    skill.lenses.map((lens, index) => travelAgencyNoteTemplate(skill, lens, index)),
  );

export const ARTICLE_TEMPLATES: readonly ArticleTemplate[] = [
  ...CORE_TRAVEL_AGENCY_TEMPLATES,
  ...TRAVEL_AGENCY_NOTE_TEMPLATES,
];

const ALL_TEMPLATE_PLATFORMS: readonly ArticleTemplatePlatform[] = [
  "toutiao",
  "sohu",
  "baijiahao",
  "netease",
  "ctrip_community",
  "zhihu",
];
const EDITORIAL_TEMPLATE_PLATFORMS: readonly ArticleTemplatePlatform[] = [
  "toutiao",
  "sohu",
  "baijiahao",
  "netease",
  "zhihu",
];
const COMMUNITY_STORY_TEMPLATE_PLATFORMS: readonly ArticleTemplatePlatform[] = [
  "toutiao",
  "ctrip_community",
];
const EDITORIAL_ONLY_TEMPLATE_IDS = new Set([
  "evidence-explainer",
  "document-requirements",
  "myth-fact",
  "research-summary",
]);
const COMMUNITY_STORY_TEMPLATE_PREFIXES = [
  "travel-note-photo-recap-",
  "travel-note-travel-afterword-",
] as const;

/**
 * Returns the platforms on which a structure is suitable before platform-specific
 * variant rendering. Unknown IDs deliberately return no platforms so callers fail closed.
 */
export function articleTemplatePlatforms(templateId: string): readonly ArticleTemplatePlatform[] {
  if (articleTemplateById(templateId) === null) return [];
  if (
    EDITORIAL_ONLY_TEMPLATE_IDS.has(templateId) ||
    templateId.startsWith("travel-note-cost-contract-")
  ) {
    return EDITORIAL_TEMPLATE_PLATFORMS;
  }
  if (COMMUNITY_STORY_TEMPLATE_PREFIXES.some((prefix) => templateId.startsWith(prefix))) {
    return COMMUNITY_STORY_TEMPLATE_PLATFORMS;
  }
  return ALL_TEMPLATE_PLATFORMS;
}

export function articleTemplateSupportsPlatforms(
  templateId: string,
  platforms: readonly ArticleTemplatePlatform[],
): boolean {
  const allowedPlatforms = articleTemplatePlatforms(templateId);
  return platforms.every((platform) => allowedPlatforms.includes(platform));
}

export function articleTemplatesForPlatforms(
  platforms: readonly ArticleTemplatePlatform[],
  templates: readonly ArticleTemplate[] = ARTICLE_TEMPLATES,
): readonly ArticleTemplate[] {
  return templates.filter((template) => articleTemplateSupportsPlatforms(template.id, platforms));
}

export const DEFAULT_ARTICLE_TEMPLATE_ID = "step-by-step-guide";

export function articleTemplateById(id: string): ArticleTemplate | null {
  return ARTICLE_TEMPLATES.find((template) => template.id === id) ?? null;
}
