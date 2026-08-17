import { describe, expect, it } from "vitest";

import {
  ctripPublicContentHash,
  ctripPublicContentHashFromMarkdown,
  normalizeCtripPublicContent,
  renderCtripPublicBodyFromMarkdown,
} from "./ctrip-public-content.js";

describe("Ctrip public content binding", () => {
  it("normalizes Unicode and whitespace before hashing title and body", () => {
    expect(normalizeCtripPublicContent(" Cafe\u0301\r\n\troute  ")).toBe(
      " Caf\u00e9 route ".trim(),
    );
    expect(ctripPublicContentHash("Cafe\u0301", "first\r\n\tsecond")).toBe(
      ctripPublicContentHash("Caf\u00e9", "first second"),
    );
  });

  it("binds the title as well as the body", () => {
    expect(ctripPublicContentHash("First", "same body")).not.toBe(
      ctripPublicContentHash("Second", "same body"),
    );
  });

  it("uses the same Markdown rendering domain as the Ctrip browser writer", () => {
    const markdown = [
      "## Tokyo **family** checklist",
      "",
      "Start with [the route](https://example.test/route).",
      "",
      "- First stop",
      "- `Second` stop",
    ].join("\n");
    const publicBody = [
      "Tokyo family checklist",
      "",
      "Start with the route (https://example.test/route).",
      "",
      "- First stop",
      "- Second stop",
    ].join("\n");

    expect(renderCtripPublicBodyFromMarkdown(markdown)).toBe(publicBody);
    expect(ctripPublicContentHashFromMarkdown("Tokyo", markdown)).toBe(
      ctripPublicContentHash("Tokyo", publicBody),
    );
  });
});
