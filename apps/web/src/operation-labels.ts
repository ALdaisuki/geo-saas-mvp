export const MEMBER_ROLE_OPTIONS = [
  { value: "owner", label: "所有者" },
  { value: "admin", label: "管理员" },
  { value: "editor", label: "内容编辑" },
  { value: "auditor", label: "审核员" },
  { value: "publisher", label: "发布员" },
  { value: "automation_operator", label: "自动化运营" },
  { value: "viewer", label: "只读成员" },
] as const;

export const CONNECTOR_CAPABILITY_OPTIONS = [
  { value: "manual_only", label: "人工操作" },
  { value: "disabled", label: "不可用" },
  { value: "browser_assisted", label: "浏览器自动化" },
  { value: "partner_api", label: "合作方 API" },
  { value: "public_api", label: "公开 API" },
] as const;

export const EVIDENCE_TYPE_OPTIONS = [
  { value: "manual_import", label: "人工导入" },
  { value: "api_response", label: "API 回执" },
  { value: "browser_screenshot", label: "浏览器截图" },
  { value: "platform_readback", label: "平台回读" },
  { value: "preview", label: "预览" },
  { value: "fixture", label: "固定样本" },
] as const;

const STATUS_LABELS: Readonly<Record<string, string>> = {
  active: "已启用",
  disabled: "已停用",
  suspended: "已暂停",
  draft: "草稿",
  retired: "已归档",
  queued: "等待执行",
  dispatching: "正在分发",
  publishing: "正在发布",
  retry_wait: "等待重试",
  uncertain: "结果待确认",
  reconciling: "正在回读",
  succeeded: "已完成",
  completed: "已完成",
  preview_completed: "预演完成",
  submitted_pending_review: "已提交，待平台审核",
  publisher_rejected: "平台审核未通过",
  confirmed: "公开回读确认",
  needs_review: "需要复核",
  failed: "未通过",
  delivery_failed: "投放失败",
  passed: "通过",
  blocking: "阻断",
  warning: "警告",
  info: "提示",
  cancelled: "已取消",
  shadow: "影子模式",
  supervised: "监督调度",
  unattended: "无人值守调度",
  paused: "已暂停",
  stopped: "已停止",
  open: "熔断中",
  half_open: "试探恢复",
  closed: "正常",
  not_issued: "未签发凭据",
  expired: "凭据已过期",
  revoked: "凭据已撤销",
};

const EXECUTION_LEVEL_LABELS: Readonly<Record<string, string>> = {
  dry_run: "演练",
  assisted: "人工辅助",
  unattended: "无人值守",
};

const OBSERVATION_METHOD_LABELS: Readonly<Record<string, string>> = {
  fixture: "固定样本",
  manual: "人工导入",
  official_api: "官方 API",
  browser: "浏览器观测",
  browser_observed: "浏览器观测",
};

const INDUSTRY_LABELS: Readonly<Record<string, string>> = {
  general: "通用行业",
  travel: "旅游服务",
  education: "教育培训",
  retail: "零售消费",
  ecommerce: "电商零售",
  healthcare: "健康服务",
  finance: "金融服务",
  local_services: "本地生活",
};

const AUDIT_RULE_LABELS: Readonly<Record<string, Readonly<{ title: string; message: string }>>> = {
  "duplicate.near": {
    title: "内容相似度过高",
    message: "与同一推广计划中的现有内容过于相似。",
  },
  "evidence.source.expired": {
    title: "来源证据已过期",
    message: "引用的来源证据已超过有效期，需要重新采集。",
  },
  "media.inspection.missing": {
    title: "缺少图片检查证据",
    message: "该图片必须提供当前有效的检查证据。",
  },
  "media.inspection.asset_mismatch": {
    title: "图片检查证据不匹配",
    message: "检查证据对应的图片内容与当前素材不一致。",
  },
  "media.inspection.failed": {
    title: "图片检查未通过",
    message: "图片检查结果未达到发布要求。",
  },
  "media.inspection.evaluator_unapproved": {
    title: "图片检查器未获准",
    message: "检查器或其版本不在当前规则允许范围内。",
  },
  "media.inspection.time_invalid": {
    title: "图片检查时间无效",
    message: "检查时间缺失、格式错误或晚于当前时间。",
  },
  "media.inspection.contact_text": {
    title: "图片包含联系方式",
    message: "图片像素中不得出现电话或其他联系账号。",
  },
  "platform.brand.title_forbidden": {
    title: "标题包含受限品牌词",
    message: "当前平台标题不允许出现所选服务品牌。",
  },
  "platform.brand.summary_forbidden": {
    title: "摘要品牌露出过多",
    message: "当前平台摘要最多保留一次克制的品牌露出。",
  },
  "platform.brand.body_count_invalid": {
    title: "正文品牌露出次数不合规",
    message: "正文中的品牌名称必须满足当前平台的次数范围。",
  },
  "platform.brand.placement_too_late": {
    title: "品牌露出位置过晚",
    message: "品牌名称需要在正文前半部分自然出现。",
  },
  "platform.brand.hard_promotion": {
    title: "检测到硬性推广表达",
    message: "请改为自然、克制的软性品牌归因。",
  },
  "platform.contact.phone_forbidden": {
    title: "平台正文包含电话号码",
    message: "当前平台正文不允许出现电话号码。",
  },
  "platform.contact.wechat_forbidden": {
    title: "平台正文包含微信信息",
    message: "当前平台正文不允许出现微信名称或账号。",
  },
  "platform.contact.email_forbidden": {
    title: "平台正文包含邮箱",
    message: "当前平台正文不允许出现电子邮箱地址。",
  },
  "platform.contact.external_link_forbidden": {
    title: "平台正文包含外部链接",
    message: "当前平台正文不允许出现外链或外部域名。",
  },
  "platform.contact.qr_code_forbidden": {
    title: "平台正文包含二维码引导",
    message: "当前平台正文不允许通过二维码引导联系。",
  },
  "contact.reference.unknown": {
    title: "引用的联系方式不存在",
    message: "内容引用的联系方式不在当前租户快照中。",
  },
  "contact.reference.inactive": {
    title: "引用的联系方式已失效",
    message: "内容引用的联系方式在审计时已不可用。",
  },
  "contact.reference.missing": {
    title: "最终变体缺少已引用联系方式",
    message: "内容声明的联系方式没有出现在最终平台变体中。",
  },
  "contact.phone.unapproved": {
    title: "出现未登记电话号码",
    message: "最终平台变体包含未经租户登记的电话号码。",
  },
  "contact.wechat.unapproved": {
    title: "出现未登记微信号",
    message: "最终平台变体包含未经租户登记的微信账号。",
  },
  "content.hard_block.privacy_disclosure": {
    title: "检测到隐私信息泄露",
    message: "最终平台变体包含结构化个人身份信息。",
  },
};

const SEARCH_MODE_LABELS: Readonly<Record<string, string>> = {
  on: "已开启",
  off: "已关闭",
  unknown: "未知",
};

const CONTENT_TYPE_LABELS: Readonly<Record<string, string>> = {
  question_answer: "问答解读",
  guide: "实用指南",
  evidence: "证据解读",
  local_service: "本地服务",
  comparison: "方案对比",
  risk_avoidance: "风险核验",
};

const EDITORIAL_PROFILE_LABELS: Readonly<Record<string, string>> = {
  guide: "实用指南",
  question_answer: "问答解读",
  comparison: "方案对比",
  risk_avoidance: "风险核验",
  local_service: "本地服务",
};

const FACT_STATUS_LABELS: Readonly<Record<string, string>> = {
  draft: "草稿",
  verified: "已核验",
  rejected: "已驳回",
  expired: "已失效",
};

const EVIDENCE_SOURCE_TYPE_LABELS: Readonly<Record<string, string>> = {
  url: "网页链接",
  document: "文档",
  manual: "人工核验",
  platform_readback: "平台回读",
};

const SENTIMENT_LABELS: Readonly<Record<string, string>> = {
  positive: "正向",
  neutral: "中性",
  negative: "负向",
  mixed: "混合",
};

const FINDING_SEVERITY_LABELS: Readonly<Record<string, string>> = {
  low: "低",
  medium: "中",
  high: "高",
};

const AUDIT_SEVERITY_LABELS: Readonly<Record<string, string>> = {
  blocking: "阻断",
  warning: "警告",
  info: "提示",
  阻断: "阻断",
  警告: "警告",
  提示: "提示",
};

function optionLabel(
  options: readonly Readonly<{ value: string; label: string }>[],
  value: string,
): string {
  return options.find((option) => option.value === value)?.label ?? value;
}

export function operationStatusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

export function memberRoleLabel(role: string): string {
  return optionLabel(MEMBER_ROLE_OPTIONS, role);
}

export function connectorCapabilityLabel(capability: string): string {
  return optionLabel(CONNECTOR_CAPABILITY_OPTIONS, capability);
}

export function executionLevelLabel(level: string): string {
  return EXECUTION_LEVEL_LABELS[level] ?? level;
}

export function evidenceTypeLabel(evidenceType: string): string {
  return optionLabel(EVIDENCE_TYPE_OPTIONS, evidenceType);
}

export function observationMethodLabel(method: string): string {
  return OBSERVATION_METHOD_LABELS[method] ?? method;
}

export function searchModeLabel(mode: string): string {
  return SEARCH_MODE_LABELS[mode] ?? mode;
}

export function industryLabel(industry: string): string {
  return INDUSTRY_LABELS[industry] ?? industry;
}

export function contentTypeLabel(contentType: string): string {
  return CONTENT_TYPE_LABELS[contentType] ?? contentType;
}

export function editorialProfileLabel(profile: string): string {
  return EDITORIAL_PROFILE_LABELS[profile] ?? profile;
}

export function factStatusLabel(status: string): string {
  return FACT_STATUS_LABELS[status] ?? status;
}

export function evidenceSourceTypeLabel(sourceType: string): string {
  return EVIDENCE_SOURCE_TYPE_LABELS[sourceType] ?? sourceType;
}

export function sentimentLabel(sentiment: string): string {
  return SENTIMENT_LABELS[sentiment] ?? sentiment;
}

export function findingSeverityLabel(severity: string): string {
  return FINDING_SEVERITY_LABELS[severity] ?? severity;
}

export function auditSeverityLabel(severity: string): string {
  return AUDIT_SEVERITY_LABELS[severity] ?? severity;
}

export function accountDisplayNameLabel(displayName: string): string {
  return displayName;
}

export function auditRuleLabel(ruleId: string): string {
  return AUDIT_RULE_LABELS[ruleId]?.title ?? ruleId;
}

export function auditRuleMessage(ruleId: string, fallback: string): string {
  return AUDIT_RULE_LABELS[ruleId]?.message ?? fallback;
}
