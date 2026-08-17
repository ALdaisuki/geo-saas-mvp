import { marked, type Token } from "marked";

import { sha256Canonical } from "./canonical.js";

export const CTRIP_PUBLIC_CONTENT_SCHEMA_VERSION = "geo.ctrip-public-content.v1";

export function normalizeCtripPublicContent(value: string): string {
  return value.normalize("NFC").replace(/\r\n?/gu, "\n").replace(/\s+/gu, " ").trim();
}

export function ctripPublicContentHash(title: string, body: string): string {
  return sha256Canonical({
    schemaVersion: CTRIP_PUBLIC_CONTENT_SCHEMA_VERSION,
    title: normalizeCtripPublicContent(title),
    body: normalizeCtripPublicContent(body),
  });
}

function safeLink(url: string): string {
  return /^https?:\/\//iu.test(url) ? url : "";
}

function inlineTokens(tokens: readonly Token[] | undefined): string {
  if (tokens === undefined) return "";
  return tokens
    .map((token) => {
      switch (token.type) {
        case "text":
        case "escape":
          return token.text;
        case "strong":
        case "em":
        case "del":
          return inlineTokens(token.tokens);
        case "codespan":
          return token.text;
        case "br":
          return "\n";
        case "link": {
          const label = inlineTokens(token.tokens) || token.text;
          const href = safeLink(token.href);
          return href.length === 0 ? label : `${label} (${href})`;
        }
        case "image":
          return token.text;
        case "html":
          return "";
        case "space":
          return "\n";
        default:
          if ("tokens" in token && Array.isArray(token.tokens)) {
            return inlineTokens(token.tokens);
          }
          return "text" in token && typeof token.text === "string" ? token.text : "";
      }
    })
    .join("");
}

function blockTokens(tokens: readonly Token[]): string {
  const blocks: string[] = [];
  for (const token of tokens) {
    switch (token.type) {
      case "space":
        continue;
      case "heading":
      case "paragraph":
      case "text":
        blocks.push(
          inlineTokens(token.tokens ?? [{ type: "text", raw: token.raw, text: token.text }]),
        );
        break;
      case "blockquote":
        blocks.push(
          blockTokens(token.tokens ?? [])
            .split("\n")
            .map((line) => `> ${line}`)
            .join("\n"),
        );
        break;
      case "list": {
        const list = token as Token & {
          readonly ordered: boolean;
          readonly items: readonly { readonly tokens: readonly Token[] }[];
        };
        blocks.push(
          list.items
            .map((item: { readonly tokens: readonly Token[] }, index: number) => {
              const value = blockTokens(item.tokens).replace(/\n{2,}/gu, "\n");
              return `${list.ordered ? `${index + 1}.` : "-"} ${value}`;
            })
            .join("\n"),
        );
        break;
      }
      case "code":
        blocks.push(token.text);
        break;
      case "table": {
        const table = token as Token & {
          readonly header: readonly { readonly tokens: readonly Token[] }[];
          readonly rows: readonly (readonly { readonly tokens: readonly Token[] }[])[];
        };
        blocks.push(
          [
            table.header
              .map((cell: { readonly tokens: readonly Token[] }) => inlineTokens(cell.tokens))
              .join(" | "),
            ...table.rows.map((row: readonly { readonly tokens: readonly Token[] }[]) =>
              row
                .map((cell: { readonly tokens: readonly Token[] }) => inlineTokens(cell.tokens))
                .join(" | "),
            ),
          ].join("\n"),
        );
        break;
      }
      case "hr":
      case "html":
      case "def":
        continue;
      default:
        if ("tokens" in token && Array.isArray(token.tokens)) {
          blocks.push(blockTokens(token.tokens));
        }
    }
  }
  return blocks
    .map((block) => block.replace(/[ \t]+$/gmu, "").trim())
    .filter((block) => block.length > 0)
    .join("\n\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

export function renderCtripPublicBodyFromMarkdown(markdown: string): string {
  return blockTokens(marked.lexer(markdown, { gfm: true }));
}

export function ctripPublicContentHashFromMarkdown(title: string, bodyMarkdown: string): string {
  return ctripPublicContentHash(title, renderCtripPublicBodyFromMarkdown(bodyMarkdown));
}
