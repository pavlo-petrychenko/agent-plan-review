// Markdown → blocks of words. Every word knows its index on the page, its source line, the
// "flow" it belongs to (a paragraph, a list item, a table cell, a code line) and its top-level
// block. The view draws each word as one element, so selection snaps to whole words.
// Every word also knows `src` / `srcEnd`: character offsets [src, srcEnd) into the page's
// markdown (its lines joined by "\n"), the server's word-exact comment anchor (`range`).
// Pure: no Herdr imports.

// ---------------------------------------------------------------------------------------------
// Inline: text → characters with styles → words made of styled segments.

const LINK_MD = /^\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/;
const IMG_MD = /^!\[([^\]]*)\]\(([^)\s]+)\)/;
const TAG = /^<\/?[a-zA-Z][^>]*>/;
const ESCAPABLE = /[\\`*_[\]()#+\-.!|<>~{}]/;
const ALNUM = /[\p{L}\p{N}]/u;

/** Scans inline markdown into characters, each with its source offset and style. */
export function scanInline(src, resolve = () => null, base = {}) {
  const out = [];
  let bold = false, italic = false, strike = false;
  const push = (ch, pos, extra = {}) => out.push({ ch, pos, st: { ...base, bold: bold || !!base.bold, italic: italic || !!base.italic, strike, ...extra } });
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "\\" && i + 1 < src.length && ESCAPABLE.test(src[i + 1])) { push(src[i + 1], i + 1); i += 2; continue; }
    if (c === "`") {
      let n = 1;
      while (src[i + n] === "`") n++;
      const fence = "`".repeat(n);
      const end = src.indexOf(fence, i + n);
      if (end > 0) {
        let body = src.slice(i + n, end), off = i + n;
        if (body.length > 2 && body.startsWith(" ") && body.endsWith(" ")) { body = body.slice(1, -1); off++; }
        for (let k = 0; k < body.length; k++) push(body[k] === "\n" ? " " : body[k], off + k, { code: true });
        i = end + n;
        continue;
      }
    }
    if (src.startsWith("[[", i)) {
      const end = src.indexOf("]]", i + 2);
      if (end > 0) {
        const inner = src.slice(i + 2, end);
        const bar = inner.indexOf("|");
        const slug = (bar >= 0 ? inner.slice(0, bar) : inner).trim();
        const label = bar >= 0 ? inner.slice(bar + 1).trim() : (resolve(slug)?.title ?? slug);
        for (const ch of label) push(ch, i, { link: { slug } });
        i = end + 2;
        continue;
      }
    }
    if (c === "!" && src[i + 1] === "[") {
      const m = IMG_MD.exec(src.slice(i));
      if (m) { for (const ch of m[1] || "image") push(ch, i, { italic: true }); i += m[0].length; continue; }
    }
    if (c === "[") {
      const m = LINK_MD.exec(src.slice(i));
      if (m) {
        const url = m[2];
        const slug = url.startsWith("#") ? url.slice(1) : (resolve(url) ? url : null);
        const link = slug ? { slug } : { url };
        for (const x of scanInline(m[1], resolve, { link })) out.push({ ...x, pos: x.pos + i + 1, st: { ...x.st, bold: x.st.bold || bold, italic: x.st.italic || italic } });
        i += m[0].length;
        continue;
      }
    }
    if (c === "<") {
      const m = TAG.exec(src.slice(i));
      if (m) { if (/^<br\s*\/?>$/i.test(m[0])) push(" ", i); i += m[0].length; continue; }
    }
    if (src.startsWith("~~", i) && (strike || src.indexOf("~~", i + 2) > 0)) { strike = !strike; i += 2; continue; }
    if (src.startsWith("**", i) || src.startsWith("__", i)) {
      const mk = src.slice(i, i + 2);
      const opens = !bold && src.indexOf(mk, i + 2) > 0 && !/\s/.test(src[i + 2] ?? " ");
      const intraword = mk === "__" && ALNUM.test(src[i - 1] ?? " ") && ALNUM.test(src[i + 2] ?? " ");
      if (!intraword && (bold || opens)) { bold = !bold; i += 2; continue; }
    }
    if (c === "*" || c === "_") {
      const prev = src[i - 1] ?? " ", next = src[i + 1] ?? " ";
      const intraword = c === "_" && ALNUM.test(prev) && ALNUM.test(next);
      const closes = italic && !/\s/.test(prev);
      const opens = !italic && !/\s/.test(next) && src.indexOf(c, i + 1) > 0;
      if (!intraword && (closes || opens)) { italic = !italic; i++; continue; }
    }
    push(c, i);
    i++;
  }
  return out;
}

const styleKey = (st) => [st.bold, st.italic, st.code, st.strike, st.kind, st.link?.slug, st.link?.url].join("|");

/** Characters → words: [{ segs: [{text, ...style}], space, pos, end }]. Whitespace ends a word.
 *  `pos` is the source offset of the first character, `end` one past the last one's. */
export function wordsFromChars(chars) {
  const words = [];
  let cur = null;
  for (const c of chars) {
    if (/\s/.test(c.ch)) {
      if (cur) { cur.space = " "; if (c.st.code) cur.spaceCode = true; }
      cur = null;
      continue;
    }
    if (!cur) { cur = { segs: [], space: "", pos: c.pos, end: c.pos + 1 }; words.push(cur); }
    cur.end = Math.max(cur.end, c.pos + 1);
    const last = cur.segs[cur.segs.length - 1];
    if (last && last.key === styleKey(c.st)) last.text += c.ch;
    else cur.segs.push({ text: c.ch, key: styleKey(c.st), ...c.st });
  }
  for (const w of words) for (const s of w.segs) delete s.key;
  return words;
}

// ---------------------------------------------------------------------------------------------
// Code: a tiny, language-agnostic highlighter. Good enough to tell code from prose at a glance.

const KEYWORDS = new Set(("const let var function return if else for while do switch case break continue new class " +
  "extends import export from default async await try catch finally throw typeof instanceof in of this super null " +
  "undefined true false def lambda pass yield with as elif not and or is None True False fn pub struct enum impl " +
  "trait mut use mod match loop where type interface package func go defer chan map range select static void int " +
  "string bool float echo then fi esac done local set unset").split(" "));
const HASH_COMMENTS = new Set(["sh", "bash", "zsh", "shell", "console", "py", "python", "yaml", "yml", "toml", "rb", "ruby", "conf", "ini", "make", "makefile", "dockerfile"]);
const TOKEN = /(\/\/.*$|"(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?|`[^`]*`?|\b\d[\d_.]*\b|(?<![\w$])--?[A-Za-z][\w-]*|[A-Za-z_$][\w$-]*|\s+|.)/g;

/** One code line → tokens [{text, kind}]; kind: comment, string, number, keyword, type, fn, punct, plain. */
export function highlightLine(line, lang = "") {
  const l = String(lang).toLowerCase();
  const hash = HASH_COMMENTS.has(l);
  const out = [];
  let rest = line;
  if (hash) {
    const m = /(^|\s)#.*$/.exec(line);
    if (m && !/["']/.test(line.slice(0, m.index))) { rest = line.slice(0, m.index + m[1].length); }
  }
  for (const m of rest.matchAll(TOKEN)) {
    const t = m[0];
    let kind = "plain";
    if (t.startsWith("//") && !hash) kind = "comment";
    else if (/^["'`]/.test(t)) kind = "string";
    else if (/^\d/.test(t)) kind = "number";
    else if (/^--?[A-Za-z]/.test(t)) kind = "keyword";
    else if (/^[A-Za-z_$]/.test(t)) {
      const after = rest.slice(m.index + t.length);
      if (KEYWORDS.has(t)) kind = "keyword";
      else if (/^\s*\(/.test(after)) kind = "fn";
      else if (/^[A-Z][a-z]/.test(t)) kind = "type";
      else if (hash && m.index === rest.search(/\S/)) kind = "fn"; // a shell command name
    } else if (/^[{}()[\];,.:=<>+\-*/!&|?%^~@]$/.test(t)) kind = "punct";
    out.push({ text: t, kind });
  }
  if (rest.length < line.length) out.push({ text: line.slice(rest.length), kind: "comment" });
  return out;
}

/** Code tokens → words; a word's `space` is its exact trailing whitespace. Leading indent is separate. */
export function codeWords(line, lang) {
  const indent = /^\s*/.exec(line)[0];
  const words = [];
  let cur = null;
  let pos = 0;
  // Strings and comments hold spaces: split them so selection still snaps to single words.
  const parts = highlightLine(line, lang).flatMap((tok) => tok.text.split(/(\s+)/).filter(Boolean).map((text) => ({ text, kind: tok.kind })));
  for (const tok of parts) {
    if (pos < indent.length && /^\s+$/.test(tok.text)) { pos += tok.text.length; continue; }
    if (/^\s+$/.test(tok.text)) {
      if (cur) cur.space += tok.text;
      cur = null;
    } else {
      if (!cur) { cur = { segs: [], space: "", pos }; words.push(cur); }
      const last = cur.segs[cur.segs.length - 1];
      if (last && last.kind === tok.kind) last.text += tok.text;
      else cur.segs.push({ text: tok.text, code: true, kind: tok.kind });
    }
    pos += tok.text.length;
  }
  return { indent, words };
}

// ---------------------------------------------------------------------------------------------
// Blocks.

const FENCE = /^(\s*)(`{3,}|~{3,})\s*([\w+#.-]*)/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const LIST = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const IMAGE_LINE = /^\s*!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)\s*$/;
const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const COMMENT_LINE = /^\s*<!--.*-->\s*$/;

const isTableRow = (l) => l.includes("|");
const startsBlock = (l, next) =>
  FENCE.test(l) || HEADING.test(l) || HR.test(l) || LIST.test(l) || QUOTE.test(l) || IMAGE_LINE.test(l) ||
  (isTableRow(l) && next !== undefined && TABLE_SEP.test(next));

/** Splits a table row on pipes that are not escaped and not inside a code span. */
export function splitRow(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells = [];
  let cur = "", code = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\" && s[i + 1] === "|") { cur += "\\|"; i++; continue; }
    if (c === "`") code = !code;
    if (c === "|" && !code) { cells.push(cur.trim()); cur = ""; continue; }
    cur += c;
  }
  cells.push(cur.trim());
  return cells;
}

/**
 * Parses a page body. `lines` are the page's lines, `startLine` the source line of lines[0].
 * Returns { blocks, words }: words are indexed 0..n-1 in reading order.
 */
export function parsePage(lines, startLine = 1, resolve = () => null) {
  const lineOff = [];
  let off = 0;
  for (const l of lines) { lineOff.push(off); off += l.length + 1; }
  const ctx = { words: [], flows: 0, top: 0, resolve, lines, startLine, lineOff, cursor: new Map() };
  const blocks = parseBlocks(lines, startLine, ctx, true);
  return { blocks, words: ctx.words };
}

// Where a flow's line of text starts in the page source: the text is a piece of its source line
// (markers, quote prefixes and cell pipes stripped), found left to right so table cells that
// share a line land on their own columns. Returns the page offset of the piece's first character.
function locate(ctx, line, piece) {
  const k = line - ctx.startLine;
  const src = ctx.lines[k];
  if (src == null) return 0;
  const from = ctx.cursor.get(line) ?? 0;
  let col = piece ? src.indexOf(piece, from) : -1;
  if (col < 0 && piece) col = src.indexOf(piece);
  if (col < 0) col = 0;
  else ctx.cursor.set(line, col + piece.length);
  return ctx.lineOff[k] + col;
}

function flow(ctx, text, line0) {
  const id = ctx.flows++;
  const nl = [];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") nl.push(i);
  const rowOf = (pos) => { let n = 0; while (n < nl.length && nl[n] < pos) n++; return n; };
  // Page offset of each of the flow's text lines, then of any position in the flow's text.
  const bases = text.split("\n").map((piece, n) => locate(ctx, line0 + n, piece));
  const abs = (pos) => { const n = rowOf(pos); return bases[n] + pos - (n ? nl[n - 1] + 1 : 0); };
  const words = wordsFromChars(scanInline(text, ctx.resolve)).map((w) => {
    const word = { i: ctx.words.length, segs: w.segs, space: w.space, line: line0 + rowOf(w.pos), flow: id, block: ctx.top, src: abs(w.pos), srcEnd: abs(w.end - 1) + 1 };
    if (w.spaceCode) word.spaceCode = true;
    ctx.words.push(word);
    return word;
  });
  return { id, words };
}

function codeFlow(ctx, text, lang, line) {
  const id = ctx.flows++;
  const { indent, words } = codeWords(text, lang);
  const base = locate(ctx, line, text);
  return {
    id, indent, words: words.map((w) => {
      const src = base + w.pos;
      const word = { i: ctx.words.length, segs: w.segs, space: w.space, line, flow: id, block: ctx.top, code: true, src, srcEnd: src + wordText(w).length };
      ctx.words.push(word);
      return word;
    }),
  };
}

function parseBlocks(lines, startLine, ctx, top) {
  const blocks = [];
  let i = 0;
  const add = (b) => { blocks.push(b); if (top) ctx.top = blocks.length; };
  while (i < lines.length) {
    const line = lines[i];
    const L = startLine + i;
    if (!line.trim() || COMMENT_LINE.test(line)) { i++; continue; }
    let m;
    if ((m = FENCE.exec(line))) {
      const [, , fence, lang] = m;
      const body = [];
      let j = i + 1;
      while (j < lines.length && !lines[j].trim().startsWith(fence)) body.push(lines[j++]);
      const codeLines = body.map((t, k) => codeFlow(ctx, t, lang, L + 1 + k));
      add({ type: "code", lang, lines: codeLines, line: L, lineEnd: startLine + Math.min(j, lines.length - 1) });
      i = j + 1;
      continue;
    }
    if ((m = HEADING.exec(line))) {
      add({ type: "heading", level: m[1].length, flow: flow(ctx, m[2], L), line: L, lineEnd: L });
      i++;
      continue;
    }
    if (HR.test(line)) { add({ type: "hr", line: L, lineEnd: L }); i++; continue; }
    if ((m = IMAGE_LINE.exec(line))) { add({ type: "image", alt: m[1], src: m[2], line: L, lineEnd: L }); i++; continue; }
    if (QUOTE.test(line)) {
      const inner = [];
      let j = i;
      while (j < lines.length && lines[j].trim() && (QUOTE.test(lines[j]) || !startsBlock(lines[j]))) {
        const q = QUOTE.exec(lines[j]);
        inner.push(q ? q[1] : lines[j]);
        j++;
      }
      const b = { type: "quote", blocks: parseBlocks(inner, L, ctx, false), line: L, lineEnd: startLine + j - 1 };
      add(b);
      i = j;
      continue;
    }
    if (isTableRow(line) && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
      const head = splitRow(line);
      const align = splitRow(lines[i + 1]).map((c) => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : "left"));
      const header = head.map((c) => flow(ctx, c, L));
      const rows = [];
      let j = i + 2;
      while (j < lines.length && lines[j].trim() && isTableRow(lines[j])) {
        const cells = splitRow(lines[j]);
        while (cells.length < head.length) cells.push("");
        rows.push(cells.slice(0, head.length).map((c) => flow(ctx, c, startLine + j)));
        j++;
      }
      add({ type: "table", align, header, rows, line: L, lineEnd: startLine + j - 1 });
      i = j;
      continue;
    }
    if (LIST.test(line)) {
      const items = [];
      const stack = []; // indent widths of open levels
      const counters = [];
      let j = i;
      while (j < lines.length) {
        const l = lines[j];
        const lm = LIST.exec(l);
        if (lm) {
          const indent = lm[1].replace(/\t/g, "    ").length;
          // A top-level switch between bullets and numbers starts a new list.
          if (items.length && indent <= stack[0] && /\d/.test(lm[2]) !== items[0].ordered) break;
          while (stack.length && indent < stack[stack.length - 1]) stack.pop();
          if (!stack.length || indent > stack[stack.length - 1]) stack.push(indent);
          const depth = stack.length - 1;
          counters.length = depth + 1;
          const ordered = /\d/.test(lm[2]);
          if (ordered) counters[depth] = counters[depth] ? counters[depth] + 1 : parseInt(lm[2], 10);
          else counters[depth] = 0;
          // Continuation lines: indented, or lazy (plain text right below).
          const text = [lm[3]];
          let k = j + 1;
          while (k < lines.length && lines[k].trim() && !LIST.test(lines[k]) && !startsBlock(lines[k].trim(), lines[k + 1])) text.push(lines[k++].trim());
          let check = null;
          const tm = /^\[([ xX])\]\s+/.exec(text[0]);
          if (tm) { check = tm[1] !== " "; text[0] = text[0].slice(tm[0].length); }
          items.push({ depth, ordered, number: ordered ? counters[depth] : null, check, flow: flow(ctx, text.join("\n"), startLine + j), line: startLine + j });
          j = k;
          continue;
        }
        // A blank line inside a list continues it when the next text line is another item.
        if (!l.trim()) {
          let k = j + 1;
          while (k < lines.length && !lines[k].trim()) k++;
          if (k < lines.length && LIST.test(lines[k])) { j = k; continue; }
        }
        break;
      }
      add({ type: "list", items, line: L, lineEnd: startLine + j - 1 });
      i = j;
      continue;
    }
    // Paragraph.
    const text = [line];
    let j = i + 1;
    while (j < lines.length && lines[j].trim() && !startsBlock(lines[j], lines[j + 1]) && !COMMENT_LINE.test(lines[j])) text.push(lines[j++]);
    add({ type: "para", flow: flow(ctx, text.join("\n"), L), line: L, lineEnd: startLine + j - 1 });
    i = j;
  }
  return blocks;
}

/** A word's visible text (segments joined, no trailing space). */
export const wordText = (w) => w.segs.map((s) => s.text).join("");

// Rough pixel widths at the table's 14 px text: proportional text, and code (monospace, in a chip).
const TEXT_PX = 8.2, CODE_PX = 8.6, CHIP_PX = 10, CELL_PAD_PX = 24;

/** The drawn width of one word, roughly: its text runs plus code chip padding. */
export function wordPx(w) {
  let px = 0;
  for (const s of w.segs) px += s.text.length * (s.code ? CODE_PX : TEXT_PX) + (s.code && !w.code ? CHIP_PX : 0);
  return px;
}

/**
 * A table's columns: { grow, min } each. `grow` shares the free width by how much text a column holds
 * (square root, 1–6). `min` is the column's longest word plus the cell padding, so a long word
 * (`ClassifyConversation`, a code path) is not narrower than its cell and does not run into the next
 * one. When the minimums do not fit, the table is wider than the text and scrolls sideways
 * (tableWidth).
 */
export function tableColumns(b) {
  const cells = (k) => [b.header[k], ...b.rows.map((r) => r[k])].filter(Boolean);
  const cols = b.header.map((_, k) => {
    const len = Math.max(0, ...cells(k).map((f) => f.words.reduce((n, w) => n + wordText(w).length + 1, 0)));
    const longest = Math.max(0, ...cells(k).flatMap((f) => f.words.map(wordPx)));
    return { grow: Math.max(1, Math.min(6, Math.sqrt(len))), min: Math.ceil(longest + CELL_PAD_PX + 1) };
  });
  return cols;
}

/** The width a table needs: its columns' minimums and the frame's border. */
export const tableWidth = (cols) => cols.reduce((n, c) => n + c.min, 0) + 2;
