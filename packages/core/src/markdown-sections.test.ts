import { describe, expect, it } from "vitest";

import { markdownHeadingSections } from "./markdown-sections.js";

describe("markdownHeadingSections", () => {
  it("preserves the preamble and groups level-two sections with nested content", () => {
    expect(
      markdownHeadingSections(
        [
          "Opening paragraph.",
          "",
          "## Transit",
          "",
          "Station details.",
          "",
          "### Transfer",
          "",
          "Platform details.",
          "",
          "## Walking",
          "",
          "Step and rest details.",
        ].join("\n"),
      ),
    ).toEqual([
      { heading: null, markdown: "Opening paragraph." },
      {
        heading: "Transit",
        markdown: "## Transit\n\nStation details.\n\n### Transfer\n\nPlatform details.",
      },
      { heading: "Walking", markdown: "## Walking\n\nStep and rest details." },
    ]);
  });
});
