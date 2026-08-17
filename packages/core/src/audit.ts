import type {
  AuditArtifact,
  AuditFinding,
  AuditStatus,
  BrandAgentProfileDocument,
  BrandAgentProfileReference,
  EditorialProfile,
  MediaAspectRatio,
  MediaProviderMode,
  MediaReference,
  Platform,
  PublicationVariantPayload,
  TenantContact,
} from "@geo/contracts";
import {
  brandAgentProfileDocumentSchema,
  CTRIP_COMMUNITY_PUBLICATION_LIMITS,
  mediaReferenceSchema,
} from "@geo/contracts";

import { sha256Canonical, sha256Text } from "./canonical.js";
import { assertCompiledAuditPolicySource } from "./audit-policy-provenance.js";
import { renderCanonicalContent } from "./content-renderer.js";
import { ctripPublicContentHashFromMarkdown } from "./ctrip-public-content.js";
import { invariant } from "./errors.js";
import {
  MANUAL_MEDIA_REVIEW_LABEL,
  mediaSceneSignature,
  mediaSnapshotHash,
  verifyVisualBrief,
} from "./media-production.js";
import { assertSha256, assertUuid, freezeDeep, parseInstant } from "./validation.js";

export interface EvidenceSource {
  readonly id: string;
  readonly locator: string;
  readonly contentHash: string;
  readonly observedAt: string;
  readonly validUntil: string | null;
}

export interface VerifiedFact {
  readonly id: string;
  readonly brandId: string;
  readonly text: string;
  readonly evidenceSourceIds: readonly string[];
  readonly validFrom: string;
  readonly validUntil: string | null;
}

export interface FactSnapshot {
  readonly tenantId: string;
  readonly capturedAt: string;
  readonly facts: readonly VerifiedFact[];
  readonly sources: readonly EvidenceSource[];
}

export interface BrandSnapshot {
  readonly id: string;
  readonly canonicalName: string;
  readonly displayName: string;
  readonly aliases: readonly string[];
  readonly agentProfile?: Readonly<{
    reference: BrandAgentProfileReference;
    document: BrandAgentProfileDocument;
  }>;
}

export interface PlatformAuditLimits {
  readonly maxTitleCharacters: number;
  readonly maxSummaryCharacters: number;
  readonly minBodyCharacters: number;
  readonly maxBodyCharacters: number;
  readonly maxTags: number;
  readonly minHeadings: number;
}

export interface PlatformMediaRenditionPolicy {
  readonly allowedMimeTypes: readonly string[];
  readonly aspectRatios: readonly MediaAspectRatio[];
  readonly minWidth: number;
  readonly minHeight: number;
  readonly maxWidth: number;
  readonly maxHeight: number;
}

export interface MediaInspectionEvaluatorPolicy {
  readonly evaluator: string;
  readonly evaluatorMode: MediaProviderMode;
  readonly evaluatorVersion: string;
}

export interface MediaAuditPolicy {
  readonly inspectionRequired: true;
  readonly evaluatorAllowlist: readonly MediaInspectionEvaluatorPolicy[];
  readonly renditions: Readonly<Record<Platform, PlatformMediaRenditionPolicy>>;
}

export interface ContentTemplates {
  readonly title: Readonly<Record<string, string>>;
  readonly summary: Readonly<Record<string, string>>;
  readonly body: Readonly<Record<string, string>>;
  readonly tag: Readonly<Record<string, string>>;
}

export type EditorialPresentation = "paragraph" | "bullet";
export type EditorialSourceBodySlot =
  | "profile_opening"
  | "claims"
  | "profile_details"
  | "profile_action"
  | "contacts"
  | "profile_closing";
export type EditorialPlatformBodySlot =
  | EditorialSourceBodySlot
  | "platform_opening"
  | "platform_scope"
  | "platform_contact"
  | "platform_disclosure";

export interface EditorialSourceProfilePolicy {
  readonly titleTemplateId: string;
  readonly summaryTemplateId: string;
  readonly bodyTemplateIds: Readonly<{
    opening: string;
    details: string;
    action: string;
    closing: string;
  }>;
  readonly bodyOrder: readonly EditorialSourceBodySlot[];
  readonly claimPresentation: EditorialPresentation;
  readonly contactPresentation: EditorialPresentation;
  readonly tagTemplateIds: readonly string[];
}

export interface EditorialPlatformProfilePolicy {
  readonly titleTemplateId: string;
  readonly summaryTemplateId: string;
  readonly bodyOrder: readonly EditorialPlatformBodySlot[];
  readonly claimPresentation: EditorialPresentation;
  readonly contactPresentation: EditorialPresentation;
}

export interface EditorialProfilePolicy {
  readonly source: EditorialSourceProfilePolicy;
  readonly platforms: Readonly<Record<Platform, EditorialPlatformProfilePolicy>>;
}

export interface PlatformEditorialStylePolicy {
  readonly bodyTemplateIds: Readonly<{
    opening: string;
    scope: string;
    contact: string;
    disclosure: string;
  }>;
  readonly tagTemplateIds: readonly string[];
}

export interface AuditPolicy {
  readonly version: string;
  readonly sourceHash?: string;
  readonly effectiveHash?: string;
  readonly artifactTtlMs: number;
  readonly maxEvidenceAgeMs: number;
  readonly minClaims: number;
  readonly duplicateThreshold: number;
  readonly minDuplicateCharacters: number;
  readonly media: MediaAuditPolicy;
  readonly platformLimits: Readonly<Record<Platform, PlatformAuditLimits>>;
  readonly contentTemplates: ContentTemplates;
  readonly editorialProfiles?: Readonly<Record<EditorialProfile, EditorialProfilePolicy>>;
  readonly platformEditorialStyles?: Readonly<Record<Platform, PlatformEditorialStylePolicy>>;
}

export interface PriorPublicationVariant {
  readonly variantId: string;
  readonly platform: Platform;
  readonly payloadHash: string;
  readonly publicContentHash?: string;
  readonly bodyMarkdown: string;
}

export interface EvaluatePublicationVariantInput {
  readonly tenantId: string;
  readonly brandSnapshot: BrandSnapshot;
  readonly variantId: string;
  readonly platform: Platform;
  readonly payload: PublicationVariantPayload;
  readonly contacts: readonly TenantContact[];
  readonly factSnapshot: FactSnapshot;
  readonly policy: AuditPolicy;
  readonly priorVariants?: readonly PriorPublicationVariant[];
  readonly submittedMediaSha256?: readonly string[];
  readonly createdAt: string;
}

export interface AuditEvaluation {
  readonly payloadHash: string;
  readonly factSnapshotHash: string;
  readonly brandSnapshotHash: string;
  readonly mediaSnapshotHash: string;
  readonly policyHash: string;
  readonly status: AuditStatus;
  readonly findings: readonly AuditFinding[];
}

export interface BuildAuditArtifactInput {
  readonly artifactId: string;
  readonly tenantId: string;
  readonly variantId: string;
  readonly channelAccountId: string;
  readonly platform: Platform;
  readonly policyVersion: string;
  readonly evaluation: AuditEvaluation;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface AuditPublicationVariantInput extends EvaluatePublicationVariantInput {
  readonly artifactId: string;
  readonly channelAccountId: string;
}

const PLATFORMS: readonly Platform[] = [
  "toutiao",
  "sohu",
  "baijiahao",
  "netease",
  "ctrip_community",
  "zhihu",
];
const PHONE_PATTERN =
  /(?<!\d)(?:\+?86[-\s]?)?(?:400[-\s]?\d{3}[-\s]?\d{4}|800[-\s]?\d{3}[-\s]?\d{4}|1[3-9]\d{9}|0\d{2,3}[-\s]?\d{7,8})(?!\d)/g;
const WECHAT_KEYWORD_PATTERN = /微信(?:咨询|号)?|wechat|wx|vx/i;
const WECHAT_TOKEN_PATTERN = /[A-Za-z][A-Za-z0-9_-]{5,19}/g;
const RESERVED_WECHAT_TOKENS = new Set(["wechat", "weixin"]);
const EMAIL_PATTERN = /[\p{L}\p{N}.!#$%&'*+/=?^_`{|}~-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/iu;
const EXTERNAL_LINK_PATTERN =
  /(?:[a-z][a-z0-9+.-]*:\/\/|www\.)[^\s，。；]+|(?<![@\p{L}\p{N}])(?:[\p{L}\p{N}-]+\.)+[a-z]{2,63}(?:\/[^\s，。；]*)?/iu;
const CTRIP_WECHAT_REFERENCE_PATTERN =
  /(?:微信|微\s*信|wechat|weixin|(?<![A-Za-z0-9])(?:wx|vx)(?![A-Za-z0-9]))/iu;
const QR_CODE_PATTERN = /(?:二维码|QR\s*码?)/iu;
const CHINESE_NATIONAL_ID_CANDIDATE_PATTERN =
  /(?<![A-Za-z0-9])(?:[1-8](?:[\s-]*\d){16}[\s-]*[\dXx])(?![A-Za-z0-9])/gu;
const PASSPORT_CANDIDATE_PATTERN =
  /(?<![A-Za-z0-9])(?:(?:P[\s-]*E|E[\s-]*[A-Z])(?:[\s-]*\d){7}|[EGDP](?:[\s-]*\d){8})(?![A-Za-z0-9])/giu;
const PAYMENT_CARD_CANDIDATE_PATTERN = /(?<![A-Za-z0-9])\d[\d \t\u00a0-]{13,40}\d(?![A-Za-z0-9])/gu;
const NON_SENSITIVE_IDENTIFIER_LABEL_PATTERN =
  /(?:订单(?:号|编号)?|工单(?:号|编号)?|运单(?:号|编号)?|快递(?:号|编号)?|流水(?:号|编号)?|order|tracking|invoice)(?:为|是)?\s*[:：#-]?\s*$/iu;

export const DEFAULT_AUDIT_POLICY: AuditPolicy = freezeDeep({
  version: "mvp-internal-v2",
  artifactTtlMs: 15 * 60 * 1_000,
  maxEvidenceAgeMs: 180 * 24 * 60 * 60 * 1_000,
  minClaims: 1,
  duplicateThreshold: 0.86,
  minDuplicateCharacters: 120,
  contentTemplates: {
    title: {
      "generic.title.verified-service": "当前服务信息核验指南",
      "editorial.guide.title": "服务信息核验操作指南",
      "editorial.question_answer.title": "服务问题核验答疑",
      "editorial.comparison.title": "服务选择对比核验",
      "editorial.risk_avoidance.title": "服务避坑与风险核验",
      "editorial.local_service.title": "本地咨询与服务核验",
      "toutiao.title.evidence-first": "服务信息怎么核对：先看事实和边界",
      "toutiao.guide.title": "服务怎么选：一份可核验指南",
      "toutiao.question_answer.title": "服务常见问题：核验后再回答",
      "toutiao.comparison.title": "服务对比别只看宣传：核验这几项",
      "toutiao.risk_avoidance.title": "服务避坑清单：先排查这些风险",
      "toutiao.local_service.title": "本地服务怎么联系：有效渠道与边界",
      "sohu.title.evidence-first": "核对服务信息：事实、条件与咨询方式",
      "sohu.guide.title": "服务信息核验指南：按步骤做决定",
      "sohu.question_answer.title": "服务疑问解答：事实与待确认项",
      "sohu.comparison.title": "服务选择如何比较：证据与口径",
      "sohu.risk_avoidance.title": "服务风险核对：承诺之前看证据",
      "sohu.local_service.title": "本地服务咨询：渠道、材料与范围",
      "baijiahao.title.evidence-first": "服务信息核验：先看依据，再做选择",
      "baijiahao.guide.title": "服务怎么选：按证据逐项核验",
      "baijiahao.question_answer.title": "服务常见疑问：依据和边界一次说清",
      "baijiahao.comparison.title": "服务如何比较：统一口径再判断",
      "baijiahao.risk_avoidance.title": "服务避坑指南：核对承诺与证据",
      "baijiahao.local_service.title": "本地服务咨询：渠道与核验要点",
      "netease.title.evidence-first": "服务信息核验：事实依据与适用范围",
      "netease.guide.title": "服务选择指南：事实、条件与确认步骤",
      "netease.question_answer.title": "服务疑问怎么答：已核实与待确认项",
      "netease.comparison.title": "服务选择对比：先统一事实口径",
      "netease.risk_avoidance.title": "服务风险清单：承诺、范围与材料核对",
      "netease.local_service.title": "本地服务怎么咨询：有效渠道与准备事项",
      "ctrip.title.evidence-first": "出行前先核对：已验证信息与服务边界",
      "ctrip.guide.title": "出行服务核验指南：预订前逐项确认",
      "ctrip.question_answer.title": "出行服务答疑：哪些信息已经核实",
      "ctrip.comparison.title": "出行服务怎么比：统一口径再选择",
      "ctrip.risk_avoidance.title": "出行服务避坑：预订前风险核对",
      "ctrip.local_service.title": "出行咨询怎么联系：有效渠道清单",
    },
    summary: {
      "generic.summary.verified-sources":
        "以下内容仅使用当前有效的已验证事实、联系方式和审计策略固定模板生成。",
      "editorial.guide.summary":
        "按核验、对照、咨询和复核的顺序整理当前事实，帮助读者完成一次可追溯的服务信息检查。",
      "editorial.question_answer.summary":
        "围绕问题区分已经证实的回答与仍需确认的部分，不用推测补全事实快照之外的信息。",
      "editorial.comparison.summary":
        "先统一比较口径，再列出当前对象的已验证事实；没有证据的对象、条件和结论不进入正文。",
      "editorial.risk_avoidance.summary":
        "从承诺、有效期、适用范围和确认材料四个方向排查风险，所有明确事实都来自当前证据快照。",
      "editorial.local_service.summary":
        "集中呈现当前有效的咨询渠道、可核验服务信息和联系前准备事项，不沿用历史或推测联系方式。",
      "toutiao.summary.evidence-first":
        "先给出可核验信息，再说明适用条件、服务边界和咨询前应确认的事项。",
      "toutiao.guide.summary":
        "把服务核验拆成清晰步骤：先看证据支持什么，再对照需求并通过有效渠道确认。",
      "toutiao.question_answer.summary":
        "直接回应常见疑问，同时标明回答依据和不能从现有材料推出的内容。",
      "toutiao.comparison.summary":
        "比较之前先统一条件和证据口径，只陈述当前可核验对象，不制造没有来源的排名。",
      "toutiao.risk_avoidance.summary":
        "用一份核验清单识别夸大承诺、过期信息和范围误读，再给出可追溯的确认入口。",
      "toutiao.local_service.summary":
        "先列当前有效联系渠道，再说明可以核对的服务事实和咨询时需要准备的信息。",
      "sohu.summary.evidence-first":
        "围绕已验证事实整理服务范围与决策要点，所有联系方式均取自当前租户记录。",
      "sohu.guide.summary": "以材料来源、适用条件和确认步骤为主线，形成一份可复核的服务决策指南。",
      "sohu.question_answer.summary":
        "将问题拆成事实回答、适用边界与后续核实三部分，避免把一般经验写成当前承诺。",
      "sohu.comparison.summary":
        "采用一致维度整理当前已验证信息，并明确未收录对象不参与事实判断或推荐排序。",
      "sohu.risk_avoidance.summary":
        "核对证据时效、服务范围和最终材料，识别哪些表述不能被理解为确定承诺。",
      "sohu.local_service.summary":
        "以当前租户记录为准汇总联系入口、服务范围和咨询流程，历史页面信息不作为补充来源。",
      "baijiahao.summary.evidence-first":
        "从材料依据出发梳理服务信息，明确事实、适用条件和需要继续确认的事项。",
      "baijiahao.guide.summary":
        "按证据来源、适用范围和确认步骤拆解服务选择，帮助读者保留可追溯的判断依据。",
      "baijiahao.question_answer.summary":
        "围绕常见疑问给出有材料支持的回答，并将动态条件和未证实内容明确留待确认。",
      "baijiahao.comparison.summary":
        "使用一致的时间、范围和证据口径比较当前信息，不以资料空白推导优劣或排名。",
      "baijiahao.risk_avoidance.summary":
        "检查承诺依据、材料时效和适用边界，避免把宣传表达误读为确定结果。",
      "baijiahao.local_service.summary":
        "汇总当前有效的本地咨询渠道与服务事实，并提示联系前需要准备的核验问题。",
      "netease.summary.evidence-first":
        "以当前有效材料呈现服务事实、适用范围和确认入口，不用一般经验补写具体承诺。",
      "netease.guide.summary":
        "围绕事实、条件、材料和复核步骤整理服务选择过程，让关键判断能够回到来源。",
      "netease.question_answer.summary":
        "把已核实回答、适用条件和待确认信息分开陈述，避免将动态安排写成固定事实。",
      "netease.comparison.summary":
        "先建立同口径事实清单，再比较证据能够支持的差异，不生成缺少来源的推荐结论。",
      "netease.risk_avoidance.summary":
        "从承诺、范围、有效期和最终材料四个维度核对风险，重要信息均保留来源边界。",
      "netease.local_service.summary":
        "列出当前有效联系入口、服务范围和咨询准备事项，过期渠道不进入生成内容。",
      "ctrip.summary.evidence-first":
        "用已验证资料梳理出行服务信息，并提示在预订前复核有效期、适用条件和最终安排。",
      "ctrip.guide.summary": "围绕出行前、咨询中和预订前的关键节点，逐项核对当前有效的服务材料。",
      "ctrip.question_answer.summary":
        "回答出行服务常见问题，并把已核实信息与需要在预订前再次确认的事项分开。",
      "ctrip.comparison.summary":
        "在相同时间、范围和材料口径下审视服务信息，不依据相似产品推断当前安排。",
      "ctrip.risk_avoidance.summary":
        "预订前检查信息时效、范围、变更条件和书面材料，降低对宣传文字的误读。",
      "ctrip.local_service.summary":
        "提供当前有效的出行咨询入口，并列出联系前应准备和确认的具体事项。",
    },
    body: {
      "generic.body.heading.verified": "## 当前可核验信息",
      "generic.body.guidance.verified":
        "以下内容仅根据当前有效的已验证事实整理。涉及时间、价格、库存、服务范围或适用条件的信息，应在作出决定前再次核验对应证据。",
      "generic.body.heading.contact": "## 联系与下一步",
      "generic.body.guidance.contact":
        "如需进一步确认，请使用当前有效的联系方式，并以签约或确认前提供的最新有效材料为准。",
      "editorial.guide.body.opening":
        "## 这份指南解决什么问题\n\n核验服务信息的目标，是把已经有证据支持的内容、仍需结合个人情况判断的条件，以及必须向服务方再次确认的事项分开。按照下面的顺序阅读，可以保留清晰的判断依据。",
      "editorial.guide.body.details":
        "## 按证据逐项核对\n\n先查看正文列出的已验证事实，再对照自己的时间、地点、人员情况和服务需求。任何未被事实条目明确覆盖的价格、库存、安排或资格，都应继续保持待确认状态。",
      "editorial.guide.body.action":
        "## 执行核验步骤\n\n记录与自己需求直接相关的事实，标出材料日期和适用范围，然后通过当前有效渠道询问差异项。作出决定前，再用最新书面材料复核一次，不把页面摘要当作最终约定。",
      "editorial.guide.body.closing":
        "## 指南的使用边界\n\n这份结构只整理当前快照能够支持的内容。事实、联系人或适用条件变化后，应重新生成并重新审计，旧文本不能代替新的确认结果。",
      "editorial.question_answer.body.opening":
        "## 先把问题说清楚\n\n同一个问题可能同时包含服务是否存在、是否适用于特定情况以及如何联系确认三个层面。正文先回答当前证据能够回答的部分，再把无法从现有材料推出的内容单独保留。",
      "editorial.question_answer.body.details":
        "## 回答依据是什么\n\n明确回答只来自下列已验证事实。事实没有覆盖的时间、价格、名额、资格或结果，不会因为问题的问法而被自动补全，也不会用一般经验替代当前证据。",
      "editorial.question_answer.body.action":
        "## 还有哪些需要追问\n\n如果问题涉及个人条件或动态安排，请向当前有效渠道提供具体需求，并要求对方说明适用范围、材料日期和最终确认方式。得到新材料后，应先进入事实核验流程再更新答案。",
      "editorial.question_answer.body.closing":
        "## 答案更新规则\n\n本页回答与当前事实快照和策略版本绑定。后续信息发生变化时，原答案只代表当时可核验状态，不能继续作为新的确定结论。",
      "editorial.comparison.body.opening":
        "## 比较之前先统一口径\n\n有效比较必须使用相同的时间、服务范围、适用人群、费用定义和证据时点。当前材料只支持描述已进入事实快照的对象，不能据此虚构其他对象的信息或生成排名。",
      "editorial.comparison.body.details":
        "## 当前对象有哪些可比事实\n\n下面的事实可以作为建立比较表的已验证输入。若另一个选项没有同口径、同有效期的证据，应标记为资料不足，而不是把空白解释为更好或更差。",
      "editorial.comparison.body.action":
        "## 用同一张清单做选择\n\n分别核对服务范围、限制条件、变更规则、材料有效期和最终确认方式。只有证据口径一致时才比较差异；主观推荐和未验证结论不进入这份正文。",
      "editorial.comparison.body.closing":
        "## 比较结论的边界\n\n本页不提供无来源的优劣排序。新增候选项或证据更新后，应重新建立快照、重新渲染并通过重复度与事实审计。",
      "editorial.risk_avoidance.body.opening":
        "## 先识别高风险信号\n\n绝对结果、模糊有效期、未说明适用范围和要求绕过正式确认的表述，都需要停下来核验。风险提示不等于认定问题存在，而是要求每个关键判断都有当前证据支撑。",
      "editorial.risk_avoidance.body.details":
        "## 哪些边界不能忽略\n\n事实条目之外的价格、库存、资格、结果和时间安排都不是当前承诺。即使历史页面出现过相似内容，也必须以本次有效快照和最终书面材料为准。",
      "editorial.risk_avoidance.body.action":
        "## 按清单逐项排查\n\n检查材料来源和日期，核对服务对象与范围，询问费用与变更口径，并保存最终确认材料。发现联系方式或事实不一致时，应停止沿用旧内容并触发重新核验。",
      "editorial.risk_avoidance.body.closing":
        "## 风险提示如何更新\n\n本文只使用受控模板和当前有效引用，不对未验证事件作判断。任何新增说法都要先成为可追溯事实，才能进入下一版内容和发布审计。",
      "editorial.local_service.body.opening":
        "## 先确认有效联系入口\n\n本地服务咨询最容易因历史页面、转发截图或过期账号产生偏差。正文只展示当前租户记录中仍然有效的渠道，不根据模型记忆或网络片段补写号码与账号。",
      "editorial.local_service.body.details":
        "## 通过渠道可以核对什么\n\n联系服务方时，应围绕自己的地点、时间、人员情况和具体需求核对服务范围。下列事实是当前可追溯信息，未列出的本地安排仍需单独确认。",
      "editorial.local_service.body.action":
        "## 联系前准备这些信息\n\n准备需求清单、期望时间和需要确认的材料口径，并记录回复所依据的文件日期。涉及签约或预订时，以最新书面材料为准，不让聊天摘要替代正式确认。",
      "editorial.local_service.body.closing":
        "## 联系信息的维护边界\n\n渠道停用、变更或超过有效期后，必须从活动联系人中移除并重新生成内容。旧文章中的联系方式不会自动获得继续使用的授权。",
      "toutiao.body.opening":
        "## 先给结论\n\n判断一项服务是否适合自己，第一步不是看宣传语，而是确认哪些信息已经有有效证据支持。下面只列出当前可核验的事实，并把仍需在决策前确认的边界单独说明。",
      "toutiao.body.scope":
        "## 再看适用条件\n\n同一项服务可能因时间、地点、人员情况或具体安排而变化。请把已验证事实与自己的需求逐项对照；凡是正文没有列明的信息，都不应被理解为当前承诺。",
      "toutiao.body.contact":
        "## 咨询时问清这些事\n\n联系服务方时，建议同时确认有效期、服务范围、费用口径、变更条件和最终书面材料。以下联系方式来自当前租户记录，不使用历史页面或模型推测值。",
      "toutiao.body.disclosure":
        "## 内容说明\n\n本文由自动化系统按固定模板整理，并在进入投放队列前校验事实、联系方式、策略版本和重复度。信息发生变化时，必须重新生成并重新审计。",
      "sohu.body.opening":
        "## 信息从哪里来\n\n这篇内容把可验证材料与一般性提示分开呈现。只有已经进入当前事实快照、仍在有效期内且能够追溯来源的信息，才会作为明确事实写入正文。",
      "sohu.body.scope":
        "## 服务边界如何判断\n\n阅读时应重点区分已确认内容、适用条件和仍待核实事项。未出现在已验证事实中的价格、库存、时间、资质或保证，不构成服务方的当前承诺。",
      "sohu.body.contact":
        "## 下一步怎么确认\n\n在作出决定前，请通过当前有效渠道核对具体需求，并要求以最新书面材料确认范围、条件和有效期。正文不会自动补全数据库中不存在的信息。",
      "sohu.body.disclosure":
        "## 生成与审计记录\n\n内容由版本化策略模板生成，事实引用、联系人引用和最终文本共同进入内容哈希。任何人工追加或模型改写都会使既有审计失效。",
      "baijiahao.body.opening":
        "## 先核对依据\n\n服务信息是否值得参考，首先取决于材料能否追溯、是否仍然有效。正文只呈现当前事实快照能够支持的内容，并把推测和待确认事项留在事实边界之外。",
      "baijiahao.body.scope":
        "## 明确适用范围\n\n时间、地点、人员情况和具体需求都可能改变服务条件。请逐项对照已验证事实；没有被当前材料覆盖的信息，不能被扩写为默认安排或确定承诺。",
      "baijiahao.body.contact":
        "## 带着问题去确认\n\n咨询时建议核对材料日期、服务范围、费用口径、变更条件和最终确认方式。下列渠道来自当前租户记录，不引用搜索片段或历史页面中的联系方式。",
      "baijiahao.body.disclosure":
        "## 内容与来源说明\n\n本文由版本化模板整理，并在发布前校验事实引用、联系方式、媒体材料和重复度。事实或正文发生变化后，原审计结果不再适用。",
      "netease.body.opening":
        "## 从事实开始\n\n判断服务信息时，先区分当前材料已经证明的事实、需要结合实际情况判断的条件，以及仍需向服务方确认的动态安排。本文不根据相似案例补写结论。",
      "netease.body.scope":
        "## 条件与边界\n\n已验证信息只在材料注明的时间和范围内成立。涉及价格、库存、资格、结果或具体时间的内容，若未进入事实快照，就应继续保持待确认状态。",
      "netease.body.contact":
        "## 获取最新确认\n\n通过当前有效渠道说明具体需求，并要求对方提供适用范围、材料日期与最终书面确认。页面摘要和自动生成文字都不能替代正式约定。",
      "netease.body.disclosure":
        "## 生成记录\n\n内容按固定策略组合事实、联系人和平台模板，最终文本与策略版本共同参与审计。任何后续改写或媒体替换都需要重新核验。",
      "ctrip.body.opening":
        "## 出行前先核对\n\n面对行程或服务信息，先确认当前材料能够证明什么，再判断是否符合自己的时间、节奏和实际需求。以下事实均来自本次审计使用的有效快照。",
      "ctrip.body.scope":
        "## 把条件逐项对齐\n\n建议对照最终材料确认适用人群、服务范围、时间安排、费用口径以及变更规则。正文未明确列出的项目需要另行确认，不能根据相似产品自行推断。",
      "ctrip.body.contact":
        "## 预订前再次确认\n\n通过下列当前有效联系方式咨询时，请说明自己的具体需求，并核对材料日期与有效期。平台预览、历史内容或自动生成文字都不能替代最终书面确认。",
      "ctrip.body.disclosure":
        "## 信息更新说明\n\n本页按固定结构整理已验证事实，并在发布前检查联系人、来源、策略和相似内容。事实或联系方式变化后，旧版本不得继续沿用原授权。",
    },
    tag: {
      "generic.tag.verified": "信息核验",
      "editorial.guide.tag": "办事指南",
      "editorial.question_answer.tag": "问题答疑",
      "editorial.comparison.tag": "服务对比",
      "editorial.risk_avoidance.tag": "风险提示",
      "editorial.local_service.tag": "本地服务",
      "toutiao.tag.evidence": "事实核验",
      "toutiao.tag.scope": "服务边界",
      "sohu.tag.evidence": "核验指南",
      "sohu.tag.decision": "决策参考",
      "baijiahao.tag.evidence": "事实依据",
      "baijiahao.tag.guide": "选择指南",
      "netease.tag.evidence": "信息核验",
      "netease.tag.scope": "适用范围",
      "ctrip.tag.evidence": "出行核验",
      "ctrip.tag.preflight": "行前确认",
    },
  },
  editorialProfiles: {
    guide: {
      source: {
        titleTemplateId: "editorial.guide.title",
        summaryTemplateId: "editorial.guide.summary",
        bodyTemplateIds: {
          opening: "editorial.guide.body.opening",
          details: "editorial.guide.body.details",
          action: "editorial.guide.body.action",
          closing: "editorial.guide.body.closing",
        },
        bodyOrder: [
          "profile_opening",
          "profile_details",
          "claims",
          "profile_action",
          "contacts",
          "profile_closing",
        ],
        claimPresentation: "bullet",
        contactPresentation: "paragraph",
        tagTemplateIds: ["editorial.guide.tag"],
      },
      platforms: {
        toutiao: {
          titleTemplateId: "toutiao.guide.title",
          summaryTemplateId: "toutiao.guide.summary",
          bodyOrder: [
            "platform_opening",
            "profile_opening",
            "profile_details",
            "claims",
            "platform_scope",
            "profile_action",
            "platform_contact",
            "contacts",
            "profile_closing",
            "platform_disclosure",
          ],
          claimPresentation: "bullet",
          contactPresentation: "paragraph",
        },
        sohu: {
          titleTemplateId: "sohu.guide.title",
          summaryTemplateId: "sohu.guide.summary",
          bodyOrder: [
            "profile_opening",
            "platform_opening",
            "profile_details",
            "platform_scope",
            "claims",
            "profile_action",
            "platform_contact",
            "contacts",
            "platform_disclosure",
            "profile_closing",
          ],
          claimPresentation: "paragraph",
          contactPresentation: "bullet",
        },
        baijiahao: {
          titleTemplateId: "baijiahao.guide.title",
          summaryTemplateId: "baijiahao.guide.summary",
          bodyOrder: [
            "profile_opening",
            "platform_opening",
            "profile_details",
            "claims",
            "platform_scope",
            "platform_contact",
            "profile_action",
            "contacts",
            "platform_disclosure",
            "profile_closing",
          ],
          claimPresentation: "bullet",
          contactPresentation: "paragraph",
        },
        netease: {
          titleTemplateId: "netease.guide.title",
          summaryTemplateId: "netease.guide.summary",
          bodyOrder: [
            "platform_opening",
            "profile_opening",
            "profile_details",
            "platform_scope",
            "claims",
            "profile_action",
            "platform_contact",
            "contacts",
            "profile_closing",
            "platform_disclosure",
          ],
          claimPresentation: "paragraph",
          contactPresentation: "bullet",
        },
        ctrip_community: {
          titleTemplateId: "ctrip.guide.title",
          summaryTemplateId: "ctrip.guide.summary",
          bodyOrder: [
            "platform_opening",
            "profile_opening",
            "platform_scope",
            "profile_details",
            "claims",
            "profile_action",
            "platform_contact",
            "contacts",
            "profile_closing",
            "platform_disclosure",
          ],
          claimPresentation: "bullet",
          contactPresentation: "bullet",
        },
        zhihu: {
          titleTemplateId: "sohu.guide.title",
          summaryTemplateId: "sohu.guide.summary",
          bodyOrder: [
            "platform_opening",
            "profile_opening",
            "profile_details",
            "platform_scope",
            "claims",
            "profile_action",
            "platform_contact",
            "contacts",
            "profile_closing",
            "platform_disclosure",
          ],
          claimPresentation: "paragraph",
          contactPresentation: "bullet",
        },
      },
    },
    question_answer: {
      source: {
        titleTemplateId: "editorial.question_answer.title",
        summaryTemplateId: "editorial.question_answer.summary",
        bodyTemplateIds: {
          opening: "editorial.question_answer.body.opening",
          details: "editorial.question_answer.body.details",
          action: "editorial.question_answer.body.action",
          closing: "editorial.question_answer.body.closing",
        },
        bodyOrder: [
          "profile_opening",
          "claims",
          "profile_details",
          "contacts",
          "profile_action",
          "profile_closing",
        ],
        claimPresentation: "paragraph",
        contactPresentation: "paragraph",
        tagTemplateIds: ["editorial.question_answer.tag"],
      },
      platforms: {
        toutiao: {
          titleTemplateId: "toutiao.question_answer.title",
          summaryTemplateId: "toutiao.question_answer.summary",
          bodyOrder: [
            "profile_opening",
            "platform_opening",
            "claims",
            "profile_details",
            "platform_scope",
            "platform_contact",
            "contacts",
            "profile_action",
            "platform_disclosure",
            "profile_closing",
          ],
          claimPresentation: "paragraph",
          contactPresentation: "paragraph",
        },
        sohu: {
          titleTemplateId: "sohu.question_answer.title",
          summaryTemplateId: "sohu.question_answer.summary",
          bodyOrder: [
            "platform_opening",
            "profile_opening",
            "profile_details",
            "claims",
            "platform_scope",
            "profile_action",
            "platform_contact",
            "contacts",
            "profile_closing",
            "platform_disclosure",
          ],
          claimPresentation: "paragraph",
          contactPresentation: "bullet",
        },
        baijiahao: {
          titleTemplateId: "baijiahao.question_answer.title",
          summaryTemplateId: "baijiahao.question_answer.summary",
          bodyOrder: [
            "platform_opening",
            "profile_opening",
            "claims",
            "platform_scope",
            "profile_details",
            "platform_contact",
            "contacts",
            "profile_action",
            "profile_closing",
            "platform_disclosure",
          ],
          claimPresentation: "paragraph",
          contactPresentation: "paragraph",
        },
        netease: {
          titleTemplateId: "netease.question_answer.title",
          summaryTemplateId: "netease.question_answer.summary",
          bodyOrder: [
            "profile_opening",
            "platform_opening",
            "profile_details",
            "claims",
            "platform_contact",
            "platform_scope",
            "profile_action",
            "contacts",
            "platform_disclosure",
            "profile_closing",
          ],
          claimPresentation: "paragraph",
          contactPresentation: "bullet",
        },
        ctrip_community: {
          titleTemplateId: "ctrip.question_answer.title",
          summaryTemplateId: "ctrip.question_answer.summary",
          bodyOrder: [
            "profile_opening",
            "platform_opening",
            "claims",
            "platform_scope",
            "profile_details",
            "profile_action",
            "platform_contact",
            "contacts",
            "platform_disclosure",
            "profile_closing",
          ],
          claimPresentation: "paragraph",
          contactPresentation: "bullet",
        },
        zhihu: {
          titleTemplateId: "sohu.question_answer.title",
          summaryTemplateId: "sohu.question_answer.summary",
          bodyOrder: [
            "profile_opening",
            "platform_opening",
            "profile_details",
            "claims",
            "platform_scope",
            "platform_contact",
            "contacts",
            "profile_action",
            "profile_closing",
            "platform_disclosure",
          ],
          claimPresentation: "paragraph",
          contactPresentation: "bullet",
        },
      },
    },
    comparison: {
      source: {
        titleTemplateId: "editorial.comparison.title",
        summaryTemplateId: "editorial.comparison.summary",
        bodyTemplateIds: {
          opening: "editorial.comparison.body.opening",
          details: "editorial.comparison.body.details",
          action: "editorial.comparison.body.action",
          closing: "editorial.comparison.body.closing",
        },
        bodyOrder: [
          "profile_opening",
          "profile_details",
          "claims",
          "profile_action",
          "profile_closing",
          "contacts",
        ],
        claimPresentation: "bullet",
        contactPresentation: "bullet",
        tagTemplateIds: ["editorial.comparison.tag"],
      },
      platforms: {
        toutiao: {
          titleTemplateId: "toutiao.comparison.title",
          summaryTemplateId: "toutiao.comparison.summary",
          bodyOrder: [
            "platform_opening",
            "profile_opening",
            "profile_details",
            "platform_scope",
            "claims",
            "profile_action",
            "profile_closing",
            "platform_contact",
            "contacts",
            "platform_disclosure",
          ],
          claimPresentation: "bullet",
          contactPresentation: "paragraph",
        },
        sohu: {
          titleTemplateId: "sohu.comparison.title",
          summaryTemplateId: "sohu.comparison.summary",
          bodyOrder: [
            "profile_opening",
            "profile_details",
            "platform_opening",
            "platform_scope",
            "claims",
            "profile_action",
            "platform_contact",
            "contacts",
            "platform_disclosure",
            "profile_closing",
          ],
          claimPresentation: "bullet",
          contactPresentation: "bullet",
        },
        baijiahao: {
          titleTemplateId: "baijiahao.comparison.title",
          summaryTemplateId: "baijiahao.comparison.summary",
          bodyOrder: [
            "profile_opening",
            "platform_opening",
            "profile_details",
            "claims",
            "platform_scope",
            "profile_action",
            "platform_contact",
            "profile_closing",
            "contacts",
            "platform_disclosure",
          ],
          claimPresentation: "bullet",
          contactPresentation: "paragraph",
        },
        netease: {
          titleTemplateId: "netease.comparison.title",
          summaryTemplateId: "netease.comparison.summary",
          bodyOrder: [
            "platform_opening",
            "profile_opening",
            "platform_scope",
            "profile_details",
            "claims",
            "platform_contact",
            "profile_action",
            "contacts",
            "platform_disclosure",
            "profile_closing",
          ],
          claimPresentation: "bullet",
          contactPresentation: "bullet",
        },
        ctrip_community: {
          titleTemplateId: "ctrip.comparison.title",
          summaryTemplateId: "ctrip.comparison.summary",
          bodyOrder: [
            "platform_opening",
            "profile_opening",
            "profile_details",
            "claims",
            "platform_scope",
            "profile_action",
            "platform_contact",
            "contacts",
            "profile_closing",
            "platform_disclosure",
          ],
          claimPresentation: "bullet",
          contactPresentation: "bullet",
        },
        zhihu: {
          titleTemplateId: "sohu.comparison.title",
          summaryTemplateId: "sohu.comparison.summary",
          bodyOrder: [
            "platform_opening",
            "profile_opening",
            "profile_details",
            "claims",
            "platform_scope",
            "profile_action",
            "platform_contact",
            "contacts",
            "profile_closing",
            "platform_disclosure",
          ],
          claimPresentation: "bullet",
          contactPresentation: "bullet",
        },
      },
    },
    risk_avoidance: {
      source: {
        titleTemplateId: "editorial.risk_avoidance.title",
        summaryTemplateId: "editorial.risk_avoidance.summary",
        bodyTemplateIds: {
          opening: "editorial.risk_avoidance.body.opening",
          details: "editorial.risk_avoidance.body.details",
          action: "editorial.risk_avoidance.body.action",
          closing: "editorial.risk_avoidance.body.closing",
        },
        bodyOrder: [
          "profile_opening",
          "profile_action",
          "claims",
          "profile_details",
          "contacts",
          "profile_closing",
        ],
        claimPresentation: "bullet",
        contactPresentation: "paragraph",
        tagTemplateIds: ["editorial.risk_avoidance.tag"],
      },
      platforms: {
        toutiao: {
          titleTemplateId: "toutiao.risk_avoidance.title",
          summaryTemplateId: "toutiao.risk_avoidance.summary",
          bodyOrder: [
            "profile_opening",
            "profile_action",
            "platform_opening",
            "claims",
            "platform_scope",
            "profile_details",
            "platform_contact",
            "contacts",
            "profile_closing",
            "platform_disclosure",
          ],
          claimPresentation: "bullet",
          contactPresentation: "paragraph",
        },
        sohu: {
          titleTemplateId: "sohu.risk_avoidance.title",
          summaryTemplateId: "sohu.risk_avoidance.summary",
          bodyOrder: [
            "profile_opening",
            "platform_opening",
            "profile_action",
            "platform_scope",
            "claims",
            "profile_details",
            "platform_contact",
            "contacts",
            "platform_disclosure",
            "profile_closing",
          ],
          claimPresentation: "paragraph",
          contactPresentation: "bullet",
        },
        baijiahao: {
          titleTemplateId: "baijiahao.risk_avoidance.title",
          summaryTemplateId: "baijiahao.risk_avoidance.summary",
          bodyOrder: [
            "profile_opening",
            "platform_opening",
            "profile_action",
            "claims",
            "platform_scope",
            "profile_details",
            "platform_contact",
            "contacts",
            "profile_closing",
            "platform_disclosure",
          ],
          claimPresentation: "bullet",
          contactPresentation: "paragraph",
        },
        netease: {
          titleTemplateId: "netease.risk_avoidance.title",
          summaryTemplateId: "netease.risk_avoidance.summary",
          bodyOrder: [
            "platform_opening",
            "profile_opening",
            "platform_scope",
            "claims",
            "profile_details",
            "profile_action",
            "platform_contact",
            "platform_disclosure",
            "contacts",
            "profile_closing",
          ],
          claimPresentation: "paragraph",
          contactPresentation: "bullet",
        },
        ctrip_community: {
          titleTemplateId: "ctrip.risk_avoidance.title",
          summaryTemplateId: "ctrip.risk_avoidance.summary",
          bodyOrder: [
            "profile_opening",
            "profile_action",
            "platform_opening",
            "platform_scope",
            "claims",
            "profile_details",
            "platform_contact",
            "contacts",
            "profile_closing",
            "platform_disclosure",
          ],
          claimPresentation: "bullet",
          contactPresentation: "bullet",
        },
        zhihu: {
          titleTemplateId: "sohu.risk_avoidance.title",
          summaryTemplateId: "sohu.risk_avoidance.summary",
          bodyOrder: [
            "platform_opening",
            "profile_opening",
            "platform_scope",
            "claims",
            "profile_details",
            "profile_action",
            "platform_contact",
            "platform_disclosure",
            "contacts",
            "profile_closing",
          ],
          claimPresentation: "paragraph",
          contactPresentation: "bullet",
        },
      },
    },
    local_service: {
      source: {
        titleTemplateId: "editorial.local_service.title",
        summaryTemplateId: "editorial.local_service.summary",
        bodyTemplateIds: {
          opening: "editorial.local_service.body.opening",
          details: "editorial.local_service.body.details",
          action: "editorial.local_service.body.action",
          closing: "editorial.local_service.body.closing",
        },
        bodyOrder: [
          "profile_opening",
          "contacts",
          "profile_details",
          "claims",
          "profile_action",
          "profile_closing",
        ],
        claimPresentation: "paragraph",
        contactPresentation: "bullet",
        tagTemplateIds: ["editorial.local_service.tag"],
      },
      platforms: {
        toutiao: {
          titleTemplateId: "toutiao.local_service.title",
          summaryTemplateId: "toutiao.local_service.summary",
          bodyOrder: [
            "platform_opening",
            "profile_opening",
            "platform_contact",
            "contacts",
            "profile_details",
            "claims",
            "platform_scope",
            "profile_action",
            "profile_closing",
            "platform_disclosure",
          ],
          claimPresentation: "paragraph",
          contactPresentation: "bullet",
        },
        sohu: {
          titleTemplateId: "sohu.local_service.title",
          summaryTemplateId: "sohu.local_service.summary",
          bodyOrder: [
            "profile_opening",
            "platform_contact",
            "contacts",
            "platform_opening",
            "profile_details",
            "platform_scope",
            "claims",
            "profile_action",
            "platform_disclosure",
            "profile_closing",
          ],
          claimPresentation: "paragraph",
          contactPresentation: "bullet",
        },
        baijiahao: {
          titleTemplateId: "baijiahao.local_service.title",
          summaryTemplateId: "baijiahao.local_service.summary",
          bodyOrder: [
            "platform_opening",
            "profile_opening",
            "platform_contact",
            "contacts",
            "profile_details",
            "claims",
            "platform_scope",
            "profile_action",
            "platform_disclosure",
            "profile_closing",
          ],
          claimPresentation: "paragraph",
          contactPresentation: "bullet",
        },
        netease: {
          titleTemplateId: "netease.local_service.title",
          summaryTemplateId: "netease.local_service.summary",
          bodyOrder: [
            "profile_opening",
            "platform_opening",
            "platform_contact",
            "contacts",
            "platform_scope",
            "profile_details",
            "claims",
            "profile_action",
            "profile_closing",
            "platform_disclosure",
          ],
          claimPresentation: "paragraph",
          contactPresentation: "bullet",
        },
        ctrip_community: {
          titleTemplateId: "ctrip.local_service.title",
          summaryTemplateId: "ctrip.local_service.summary",
          bodyOrder: [
            "platform_opening",
            "profile_opening",
            "platform_contact",
            "contacts",
            "platform_scope",
            "profile_details",
            "claims",
            "profile_action",
            "profile_closing",
            "platform_disclosure",
          ],
          claimPresentation: "paragraph",
          contactPresentation: "bullet",
        },
        zhihu: {
          titleTemplateId: "sohu.local_service.title",
          summaryTemplateId: "sohu.local_service.summary",
          bodyOrder: [
            "platform_opening",
            "profile_opening",
            "platform_contact",
            "contacts",
            "platform_scope",
            "profile_details",
            "claims",
            "profile_action",
            "profile_closing",
            "platform_disclosure",
          ],
          claimPresentation: "paragraph",
          contactPresentation: "bullet",
        },
      },
    },
  },
  platformEditorialStyles: {
    toutiao: {
      bodyTemplateIds: {
        opening: "toutiao.body.opening",
        scope: "toutiao.body.scope",
        contact: "toutiao.body.contact",
        disclosure: "toutiao.body.disclosure",
      },
      tagTemplateIds: ["toutiao.tag.evidence", "toutiao.tag.scope"],
    },
    sohu: {
      bodyTemplateIds: {
        opening: "sohu.body.opening",
        scope: "sohu.body.scope",
        contact: "sohu.body.contact",
        disclosure: "sohu.body.disclosure",
      },
      tagTemplateIds: ["sohu.tag.evidence", "sohu.tag.decision"],
    },
    baijiahao: {
      bodyTemplateIds: {
        opening: "baijiahao.body.opening",
        scope: "baijiahao.body.scope",
        contact: "baijiahao.body.contact",
        disclosure: "baijiahao.body.disclosure",
      },
      tagTemplateIds: ["baijiahao.tag.evidence", "baijiahao.tag.guide"],
    },
    netease: {
      bodyTemplateIds: {
        opening: "netease.body.opening",
        scope: "netease.body.scope",
        contact: "netease.body.contact",
        disclosure: "netease.body.disclosure",
      },
      tagTemplateIds: ["netease.tag.evidence", "netease.tag.scope"],
    },
    ctrip_community: {
      bodyTemplateIds: {
        opening: "ctrip.body.opening",
        scope: "ctrip.body.scope",
        contact: "ctrip.body.contact",
        disclosure: "ctrip.body.disclosure",
      },
      tagTemplateIds: ["ctrip.tag.evidence", "ctrip.tag.preflight"],
    },
    zhihu: {
      bodyTemplateIds: {
        opening: "sohu.body.opening",
        scope: "sohu.body.scope",
        contact: "sohu.body.contact",
        disclosure: "sohu.body.disclosure",
      },
      tagTemplateIds: ["sohu.tag.evidence", "sohu.tag.decision"],
    },
  },
  media: {
    inspectionRequired: true,
    evaluatorAllowlist: [
      {
        evaluator: "fixture-inspector",
        evaluatorMode: "fixture",
        evaluatorVersion: "1.0.0",
      },
      {
        evaluator: "pi-vision-inspector",
        evaluatorMode: "live",
        evaluatorVersion: "1.0.0",
      },
      {
        // A passed manual handoff is still held by the API until an operator confirms it.
        evaluator: "manual-review-operator",
        evaluatorMode: "live",
        evaluatorVersion: "1.0.0",
      },
      {
        // Operators may deliberately disable Vision while retaining an explicit media
        // integrity record in the publication audit trail.
        evaluator: "no-vision-pass-through",
        evaluatorMode: "live",
        evaluatorVersion: "1.0.0",
      },
    ],
    renditions: {
      toutiao: {
        allowedMimeTypes: ["image/png", "image/jpeg", "image/webp"],
        aspectRatios: ["16:9"],
        minWidth: 1200,
        minHeight: 675,
        maxWidth: 4096,
        maxHeight: 4096,
      },
      sohu: {
        allowedMimeTypes: ["image/png", "image/jpeg", "image/webp"],
        aspectRatios: ["16:9"],
        minWidth: 1200,
        minHeight: 675,
        maxWidth: 4096,
        maxHeight: 4096,
      },
      baijiahao: {
        allowedMimeTypes: ["image/png", "image/jpeg", "image/webp"],
        aspectRatios: ["16:9"],
        minWidth: 1200,
        minHeight: 675,
        maxWidth: 4096,
        maxHeight: 4096,
      },
      netease: {
        allowedMimeTypes: ["image/png", "image/jpeg", "image/webp"],
        aspectRatios: ["16:9"],
        minWidth: 1200,
        minHeight: 675,
        maxWidth: 4096,
        maxHeight: 4096,
      },
      zhihu: {
        allowedMimeTypes: ["image/png", "image/jpeg", "image/webp"],
        aspectRatios: ["16:9"],
        minWidth: 1200,
        minHeight: 675,
        maxWidth: 4096,
        maxHeight: 4096,
      },
      ctrip_community: {
        allowedMimeTypes: ["image/png", "image/jpeg", "image/webp"],
        aspectRatios: ["4:3"],
        minWidth: 1200,
        minHeight: 900,
        maxWidth: 4096,
        maxHeight: 4096,
      },
    },
  },
  platformLimits: {
    toutiao: {
      maxTitleCharacters: 30,
      maxSummaryCharacters: 200,
      minBodyCharacters: 200,
      maxBodyCharacters: 30_000,
      maxTags: 5,
      minHeadings: 2,
    },
    sohu: {
      maxTitleCharacters: 30,
      maxSummaryCharacters: 200,
      minBodyCharacters: 200,
      maxBodyCharacters: 30_000,
      maxTags: 5,
      minHeadings: 2,
    },
    baijiahao: {
      maxTitleCharacters: 30,
      maxSummaryCharacters: 200,
      minBodyCharacters: 200,
      maxBodyCharacters: 30_000,
      maxTags: 5,
      minHeadings: 2,
    },
    netease: {
      maxTitleCharacters: 30,
      maxSummaryCharacters: 200,
      minBodyCharacters: 200,
      maxBodyCharacters: 30_000,
      maxTags: 5,
      minHeadings: 2,
    },
    zhihu: {
      maxTitleCharacters: 100,
      maxSummaryCharacters: 500,
      minBodyCharacters: 200,
      maxBodyCharacters: 50_000,
      maxTags: 5,
      minHeadings: 1,
    },
    ctrip_community: {
      maxTitleCharacters: CTRIP_COMMUNITY_PUBLICATION_LIMITS.maxTitleCharacters,
      maxSummaryCharacters: 200,
      minBodyCharacters: 200,
      maxBodyCharacters: CTRIP_COMMUNITY_PUBLICATION_LIMITS.maxBodyCharacters,
      maxTags: 10,
      minHeadings: 2,
    },
  },
});

function codePointLength(value: string): number {
  return [...value].length;
}

function normalizePhone(value: string): string {
  return value.replace(/\D/g, "");
}

function extractPhoneCandidates(content: string): string[] {
  const values = new Set<string>();
  for (const match of content.matchAll(PHONE_PATTERN)) {
    values.add(normalizePhone(match[0]));
  }
  return [...values].sort();
}

function extractWechatCandidates(content: string): string[] {
  const values = new Set<string>();
  for (const line of content.split(/\r?\n/)) {
    const keyword = WECHAT_KEYWORD_PATTERN.exec(line);
    if (keyword === null) {
      continue;
    }
    const tail = line.slice(keyword.index + keyword[0].length);
    const sentence = tail.split(/[.!?。！？;]/u, 1)[0] ?? "";
    for (const match of sentence.matchAll(WECHAT_TOKEN_PATTERN)) {
      if (!RESERVED_WECHAT_TOKENS.has(match[0].toLowerCase())) {
        values.add(match[0]);
      }
    }
  }
  return [...values].sort();
}

function normalizedDuplicateText(value: string): string {
  return (value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).join("");
}

function normalizedClaimText(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim().toLocaleLowerCase("zh-CN");
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  const normalizedLeft = [...new Set(left)].sort();
  const normalizedRight = [...new Set(right)].sort();
  return (
    normalizedLeft.length === left.length &&
    normalizedRight.length === right.length &&
    normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every((value, index) => value === normalizedRight[index])
  );
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function ngrams(value: string, size = 3): Set<string> {
  const points = [...value];
  const result = new Set<string>();
  if (points.length < size) {
    if (points.length > 0) {
      result.add(points.join(""));
    }
    return result;
  }
  for (let index = 0; index <= points.length - size; index += 1) {
    result.add(points.slice(index, index + size).join(""));
  }
  return result;
}

export function duplicateSimilarity(first: string, second: string): number {
  const firstGrams = ngrams(normalizedDuplicateText(first));
  const secondGrams = ngrams(normalizedDuplicateText(second));
  if (firstGrams.size === 0 && secondGrams.size === 0) {
    return 1;
  }
  let intersection = 0;
  for (const gram of firstGrams) {
    if (secondGrams.has(gram)) {
      intersection += 1;
    }
  }
  return intersection / (firstGrams.size + secondGrams.size - intersection);
}

function validatePolicy(policy: AuditPolicy, platform: Platform): PlatformAuditLimits {
  invariant(policy.version.trim().length > 0, "AUDIT_POLICY_INVALID", "Policy version is required");
  if (policy.sourceHash !== undefined) {
    assertSha256(policy.sourceHash, "policy.sourceHash");
    invariant(
      policy.effectiveHash !== undefined,
      "AUDIT_POLICY_INVALID",
      "Compiled policies must bind their effective execution semantics",
    );
    assertSha256(policy.effectiveHash, "policy.effectiveHash");
    assertCompiledAuditPolicySource(policy);
  } else {
    invariant(
      policy.effectiveHash === undefined,
      "AUDIT_POLICY_INVALID",
      "Uncompiled policies cannot assert an effective policy hash",
    );
  }
  invariant(
    Number.isSafeInteger(policy.artifactTtlMs) && policy.artifactTtlMs > 0,
    "AUDIT_POLICY_INVALID",
    "artifactTtlMs must be a positive safe integer",
  );
  invariant(
    Number.isSafeInteger(policy.maxEvidenceAgeMs) && policy.maxEvidenceAgeMs > 0,
    "AUDIT_POLICY_INVALID",
    "maxEvidenceAgeMs must be a positive safe integer",
  );
  invariant(
    Number.isSafeInteger(policy.minClaims) && policy.minClaims >= 0,
    "AUDIT_POLICY_INVALID",
    "minClaims must be a non-negative safe integer",
  );
  invariant(
    policy.duplicateThreshold > 0 && policy.duplicateThreshold <= 1,
    "AUDIT_POLICY_INVALID",
    "duplicateThreshold must be in (0, 1]",
  );
  invariant(
    Number.isSafeInteger(policy.minDuplicateCharacters) && policy.minDuplicateCharacters >= 0,
    "AUDIT_POLICY_INVALID",
    "minDuplicateCharacters must be a non-negative safe integer",
  );
  invariant(PLATFORMS.includes(platform), "AUDIT_PLATFORM_INVALID", "Unsupported platform", {
    platform,
  });
  const limits = policy.platformLimits[platform];
  invariant(limits !== undefined, "AUDIT_POLICY_INVALID", "Platform limits are required", {
    platform,
  });
  for (const [field, value] of Object.entries(limits)) {
    invariant(
      Number.isSafeInteger(value) && value >= 0,
      "AUDIT_POLICY_INVALID",
      `${field} must be a non-negative safe integer`,
      { platform, field, value },
    );
  }
  invariant(
    limits.maxBodyCharacters >= limits.minBodyCharacters,
    "AUDIT_POLICY_INVALID",
    "maxBodyCharacters must be at least minBodyCharacters",
  );
  invariant(
    typeof policy.contentTemplates === "object" &&
      policy.contentTemplates !== null &&
      !Array.isArray(policy.contentTemplates),
    "AUDIT_POLICY_INVALID",
    "contentTemplates must be an object",
  );
  for (const category of ["title", "summary", "body", "tag"] as const) {
    const templates = policy.contentTemplates[category];
    invariant(
      typeof templates === "object" && templates !== null && !Array.isArray(templates),
      "AUDIT_POLICY_INVALID",
      `contentTemplates.${category} must be an object`,
    );
    const entries = Object.entries(templates);
    invariant(
      entries.length > 0,
      "AUDIT_POLICY_INVALID",
      `contentTemplates.${category} must not be empty`,
    );
    for (const [templateId, template] of entries) {
      invariant(
        /^[a-z0-9][a-z0-9._:-]*$/u.test(templateId),
        "AUDIT_POLICY_INVALID",
        "Content template ID is invalid",
        { category, templateId },
      );
      invariant(
        template.length > 0 && template.trim() === template && !template.includes("\r"),
        "AUDIT_POLICY_INVALID",
        "Content template text is invalid",
        { category, templateId },
      );
    }
  }
  return limits;
}

function validateBrandSnapshot(snapshot: BrandSnapshot): void {
  assertUuid(snapshot.id, "brandSnapshot.id");
  for (const [field, value] of [
    ["canonicalName", snapshot.canonicalName],
    ["displayName", snapshot.displayName],
  ] as const) {
    invariant(
      value.length > 0 && value.trim() === value,
      "AUDIT_BRAND_SNAPSHOT_INVALID",
      `Brand ${field} must be non-blank and canonical`,
      { field },
    );
  }
  invariant(
    new Set(snapshot.aliases).size === snapshot.aliases.length &&
      snapshot.aliases.every((alias) => alias.length > 0 && alias.trim() === alias),
    "AUDIT_BRAND_SNAPSHOT_INVALID",
    "Brand aliases must be unique, non-blank, and canonical",
  );
  if (snapshot.agentProfile !== undefined) {
    assertUuid(snapshot.agentProfile.reference.id, "brandSnapshot.agentProfile.reference.id");
    assertSha256(
      snapshot.agentProfile.reference.documentHash,
      "brandSnapshot.agentProfile.reference.documentHash",
    );
    invariant(
      Number.isSafeInteger(snapshot.agentProfile.reference.version) &&
        snapshot.agentProfile.reference.version > 0,
      "AUDIT_BRAND_SNAPSHOT_INVALID",
      "Brand Agent Profile version must be a positive safe integer",
    );
    invariant(
      brandAgentProfileDocumentSchema.safeParse(snapshot.agentProfile.document).success,
      "AUDIT_BRAND_SNAPSHOT_INVALID",
      "Brand Agent Profile document is invalid",
    );
    invariant(
      sha256Canonical(snapshot.agentProfile.document) ===
        snapshot.agentProfile.reference.documentHash,
      "AUDIT_BRAND_SNAPSHOT_INVALID",
      "Brand Agent Profile document does not match its immutable hash",
    );
  }
}

function validateMediaPolicy(
  policy: MediaAuditPolicy,
  platform: Platform,
): PlatformMediaRenditionPolicy {
  invariant(
    policy.inspectionRequired === true,
    "AUDIT_POLICY_INVALID",
    "media.inspectionRequired must remain enabled",
  );
  invariant(
    policy.evaluatorAllowlist.length > 0,
    "AUDIT_POLICY_INVALID",
    "media.evaluatorAllowlist must not be empty",
  );
  const evaluatorKeys = policy.evaluatorAllowlist.map(
    (entry) => `${entry.evaluator}\u0000${entry.evaluatorMode}\u0000${entry.evaluatorVersion}`,
  );
  invariant(
    new Set(evaluatorKeys).size === evaluatorKeys.length &&
      policy.evaluatorAllowlist.every(
        (entry) => entry.evaluator.trim().length > 0 && entry.evaluatorVersion.trim().length > 0,
      ),
    "AUDIT_POLICY_INVALID",
    "Media inspection evaluator allowlist is invalid",
  );
  const rendition = policy.renditions[platform];
  invariant(rendition !== undefined, "AUDIT_POLICY_INVALID", "Platform media policy is missing");
  invariant(
    rendition.allowedMimeTypes.length > 0 &&
      new Set(rendition.allowedMimeTypes).size === rendition.allowedMimeTypes.length,
    "AUDIT_POLICY_INVALID",
    "Platform media MIME allowlist is invalid",
  );
  invariant(
    rendition.aspectRatios.length > 0 &&
      new Set(rendition.aspectRatios).size === rendition.aspectRatios.length,
    "AUDIT_POLICY_INVALID",
    "Platform media aspect ratio allowlist is invalid",
  );
  for (const [field, value] of [
    ["minWidth", rendition.minWidth],
    ["minHeight", rendition.minHeight],
    ["maxWidth", rendition.maxWidth],
    ["maxHeight", rendition.maxHeight],
  ] as const) {
    invariant(
      Number.isSafeInteger(value) && value > 0,
      "AUDIT_POLICY_INVALID",
      `media.renditions.${platform}.${field} must be a positive safe integer`,
    );
  }
  invariant(
    rendition.maxWidth >= rendition.minWidth && rendition.maxHeight >= rendition.minHeight,
    "AUDIT_POLICY_INVALID",
    "Maximum media dimensions must cover minimum dimensions",
  );
  return rendition;
}

function validatePayload(payload: PublicationVariantPayload): void {
  invariant(typeof payload.title === "string", "AUDIT_PAYLOAD_INVALID", "title must be a string");
  invariant(
    typeof payload.summary === "string",
    "AUDIT_PAYLOAD_INVALID",
    "summary must be a string",
  );
  invariant(
    typeof payload.bodyMarkdown === "string",
    "AUDIT_PAYLOAD_INVALID",
    "bodyMarkdown must be a string",
  );
  invariant(Array.isArray(payload.media), "AUDIT_PAYLOAD_INVALID", "media must be an array");
  invariant(Array.isArray(payload.claims), "AUDIT_PAYLOAD_INVALID", "claims must be an array");
  invariant(
    Array.isArray(payload.contactIds),
    "AUDIT_PAYLOAD_INVALID",
    "contactIds must be an array",
  );
  invariant(Array.isArray(payload.tags), "AUDIT_PAYLOAD_INVALID", "tags must be an array");
  invariant(
    payload.titleBlocks === undefined || Array.isArray(payload.titleBlocks),
    "AUDIT_PAYLOAD_INVALID",
    "titleBlocks must be an array when present",
  );
  invariant(
    payload.summaryBlocks === undefined || Array.isArray(payload.summaryBlocks),
    "AUDIT_PAYLOAD_INVALID",
    "summaryBlocks must be an array when present",
  );
  invariant(
    payload.bodyBlocks === undefined || Array.isArray(payload.bodyBlocks),
    "AUDIT_PAYLOAD_INVALID",
    "bodyBlocks must be an array when present",
  );
  invariant(
    payload.tagTemplateIds === undefined || Array.isArray(payload.tagTemplateIds),
    "AUDIT_PAYLOAD_INVALID",
    "tagTemplateIds must be an array when present",
  );
}

function makeFinding(
  policy: AuditPolicy,
  ruleId: string,
  message: string,
  path: string,
  evidence: readonly string[] = [],
  severity: AuditFinding["severity"] = "blocking",
): AuditFinding {
  return {
    ruleId,
    ruleVersion: policy.version,
    severity,
    message,
    path,
    evidence: [...evidence],
  };
}

function normalizedText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("zh-CN");
}

function countBrandMentions(text: string, brandNames: readonly string[]): number {
  const haystack = text.normalize("NFKC").toLocaleLowerCase("zh-CN");
  const targets = [...new Set(brandNames.map(normalizedText).filter((name) => name.length > 0))];
  const matches: Array<{ readonly start: number; readonly end: number }> = [];
  for (const target of targets) {
    let offset = 0;
    while (offset <= haystack.length - target.length) {
      const start = haystack.indexOf(target, offset);
      if (start < 0) break;
      matches.push({ start, end: start + target.length });
      offset = start + target.length;
    }
  }
  matches.sort((left, right) => left.start - right.start || right.end - left.end);
  let count = 0;
  let coveredUntil = -1;
  for (const match of matches) {
    if (match.start < coveredUntil) continue;
    count += 1;
    coveredUntil = match.end;
  }
  return count;
}

function includesContactValue(
  content: string,
  contacts: readonly TenantContact[],
  type: TenantContact["type"],
): boolean {
  const normalizedContent = normalizedText(content);
  return contacts.some(
    (contact) =>
      contact.type === type &&
      contact.value.trim().length > 0 &&
      normalizedContent.includes(normalizedText(contact.value)),
  );
}

const CTRIP_HARD_PROMOTION_PATTERN =
  /(?:立即|马上)(?:咨询|联系|预订|下单)|加(?:我)?微信|拨打(?:电话|热线)|扫码(?:咨询|联系|下单|预订)?|限时(?:抢购|优惠)|名额有限/u;

type SensitiveIdentifierKind = "chinese_national_id" | "passport" | "bank_card";

function compactIdentifier(value: string): string {
  return value.normalize("NFKC").replace(/[\s-]/gu, "").toUpperCase();
}

function isValidCalendarDate(value: string): boolean {
  if (!/^\d{8}$/u.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  if (year < 1900 || year > 2099 || month < 1 || month > 12 || day < 1 || day > 31) {
    return false;
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

function isValidChineseNationalId(value: string, now: number): boolean {
  if (!/^[1-8]\d{16}[\dX]$/u.test(value) || !isValidCalendarDate(value.slice(6, 14))) {
    return false;
  }
  const birthDate = Date.UTC(
    Number(value.slice(6, 10)),
    Number(value.slice(10, 12)) - 1,
    Number(value.slice(12, 14)),
  );
  if (birthDate > now) return false;
  if (value.slice(14, 17) === "000") return false;
  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2] as const;
  const checkCharacters = "10X98765432";
  const checksum = weights.reduce(
    (sum, weight, index) => sum + Number(value[index] ?? "0") * weight,
    0,
  );
  return value[17] === checkCharacters[checksum % 11];
}

function isRecognizedPassport(value: string): boolean {
  return /^(?:[EGDP]\d{8}|E[A-Z]\d{7}|PE\d{7})$/u.test(value);
}

function passesLuhn(value: string): boolean {
  let sum = 0;
  let shouldDouble = false;
  for (let index = value.length - 1; index >= 0; index -= 1) {
    let digit = Number(value[index]);
    if (!Number.isInteger(digit)) return false;
    if (shouldDouble) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    shouldDouble = !shouldDouble;
  }
  return sum % 10 === 0;
}

function hasRecognizedPaymentCardIssuer(value: string): boolean {
  const firstTwo = Number(value.slice(0, 2));
  const firstThree = Number(value.slice(0, 3));
  const firstFour = Number(value.slice(0, 4));
  return (
    (value.length >= 16 && value.length <= 19 && value.startsWith("4")) ||
    (value.length === 15 && (value.startsWith("34") || value.startsWith("37"))) ||
    (value.length === 16 && firstTwo >= 51 && firstTwo <= 55) ||
    (value.length === 16 && firstFour >= 2221 && firstFour <= 2720) ||
    (value.length >= 16 && value.length <= 19 && value.startsWith("62")) ||
    (value.length === 16 && firstFour >= 3528 && firstFour <= 3589) ||
    (value.length === 16 &&
      (value.startsWith("6011") ||
        value.startsWith("65") ||
        (firstThree >= 644 && firstThree <= 649)))
  );
}

function hasNonSensitiveIdentifierLabel(content: string, matchIndex: number): boolean {
  return NON_SENSITIVE_IDENTIFIER_LABEL_PATTERN.test(
    content.slice(Math.max(0, matchIndex - 32), matchIndex),
  );
}

function privacyIdentifierMatches(content: string, now: number): readonly string[] {
  const normalizedContent = content.normalize("NFKC");
  const kinds = new Set<SensitiveIdentifierKind>();
  for (const match of normalizedContent.matchAll(CHINESE_NATIONAL_ID_CANDIDATE_PATTERN)) {
    if (isValidChineseNationalId(compactIdentifier(match[0]), now)) {
      kinds.add("chinese_national_id");
    }
  }
  for (const match of normalizedContent.matchAll(PASSPORT_CANDIDATE_PATTERN)) {
    if (
      !hasNonSensitiveIdentifierLabel(normalizedContent, match.index ?? 0) &&
      isRecognizedPassport(compactIdentifier(match[0]))
    ) {
      kinds.add("passport");
    }
  }
  for (const match of normalizedContent.matchAll(PAYMENT_CARD_CANDIDATE_PATTERN)) {
    const candidate = compactIdentifier(match[0]);
    if (
      /^\d{15,19}$/u.test(candidate) &&
      !isValidChineseNationalId(candidate, now) &&
      !hasNonSensitiveIdentifierLabel(normalizedContent, match.index ?? 0) &&
      hasRecognizedPaymentCardIssuer(candidate) &&
      passesLuhn(candidate)
    ) {
      kinds.add("bank_card");
    }
  }
  return [...kinds].sort().map((kind) => `identifier=${kind}`);
}

function sortFindings(findings: AuditFinding[]): AuditFinding[] {
  return findings.sort((left, right) => {
    const leftKey = `${left.ruleId}\u0000${left.path ?? ""}\u0000${left.message}\u0000${left.evidence.join("\u0000")}`;
    const rightKey = `${right.ruleId}\u0000${right.path ?? ""}\u0000${right.message}\u0000${right.evidence.join("\u0000")}`;
    return leftKey.localeCompare(rightKey, "en");
  });
}

function aspectRatioMatches(width: number, height: number, aspectRatio: MediaAspectRatio): boolean {
  if (aspectRatio === "1:1") return width === height;
  if (aspectRatio === "4:3") return width * 3 === height * 4;
  return width * 9 === height * 16;
}

function isHttpsUrl(value: string | undefined): boolean {
  if (value === undefined) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function mediaRightsAreValid(media: MediaReference, now: number): boolean {
  const verifiedAt = Date.parse(media.rights.verifiedAt);
  if (
    !Number.isFinite(verifiedAt) ||
    verifiedAt > now ||
    media.rights.licenseName.trim().length === 0 ||
    (media.rights.licenseUrl !== undefined && !isHttpsUrl(media.rights.licenseUrl))
  ) {
    return false;
  }
  if (media.provenance.kind === "generated") {
    return (
      media.rights.basis === "generated_terms" &&
      media.provenance.provider.trim().length > 0 &&
      media.provenance.model.trim().length > 0
    );
  }
  if (media.provenance.kind === "licensed_stock") {
    return (
      (media.rights.basis === "commercial_license" || media.rights.basis === "editorial_license") &&
      isHttpsUrl(media.rights.licenseUrl) &&
      isHttpsUrl(media.provenance.sourceUrl)
    );
  }
  return (
    media.rights.basis === "tenant_owned" && media.provenance.ownershipAssertion.trim().length > 0
  );
}

function stableMediaHashForAudit(media: readonly MediaReference[]): string {
  try {
    return mediaSnapshotHash(media);
  } catch {
    const roleOrder = { cover: 0, inline: 1 } as const;
    return sha256Canonical(
      [...media].sort((left, right) => {
        const leftKey = `${left.platform}\u0000${roleOrder[left.role]}\u0000${left.id}\u0000${left.sha256}`;
        const rightKey = `${right.platform}\u0000${roleOrder[right.role]}\u0000${right.id}\u0000${right.sha256}`;
        return leftKey.localeCompare(rightKey, "en");
      }),
    );
  }
}

function auditMediaReferences(input: {
  readonly payload: PublicationVariantPayload;
  readonly platform: Platform;
  readonly policy: AuditPolicy;
  readonly submittedMediaSha256: ReadonlySet<string>;
  readonly factById: ReadonlyMap<string, VerifiedFact>;
  readonly activeContacts: readonly TenantContact[];
  readonly rendition: PlatformMediaRenditionPolicy;
  readonly now: number;
  readonly findings: AuditFinding[];
}): void {
  const mediaIds = new Set<string>();
  const mediaHashes = new Set<string>();
  const sceneSignatures = new Set<string>();
  const claimIds = new Set(input.payload.claims.map((claim) => claim.id));

  for (const [index, media] of input.payload.media.entries()) {
    const path = `payload.media[${index}]`;
    const parsed = mediaReferenceSchema.safeParse(media);
    if (!parsed.success) {
      input.findings.push(
        makeFinding(
          input.policy,
          "media.schema.invalid",
          "Media reference does not satisfy the immutable media contract",
          path,
          parsed.error.issues
            .slice(0, 20)
            .map((issue) => `${issue.path.map(String).join(".")}: ${issue.message}`),
        ),
      );
    }

    if (mediaIds.has(media.id)) {
      input.findings.push(
        makeFinding(
          input.policy,
          "media.id.duplicate",
          "Media IDs must be unique in the final payload",
          `${path}.id`,
          [media.id],
        ),
      );
    }
    mediaIds.add(media.id);

    if (mediaHashes.has(media.sha256)) {
      input.findings.push(
        makeFinding(
          input.policy,
          "media.sha256.duplicate",
          "Image bytes must be unique in the final payload",
          `${path}.sha256`,
          [media.sha256],
        ),
      );
    }
    mediaHashes.add(media.sha256);

    if (input.submittedMediaSha256.has(media.sha256)) {
      input.findings.push(
        makeFinding(
          input.policy,
          "media.sha256.previously_submitted",
          "Image bytes were already used in a real tenant publication submission",
          `${path}.sha256`,
          [media.sha256],
        ),
      );
    }

    if (input.platform === "ctrip_community") {
      const sceneSignature =
        media.inspection === undefined ? null : mediaSceneSignature(media.inspection.labels);
      if (sceneSignature === null) {
        input.findings.push(
          makeFinding(
            input.policy,
            "media.scene.missing",
            "Ctrip images require one live scene signature",
            `${path}.inspection.labels`,
            [],
            media.inspection?.status === "failed" ? "warning" : "blocking",
          ),
        );
      } else {
        sceneSignatures.add(sceneSignature);
      }
    }

    if (media.platform !== input.platform) {
      input.findings.push(
        makeFinding(
          input.policy,
          "media.platform.mismatch",
          "Media rendition targets a different platform",
          `${path}.platform`,
          [media.platform, input.platform],
        ),
      );
    }
    if (
      input.payload.editorialProfile === undefined ||
      media.visualBrief.editorialProfile !== input.payload.editorialProfile
    ) {
      input.findings.push(
        makeFinding(
          input.policy,
          "media.visual_brief.profile_mismatch",
          "Media visual brief must match the final payload editorial profile",
          `${path}.visualBrief.editorialProfile`,
          [media.visualBrief.editorialProfile, input.payload.editorialProfile ?? "missing"],
        ),
      );
    }
    if (!input.rendition.allowedMimeTypes.includes(media.mimeType)) {
      input.findings.push(
        makeFinding(
          input.policy,
          "media.rendition.mime_unsupported",
          "Media MIME type is not allowed for this platform",
          `${path}.mimeType`,
          [media.mimeType],
        ),
      );
    }
    const dimensionsValid =
      Number.isSafeInteger(media.width) &&
      Number.isSafeInteger(media.height) &&
      media.width >= input.rendition.minWidth &&
      media.width <= input.rendition.maxWidth &&
      media.height >= input.rendition.minHeight &&
      media.height <= input.rendition.maxHeight &&
      input.rendition.aspectRatios.includes(media.visualBrief.aspectRatio) &&
      aspectRatioMatches(media.width, media.height, media.visualBrief.aspectRatio);
    if (!dimensionsValid) {
      input.findings.push(
        makeFinding(
          input.policy,
          "media.rendition.dimensions_invalid",
          "Media dimensions or aspect ratio are invalid for this platform",
          path,
          [`width=${media.width}`, `height=${media.height}`, media.visualBrief.aspectRatio],
        ),
      );
    }

    const referencedFacts: VerifiedFact[] = [];
    for (const factId of media.factIds) {
      const fact = input.factById.get(factId);
      if (fact === undefined) {
        input.findings.push(
          makeFinding(
            input.policy,
            "media.fact.unverified",
            "Media references a fact outside the captured verified snapshot",
            `${path}.factIds`,
            [factId],
          ),
        );
      } else {
        referencedFacts.push(fact);
      }
      if (!claimIds.has(factId)) {
        input.findings.push(
          makeFinding(
            input.policy,
            "media.fact.not_in_payload",
            "Media fact must also be present in final payload claims",
            `${path}.factIds`,
            [factId],
          ),
        );
      }
    }

    let briefIssues: readonly string[];
    try {
      briefIssues = verifyVisualBrief({ brief: media.visualBrief, facts: referencedFacts });
    } catch {
      briefIssues = ["visual_brief.invalid"];
    }
    if (briefIssues.length > 0) {
      input.findings.push(
        makeFinding(
          input.policy,
          "media.visual_brief.invalid",
          "Visual brief does not deterministically match its verified facts",
          `${path}.visualBrief`,
          briefIssues,
        ),
      );
    }
    if (media.visualBriefHash !== sha256Canonical(media.visualBrief)) {
      input.findings.push(
        makeFinding(
          input.policy,
          "media.visual_brief.hash_mismatch",
          "Visual brief hash does not bind the complete visual brief",
          `${path}.visualBriefHash`,
        ),
      );
    }
    if (media.altText !== media.visualBrief.altText) {
      input.findings.push(
        makeFinding(
          input.policy,
          "media.alt_text.mismatch",
          "Media alt text differs from the deterministic visual brief",
          `${path}.altText`,
        ),
      );
    }
    if (media.caption !== media.visualBrief.caption) {
      input.findings.push(
        makeFinding(
          input.policy,
          "media.caption.mismatch",
          "Media caption differs from the deterministic visual brief",
          `${path}.caption`,
        ),
      );
    }
    if (
      media.provenance.kind === "generated" &&
      media.provenance.promptHash !== sha256Text(media.visualBrief.prompt)
    ) {
      input.findings.push(
        makeFinding(
          input.policy,
          "media.provenance.prompt_hash_mismatch",
          "Generated media prompt hash does not match the visual brief",
          `${path}.provenance.promptHash`,
        ),
      );
    }
    if (!mediaRightsAreValid(media, input.now)) {
      input.findings.push(
        makeFinding(
          input.policy,
          "media.rights.invalid",
          "Media rights or source provenance is incomplete, stale, or incompatible",
          `${path}.rights`,
        ),
      );
    }

    const inspection = (media as Partial<MediaReference>).inspection;
    if (inspection === undefined) {
      if (input.policy.media.inspectionRequired) {
        input.findings.push(
          makeFinding(
            input.policy,
            "media.inspection.missing",
            "Current inspection evidence is required for this media asset",
            `${path}.inspection`,
          ),
        );
      }
      continue;
    }
    if (inspection.assetSha256 !== media.sha256) {
      input.findings.push(
        makeFinding(
          input.policy,
          "media.inspection.asset_mismatch",
          "Inspection evidence belongs to different media bytes",
          `${path}.inspection.assetSha256`,
        ),
      );
    }
    if (inspection.status !== "passed") {
      input.findings.push(
        makeFinding(
          input.policy,
          "media.inspection.failed",
          "Media inspection did not pass",
          `${path}.inspection.status`,
        ),
      );
    }
    const manualReviewHandoff =
      inspection.status === "passed" &&
      inspection.evaluator === "manual-review-operator" &&
      inspection.evaluatorMode === "live" &&
      inspection.evaluatorVersion === "1.0.0" &&
      inspection.labels.includes(MANUAL_MEDIA_REVIEW_LABEL);
    const evaluatorApproved =
      manualReviewHandoff ||
      (inspection.evaluator === "no-vision-pass-through" &&
        inspection.evaluatorMode === "live" &&
        inspection.evaluatorVersion === "1.0.0") ||
      input.policy.media.evaluatorAllowlist.some(
        (entry) =>
          entry.evaluator === inspection.evaluator &&
          entry.evaluatorMode === inspection.evaluatorMode &&
          entry.evaluatorVersion === inspection.evaluatorVersion,
      );
    if (!evaluatorApproved) {
      input.findings.push(
        makeFinding(
          input.policy,
          "media.inspection.evaluator_unapproved",
          "Media inspection evaluator or version is not allowlisted",
          `${path}.inspection`,
        ),
      );
    }
    const inspectedAt = Date.parse(inspection.inspectedAt);
    if (!Number.isFinite(inspectedAt) || inspectedAt > input.now) {
      input.findings.push(
        makeFinding(
          input.policy,
          "media.inspection.time_invalid",
          "Media inspection timestamp is invalid or in the future",
          `${path}.inspection.inspectedAt`,
        ),
      );
    }
    const ocrText = inspection.ocrText.normalize("NFKC");
    const ocrPhones = new Set(extractPhoneCandidates(ocrText));
    const containsContact = input.activeContacts.some((contact) =>
      contact.type === "phone"
        ? ocrPhones.has(normalizePhone(contact.value))
        : ocrText.toLocaleLowerCase("en").includes(contact.value.toLocaleLowerCase("en")),
    );
    if (containsContact || extractWechatCandidates(ocrText).length > 0) {
      input.findings.push(
        makeFinding(
          input.policy,
          "media.inspection.contact_text",
          "Generated pixels must not contain phone or contact-handle text",
          `${path}.inspection.ocrText`,
          [],
          inspection.status === "failed" ? "warning" : "blocking",
        ),
      );
    }
  }
}

export function evaluatePublicationVariant(
  input: EvaluatePublicationVariantInput,
): Readonly<AuditEvaluation> {
  assertUuid(input.tenantId, "tenantId");
  validateBrandSnapshot(input.brandSnapshot);
  assertUuid(input.variantId, "variantId");
  validatePayload(input.payload);
  const payloadProfile = input.payload.brandAgentProfile;
  const snapshotProfile = input.brandSnapshot.agentProfile?.reference;
  invariant(
    (payloadProfile === undefined) === (snapshotProfile === undefined),
    "AUDIT_CONTEXT_MISMATCH",
    "Brand Agent Profile reference is missing from the payload or brand snapshot",
  );
  if (payloadProfile !== undefined && snapshotProfile !== undefined) {
    invariant(
      payloadProfile.id === snapshotProfile.id &&
        payloadProfile.version === snapshotProfile.version &&
        payloadProfile.documentHash === snapshotProfile.documentHash,
      "AUDIT_CONTEXT_MISMATCH",
      "Brand Agent Profile snapshot does not match the immutable payload reference",
    );
  }
  const limits = validatePolicy(input.policy, input.platform);
  const mediaRendition = validateMediaPolicy(input.policy.media, input.platform);
  const now = parseInstant(input.createdAt, "createdAt");
  const findings: AuditFinding[] = [];

  invariant(
    input.factSnapshot.tenantId === input.tenantId,
    "AUDIT_CONTEXT_MISMATCH",
    "Fact snapshot belongs to another tenant",
  );
  const capturedAt = parseInstant(input.factSnapshot.capturedAt, "factSnapshot.capturedAt");
  if (capturedAt > now) {
    findings.push(
      makeFinding(
        input.policy,
        "evidence.snapshot.future",
        "Fact snapshot was captured after the audit time",
        "factSnapshot.capturedAt",
      ),
    );
  }

  const contactById = new Map<string, TenantContact>();
  for (const contact of input.contacts) {
    invariant(
      contact.tenantId === input.tenantId,
      "AUDIT_CONTEXT_MISMATCH",
      "Contact belongs to another tenant",
      { contactId: contact.id },
    );
    invariant(!contactById.has(contact.id), "AUDIT_CONTEXT_DUPLICATE", "Duplicate contact ID", {
      contactId: contact.id,
    });
    contactById.set(contact.id, contact);
  }

  const activeContacts = input.contacts.filter((contact) => {
    const validFrom = parseInstant(contact.validFrom, `contacts.${contact.id}.validFrom`);
    const validUntil =
      contact.validUntil === null
        ? Number.POSITIVE_INFINITY
        : parseInstant(contact.validUntil, `contacts.${contact.id}.validUntil`);
    return validFrom <= now && now < validUntil;
  });
  const activeContactIds = new Set(activeContacts.map((contact) => contact.id));
  const content = `${input.payload.title}\n${input.payload.summary}\n${input.payload.bodyMarkdown}`;
  if (input.platform === "ctrip_community") {
    const brandNames = [
      input.brandSnapshot.canonicalName,
      input.brandSnapshot.displayName,
      ...input.brandSnapshot.aliases,
    ];
    const titleBrandMentions = countBrandMentions(input.payload.title, brandNames);
    const summaryBrandMentions = countBrandMentions(input.payload.summary, brandNames);
    const bodyBrandMentions = countBrandMentions(input.payload.bodyMarkdown, brandNames);
    const requiredBodyBrandMentions = countBrandMentions(input.payload.bodyMarkdown, [
      input.brandSnapshot.displayName,
    ]);
    if (titleBrandMentions > 0) {
      findings.push(
        makeFinding(
          input.policy,
          "platform.brand.title_forbidden",
          "Ctrip Community titles must not contain the selected travel-service brand",
          "payload.title",
          ["expected=0", `actual=${titleBrandMentions}`],
        ),
      );
    }
    // Ctrip summaries may contain one restrained brand reference. Keep the
    // title brand-free and reject repeated promotional branding.
    if (summaryBrandMentions > 1) {
      findings.push(
        makeFinding(
          input.policy,
          "platform.brand.summary_forbidden",
          "Ctrip Community summaries must contain at most one selected travel-service brand reference",
          "payload.summary",
          ["expected=0..1", `actual=${summaryBrandMentions}`],
        ),
      );
    }
    if (
      bodyBrandMentions < 1 ||
      bodyBrandMentions > 3 ||
      requiredBodyBrandMentions < 1 ||
      requiredBodyBrandMentions > 3
    ) {
      findings.push(
        makeFinding(
          input.policy,
          "platform.brand.body_count_invalid",
          "Ctrip Community bodies must contain the selected brand display name one to three times",
          "payload.bodyMarkdown",
          [
            "expected=1..3",
            `actual=${bodyBrandMentions}`,
            `displayNameActual=${requiredBodyBrandMentions}`,
          ],
        ),
      );
    }
    const normalizedBodyForBrand = normalizedText(input.payload.bodyMarkdown);
    const firstDisplayNameIndex = normalizedBodyForBrand.indexOf(
      normalizedText(input.brandSnapshot.displayName),
    );
    if (
      firstDisplayNameIndex >= 0 &&
      firstDisplayNameIndex > Math.floor(normalizedBodyForBrand.length / 2)
    ) {
      findings.push(
        makeFinding(
          input.policy,
          "platform.brand.placement_too_late",
          "Ctrip Community must introduce the selected brand before the second half of the body",
          "payload.bodyMarkdown",
          [`firstIndex=${firstDisplayNameIndex}`, `bodyLength=${normalizedBodyForBrand.length}`],
        ),
      );
    }

    const normalizedBody = input.payload.bodyMarkdown.normalize("NFKC");
    const prohibitedContactSignals = [
      {
        detected:
          extractPhoneCandidates(normalizedBody).length > 0 ||
          includesContactValue(normalizedBody, input.contacts, "phone"),
        ruleId: "platform.contact.phone_forbidden",
        message: "Ctrip Community bodies must not contain phone numbers",
      },
      {
        detected:
          CTRIP_WECHAT_REFERENCE_PATTERN.test(normalizedBody) ||
          includesContactValue(normalizedBody, input.contacts, "wechat"),
        ruleId: "platform.contact.wechat_forbidden",
        message: "Ctrip Community bodies must not contain WeChat references or IDs",
      },
      {
        detected:
          EMAIL_PATTERN.test(normalizedBody) ||
          includesContactValue(normalizedBody, input.contacts, "email"),
        ruleId: "platform.contact.email_forbidden",
        message: "Ctrip Community bodies must not contain email addresses",
      },
      {
        detected:
          EXTERNAL_LINK_PATTERN.test(normalizedBody) ||
          includesContactValue(normalizedBody, input.contacts, "website"),
        ruleId: "platform.contact.external_link_forbidden",
        message: "Ctrip Community bodies must not contain external links or domains",
      },
      {
        detected: QR_CODE_PATTERN.test(normalizedBody),
        ruleId: "platform.contact.qr_code_forbidden",
        message: "Ctrip Community bodies must not contain QR-code contact routes",
      },
    ] as const;
    for (const signal of prohibitedContactSignals) {
      if (!signal.detected) continue;
      findings.push(
        makeFinding(input.policy, signal.ruleId, signal.message, "payload.bodyMarkdown"),
      );
    }

    const hardPromotion = normalizedText(content).match(CTRIP_HARD_PROMOTION_PATTERN)?.[0];
    if (hardPromotion !== undefined) {
      findings.push(
        makeFinding(
          input.policy,
          "platform.brand.hard_promotion",
          "Ctrip Community variants must use soft brand attribution instead of a hard-sell CTA",
          "payload",
          [hardPromotion],
        ),
      );
    }
  }
  const phoneCandidates = extractPhoneCandidates(content);
  const wechatCandidates = extractWechatCandidates(content);
  const approvedPhones = new Set(
    activeContacts
      .filter((contact) => contact.type === "phone")
      .map((contact) => normalizePhone(contact.value)),
  );
  const approvedWechat = new Set(
    activeContacts.filter((contact) => contact.type === "wechat").map((contact) => contact.value),
  );

  for (const contactId of input.payload.contactIds) {
    const contact = contactById.get(contactId);
    if (contact === undefined) {
      findings.push(
        makeFinding(
          input.policy,
          "contact.reference.unknown",
          "Referenced contact does not exist in the tenant snapshot",
          "payload.contactIds",
          [contactId],
        ),
      );
      continue;
    }
    if (!activeContactIds.has(contactId)) {
      findings.push(
        makeFinding(
          input.policy,
          "contact.reference.inactive",
          "Referenced contact is not active at audit time",
          "payload.contactIds",
          [contactId],
        ),
      );
      continue;
    }
    const present =
      contact.type === "phone"
        ? phoneCandidates.includes(normalizePhone(contact.value))
        : contact.type === "wechat"
          ? wechatCandidates.includes(contact.value)
          : content.includes(contact.value);
    if (!present) {
      findings.push(
        makeFinding(
          input.policy,
          "contact.reference.missing",
          "Referenced contact value is absent from the final platform variant",
          "payload.contactIds",
          [contactId, contact.type],
        ),
      );
    }
  }
  for (const candidate of phoneCandidates) {
    if (!approvedPhones.has(candidate)) {
      findings.push(
        makeFinding(
          input.policy,
          "contact.phone.unapproved",
          "Final platform variant contains an unapproved phone number",
          "payload.bodyMarkdown",
          ["candidate=redacted"],
        ),
      );
    }
  }
  for (const candidate of wechatCandidates) {
    if (!approvedWechat.has(candidate)) {
      findings.push(
        makeFinding(
          input.policy,
          "contact.wechat.unapproved",
          "Final platform variant contains an unapproved WeChat ID",
          "payload.bodyMarkdown",
          ["candidate=redacted"],
        ),
      );
    }
  }

  const sourceById = new Map<string, EvidenceSource>();
  for (const source of input.factSnapshot.sources) {
    invariant(
      !sourceById.has(source.id),
      "AUDIT_CONTEXT_DUPLICATE",
      "Duplicate evidence source ID",
      {
        sourceId: source.id,
      },
    );
    invariant(
      source.locator.trim().length > 0,
      "AUDIT_CONTEXT_INVALID",
      "Evidence locator is required",
      {
        sourceId: source.id,
      },
    );
    assertSha256(source.contentHash, `factSnapshot.sources.${source.id}.contentHash`);
    sourceById.set(source.id, source);
  }
  const factById = new Map<string, VerifiedFact>();
  for (const fact of input.factSnapshot.facts) {
    assertUuid(fact.id, "factSnapshot.facts.id");
    assertUuid(fact.brandId, `factSnapshot.facts.${fact.id}.brandId`);
    invariant(!factById.has(fact.id), "AUDIT_CONTEXT_DUPLICATE", "Duplicate fact ID", {
      factId: fact.id,
    });
    invariant(
      fact.text.trim().length > 0,
      "AUDIT_CONTEXT_INVALID",
      "Verified fact text is required",
      { factId: fact.id },
    );
    factById.set(fact.id, fact);
  }

  const rendered = renderCanonicalContent({
    payload: input.payload,
    policy: input.policy,
    factSnapshot: input.factSnapshot,
    contacts: input.contacts,
  });
  for (const issue of rendered.issues) {
    findings.push(
      makeFinding(input.policy, issue.ruleId, issue.message, issue.path, issue.evidence),
    );
  }
  const derivedFields = [
    {
      ruleId: "title.render_mismatch",
      message: "Title differs from canonical content rendering",
      path: "payload.title",
      actual: input.payload.title,
      expected: rendered.title,
    },
    {
      ruleId: "summary.render_mismatch",
      message: "Summary differs from canonical content rendering",
      path: "payload.summary",
      actual: input.payload.summary,
      expected: rendered.summary,
    },
    {
      ruleId: "body.render_mismatch",
      message: "Body differs from canonical content rendering",
      path: "payload.bodyMarkdown",
      actual: input.payload.bodyMarkdown,
      expected: rendered.bodyMarkdown,
    },
  ];
  for (const field of derivedFields) {
    if (field.expected !== null && field.actual !== field.expected) {
      findings.push(
        makeFinding(input.policy, field.ruleId, field.message, field.path, [
          `expectedHash=${sha256Canonical(field.expected)}`,
          `actualHash=${sha256Canonical(field.actual)}`,
        ]),
      );
    }
  }
  if (rendered.tags !== null && !sameStringArray(input.payload.tags, rendered.tags)) {
    findings.push(
      makeFinding(
        input.policy,
        "tags.render_mismatch",
        "Tags differ from canonical content rendering",
        "payload.tags",
        [
          `expectedHash=${sha256Canonical(rendered.tags)}`,
          `actualHash=${sha256Canonical(input.payload.tags)}`,
        ],
      ),
    );
  }
  const payloadClaimIds = input.payload.claims.map((claim) => claim.id);
  if (!sameStringSet(payloadClaimIds, rendered.claimIds)) {
    findings.push(
      makeFinding(
        input.policy,
        "content.claim.references_mismatch",
        "Claim metadata must exactly match canonical claim references",
        "payload.claims",
        [
          `metadata=${[...payloadClaimIds].sort().join(",")}`,
          `rendered=${[...rendered.claimIds].sort().join(",")}`,
        ],
      ),
    );
  }
  if (!sameStringSet(input.payload.contactIds, rendered.contactIds)) {
    findings.push(
      makeFinding(
        input.policy,
        "content.contact.references_mismatch",
        "Contact metadata must exactly match canonical contact references",
        "payload.contactIds",
        [
          `metadata=${[...input.payload.contactIds].sort().join(",")}`,
          `rendered=${[...rendered.contactIds].sort().join(",")}`,
        ],
      ),
    );
  }
  const submittedMediaSha256 = new Set(input.submittedMediaSha256 ?? []);
  for (const sha256 of submittedMediaSha256) {
    assertSha256(sha256, "submittedMediaSha256");
  }
  auditMediaReferences({
    payload: input.payload,
    platform: input.platform,
    policy: input.policy,
    submittedMediaSha256,
    factById,
    activeContacts,
    rendition: mediaRendition,
    now,
    findings,
  });
  if (input.payload.canonicalUrl !== undefined) {
    findings.push(
      makeFinding(
        input.policy,
        "content.canonical_url.unsupported",
        "Canonical content v1 does not support link provenance",
        "payload.canonicalUrl",
      ),
    );
  }

  if (input.payload.claims.length < input.policy.minClaims) {
    findings.push(
      makeFinding(
        input.policy,
        "evidence.claims.insufficient",
        "Final platform variant does not contain enough explicit claims",
        "payload.claims",
        [`required=${input.policy.minClaims}`, `actual=${input.payload.claims.length}`],
      ),
    );
  }
  for (const [claimIndex, claim] of input.payload.claims.entries()) {
    const claimPath = `payload.claims[${claimIndex}]`;
    const verifiedFact = factById.get(claim.id);
    if (verifiedFact === undefined) {
      findings.push(
        makeFinding(
          input.policy,
          "evidence.claim.unverified",
          "Claim is not bound to a verified tenant fact",
          `${claimPath}.id`,
          [claim.id],
        ),
      );
    } else {
      if (verifiedFact.brandId !== input.brandSnapshot.id) {
        findings.push(
          makeFinding(
            input.policy,
            "evidence.claim.brand_mismatch",
            "Verified fact belongs to a different brand",
            `${claimPath}.id`,
            [claim.id, verifiedFact.brandId, input.brandSnapshot.id],
          ),
        );
      }
      if (claim.text !== verifiedFact.text) {
        findings.push(
          makeFinding(
            input.policy,
            "evidence.claim.text_mismatch",
            "Claim text differs from the verified fact",
            `${claimPath}.text`,
            [claim.id],
          ),
        );
      }
      if (!sameStringSet(claim.evidenceSourceIds, verifiedFact.evidenceSourceIds)) {
        findings.push(
          makeFinding(
            input.policy,
            "evidence.claim.sources_mismatch",
            "Claim evidence differs from the verified fact",
            `${claimPath}.evidenceSourceIds`,
            [claim.id],
          ),
        );
      }
      const factValidFrom = parseInstant(
        verifiedFact.validFrom,
        `factSnapshot.facts.${claim.id}.validFrom`,
      );
      const factValidUntil =
        verifiedFact.validUntil === null
          ? null
          : parseInstant(verifiedFact.validUntil, `factSnapshot.facts.${claim.id}.validUntil`);
      const claimValidUntil =
        claim.validUntil === null
          ? null
          : parseInstant(claim.validUntil, `${claimPath}.validUntil`);
      if (factValidFrom > now || (factValidUntil !== null && factValidUntil <= now)) {
        findings.push(
          makeFinding(
            input.policy,
            "evidence.claim.fact_inactive",
            "Verified fact is not active at audit time",
            `${claimPath}.id`,
            [claim.id],
          ),
        );
      }
      if (claimValidUntil !== factValidUntil) {
        findings.push(
          makeFinding(
            input.policy,
            "evidence.claim.validity_mismatch",
            "Claim validity differs from the verified fact",
            `${claimPath}.validUntil`,
            [claim.id],
          ),
        );
      }
    }
    if (!normalizedClaimText(content).includes(normalizedClaimText(claim.text))) {
      findings.push(
        makeFinding(
          input.policy,
          "evidence.claim.not_in_content",
          "Verified claim text is absent from the final platform variant",
          `${claimPath}.text`,
          [claim.id],
        ),
      );
    }
    if (
      claim.validUntil !== null &&
      parseInstant(claim.validUntil, `${claimPath}.validUntil`) <= now
    ) {
      findings.push(
        makeFinding(
          input.policy,
          "evidence.claim.expired",
          "Claim expired before the audit completed",
          `${claimPath}.validUntil`,
          [claim.id],
        ),
      );
    }
    if (claim.evidenceSourceIds.length === 0) {
      findings.push(
        makeFinding(
          input.policy,
          "evidence.source.missing",
          "Claim has no evidence source",
          `${claimPath}.evidenceSourceIds`,
          [claim.id],
        ),
      );
    }
    for (const sourceId of new Set(claim.evidenceSourceIds)) {
      const source = sourceById.get(sourceId);
      if (source === undefined) {
        findings.push(
          makeFinding(
            input.policy,
            "evidence.source.unknown",
            "Claim references an unknown evidence source",
            `${claimPath}.evidenceSourceIds`,
            [claim.id, sourceId],
          ),
        );
        continue;
      }
      const observedAt = parseInstant(
        source.observedAt,
        `factSnapshot.sources.${sourceId}.observedAt`,
      );
      if (observedAt > now) {
        findings.push(
          makeFinding(
            input.policy,
            "evidence.source.future",
            "Evidence was observed after the audit time",
            `${claimPath}.evidenceSourceIds`,
            [claim.id, sourceId],
          ),
        );
      }
      if (now - observedAt > input.policy.maxEvidenceAgeMs) {
        findings.push(
          makeFinding(
            input.policy,
            "evidence.source.stale",
            "Evidence exceeds the policy freshness window",
            `${claimPath}.evidenceSourceIds`,
            [claim.id, sourceId],
          ),
        );
      }
      if (
        source.validUntil !== null &&
        parseInstant(source.validUntil, `factSnapshot.sources.${sourceId}.validUntil`) <= now
      ) {
        findings.push(
          makeFinding(
            input.policy,
            "evidence.source.expired",
            "Evidence expired before the audit completed",
            `${claimPath}.evidenceSourceIds`,
            [claim.id, sourceId],
          ),
        );
      }
    }
  }

  const privacyInspectionContent = [
    content,
    ...input.payload.media.flatMap((media) => [
      media.altText,
      media.caption,
      media.inspection?.ocrText ?? "",
    ]),
  ].join("\n");
  const privacyIdentifiers = privacyIdentifierMatches(privacyInspectionContent, now);
  if (privacyIdentifiers.length > 0) {
    findings.push(
      makeFinding(
        input.policy,
        "content.hard_block.privacy_disclosure",
        "Final platform variant contains a structured personal identifier",
        "payload",
        privacyIdentifiers,
      ),
    );
  }

  const titleLength = codePointLength(input.payload.title);
  const summaryLength = codePointLength(input.payload.summary);
  const bodyLength = codePointLength(input.payload.bodyMarkdown);
  const titleMaximum =
    input.platform === "ctrip_community"
      ? Math.min(limits.maxTitleCharacters, CTRIP_COMMUNITY_PUBLICATION_LIMITS.maxTitleCharacters)
      : limits.maxTitleCharacters;
  const bodyMaximum =
    input.platform === "ctrip_community"
      ? Math.min(limits.maxBodyCharacters, CTRIP_COMMUNITY_PUBLICATION_LIMITS.maxBodyCharacters)
      : limits.maxBodyCharacters;
  if (
    input.platform === "ctrip_community" &&
    titleLength < CTRIP_COMMUNITY_PUBLICATION_LIMITS.minTitleCharacters
  ) {
    findings.push(
      makeFinding(
        input.policy,
        "platform.title.too_short",
        "Title is shorter than the fixed Ctrip publication boundary",
        "payload.title",
        [`limit=${CTRIP_COMMUNITY_PUBLICATION_LIMITS.minTitleCharacters}`, `actual=${titleLength}`],
      ),
    );
  }
  if (
    input.platform === "ctrip_community" &&
    input.payload.media.filter((media) => media.role === "cover").length !== 1
  ) {
    findings.push(
      makeFinding(
        input.policy,
        "platform.media.cover_count_invalid",
        "Ctrip publication requires exactly one cover image",
        "payload.media",
        [
          "expected=1",
          `actual=${input.payload.media.filter((media) => media.role === "cover").length}`,
        ],
      ),
    );
  }
  if (titleLength > titleMaximum) {
    findings.push(
      makeFinding(
        input.policy,
        "platform.title.too_long",
        "Title exceeds the versioned platform policy",
        "payload.title",
        [`limit=${titleMaximum}`, `actual=${titleLength}`],
      ),
    );
  }
  if (summaryLength > limits.maxSummaryCharacters) {
    findings.push(
      makeFinding(
        input.policy,
        "platform.summary.too_long",
        "Summary exceeds the versioned platform policy",
        "payload.summary",
        [`limit=${limits.maxSummaryCharacters}`, `actual=${summaryLength}`],
      ),
    );
  }
  if (bodyLength < limits.minBodyCharacters) {
    findings.push(
      makeFinding(
        input.policy,
        "structure.body.too_short",
        "Body is shorter than the versioned quality floor",
        "payload.bodyMarkdown",
        [`limit=${limits.minBodyCharacters}`, `actual=${bodyLength}`],
      ),
    );
  }
  if (bodyLength > bodyMaximum) {
    findings.push(
      makeFinding(
        input.policy,
        "platform.body.too_long",
        "Body exceeds the versioned platform policy",
        "payload.bodyMarkdown",
        [`limit=${bodyMaximum}`, `actual=${bodyLength}`],
      ),
    );
  }
  if (
    input.platform === "ctrip_community" &&
    (input.payload.media.length < CTRIP_COMMUNITY_PUBLICATION_LIMITS.minImages ||
      input.payload.media.length > CTRIP_COMMUNITY_PUBLICATION_LIMITS.maxImages)
  ) {
    findings.push(
      makeFinding(
        input.policy,
        "platform.media.count_invalid",
        "Image count is outside the fixed Ctrip publication boundary",
        "payload.media",
        [
          `min=${CTRIP_COMMUNITY_PUBLICATION_LIMITS.minImages}`,
          `max=${CTRIP_COMMUNITY_PUBLICATION_LIMITS.maxImages}`,
          `actual=${input.payload.media.length}`,
        ],
      ),
    );
  }
  if (input.payload.tags.length > limits.maxTags) {
    findings.push(
      makeFinding(
        input.policy,
        "platform.tags.too_many",
        "Tag count exceeds the versioned platform policy",
        "payload.tags",
        [`limit=${limits.maxTags}`, `actual=${input.payload.tags.length}`],
      ),
    );
  }
  const headingCount = [...input.payload.bodyMarkdown.matchAll(/^#{2,3}\s+\S+/gm)].length;
  if (headingCount < limits.minHeadings) {
    findings.push(
      makeFinding(
        input.policy,
        "structure.headings.insufficient",
        "Body does not contain enough scannable sections",
        "payload.bodyMarkdown",
        [`required=${limits.minHeadings}`, `actual=${headingCount}`],
      ),
    );
  }

  const payloadHash = sha256Canonical(input.payload);
  const publicContentHash =
    input.platform === "ctrip_community"
      ? ctripPublicContentHashFromMarkdown(input.payload.title, input.payload.bodyMarkdown)
      : undefined;
  const normalizedBodyLength = codePointLength(normalizedDuplicateText(input.payload.bodyMarkdown));
  let closestDuplicate: { prior: PriorPublicationVariant; similarity: number } | undefined;
  for (const prior of input.priorVariants ?? []) {
    if (prior.variantId === input.variantId) {
      continue;
    }
    assertSha256(prior.payloadHash, `priorVariants.${prior.variantId}.payloadHash`);
    if (prior.publicContentHash !== undefined) {
      assertSha256(prior.publicContentHash, `priorVariants.${prior.variantId}.publicContentHash`);
    }
    if (
      prior.payloadHash === payloadHash ||
      (publicContentHash !== undefined && prior.publicContentHash === publicContentHash)
    ) {
      findings.push(
        makeFinding(
          input.policy,
          "duplicate.exact",
          "Final platform variant exactly duplicates an earlier payload",
          "payload",
          [prior.variantId, prior.platform],
        ),
      );
      closestDuplicate = undefined;
      break;
    }
    if (
      normalizedBodyLength < input.policy.minDuplicateCharacters ||
      codePointLength(normalizedDuplicateText(prior.bodyMarkdown)) <
        input.policy.minDuplicateCharacters
    ) {
      continue;
    }
    const similarity = duplicateSimilarity(input.payload.bodyMarkdown, prior.bodyMarkdown);
    if (closestDuplicate === undefined || similarity > closestDuplicate.similarity) {
      closestDuplicate = { prior, similarity };
    }
  }
  if (
    closestDuplicate !== undefined &&
    closestDuplicate.similarity >= input.policy.duplicateThreshold
  ) {
    findings.push(
      makeFinding(
        input.policy,
        "duplicate.near",
        "Final platform variant is too similar to an earlier publication",
        "payload.bodyMarkdown",
        [
          closestDuplicate.prior.variantId,
          closestDuplicate.prior.platform,
          `similarity=${closestDuplicate.similarity.toFixed(4)}`,
        ],
      ),
    );
  }

  sortFindings(findings);
  const status: AuditStatus = findings.some((finding) => finding.severity === "blocking")
    ? "failed"
    : "passed";
  return freezeDeep({
    payloadHash,
    factSnapshotHash: sha256Canonical(input.factSnapshot),
    brandSnapshotHash: sha256Canonical(input.brandSnapshot),
    mediaSnapshotHash: stableMediaHashForAudit(input.payload.media),
    policyHash:
      input.policy.effectiveHash ?? input.policy.sourceHash ?? sha256Canonical(input.policy),
    status,
    findings,
  });
}

function unsignedAuditArtifact(artifact: Omit<AuditArtifact, "auditHash">): unknown {
  return {
    schema: "geo.audit-artifact.v2",
    id: artifact.id,
    tenantId: artifact.tenantId,
    variantId: artifact.variantId,
    channelAccountId: artifact.channelAccountId,
    platform: artifact.platform,
    payloadHash: artifact.payloadHash,
    factSnapshotHash: artifact.factSnapshotHash,
    brandSnapshotHash: artifact.brandSnapshotHash,
    mediaSnapshotHash: artifact.mediaSnapshotHash,
    policyHash: artifact.policyHash,
    policyVersion: artifact.policyVersion,
    status: artifact.status,
    findings: artifact.findings,
    createdAt: artifact.createdAt,
    expiresAt: artifact.expiresAt,
  };
}

export function computeAuditHash(artifact: Omit<AuditArtifact, "auditHash">): string {
  return sha256Canonical(unsignedAuditArtifact(artifact));
}

export function verifyAuditArtifactIntegrity(artifact: Readonly<AuditArtifact>): boolean {
  try {
    assertSha256(artifact.auditHash, "auditHash");
    assertSha256(artifact.payloadHash, "payloadHash");
    assertSha256(artifact.factSnapshotHash, "factSnapshotHash");
    assertSha256(artifact.brandSnapshotHash, "brandSnapshotHash");
    assertSha256(artifact.mediaSnapshotHash, "mediaSnapshotHash");
    assertSha256(artifact.policyHash, "policyHash");
    const expectedStatus: AuditStatus = artifact.findings.some(
      (finding) => finding.severity === "blocking",
    )
      ? "failed"
      : "passed";
    return artifact.status === expectedStatus && computeAuditHash(artifact) === artifact.auditHash;
  } catch {
    return false;
  }
}

export function buildAuditArtifact(input: BuildAuditArtifactInput): Readonly<AuditArtifact> {
  assertUuid(input.artifactId, "artifactId");
  assertUuid(input.tenantId, "tenantId");
  assertUuid(input.variantId, "variantId");
  assertUuid(input.channelAccountId, "channelAccountId");
  const createdAt = parseInstant(input.createdAt, "createdAt");
  const expiresAt = parseInstant(input.expiresAt, "expiresAt");
  invariant(expiresAt > createdAt, "AUDIT_EXPIRY_INVALID", "Audit expiry must follow creation");
  invariant(
    input.evaluation.status ===
      (input.evaluation.findings.some((finding) => finding.severity === "blocking")
        ? "failed"
        : "passed"),
    "AUDIT_STATUS_INVALID",
    "Audit status does not match its findings",
  );

  const unsigned: Omit<AuditArtifact, "auditHash"> = {
    id: input.artifactId,
    tenantId: input.tenantId,
    variantId: input.variantId,
    channelAccountId: input.channelAccountId,
    platform: input.platform,
    payloadHash: input.evaluation.payloadHash,
    factSnapshotHash: input.evaluation.factSnapshotHash,
    brandSnapshotHash: input.evaluation.brandSnapshotHash,
    mediaSnapshotHash: input.evaluation.mediaSnapshotHash,
    policyHash: input.evaluation.policyHash,
    policyVersion: input.policyVersion,
    status: input.evaluation.status,
    findings: input.evaluation.findings.map((finding) => ({
      ...finding,
      evidence: [...finding.evidence],
    })),
    createdAt: input.createdAt,
    expiresAt: input.expiresAt,
  };
  return freezeDeep({ ...unsigned, auditHash: computeAuditHash(unsigned) });
}

export function auditPublicationVariant(
  input: AuditPublicationVariantInput,
): Readonly<AuditArtifact> {
  const evaluation = evaluatePublicationVariant(input);
  const createdAt = parseInstant(input.createdAt, "createdAt");
  return buildAuditArtifact({
    artifactId: input.artifactId,
    tenantId: input.tenantId,
    variantId: input.variantId,
    channelAccountId: input.channelAccountId,
    platform: input.platform,
    policyVersion: input.policy.version,
    evaluation,
    createdAt: input.createdAt,
    expiresAt: new Date(createdAt + input.policy.artifactTtlMs).toISOString(),
  });
}
