import type {
  EditorialProfile,
  MediaReference,
  MediaRole,
  Platform,
  VisualBrief,
} from "@geo/contracts";

import type { VerifiedFact } from "./audit.js";
import { sha256Canonical } from "./canonical.js";
import { invariant } from "./errors.js";
import { freezeDeep } from "./validation.js";

export interface BuildVisualBriefInput {
  readonly editorialProfile: EditorialProfile;
  readonly platform: Platform;
  readonly role: MediaRole;
  readonly facts: readonly VerifiedFact[];
}

const PLATFORM_ASPECT_RATIOS: Readonly<Record<Platform, VisualBrief["aspectRatio"]>> = {
  toutiao: "16:9",
  sohu: "16:9",
  ctrip_community: "4:3",
};

const PLATFORM_LABELS: Readonly<Record<Platform, string>> = {
  toutiao: "今日头条",
  sohu: "搜狐",
  ctrip_community: "携程社区",
};

const PROFILE_LABELS: Readonly<Record<EditorialProfile, string>> = {
  guide: "核验指南",
  question_answer: "核验问答",
  comparison: "核验对比",
  risk_avoidance: "风险提示",
  local_service: "本地服务",
};

const ROLE_LABELS: Readonly<Record<MediaRole, string>> = {
  cover: "封面",
  inline: "正文配图",
};

const PROFILES = Object.keys(PROFILE_LABELS) as EditorialProfile[];
const PLATFORMS = Object.keys(PLATFORM_LABELS) as Platform[];
const ROLES = Object.keys(ROLE_LABELS) as MediaRole[];

const CONTACT_MARKER = "联系方式不在图片中呈现";
const SENSITIVE_MARKER = "敏感文本不在图片中呈现";
const NEGATIVE_PROMPT = "文字、水印、二维码、电话号码、微信号、价格、证件、夸张承诺、虚构人物背书";
const SAFETY_DIRECTIVE =
  "不得虚构地点、人物、日期、价格、资质、品牌标识、联系方式或保证性承诺；图片像素中不得呈现联系方式文字";

const EMAIL_PATTERN = /[\p{L}\p{N}.!#$%&'*+/=?^_`{|}~-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/giu;
const URL_PATTERN =
  /(?:[a-z][a-z0-9+.-]*:\/\/|www\.)[^\s，。；]+|(?<![@\p{L}\p{N}])(?:[\p{L}\p{N}-]+\.)+[a-z]{2,63}(?:\/[^\s，。；]*)?/giu;
const CREDENTIAL_PATTERN =
  /(?:许可证|营业执照|资质证书|证件|统一社会信用代码|credential|licen[cs]e)(?:号|号码|编号|number)?\s*[:：]?\s*[A-Za-z\p{N}][A-Za-z\p{N}_.-]{2,}/giu;
const LABELED_CONTACT_HANDLE_PATTERN =
  /(?:微信(?:咨询|号)?|微\s*信|wechat|weixin|whatsapp|telegram|line|(?:wx|vx|qq)(?:号)?|客服账号|联系账号|社交账号|contact)\s*[:：]?\s*[A-Za-z][A-Za-z0-9_.-]{2,31}/giu;
const PHONE_LIKE_PATTERN =
  /[+＋]?(?:[（(]?\p{N}{1,4}[）)]?)(?:[\s.．·/／\-‐‑‒–—―]*[（(]?\p{N}{2,4}[）)]?){2,}/gu;
const PRICE_PATTERN =
  /(?:(?:[A-Z]{3}|人民币|美元|欧元|英镑|日元|港币|\p{Sc})\s*[\p{N}\s,，.．]+|[\p{N}\s,，.．]+\s*(?:[A-Z]{3}|元|人民币|美元|欧元|英镑|日元|港币)(?:起)?)/giu;
const CURRENCY_PATTERN =
  /(?<![A-Za-z])(?:USD|CNY|RMB|EUR|GBP|JPY|HKD)(?![A-Za-z])|人民币|美元|欧元|英镑|日元|港币|\p{Sc}/giu;
const GUARANTEE_PATTERN =
  /(?:\p{N}+\s*[%％]|百分(?:之)?百|承诺|保证(?:办理|通过|成功|签证|结果)?|确保(?:办理|通过|成功|结果)?|担保|保过|包过|必过|稳过|零风险|无风险|一定(?:通过|成功|有效)|绝对(?:保证|成功)|肯定(?:通过|成功))/giu;
const AT_HANDLE_PATTERN = /(?<![\p{L}\p{N}])@[A-Za-z][A-Za-z0-9_.-]{2,31}/gu;
const MIXED_HANDLE_PATTERN =
  /(?<![A-Za-z0-9_.-])(?=[A-Za-z0-9_.-]{6,32}(?![A-Za-z0-9_.-]))(?=[A-Za-z0-9_.-]*[A-Za-z])(?=[A-Za-z0-9_.-]*[0-9])[A-Za-z][A-Za-z0-9_.-]+/gu;
const UNDERSCORE_HANDLE_PATTERN =
  /(?<![A-Za-z0-9_])[A-Za-z][A-Za-z0-9]{1,15}_[A-Za-z0-9_]{2,31}(?![A-Za-z0-9_])/gu;
const QR_PATTERN = /(?:二维码|QR\s*码?)/giu;
const PHONE_PUNCTUATION_PATTERN = /[+＋()（）.．·/／\\\-‐‑‒–—―]{3,}/gu;

function sameOrderedValues(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function clipCodePoints(value: string, maxCodePoints: number): string {
  return [...value].slice(0, maxCodePoints).join("");
}

function clipWithSuffix(value: string, suffix: string, maxCodePoints: number): string {
  const suffixLength = [...suffix].length;
  return `${clipCodePoints(value, maxCodePoints - suffixLength)}${suffix}`;
}

function sanitizeFactText(value: string): string {
  return value
    .trim()
    .normalize("NFKC")
    .replace(EMAIL_PATTERN, CONTACT_MARKER)
    .replace(URL_PATTERN, CONTACT_MARKER)
    .replace(CREDENTIAL_PATTERN, SENSITIVE_MARKER)
    .replace(LABELED_CONTACT_HANDLE_PATTERN, CONTACT_MARKER)
    .replace(PHONE_LIKE_PATTERN, CONTACT_MARKER)
    .replace(PRICE_PATTERN, SENSITIVE_MARKER)
    .replace(CURRENCY_PATTERN, SENSITIVE_MARKER)
    .replace(GUARANTEE_PATTERN, SENSITIVE_MARKER)
    .replace(AT_HANDLE_PATTERN, CONTACT_MARKER)
    .replace(MIXED_HANDLE_PATTERN, CONTACT_MARKER)
    .replace(UNDERSCORE_HANDLE_PATTERN, CONTACT_MARKER)
    .replace(QR_PATTERN, SENSITIVE_MARKER)
    .replace(/\p{N}+/gu, SENSITIVE_MARKER)
    .replace(CURRENCY_PATTERN, SENSITIVE_MARKER)
    .replace(PHONE_PUNCTUATION_PATTERN, " ")
    .replace(/\s+/gu, " ");
}

function validateInput(input: BuildVisualBriefInput): void {
  invariant(
    Object.hasOwn(PROFILE_LABELS, input.editorialProfile),
    "VISUAL_BRIEF_PROFILE_INVALID",
    "Visual brief editorial profile is unsupported",
  );
  invariant(
    Object.hasOwn(PLATFORM_ASPECT_RATIOS, input.platform),
    "VISUAL_BRIEF_PLATFORM_INVALID",
    "Visual brief platform is unsupported",
  );
  invariant(
    Object.hasOwn(ROLE_LABELS, input.role),
    "VISUAL_BRIEF_ROLE_INVALID",
    "Visual brief role is unsupported",
  );
  invariant(
    input.facts.length >= 1 && input.facts.length <= 3,
    "VISUAL_BRIEF_FACT_COUNT_INVALID",
    "Visual brief requires between one and three facts",
    { factCount: input.facts.length },
  );
  invariant(
    new Set(input.facts.map((fact) => fact.id)).size === input.facts.length,
    "VISUAL_BRIEF_FACT_DUPLICATE",
    "Visual brief facts must be unique",
  );
  invariant(
    new Set(input.facts.map((fact) => fact.brandId)).size === 1,
    "VISUAL_BRIEF_BRAND_MISMATCH",
    "Visual brief facts must belong to one brand",
  );
  for (const fact of input.facts) {
    invariant(
      fact.text.trim().length > 0,
      "VISUAL_BRIEF_FACT_TEXT_INVALID",
      "Visual brief fact text must contain usable text",
      { factId: fact.id },
    );
  }
}

export function buildVisualBrief(input: BuildVisualBriefInput): Readonly<VisualBrief> {
  validateInput(input);
  const platformLabel = PLATFORM_LABELS[input.platform];
  const profileLabel = PROFILE_LABELS[input.editorialProfile];
  const roleLabel = ROLE_LABELS[input.role];
  const factText = input.facts.map((fact) => sanitizeFactText(fact.text)).join("；");
  const contactSuffix = `；${CONTACT_MARKER}`;
  const promptSuffix = `；${CONTACT_MARKER}；${SAFETY_DIRECTIVE}`;
  const prompt = clipWithSuffix(
    `为${platformLabel}生成${roleLabel}，采用${profileLabel}表达。仅依据以下已核验事实构图：${factText}`,
    promptSuffix,
    10_000,
  );
  const altText = clipWithSuffix(
    `${platformLabel}${roleLabel}，${profileLabel}：${factText}`,
    contactSuffix,
    500,
  );
  const caption = clipWithSuffix(
    `${profileLabel}${roleLabel}，画面仅表达已核验事实：${factText}`,
    contactSuffix,
    500,
  );

  const brief: VisualBrief = {
    schemaVersion: "geo.visual-brief.v1",
    editorialProfile: input.editorialProfile,
    platform: input.platform,
    role: input.role,
    aspectRatio: PLATFORM_ASPECT_RATIOS[input.platform],
    factIds: input.facts.map((fact) => fact.id),
    prompt,
    negativePrompt: NEGATIVE_PROMPT,
    altText,
    caption,
  };
  return freezeDeep(brief);
}

const RENDERED_FIELDS = ["aspectRatio", "prompt", "negativePrompt", "altText", "caption"] as const;

function sameRenderedBrief(left: VisualBrief, right: VisualBrief): boolean {
  return (
    sameOrderedValues(left.factIds, right.factIds) &&
    RENDERED_FIELDS.every((field) => left[field] === right[field])
  );
}

export function verifyVisualBrief(input: {
  readonly brief: VisualBrief;
  readonly facts: readonly VerifiedFact[];
}): readonly string[] {
  const issues: string[] = [];
  const addIssue = (issue: string): void => {
    if (!issues.includes(issue)) {
      issues.push(issue);
    }
  };
  const briefIds = input.brief.factIds;
  const factIds = input.facts.map((fact) => fact.id);
  const briefIdSet = new Set(briefIds);
  const factIdSet = new Set(factIds);

  if (briefIdSet.size !== briefIds.length || factIdSet.size !== factIds.length) {
    addIssue("visual_brief.fact_duplicate");
  }
  if (briefIds.some((id) => !factIdSet.has(id))) {
    addIssue("visual_brief.fact_unknown");
  }
  if (factIds.some((id) => !briefIdSet.has(id))) {
    addIssue("visual_brief.fact_missing");
  }
  if (
    briefIdSet.size === factIdSet.size &&
    [...briefIdSet].every((id) => factIdSet.has(id)) &&
    !sameOrderedValues(briefIds, factIds)
  ) {
    addIssue("visual_brief.fact_order_changed");
  }
  if (input.brief.schemaVersion !== "geo.visual-brief.v1") {
    addIssue("visual_brief.schema_version_changed");
  }

  const factsMatch = issues.every(
    (issue) =>
      issue !== "visual_brief.fact_duplicate" &&
      issue !== "visual_brief.fact_unknown" &&
      issue !== "visual_brief.fact_missing" &&
      issue !== "visual_brief.fact_order_changed",
  );
  if (!factsMatch) {
    return Object.freeze(issues);
  }

  let matchingCandidate: VisualBrief | undefined;
  for (const editorialProfile of PROFILES) {
    for (const platform of PLATFORMS) {
      for (const role of ROLES) {
        const candidate = buildVisualBrief({
          editorialProfile,
          platform,
          role,
          facts: input.facts,
        });
        if (sameRenderedBrief(candidate, input.brief)) {
          matchingCandidate = candidate;
        }
      }
    }
  }

  if (matchingCandidate !== undefined) {
    if (matchingCandidate.editorialProfile !== input.brief.editorialProfile) {
      addIssue("visual_brief.editorial_profile_changed");
    }
    if (matchingCandidate.platform !== input.brief.platform) {
      addIssue("visual_brief.platform_changed");
    }
    if (matchingCandidate.role !== input.brief.role) {
      addIssue("visual_brief.role_changed");
    }
    return Object.freeze(issues);
  }

  const expected = buildVisualBrief({
    editorialProfile: input.brief.editorialProfile,
    platform: input.brief.platform,
    role: input.brief.role,
    facts: input.facts,
  });
  if (input.brief.aspectRatio !== expected.aspectRatio) {
    addIssue("visual_brief.aspect_ratio_changed");
  }
  if (input.brief.prompt !== expected.prompt) {
    addIssue("visual_brief.prompt_tampered");
  }
  if (input.brief.negativePrompt !== expected.negativePrompt) {
    addIssue("visual_brief.negative_prompt_tampered");
  }
  if (input.brief.altText !== expected.altText) {
    addIssue("visual_brief.alt_text_tampered");
  }
  if (input.brief.caption !== expected.caption) {
    addIssue("visual_brief.caption_tampered");
  }
  return Object.freeze(issues);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function mediaSnapshotHash(media: readonly MediaReference[]): string {
  const mediaIds = new Set<string>();
  for (const item of media) {
    invariant(
      !mediaIds.has(item.id),
      "MEDIA_SNAPSHOT_DUPLICATE_ID",
      "Media snapshot contains a duplicate media ID",
      { mediaId: item.id },
    );
    mediaIds.add(item.id);
  }
  const roleOrder: Readonly<Record<MediaRole, number>> = { cover: 0, inline: 1 };
  const sorted = [...media].sort(
    (left, right) =>
      compareText(left.platform, right.platform) ||
      roleOrder[left.role] - roleOrder[right.role] ||
      compareText(left.id, right.id),
  );
  return sha256Canonical(sorted);
}
