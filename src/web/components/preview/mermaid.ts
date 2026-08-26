/**
 * Client-side Mermaid rendering for fenced ```mermaid blocks.
 *
 * The server renders mermaid fences as plain `<pre><code class="language-mermaid">`
 * (mermaid needs a live DOM, so it can't run in the unified pipeline). After
 * PreviewPane mounts a page of blocks, `renderMermaidBlocks` swaps each such
 * code block for an SVG rendered in the browser.
 *
 * Design constraints from the block↔line comment contract:
 *  - Only content INSIDE the `.md-block` wrapper is touched, so
 *    `data-line-start`/`data-line-end` anchors and comment threads stay put.
 *  - On a diagram parse/render error the original source stays visible,
 *    flagged with `.md-mermaid-error` — plans must stay readable.
 *
 * The mermaid bundle (~1 MB) is loaded lazily on first use via dynamic import;
 * pages without diagrams never pay for it. Re-invoking with a different theme
 * re-initializes mermaid; React wipes our mutations whenever block HTML
 * changes, so this is safe to call after every relevant render pass.
 */

type MermaidApi = (typeof import('mermaid'))['default'];

let mermaidLoad: Promise<MermaidApi> | null = null;

function loadMermaid(): Promise<MermaidApi> {
  if (!mermaidLoad) {
    mermaidLoad = import('mermaid').then((m) => {
      m.default.initialize({ startOnLoad: false, securityLevel: 'strict' });
      return m.default;
    });
  }
  return mermaidLoad;
}

let renderSeq = 0;

/**
 * Render every pending ```mermaid code block under `container`.
 * Blocks already handled (or failed) are skipped via a data marker.
 */
export async function renderMermaidBlocks(container: HTMLElement, dark: boolean): Promise<void> {
  const targets = Array.from(
    container.querySelectorAll<HTMLElement>('pre > code.language-mermaid'),
  ).filter((code) => !code.dataset.mermaidState);
  if (targets.length === 0) return;

  let mermaid: MermaidApi;
  try {
    mermaid = await loadMermaid();
  } catch {
    // Bundle failed to load (e.g. offline cache miss) — leave sources visible.
    return;
  }

  // Theme applies at initialize time; re-init per batch so toggling works.
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: dark ? 'dark' : 'neutral',
  });

  for (const code of targets) {
    const pre = code.parentElement;
    if (!pre) continue;
    const source = code.textContent ?? '';
    const id = `mermaid-svg-${++renderSeq}`;
    try {
      const { svg } = await mermaid.render(id, source);
      // React may have re-rendered while we awaited — bail if detached.
      if (!pre.isConnected) continue;
      const holder = document.createElement('div');
      holder.className = 'md-mermaid';
      holder.innerHTML = svg;
      pre.replaceWith(holder);
    } catch (err) {
      if (!pre.isConnected) continue;
      code.dataset.mermaidState = 'error';
      pre.classList.add('md-mermaid-error');
      pre.title = err instanceof Error ? err.message : String(err);
    }
  }
}
