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
  };
}

function insCount(rows: UnifiedRow[]): number {
  return rows.reduce((acc, r) => acc + (r.kind === 'add' ? 1 : 0), 0);
}
function delCount(rows: UnifiedRow[]): number {
  return rows.reduce((acc, r) => acc + (r.kind === 'del' ? 1 : 0), 0);
}
