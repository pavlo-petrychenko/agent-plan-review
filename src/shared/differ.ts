/**
 * Line diff — pure LCS-based, shared by the server (nothing yet) and the web
 * client (diff view). Plans are small; O(n·m) DP is plenty.
 */

export type DiffOp = {
  type: 'equal' | 'del' | 'ins';
  text: string;
  /** 1-based old line number (del/equal). */
  oldLine?: number;
  /** 1-based new line number (ins/equal). */
  newLine?: number;
};

export interface DiffStats {
  added: number;
  removed: number;
}

/** Side-by-side row: paired add/delete runs align row-wise; blanks pad. */
export interface SbsRow {
  kind: 'eq' | 'add' | 'del' | 'mod';
  left?: { n: number; text: string };
  right?: { n: number; text: string };
}

/** Unified row for the single-column view. */
export interface UnifiedRow {
  kind: 'eq' | 'add' | 'del';
  oldLine?: number;
  newLine?: number;
  text: string;
}

function diffOps(a: string[], b: string[]): DiffOp[] {
  const n = a.length;
  const m = b.length;
  // LCS length table (row-major, (n+1) x (m+1)).
  const width = m + 1;
  const dp = new Int32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * width + j] =
        a[i] === b[j]
          ? dp[(i + 1) * width + j + 1] + 1
          : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1]);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: 'equal', text: a[i], oldLine: i + 1, newLine: j + 1 });
      i++;
      j++;
    } else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) {
      ops.push({ type: 'del', text: a[i], oldLine: i + 1 });
      i++;
    } else {
      ops.push({ type: 'ins', text: b[j], newLine: j + 1 });
      j++;
    }
  }
  while (i < n) ops.push({ type: 'del', text: a[i], oldLine: ++i });
  while (j < m) ops.push({ type: 'ins', text: b[j], newLine: ++j });
  return ops;
}

export interface LineDiff {
  rows: SbsRow[];
  unified: UnifiedRow[];
  stats: DiffStats;
  /** Change regions with context — drives the GitHub-style hunked view. */
  hunks: DiffHunk[];
}

/** A visible run of rows: every change plus `context` unchanged rows around it. */
export interface DiffHunk {
  /** Index into `rows` of the first visible row (inclusive). */
  start: number;
  /** Index into `rows` one past the last visible row (exclusive). */
  end: number;
}

/** Render plan for the hunked view: visible row runs and the gaps between them. */
export type DiffSegment =
  | { kind: 'rows'; start: number; end: number }
  | { kind: 'gap'; start: number; count: number };

/**
 * Collapse a row list into hunks: each change run plus `context` rows of
 * surrounding context. Change runs closer than `2 * context` rows merge into a
 * single hunk, mirroring unified-diff hunk headers. Works for either row shape
 * (`SbsRow`, `UnifiedRow`, `ViewRow`) — only `kind` is inspected.
 */
export function computeHunks(rows: readonly { kind: string }[], context = 3): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].kind === 'eq') continue;
    const last = hunks[hunks.length - 1];
    if (last && i - last.end <= context * 2) last.end = i + 1;
    else hunks.push({ start: Math.max(0, i - context), end: i + 1 });
  }
  return hunks.map((h) => ({ start: h.start, end: Math.min(rows.length, h.end + context) }));
}

/** Split `rows` into visible runs plus the hidden gaps between them. */
export function diffSegments(rows: readonly unknown[], hunks: DiffHunk[]): DiffSegment[] {
  const segments: DiffSegment[] = [];
  let cursor = 0;
  for (const hunk of hunks) {
    if (hunk.start > cursor) segments.push({ kind: 'gap', start: cursor, count: hunk.start - cursor });
    if (hunk.end > hunk.start) segments.push({ kind: 'rows', start: hunk.start, end: hunk.end });
    cursor = Math.max(cursor, hunk.end);
  }
  if (cursor < rows.length) segments.push({ kind: 'gap', start: cursor, count: rows.length - cursor });
  return segments;
}

const splitLines = (text: string): string[] => (text.length === 0 ? [] : text.split('\n'));

/** Compute side-by-side rows, unified rows and change stats for two documents. */
export function diffTexts(fromMarkdown: string, toMarkdown: string): LineDiff {
  const a = splitLines(fromMarkdown);
  const b = splitLines(toMarkdown);
  const ops = diffOps(a, b);

  // --- unified -------------------------------------------------------------
  const unified: UnifiedRow[] = ops.map((op) => ({
    kind: op.type === 'equal' ? 'eq' : op.type === 'del' ? 'del' : 'add',
    oldLine: op.oldLine,
    newLine: op.newLine,
    text: op.text,
  }));

  // --- side-by-side --------------------------------------------------------
  const rows: SbsRow[] = [];
  let k = 0;
  while (k < ops.length) {
    if (ops[k].type === 'equal') {
      rows.push({
        kind: 'eq',
        left: { n: ops[k].oldLine!, text: ops[k].text },
        right: { n: ops[k].newLine!, text: ops[k].text },
      });
      k++;
      continue;
    }
    // Collect consecutive del run then ins run.
    const dels: DiffOp[] = [];
    const inses: DiffOp[] = [];
    while (k < ops.length && ops[k].type === 'del') dels.push(ops[k++]);
    while (k < ops.length && ops[k].type === 'ins') inses.push(ops[k++]);
    const pairLen = Math.min(dels.length, inses.length);
    for (let p = 0; p < pairLen; p++) {
      rows.push({
        kind: 'mod',
        left: { n: dels[p].oldLine!, text: dels[p].text },
        right: { n: inses[p].newLine!, text: inses[p].text },
      });
    }
    for (let p = pairLen; p < dels.length; p++) {
      rows.push({ kind: 'del', left: { n: dels[p].oldLine!, text: dels[p].text } });
    }
    for (let p = pairLen; p < inses.length; p++) {
      rows.push({ kind: 'add', right: { n: inses[p].newLine!, text: inses[p].text } });
    }
  }

  return {
    rows,
    unified,
    stats: {
      added: insCount(unified),
      removed: delCount(unified),
    },
    hunks: computeHunks(rows),
  };
}

function insCount(rows: UnifiedRow[]): number {
  return rows.reduce((acc, r) => acc + (r.kind === 'add' ? 1 : 0), 0);
}
function delCount(rows: UnifiedRow[]): number {
  return rows.reduce((acc, r) => acc + (r.kind === 'del' ? 1 : 0), 0);
}

/**
 * Mode-independent row shape the hunked view renders: one entry per visible
 * line, with the line numbers and text of whichever sides exist. Split pairs a
 * removal with an addition into one `mod` row, while unified lists them
 * separately — so each mode hunks its OWN row list (hunk offsets never cross
 * between modes).
 */
export interface ViewRow {
  kind: 'eq' | 'add' | 'del' | 'mod';
  oldLine?: number;
  oldText: string;
  newLine?: number;
  newText: string;
}

/** Project a line diff into the row shape for one view mode. */
export function toViewRows(diff: LineDiff, mode: 'split' | 'unified'): ViewRow[] {
  if (mode === 'split') {
    return diff.rows.map((r) => ({
      kind: r.kind,
      oldLine: r.left?.n,
      oldText: r.left?.text ?? '',
      newLine: r.right?.n,
      newText: r.right?.text ?? '',
    }));
  }
  // Unified has separate rows for removals and additions, so a modified pair
  // becomes one old-side row followed by one new-side row.
  return diff.unified.map((r) => ({
    kind: r.kind,
    oldLine: r.kind === 'add' ? undefined : r.oldLine,
    oldText: r.kind === 'add' ? '' : r.text,
    newLine: r.kind === 'del' ? undefined : r.newLine,
    newText: r.kind === 'del' ? '' : r.text,
  }));
}
