import { marked } from "marked";

export interface MarkdownHeadingSection {
  readonly heading: string | null;
  readonly markdown: string;
}

export function markdownHeadingSections(
  markdown: string,
  headingDepth = 2,
): readonly MarkdownHeadingSection[] {
  const sections: MarkdownHeadingSection[] = [];
  let heading: string | null = null;
  let chunks: string[] = [];

  const flush = () => {
    const sectionMarkdown = chunks.join("").trim();
    if (sectionMarkdown.length > 0) {
      sections.push(Object.freeze({ heading, markdown: sectionMarkdown }));
    }
    chunks = [];
  };

  for (const token of marked.lexer(markdown, { gfm: true })) {
    if (token.type === "heading" && token.depth === headingDepth) {
      flush();
      heading = token.text.trim();
    }
    chunks.push(token.raw);
  }
  flush();

  return Object.freeze(sections);
}
