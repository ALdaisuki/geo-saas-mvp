import type {
  CanonicalBodyBlock,
  CanonicalInlineBlock,
  PublicationVariantPayload,
  TenantContact,
} from "@geo/contracts";

import type { AuditPolicy, FactSnapshot, VerifiedFact } from "./audit.js";
import { freezeDeep } from "./validation.js";

export interface CanonicalContentIssue {
  readonly ruleId: string;
  readonly message: string;
  readonly path: string;
  readonly evidence: readonly string[];
}

export interface RenderCanonicalContentInput {
  readonly payload: PublicationVariantPayload;
  readonly policy: AuditPolicy;
  readonly factSnapshot: FactSnapshot;
  readonly contacts: readonly TenantContact[];
}

export interface RenderedCanonicalContent {
  readonly title: string | null;
  readonly summary: string | null;
  readonly bodyMarkdown: string | null;
  readonly tags: readonly string[] | null;
  readonly claimIds: readonly string[];
  readonly contactIds: readonly string[];
  readonly issues: readonly CanonicalContentIssue[];
}

type TemplateCategory = keyof AuditPolicy["contentTemplates"];

function presented(value: string, presentation: "paragraph" | "bullet"): string {
  return presentation === "paragraph" ? value : `- ${value.replaceAll("\n", "\n  ")}`;
}

export function renderCanonicalContent(
  input: RenderCanonicalContentInput,
): Readonly<RenderedCanonicalContent> {
  const issues: CanonicalContentIssue[] = [];
  const claimIds: string[] = [];
  const contactIds: string[] = [];
  const facts = new Map<string, VerifiedFact>();
  const contacts = new Map<string, TenantContact>();
  const seen = new Map<string, string>();

  for (const fact of input.factSnapshot.facts) {
    if (!facts.has(fact.id)) facts.set(fact.id, fact);
  }
  for (const contact of input.contacts) {
    if (!contacts.has(contact.id)) contacts.set(contact.id, contact);
  }

  const duplicate = (
    kind: "template" | "claim" | "contact",
    id: string,
    path: string,
    scope = "global",
  ) => {
    const key = `${kind}:${scope}:${id}`;
    const firstPath = seen.get(key);
    if (firstPath === undefined) {
      seen.set(key, path);
      return;
    }
    issues.push({
      ruleId: "content.reference.duplicate",
      message: `Canonical content repeats a ${kind} reference`,
      path,
      evidence: [id, firstPath],
    });
  };

  const template = (category: TemplateCategory, templateId: string, path: string): string => {
    duplicate("template", templateId, path, category);
    const value = input.policy.contentTemplates[category][templateId];
    if (value === undefined) {
      issues.push({
        ruleId: "content.template.unknown",
        message: "Canonical content references a template outside the active policy",
        path,
        evidence: [category, templateId],
      });
      return "";
    }
    return value;
  };

  const claim = (claimId: string, path: string): string => {
    duplicate("claim", claimId, path);
    claimIds.push(claimId);
    const fact = facts.get(claimId);
    if (fact === undefined) {
      issues.push({
        ruleId: "content.claim.unknown",
        message: "Canonical content references a claim outside the verified fact snapshot",
        path,
        evidence: [claimId],
      });
      return "";
    }
    return fact.text;
  };

  const contact = (contactId: string, path: string): string => {
    duplicate("contact", contactId, path);
    contactIds.push(contactId);
    const value = contacts.get(contactId);
    if (value === undefined) {
      issues.push({
        ruleId: "content.contact.unknown",
        message: "Canonical content references a contact outside the tenant snapshot",
        path,
        evidence: [contactId],
      });
      return "";
    }
    return `${value.label}: ${value.value}`;
  };

  const renderInline = (
    blocks: readonly CanonicalInlineBlock[] | undefined,
    category: "title" | "summary",
  ): string | null => {
    if (blocks === undefined) return null;
    return blocks
      .map((block, index) => {
        const basePath = `payload.${category}Blocks[${index}]`;
        if (block.type === "template") {
          return template(category, block.templateId, `${basePath}.templateId`);
        }
        if (block.type === "claim") return claim(block.claimId, `${basePath}.claimId`);
        return contact(block.contactId, `${basePath}.contactId`);
      })
      .filter((value) => value.length > 0)
      .join(" ");
  };

  const renderBody = (blocks: readonly CanonicalBodyBlock[] | undefined): string | null => {
    if (blocks === undefined) return null;
    return blocks
      .map((block, index) => {
        const basePath = `payload.bodyBlocks[${index}]`;
        if (block.type === "template") {
          return template("body", block.templateId, `${basePath}.templateId`);
        }
        if (block.type === "claim") {
          const value = claim(block.claimId, `${basePath}.claimId`);
          return value.length === 0 ? "" : presented(value, block.presentation);
        }
        const value = contact(block.contactId, `${basePath}.contactId`);
        return value.length === 0 ? "" : presented(value, block.presentation);
      })
      .filter((value) => value.length > 0)
      .join("\n\n");
  };

  const renderTags = (templateIds: readonly string[] | undefined): readonly string[] | null => {
    if (templateIds === undefined) return null;
    return templateIds.map((templateId, index) =>
      template("tag", templateId, `payload.tagTemplateIds[${index}]`),
    );
  };

  const missing = [
    input.payload.titleBlocks === undefined ? "titleBlocks" : null,
    input.payload.summaryBlocks === undefined ? "summaryBlocks" : null,
    input.payload.bodyBlocks === undefined ? "bodyBlocks" : null,
    input.payload.tagTemplateIds === undefined ? "tagTemplateIds" : null,
  ].filter((value): value is string => value !== null);
  if (missing.length > 0) {
    issues.push({
      ruleId: "content.legacy_unstructured",
      message: "Publication payload is missing canonical content references",
      path: "payload",
      evidence: missing,
    });
  }

  return freezeDeep({
    title: renderInline(input.payload.titleBlocks, "title"),
    summary: renderInline(input.payload.summaryBlocks, "summary"),
    bodyMarkdown: renderBody(input.payload.bodyBlocks),
    tags: renderTags(input.payload.tagTemplateIds),
    claimIds,
    contactIds,
    issues,
  });
}
