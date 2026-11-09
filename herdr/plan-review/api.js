// The agent-plan-review HTTP API, as the web UI uses it (src/web/api/endpoints.ts). No Herdr
// imports: `fetch` is passed in, so node tests can give it a fake.

export class ApiError extends Error {
  /** status 0: no answer at all (the server is not running). */
  constructor(status, message, payload = null) {
    super(message);
    this.status = status;
    this.payload = payload;
  }
  get down() { return this.status === 0; }
}

const enc = encodeURIComponent;

/** What a failed load says on screen. Herdr's limit on background tasks (shared by every mod in
 *  the window) breaks every load until the window restarts, so that one names the way out. */
export function loadErrorText(err) {
  const msg = String(err?.message ?? err ?? "Unknown error");
  if (/outstanding host task limit/i.test(msg)) {
    return "Herdr ran out of background tasks: a mod in this window leaks them. Restart Herdr (your agents keep running), then the plan loads.";
  }
  return msg;
}

/** A client for the server at `base` ("http://127.0.0.1:4620"). */
export function createApi(base, fetchFn = globalThis.fetch) {
  const root = String(base).replace(/\/+$/, "");
  async function request(path, init) {
    let res;
    try {
      res = await fetchFn(`${root}${path}`, { headers: { "content-type": "application/json" }, ...init });
    } catch (err) {
      throw new ApiError(0, err?.message || "The review server is not running");
    }
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = null; }
    if (!res.ok) {
      const message = body && typeof body === "object" && "error" in body ? String(body.error) : `Request failed (${res.status})`;
      throw new ApiError(res.status, message, body);
    }
    return body;
  }
  const get = (p) => request(p);
  const post = (p, body) => request(p, { method: "POST", body: JSON.stringify(body ?? {}) });
  const del = (p) => request(p, { method: "DELETE" });
  const v = (key, n) => `/api/projects/${enc(key)}/versions/${n}`;

  return {
    base: root,
    health: () => get("/api/health"),
    review: (id) => get(`/api/reviews/${enc(id)}`),
    /** The project: { meta, versions: [{ n, createdAt, kind, docCount }] }. */
    project: (key) => get(`/api/projects/${enc(key)}`),
    /** Every review of the project (any status), as the web UI lists them. */
    reviewsOf: (key) => get(`/api/reviews?project=${enc(key)}`).then((r) => (Array.isArray(r) ? r : [])),
    /** The page-by-page diff of two versions (differ.ts's inputs): { docs: [{ slug, title, parent, status, from?, to? }] }. */
    diff: (key, from, to) => get(`/api/projects/${enc(key)}/diff?from=${from}&to=${to}`),
    version: (key, n) => get(v(key, n)),
    doc: (key, n, slug) => get(`${v(key, n)}/docs/${enc(slug)}`),
    comments: (key, n) => get(`${v(key, n)}/comments`).then((r) => r?.comments ?? []),
    addComment: (key, n, input) => post(`${v(key, n)}/comments`, input),
    reply: (key, n, id, input) => post(`${v(key, n)}/comments/${enc(id)}/replies`, input),
    resolve: (key, n, id, resolved) => post(`${v(key, n)}/comments/${enc(id)}/resolve`, { resolved }),
    remove: (key, n, id) => del(`${v(key, n)}/comments/${enc(id)}`),
    decide: (id, decision, summary) => post(`/api/reviews/${enc(id)}/decision`, summary ? { decision, summary } : { decision }),

    /**
     * A version's pages: { kind, root, docs: [{ slug, title, parent, markdown }] }. A single
     * version is one root page; a tree version fetches each document (manifest order).
     */
    async plan(key, n) {
      const p = await get(v(key, n));
      if (p?.kind !== "tree" || !p.manifest) {
        return { kind: "single", root: "root", docs: [{ slug: "root", title: null, parent: null, markdown: p?.markdown ?? "" }] };
      }
      const docs = await Promise.all(p.manifest.docs.map(async (d) => {
        const doc = await get(`${v(key, n)}/docs/${enc(d.slug)}`);
        return { slug: d.slug, title: d.title ?? doc?.title ?? null, parent: d.parent ?? null, markdown: doc?.markdown ?? "" };
      }));
      return { kind: "tree", root: p.manifest.root, docs };
    },
  };
}
