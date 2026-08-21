/**
 * Heading outline extraction — pure, used by the web client to build the
 * "view as tree" navigation and section filtering.
 */

export interface HeadingEntry {
  level: number; // 1..6
  text: string;
  /** 1-based source line of the heading. */
  line: number;
}

const ATX_RE = /^( {0,3})(#{1,6})\s+(.+?)\s*#*\s*$/;

/** Extract ATX headings (fences respected). Setext headings are not tracked. */
export function parseHeadings(markdown: string): HeadingEntry[] {
  const out: HeadingEntry[] = [];
  let fence: string | null = null;
  const lines = markdown.split('\n');
  lines.forEach((line, idx) => {
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (m) {
      if (fence === null) fence = m[1];
      else if (line.trimStart().startsWith(fence[0]) && leadingRun(line.trimStart(), fence[0]) >= fence.length) fence = null;
      return;
    }
    if (fence !== null) return;
    const h = ATX_RE.exec(line);
    if (h) {
      out.push({ level: h[2].length, text: h[3].trim(), line: idx + 1 });
    }
  });
  return out;
}

function leadingRun(text: string, char: string): number {
  let i = 0;
  while (i < text.length && text[i] === char) i++;
  return i;
}

/**
 * Compute the source-line range a heading's SECTION covers (the heading
 * itself through the line before the next heading of level <= its own).
 * `endLine` is exclusive.
 */
export function sectionRange(headings: HeadingEntry[], index: number, totalLines: number): { start: number; end: number } {
  const start = headings[index].line;
  for (let i = index + 1; i < headings.length; i++) {
    if (headings[i].level <= headings[index].level) {
      return { start, end: headings[i].line };
    }
  }
  return { start, end: totalLines + 1 };
}
