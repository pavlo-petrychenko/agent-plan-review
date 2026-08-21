/**
 * Parse server-rendered markdown HTML into top-level blocks with their
 * source-line ranges — the client side of the block↔line contract.
 */

export interface MdBlock {
  index: number;
  lineStart: number;
  lineEnd: number;
  html: string;
}

const parser = new DOMParser();

export function parseBlocks(html: string): MdBlock[] {
  const doc = parser.parseFromString(`<body>${html}</body>`, 'text/html');
  const nodes = Array.from(doc.body.childNodes).filter(
    (n) => n.nodeType === Node.ELEMENT_NODE || (n.nodeType === Node.TEXT_NODE && n.textContent?.trim()),
  );
  let cursorLine = 0;
  return nodes.map((node, index) => {
    const el = node as Element;
    const ls = Number(el.getAttribute?.('data-line-start'));
    const le = Number(el.getAttribute?.('data-line-end'));
    // Blocks without position data still render; they just can't anchor comments.
    const lineStart = Number.isFinite(ls) && ls > 0 ? ls : cursorLine + 1;
    const lineEnd = Number.isFinite(le) && le > 0 ? Math.max(le, lineStart) : lineStart;
    cursorLine = lineEnd;
    return {
      index,
      lineStart,
      lineEnd,
      html: node.nodeType === Node.ELEMENT_NODE ? el.outerHTML : escapeHtml(node.textContent ?? ''),
    };
  });
}

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
