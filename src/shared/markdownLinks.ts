/**
 * Fence-aware scanning helpers for cross-document links.
 *
 * Two consumers:
 *  - normalizeWikiLinks: rewrites `[[slug]]` / `[[slug|text]]` into standard
 *    `[text](doc:slug)` links before markdown parsing (server render).
 *  - extractDocLinks: collects referenced slugs for validation.
 *
 * Both deliberately skip fenced code blocks and inline code spans so examples
 * inside a plan are never treated as navigation.
 */

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;
const INLINE_CODE_RE = /`+[^`]*`+/g;
const WIKI_RE = /\[\[([a-zA-Z0-9][a-zA-Z0-9 _-]*)(?:\|([^\]]+))?\]\]/g;
const DOC_LINK_RE = /\]\(doc:([^)\s]+)\)/g;

function leadingRun(text: string, char: string): number {
  let i = 0;
  while (i < text.length && text[i] === char) i++;
  return i;
}

/**
 * Apply `transform` to every line outside fenced code blocks.
 * Fence lines themselves are never transformed.
 */
function mapOutsideFences(markdown: string, transform: (line: string) => string): string[] {
  const out: string[] = [];
  let fence: string | null = null;
  for (const line of markdown.split('\n')) {
    const m = FENCE_RE.exec(line);
    const run = m?.[1] ?? null;
    if (fence === null) {
      if (run) {
        fence = run;
        out.push(line);
      } else {
        out.push(transform(line));
      }
      continue;
    }
    // Inside a fence: only an explicit closing run of the same character ends it.
    if (run && run[0] === fence[0] && leadingRun(line.trimStart(), fence[0]) >= fence.length) {
      fence = null;
    }
    out.push(line);
  }
  return out;
}

/** Is `index` inside an inline-code span of this line? */
function insideInlineCode(line: string, index: number): boolean {
  INLINE_CODE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = INLINE_CODE_RE.exec(line))) {
    if (index >= m.index && index < m.index + m[0].length) return true;
  }
  return false;
}

function slugifyWikiTarget(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, '-');
}

/**
 * Rewrite wiki-style links to `[text](doc:slug)`.
 * `[[slug]]` → `[slug](doc:slug)`; `[[slug|Label]]` → `[Label](doc:slug)`.
 */
export function normalizeWikiLinks(markdown: string): string {
  return mapOutsideFences(markdown, (line) => {
    let result = '';
    let last = 0;
    WIKI_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = WIKI_RE.exec(line))) {
      if (insideInlineCode(line, m.index)) continue;
      const target = slugifyWikiTarget(m[1]);
      const text = (m[2] ?? m[1]).trim() || target;
      result += line.slice(last, m.index);
      result += `[${text}](doc:${target})`;
      last = m.index + m[0].length;
    }
    return last === 0 ? line : result + line.slice(last);
  }).join('\n');
}

/** Collect every doc-target referenced by wiki or `(doc:x)` links. */
export function extractDocLinks(markdown: string): string[] {
  const found = new Set<string>();
  // Scan inside the transform callback so fenced lines (passed through raw)
  // are never searched.
  mapOutsideFences(markdown, (line) => {
    // Mask inline-code span contents before matching.
    const masked = line.replace(INLINE_CODE_RE, '\u0000'.repeat(4));
    WIKI_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = WIKI_RE.exec(masked))) found.add(slugifyWikiTarget(m[1]));
    DOC_LINK_RE.lastIndex = 0;
    while ((m = DOC_LINK_RE.exec(masked))) found.add(m[1]);
    return line;
  });
  return [...found];
}
