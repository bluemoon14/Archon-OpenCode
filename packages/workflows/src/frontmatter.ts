/**
 * Frontmatter splitter for markdown files with YAML headers.
 *
 * Accepts `---\n<yaml>\n---\n<body>` or an empty-frontmatter file. The YAML
 * block is parsed with `Bun.YAML.parse` (same parser used elsewhere in the
 * repo — no new deps). Returns the raw YAML object and the trailing body
 * separately so callers can Zod-validate the frontmatter and pass the body
 * through unchanged.
 */

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export interface ParsedFrontmatter {
  /** Parsed YAML frontmatter as an arbitrary object (unknown shape). */
  data: Record<string, unknown>;
  /** Markdown body after the closing `---` line. */
  body: string;
  /** True if the file had a frontmatter block; false if the file was pure markdown. */
  hasFrontmatter: boolean;
}

/**
 * Split a file into frontmatter + body. Throws on malformed YAML in the header.
 * Files without a frontmatter block return `{ data: {}, body: <full content>, hasFrontmatter: false }`.
 */
export function parseFrontmatter(content: string): ParsedFrontmatter {
  const match = FRONTMATTER_RE.exec(content);
  if (match === null) {
    return { data: {}, body: content, hasFrontmatter: false };
  }

  const [, yamlBlock, body] = match;
  const parsed = Bun.YAML.parse(yamlBlock);

  // YAML.parse of an empty string returns null; treat as empty frontmatter.
  if (parsed === null || parsed === undefined) {
    return { data: {}, body, hasFrontmatter: true };
  }
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('frontmatter must be a YAML mapping, not an array or scalar');
  }

  return { data: parsed as Record<string, unknown>, body, hasFrontmatter: true };
}
