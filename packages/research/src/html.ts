import { parse } from "parse5";

import { normalizeResearchUrl } from "./url-policy.js";
import type { ResearchPolicy } from "./types.js";

interface HtmlAttribute {
  readonly name: string;
  readonly value: string;
}

interface HtmlNode {
  readonly nodeName?: string;
  readonly tagName?: string;
  readonly value?: string;
  readonly attrs?: readonly HtmlAttribute[];
  readonly childNodes?: readonly HtmlNode[];
}

interface ParsedResearchHtml {
  readonly title: string | null;
  readonly language: string | null;
  readonly canonicalUrl: string | null;
  readonly metaRobots: readonly string[];
  readonly visibleText: string;
  readonly structuredData: readonly unknown[];
  readonly discoveredUrls: readonly string[];
}

function attribute(node: HtmlNode, name: string): string | undefined {
  return node.attrs?.find((candidate) => candidate.name.toLocaleLowerCase("en-US") === name)?.value;
}

function textContent(node: HtmlNode): string {
  if (node.nodeName === "#text") return node.value ?? "";
  return (node.childNodes ?? []).map(textContent).join(" ");
}

function walk(node: HtmlNode, visit: (candidate: HtmlNode) => void): void {
  visit(node);
  for (const child of node.childNodes ?? []) walk(child, visit);
}

function normalizedText(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function collectVisibleText(node: HtmlNode, hidden: boolean, result: string[]): void {
  const tag = node.tagName?.toLocaleLowerCase("en-US");
  const isHidden =
    hidden || ["script", "style", "noscript", "template", "head"].includes(tag ?? "");
  if (!isHidden && node.nodeName === "#text") {
    const value = normalizedText(node.value ?? "");
    if (value.length > 0) result.push(value);
  }
  for (const child of node.childNodes ?? []) collectVisibleText(child, isHidden, result);
}

function safeAllowedUrl(
  value: string | undefined,
  baseUrl: string,
  policy: ResearchPolicy,
): string | null {
  if (value === undefined || value.trim().length === 0) return null;
  try {
    return normalizeResearchUrl(new URL(value, baseUrl).toString(), policy).toString();
  } catch {
    return null;
  }
}

export function parseResearchHtml(
  html: string,
  pageUrl: string,
  policy: ResearchPolicy,
): ParsedResearchHtml {
  const document = parse(html) as unknown as HtmlNode;
  let title: string | null = null;
  let language: string | null = null;
  let canonicalUrl: string | null = null;
  const metaRobots = new Set<string>();
  const structuredData: unknown[] = [];
  const discoveredUrls = new Set<string>();
  const visibleParts: string[] = [];

  walk(document, (node) => {
    const tag = node.tagName?.toLocaleLowerCase("en-US");
    if (tag === "html") language = attribute(node, "lang")?.trim() || null;
    if (tag === "title" && title === null) title = normalizedText(textContent(node)) || null;
    if (tag === "meta" && attribute(node, "name")?.toLocaleLowerCase("en-US") === "robots") {
      for (const token of (attribute(node, "content") ?? "").split(/[\s,]+/u)) {
        const normalized = token.trim().toLocaleLowerCase("en-US");
        if (normalized.length > 0) metaRobots.add(normalized);
      }
    }
    if (tag === "link") {
      const relationships = new Set(
        (attribute(node, "rel") ?? "").toLocaleLowerCase("en-US").split(/\s+/u).filter(Boolean),
      );
      if (relationships.has("canonical") && canonicalUrl === null) {
        canonicalUrl = safeAllowedUrl(attribute(node, "href"), pageUrl, policy);
      }
    }
    if (tag === "a" && discoveredUrls.size < policy.maxDiscoveredUrls) {
      const discovered = safeAllowedUrl(attribute(node, "href"), pageUrl, policy);
      if (discovered !== null && discovered !== pageUrl) discoveredUrls.add(discovered);
    }
    if (
      tag === "script" &&
      attribute(node, "type")?.toLocaleLowerCase("en-US") === "application/ld+json"
    ) {
      const raw = textContent(node).trim();
      if (raw.length > 0 && raw.length <= policy.maxBytes) {
        try {
          structuredData.push(JSON.parse(raw) as unknown);
        } catch {
          // Invalid JSON-LD remains visible in the immutable raw page evidence.
        }
      }
    }
  });
  collectVisibleText(document, false, visibleParts);
  const visibleText = normalizedText(visibleParts.join(" "));

  return {
    title,
    language,
    canonicalUrl,
    metaRobots: [...metaRobots],
    visibleText,
    structuredData,
    discoveredUrls: [...discoveredUrls].slice(0, policy.maxDiscoveredUrls),
  };
}
