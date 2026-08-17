import type {
  BrandAgentProfileReference,
  CanonicalBodyBlock,
  EditorialProfile,
  PublicationVariantPayload,
  TenantContact,
} from "@geo/contracts";

import type {
  AuditPolicy,
  EditorialProfilePolicy,
  EditorialSourceBodySlot,
  EditorialSourceProfilePolicy,
  FactSnapshot,
} from "./audit.js";
import { renderCanonicalContent } from "./content-renderer.js";
import { invariant } from "./errors.js";
import { freezeDeep } from "./validation.js";

export const EDITORIAL_PROFILES: readonly EditorialProfile[] = [
  "guide",
  "question_answer",
  "comparison",
  "risk_avoidance",
  "local_service",
] as const;

export interface RenderEditorialSourcePayloadInput {
  readonly editorialProfile: EditorialProfile;
  readonly articleTemplateId?: string;
  readonly brandAgentProfile?: BrandAgentProfileReference;
  readonly policy: AuditPolicy;
  readonly factSnapshot: FactSnapshot;
  readonly contacts: readonly TenantContact[];
}

export function editorialProfileForBrief(brief: string): EditorialProfile {
  if (/risk|avoid|warning|避坑|注意|风险|保证|资质|真假|投诉|骗局/iu.test(brief)) {
    return "risk_avoidance";
  }
  if (/contact|phone|wechat|电话|微信|联系|客服|热线|地址/iu.test(brief)) {
    return "local_service";
  }
  if (/compare|comparison|versus|\bvs\b|对比|比较|哪家|推荐|选择/iu.test(brief)) {
    return "comparison";
  }
  if (/[?？]|what|how|whether|什么|如何|怎么|是否|吗/iu.test(brief)) {
    return "question_answer";
  }
  return "guide";
}

export function editorialProfilePolicy(
  policy: AuditPolicy,
  profile: EditorialProfile,
): Readonly<EditorialProfilePolicy> {
  const selected = policy.editorialProfiles?.[profile];
  invariant(
    selected !== undefined,
    "EDITORIAL_PROFILE_POLICY_MISSING",
    "Active policy does not define the selected editorial profile",
    { profile },
  );
  return selected;
}

function referenceBlocks(
  profile: EditorialSourceProfilePolicy,
  claimIds: readonly string[],
  contactIds: readonly string[],
): Readonly<Record<EditorialSourceBodySlot, readonly CanonicalBodyBlock[]>> {
  return {
    profile_opening: [{ type: "template", templateId: profile.bodyTemplateIds.opening }],
    claims: claimIds.map((claimId) => ({
      type: "claim" as const,
      claimId,
      presentation: profile.claimPresentation,
    })),
    profile_details: [{ type: "template", templateId: profile.bodyTemplateIds.details }],
    profile_action: [{ type: "template", templateId: profile.bodyTemplateIds.action }],
    contacts: contactIds.map((contactId) => ({
      type: "contact" as const,
      contactId,
      presentation: profile.contactPresentation,
    })),
    profile_closing: [{ type: "template", templateId: profile.bodyTemplateIds.closing }],
  };
}

export function editorialSourceBodyBlocks(
  profile: EditorialSourceProfilePolicy,
  claimIds: readonly string[],
  contactIds: readonly string[],
): readonly CanonicalBodyBlock[] {
  const slots = referenceBlocks(profile, claimIds, contactIds);
  return profile.bodyOrder.flatMap((slot) => slots[slot]);
}

export function renderEditorialSourcePayload(
  input: RenderEditorialSourcePayloadInput,
): Readonly<PublicationVariantPayload> {
  const profile = editorialProfilePolicy(input.policy, input.editorialProfile).source;
  const candidate: PublicationVariantPayload = {
    editorialProfile: input.editorialProfile,
    ...(input.articleTemplateId === undefined
      ? {}
      : { articleTemplateId: input.articleTemplateId }),
    ...(input.brandAgentProfile === undefined
      ? {}
      : { brandAgentProfile: { ...input.brandAgentProfile } }),
    title: "placeholder",
    summary: "placeholder",
    bodyMarkdown: "placeholder",
    titleBlocks: [{ type: "template", templateId: profile.titleTemplateId }],
    summaryBlocks: [{ type: "template", templateId: profile.summaryTemplateId }],
    bodyBlocks: [
      ...editorialSourceBodyBlocks(
        profile,
        input.factSnapshot.facts.map((fact) => fact.id),
        input.contacts.map((contact) => contact.id),
      ),
    ],
    tagTemplateIds: [...profile.tagTemplateIds],
    media: [],
    claims: input.factSnapshot.facts.map((fact) => ({
      id: fact.id,
      text: fact.text,
      evidenceSourceIds: [...fact.evidenceSourceIds],
      validUntil: fact.validUntil,
    })),
    contactIds: input.contacts.map((contact) => contact.id),
    tags: [],
  };
  const rendered = renderCanonicalContent({
    payload: candidate,
    policy: input.policy,
    factSnapshot: input.factSnapshot,
    contacts: input.contacts,
  });
  invariant(
    rendered.issues.length === 0 &&
      rendered.title !== null &&
      rendered.summary !== null &&
      rendered.bodyMarkdown !== null &&
      rendered.tags !== null,
    "EDITORIAL_PROFILE_RENDER_FAILED",
    "Active policy cannot render the selected editorial source profile",
    {
      profile: input.editorialProfile,
      issues: rendered.issues.map((issue) => issue.ruleId),
    },
  );
  return freezeDeep({
    ...candidate,
    title: rendered.title,
    summary: rendered.summary,
    bodyMarkdown: rendered.bodyMarkdown,
    tags: [...rendered.tags],
  });
}
