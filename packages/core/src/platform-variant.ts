import type {
  CanonicalBodyBlock,
  EditorialProfile,
  MediaReference,
  Platform,
  PublicationVariantPayload,
  TenantContact,
} from "@geo/contracts";
import { mediaReferenceSchema } from "@geo/contracts";

import type {
  AuditPolicy,
  EditorialPlatformBodySlot,
  EditorialPlatformProfilePolicy,
  EditorialSourceProfilePolicy,
  FactSnapshot,
  PlatformEditorialStylePolicy,
} from "./audit.js";
import { sha256Canonical } from "./canonical.js";
import { renderCanonicalContent } from "./content-renderer.js";
import { editorialProfilePolicy, editorialSourceBodyBlocks } from "./editorial-profile.js";
import { invariant } from "./errors.js";
import { freezeDeep } from "./validation.js";

export interface RenderPlatformPublicationVariantInput {
  readonly sourcePayload: PublicationVariantPayload;
  readonly platform: Platform;
  readonly policy: AuditPolicy;
  readonly factSnapshot: FactSnapshot;
  readonly contacts: readonly TenantContact[];
}

function sameArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameUniqueSet(left: readonly string[], right: readonly string[]): boolean {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return (
    leftSet.size === left.length &&
    rightSet.size === right.length &&
    leftSet.size === rightSet.size &&
    [...leftSet].every((value) => rightSet.has(value))
  );
}

function validateCanonicalSource(input: RenderPlatformPublicationVariantInput): Readonly<{
  editorialProfile: EditorialProfile;
  media: readonly MediaReference[];
}> {
  invariant(
    input.sourcePayload.editorialProfile !== undefined,
    "PLATFORM_VARIANT_SOURCE_INVALID",
    "Platform variants require an explicit editorial profile",
  );
  const sourceProfile = editorialProfilePolicy(
    input.policy,
    input.sourcePayload.editorialProfile,
  ).source;
  const rendered = renderCanonicalContent({
    payload: input.sourcePayload,
    policy: input.policy,
    factSnapshot: input.factSnapshot,
    contacts: input.contacts,
  });
  invariant(
    rendered.issues.length === 0 &&
      rendered.title === input.sourcePayload.title &&
      rendered.summary === input.sourcePayload.summary &&
      rendered.bodyMarkdown === input.sourcePayload.bodyMarkdown &&
      rendered.tags !== null &&
      sameArray(rendered.tags, input.sourcePayload.tags),
    "PLATFORM_VARIANT_SOURCE_INVALID",
    "Platform variants require an exact canonical source payload",
    { issues: rendered.issues.map((issue) => issue.ruleId) },
  );
  invariant(
    sameUniqueSet(
      input.sourcePayload.claims.map((claim) => claim.id),
      rendered.claimIds,
    ),
    "PLATFORM_VARIANT_SOURCE_INVALID",
    "Canonical source claim metadata does not match rendered references",
  );
  invariant(
    sameUniqueSet(input.sourcePayload.contactIds, rendered.contactIds),
    "PLATFORM_VARIANT_SOURCE_INVALID",
    "Canonical source contact metadata does not match rendered references",
  );
  invariant(
    input.sourcePayload.canonicalUrl === undefined,
    "PLATFORM_VARIANT_SOURCE_INVALID",
    "Platform variants do not support canonical link provenance",
  );
  const media = input.sourcePayload.media.map((reference, index) => {
    const parsed = mediaReferenceSchema.safeParse(reference);
    invariant(
      parsed.success,
      "PLATFORM_VARIANT_SOURCE_INVALID",
      "Platform variants require strict immutable media references",
      {
        index,
        issues: parsed.success
          ? []
          : parsed.error.issues.map((issue) => ({
              path: issue.path.map(String).join("."),
              message: issue.message,
            })),
      },
    );
    return parsed.data;
  });
  invariant(
    input.sourcePayload.titleBlocks !== undefined &&
      input.sourcePayload.summaryBlocks !== undefined &&
      input.sourcePayload.bodyBlocks !== undefined &&
      input.sourcePayload.tagTemplateIds !== undefined,
    "PLATFORM_VARIANT_SOURCE_INVALID",
    "Editorial source references are required",
  );
  const expectedTitleBlocks = [
    { type: "template" as const, templateId: sourceProfile.titleTemplateId },
  ];
  const expectedSummaryBlocks = [
    { type: "template" as const, templateId: sourceProfile.summaryTemplateId },
  ];
  const expectedBodyBlocks = editorialSourceBodyBlocks(
    sourceProfile,
    input.sourcePayload.claims.map((claim) => claim.id),
    input.sourcePayload.contactIds,
  );
  invariant(
    sha256Canonical(input.sourcePayload.titleBlocks) === sha256Canonical(expectedTitleBlocks) &&
      sha256Canonical(input.sourcePayload.summaryBlocks) ===
        sha256Canonical(expectedSummaryBlocks) &&
      sha256Canonical(input.sourcePayload.bodyBlocks) === sha256Canonical(expectedBodyBlocks) &&
      sameArray(input.sourcePayload.tagTemplateIds, sourceProfile.tagTemplateIds),
    "PLATFORM_VARIANT_SOURCE_INVALID",
    "Canonical source references do not match the declared editorial profile",
    { profile: input.sourcePayload.editorialProfile },
  );
  return { editorialProfile: input.sourcePayload.editorialProfile, media };
}

function bodyBlocks(
  sourceProfile: EditorialSourceProfilePolicy,
  platformProfile: EditorialPlatformProfilePolicy,
  platformStyle: PlatformEditorialStylePolicy,
  source: PublicationVariantPayload,
): CanonicalBodyBlock[] {
  const claims = source.claims.map(
    (claim) =>
      ({
        type: "claim",
        claimId: claim.id,
        presentation: platformProfile.claimPresentation,
      }) as const,
  );
  const contacts = source.contactIds.map(
    (contactId) =>
      ({
        type: "contact",
        contactId,
        presentation: platformProfile.contactPresentation,
      }) as const,
  );

  const slots: Readonly<Record<EditorialPlatformBodySlot, readonly CanonicalBodyBlock[]>> = {
    platform_opening: [{ type: "template", templateId: platformStyle.bodyTemplateIds.opening }],
    profile_opening: [{ type: "template", templateId: sourceProfile.bodyTemplateIds.opening }],
    claims,
    profile_details: [{ type: "template", templateId: sourceProfile.bodyTemplateIds.details }],
    platform_scope: [{ type: "template", templateId: platformStyle.bodyTemplateIds.scope }],
    profile_action: [{ type: "template", templateId: sourceProfile.bodyTemplateIds.action }],
    platform_contact: [{ type: "template", templateId: platformStyle.bodyTemplateIds.contact }],
    contacts,
    profile_closing: [{ type: "template", templateId: sourceProfile.bodyTemplateIds.closing }],
    platform_disclosure: [
      { type: "template", templateId: platformStyle.bodyTemplateIds.disclosure },
    ],
  };
  return platformProfile.bodyOrder.flatMap((slot) => slots[slot]);
}

export function renderPlatformPublicationVariant(
  input: RenderPlatformPublicationVariantInput,
): Readonly<PublicationVariantPayload> {
  const validatedSource = validateCanonicalSource(input);
  const editorialProfile = validatedSource.editorialProfile;
  const profile = editorialProfilePolicy(input.policy, editorialProfile);
  const platformProfile = profile.platforms[input.platform];
  const platformStyle = input.policy.platformEditorialStyles?.[input.platform];
  invariant(
    platformStyle !== undefined,
    "PLATFORM_VARIANT_PROFILE_INVALID",
    "Active policy does not define the selected platform editorial style",
    { platform: input.platform },
  );
  const candidate: PublicationVariantPayload = {
    editorialProfile,
    ...(input.sourcePayload.articleTemplateId === undefined
      ? {}
      : { articleTemplateId: input.sourcePayload.articleTemplateId }),
    ...(input.sourcePayload.brandAgentProfile === undefined
      ? {}
      : { brandAgentProfile: { ...input.sourcePayload.brandAgentProfile } }),
    title: "placeholder",
    summary: "placeholder",
    bodyMarkdown: "placeholder",
    titleBlocks: [{ type: "template", templateId: platformProfile.titleTemplateId }],
    summaryBlocks: [{ type: "template", templateId: platformProfile.summaryTemplateId }],
    bodyBlocks: bodyBlocks(profile.source, platformProfile, platformStyle, input.sourcePayload),
    tagTemplateIds: [...platformStyle.tagTemplateIds, ...profile.source.tagTemplateIds],
    media: validatedSource.media.filter((item) => item.platform === input.platform),
    claims: input.sourcePayload.claims.map((claim) => ({
      ...claim,
      evidenceSourceIds: [...claim.evidenceSourceIds],
    })),
    contactIds: [...input.sourcePayload.contactIds],
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
    "PLATFORM_VARIANT_PROFILE_INVALID",
    "Active policy cannot render the selected platform profile",
    { platform: input.platform, issues: rendered.issues.map((issue) => issue.ruleId) },
  );
  return freezeDeep({
    ...candidate,
    title: rendered.title,
    summary: rendered.summary,
    bodyMarkdown: rendered.bodyMarkdown,
    tags: [...rendered.tags],
  });
}
