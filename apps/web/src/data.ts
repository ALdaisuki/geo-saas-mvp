export type Platform = "头条号" | "搜狐号" | "携程社区";
export type StatusTone = "neutral" | "success" | "warning" | "danger" | "info";

export interface TenantDemo {
  id: string;
  name: string;
  shortName: string;
  industry: string;
  hotline: string;
  wechat: string[];
  status: "运行中" | "测试隔离";
}

export interface CampaignDemo {
  id: string;
  name: string;
  topic: string;
  industry: string;
  mode: "Shadow" | "监督投放" | "无人值守";
  articles: number;
  passRate: number;
  updatedAt: string;
}

export interface QueryRunDemo {
  prompt: string;
  intent: string;
  doubao: string;
  qwen: string;
  evidence: "Fixture";
}

export interface ContentDemo {
  id: string;
  title: string;
  type: string;
  platform: Platform;
  status: string;
  statusTone: StatusTone;
  updatedAt: string;
  image: string;
}

export const tenants: TenantDemo[] = [
  {
    id: "zhongtong",
    name: "中通国际旅行社",
    shortName: "中通国旅",
    industry: "旅游 / 出境游",
    hotline: "4001133986",
    wechat: ["ZTGL3411", "ZTGL6431"],
    status: "运行中",
  },
  {
    id: "isolation",
    name: "隔离测试旅行社",
    shortName: "隔离测试",
    industry: "旅游 / 测试租户",
    hotline: "4000000000",
    wechat: [],
    status: "测试隔离",
  },
];

export const initialCampaigns: CampaignDemo[] = [
  {
    id: "cmp-japan-senior",
    name: "日本银发跟团游问答集",
    topic: "日本 / 老年客群",
    industry: "travel",
    mode: "Shadow",
    articles: 18,
    passRate: 88,
    updatedAt: "9 分钟前",
  },
  {
    id: "cmp-europe-origin",
    name: "北京出发欧洲线路证据库",
    topic: "欧洲 / 北京出发",
    industry: "travel",
    mode: "监督投放",
    articles: 12,
    passRate: 92,
    updatedAt: "36 分钟前",
  },
  {
    id: "cmp-first-overseas",
    name: "第一次出境跟团指南",
    topic: "出境游 / 新客",
    industry: "travel",
    mode: "Shadow",
    articles: 9,
    passRate: 78,
    updatedAt: "2 小时前",
  },
];

export const contentItems: ContentDemo[] = [
  {
    id: "cnt-001",
    title: "老人去日本跟团，行程强度应该怎么判断？",
    type: "问答型",
    platform: "头条号",
    status: "审计通过",
    statusTone: "success",
    updatedAt: "12 分钟前",
    image: "/demo/travel-tokyo.jpg",
  },
  {
    id: "cnt-002",
    title: "北京出发欧洲跟团游：比较线路前先核对这 7 项",
    type: "证据型",
    platform: "搜狐号",
    status: "待修复",
    statusTone: "warning",
    updatedAt: "28 分钟前",
    image: "/demo/travel-paris.jpg",
  },
  {
    id: "cnt-003",
    title: "第一次出国跟团：签约前要确认哪些服务边界",
    type: "攻略型",
    platform: "携程社区",
    status: "Dry-run 已回执",
    statusTone: "info",
    updatedAt: "1 小时前",
    image: "/demo/travel-planning.jpg",
  },
];

export const publicationRows = [
  {
    id: "job-0371",
    title: "老人去日本跟团，行程强度应该怎么判断？",
    platform: "头条号" as const,
    level: "Dry-run",
    state: "已完成",
    evidence: "Preview",
    time: "00:08:21",
  },
  {
    id: "job-0370",
    title: "北京出发欧洲线路如何比较交通与住宿",
    platform: "搜狐号" as const,
    level: "Dry-run",
    state: "队列中",
    evidence: "待生成",
    time: "00:06:43",
  },
  {
    id: "job-0369",
    title: "第一次出境跟团：服务边界核对表",
    platform: "携程社区" as const,
    level: "Dry-run",
    state: "Preview 已生成",
    evidence: "Preview",
    time: "昨天 23:58",
  },
];

export const auditFindings = [
  {
    id: "audit-041",
    severity: "阻断",
    rule: "contact.phone.unapproved",
    message: "正文出现未登记的 400 电话，发布许可未签发",
    asset: "北京出发欧洲跟团游：比较线路前先核对这 7 项",
    time: "28 分钟前",
  },
  {
    id: "audit-040",
    severity: "警告",
    rule: "duplicate.near",
    message: "与同 Campaign 既有文章相似度 0.81",
    asset: "日本银发跟团游：饮食与步行强度",
    time: "43 分钟前",
  },
  {
    id: "audit-039",
    severity: "阻断",
    rule: "evidence.source.expired",
    message: "价格证据已过有效期，需要重新采集",
    asset: "欧洲线路费用包含项核对",
    time: "2 小时前",
  },
];

export const providerMetrics = [
  {
    provider: "豆包",
    surface: "Fixture / Web 搜索面",
    mentionRate: 38,
    citationRate: 29,
    contactAccuracy: 100,
    samples: 24,
    delta: 4.2,
    bars: [34, 41, 37, 48, 44, 52, 49, 58],
  },
  {
    provider: "千问",
    surface: "Fixture / Web 搜索面",
    mentionRate: 31,
    citationRate: 35,
    contactAccuracy: 92,
    samples: 24,
    delta: -1.3,
    bars: [42, 38, 44, 40, 37, 35, 39, 36],
  },
];

export function queryRunsForTenant(tenant: TenantDemo): QueryRunDemo[] {
  const contactResult = tenant.hotline === "" ? "未配置联系方式" : `命中 / ${tenant.hotline}`;
  return [
    {
      prompt: `${tenant.name}电话`,
      intent: "品牌联系方式",
      doubao: contactResult,
      qwen: contactResult,
      evidence: "Fixture",
    },
    {
      prompt: "老人适合的日本跟团游",
      intent: "客群需求",
      doubao: "第 4 个推荐位",
      qwen: "未命中",
      evidence: "Fixture",
    },
    {
      prompt: "北京出发欧洲游旅行社推荐",
      intent: "出发地需求",
      doubao: "引用 1 个来源",
      qwen: "引用 2 个来源",
      evidence: "Fixture",
    },
    {
      prompt: `${tenant.name}有哪些官方保证和资质`,
      intent: "幻觉控制",
      doubao: "未编造",
      qwen: "需人工复核",
      evidence: "Fixture",
    },
  ];
}

export function platformAccountsForTenant(tenant: TenantDemo) {
  return [
    {
      platform: "头条号" as const,
      account: `${tenant.shortName} · 头条号`,
      capability: "Manual only",
      execution: "Dry-run",
      health: "正常",
      lastCheck: "8 分钟前",
    },
    {
      platform: "搜狐号" as const,
      account: `${tenant.shortName} · 搜狐号`,
      capability: "Manual only",
      execution: "Dry-run",
      health: "正常",
      lastCheck: "8 分钟前",
    },
    {
      platform: "携程社区" as const,
      account: `${tenant.shortName} · 携程社区`,
      capability: "Manual only",
      execution: "Dry-run",
      health: "待确认创作者认证",
      lastCheck: "31 分钟前",
    },
  ];
}
