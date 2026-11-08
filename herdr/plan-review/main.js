// Plan review in Herdr: the plan an agent submitted to agent-plan-review, drawn word by word,
// with drag selection, comment threads in the margin, a page tree and the decision bar. Every
// comment, reply, Ask and decision goes to the agent-plan-review server, so the agent gets it.
//
// Which plan: the agent terminal's pointer file, <app home>/data/plan-review/<terminal>.json,
// written by the server (`agent-plan-review herdr enable`).
//
// Props: {}                 the plan of the agent in the focused tab (a pane beside the agent, or
//                           the plan side of the layout's stack)
//        { terminal }       that agent's plan
//        { terminal, window: true, page? }   the same, in an "Open in window" overlay
//
// Keyboard: when the plan is flipped to (or another agent is shown while the plan is up) the mod takes
// the keyboard itself, so plan keys never reach the hidden agent terminal. Commands (keys.json, `run`):
// `plan-review.back` / `.flip` (to the agent, keyboard back to its pane), `.focus` (take the keyboard).
//
// Server: the pointer's `server`, else install.json (written by `agent-plan-review herdr
// install`) and agent-plan-review's server.json. "Start server" runs install.json's command.

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, TextareaState, Textarea, Popover } from "gpui-base";
import { props, theme, settings, appHome, readTextFile, exec, notify, watchFolder, nextCommand, run, setShared, openOverlay, closeOverlay, focused, panes, shared, layout } from "herdr";
import { planFromDocs, planWithRemoved, pageOr, neighbour, ancestors, treeRows } from "./plan.js";
import { parsePage, wordText } from "./markdown.js";
import { range, inRange, extend, flowRange, rangeText, tintMap, threadAt } from "./selection.js";
import { threadsFromComments, anchorOf, openCounts, layoutMargin, ago } from "./threads.js";
import { makeUnits, changedUnits, unitsByBlock } from "./units.js";
import { POINTER_DIR, IMAGE_DIR, STACK, AGENT_VIEW, PLAN_VIEW, VIEW_KEY, STATES, parsePointer, terminalOfFile, touchesPointers, planFor, stackActive, harnessName } from "./pointer.js";
import { parseInstall, serverUrl, reviewPageUrl, startScript, pollDelay } from "./server.js";
import { createApi } from "./api.js";
import { delivery, withDelivery, sentLabel, decisionState } from "./review.js";
import { buildDiffPage, collapseRows, removedRowOf } from "./diff.js";
import { VERSION_STATES, PAGE_MARKS, versionList, shownVersion, pointerFor, diffBase, stepBase, neighbourVersion, diffIndex } from "./versions.js";

const MOD = "mods/plan-review";
const ICON = (n) => `${MOD}/icons/${n}.svg`;
const SIDEBAR_W = 256;
const MARGIN_W = 300;
const GAP = 36;
const PAD = 40;
const TEXT_DEFAULT = 700; // before the first layout; the text itself fills the pane (see render)
const TEXT_MIN = 460;
const BASE = 15;
const LINE = 26;
const COMPOSER = "__composer";
const GAP_H = 30; // a folded run of unchanged lines in a diff
// Herdr's bundled UI font draws no bold or italic; the system font has both.
const PROSE_FONT = ".SystemUIFont";
const IMAGE_RE = /(?:^|\/)api\/images\/([A-Za-z0-9._-]+)$/;

// The page is drawn as retained child views, one per unit (units.js), so a selection step redraws
// only the units whose words changed tint, not the whole page. A unit reads everything from its
// plan view, found here by id.
const HOSTS = (globalThis.__planReviewHosts ??= new Map());

// Pages with more words than this mount only the units near the viewport. Below it the whole
// page is mounted: a drag step there already fits a frame (1,162 words: ~16 ms).
const VIRTUAL_WORDS = 3000;

// Where an event's element starts, in window coordinates: the pointer in the window minus the
// pointer in the element.
const originY = (e) => (e?.position && e.local_position ? e.position.y - e.local_position.y : e?.bounds?.y ?? null);
const sleep = (cx, ms) => new Promise((ok) => cx.timer.after(ms, () => ok()));

class UnitView extends View {
  init(p) { this.p = p; }
  update(p) { this.p = p; }
  render(_cx) { return HOSTS.get(this.p.host)?.unitElement(this.p.key, this.p.unit) ?? div(); }
}

export default class PlanReview extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.home = appHome();
    this.windowed = !!p.window; // opened with "Open in window": one agent's plan, fixed
    this.fixed = typeof p.terminal === "string" && p.terminal ? p.terminal : null; // a fixed agent
    this.startPage = typeof p.page === "string" ? p.page : null;
    // For screenshots and tests of states that need a mouse: select: [from, to] word range,
    // composer: text to open the composer with (on the selection, else the whole page),
    // active: index of a thread on the page to focus, resolved: show resolved threads.
    this.startProps = p.select || p.composer != null || p.active != null || p.resolved ? p : null;
    this.terminal = null; // the agent the shown plan belongs to
    this.handle = cx.focus_handle();
    this.hostId = `h${Date.now().toString(36)}${Math.floor(Math.random() * 1e6)}`;
    HOSTS.set(this.hostId, this);
    this.ui = null; // the current page's units and their views
    this.storeVersion = 0;
    this.docs = new Map(); // "projectKey@version" → doc
    this.doc = null;
    this.pointers = new Map(); // terminal → pointer
    this.pointerRaw = new Map();
    this.install = parseInstall(null);
    this.server = { down: false, starting: false, error: null };
    this.sel = null; // { anchor, focus } word indexes on the current page
    this.press = null; // a press on a word in progress
    this.pill = null; // { x, y }: where the "Comment" pill floats, in content coordinates
    this.composer = null; // { r | null, state, doc }
    this.replying = null; // { id, state, doc }
    this.deciding = null; // { kind: "approve" | "reject", state, doc }
    this.busy = null; // what is being sent ("comment", "reply", "decide", …)
    this.typing = false;
    this.active = null; // focused thread id
    this.confirmDelete = null;
    this.showResolved = false;
    this.sidebar = null; // the page tree: null = shown when the view is wide enough
    this.versionsOpen = false; // the version list (a Popover) is open
    this.width = 1200;
    this.blockH = new Map();
    this.winTop = new Map(); // page → top of the mounted window, from the scroll position
    this.subH = new Map(); // list item and table row heights, for anchoring cards
    this.cardH = new Map();
    this.projects = new Map(); // project key → { list: [version + review state], raw }
    this.vpick = new Map(); // terminal → { n, follow }: the version picked while the pointer names `follow`
    this.diffOn = false; // diff mode: the shown version against an earlier one
    this.baseOf = new Map(); // terminal → the chosen base version
    this.allExpanded = false; // diff mode: every unchanged line shown

    // Units are made outside render: render asks for them, this task makes them (a few per frame).
    // It also loads the plan render asked for, and redraws this view for handlers that run in a
    // unit's context.
    cx.spawn(async (cx) => {
      for (;;) {
        if (!this.wakePending) await new Promise((ok) => { this.waker = ok; });
        this.wakePending = false;
        await sleep(cx, 0);
        if (this.wantDoc) { const t = this.wantDoc; this.wantDoc = null; await this.ensureDoc(t, cx); }
        if (this.wantDiff) { const w = this.wantDiff; this.wantDiff = null; await this.ensureDiff(w, cx); }
        if (this.startProps && this.doc?.plan && this.page()) this.applyStartProps();
        if (this.doc?.plan && this.slug && this.ui?.key !== this.pageKey()) this.prepareUnits(cx);
        else if (this.ui && this.ui.next < this.ui.units.length) this.createUnits(cx, 1500);
        this.touch(cx);
      }
    });
    // The keyboard: asked for when the plan is flipped to, or by `plan-review.focus`. The element is
    // not in the window yet in the frame the plan first shows, so focus() is retried until it holds.
    cx.spawn(async (cx) => {
      for (;;) {
        if (!this.keysWanted) await new Promise((ok) => { this.keysWaker = ok; });
        for (let i = 0; this.keysWanted && i < 25; i++) {
          await sleep(cx, 40);
          try { this.handle.focus(); await sleep(cx, 20); if (this.handle.is_focused()) break; } catch { break; }
        }
        this.keysWanted = false;
      }
    });
    cx.spawn(async (cx) => {
      for (;;) {
        const c = String(await nextCommand()).replace(/^plan-review\./, "");
        if (c === "back" || c === "flip") this.flipBack();
        else if (c === "focus" && !this.windowed) this.wantKeys();
        else if (c === "window" && !this.windowed) this.openWindow();
        else if (c === "close-window" && this.windowed) closeOverlay(props()?.overlay);
        else if (c === "refresh" && this.doc) await this.refreshDoc(this.doc, cx, { force: true });
        else if (c === "start-server" && this.server.down && !this.server.starting) await this.startServer(cx);
        else if (this.page()) this.command(c, cx);
        else if (c === "virtual") { this.virtual = this.virtual === false; console.log("plan-review: mount only near the viewport:", this.virtual); }
        this.touch(cx);
      }
    });
    // Pointer files: read them all, then again whenever one changes.
    cx.spawn(async (cx) => {
      const dir = `${this.home}/${POINTER_DIR}`;
      await exec("mkdir", ["-p", dir]).catch(() => null);
      this.install = parseInstall(await readTextFile(`${this.home}/${MOD}/install.json`).catch(() => null));
      await this.readPointers(null, cx);
      for (;;) {
        const changed = await watchFolder(dir).catch(() => null);
        if (!changed) { await sleep(cx, 5000); await this.readPointers(null, cx); continue; }
        const mine = changed.filter((c) => touchesPointers(c, dir));
        if (mine.length) await this.readPointers(mine.includes(dir) || mine.includes(`${dir}/`) ? null : mine, cx);
      }
    });
    // Live updates while a pending plan is on screen: the web page's backoff (2.5, 5, 15, 30 s),
    // restarted when the plan comes back into view; nothing is asked while it is hidden.
    cx.spawn(async (cx) => {
      let since = Date.now(), was = null;
      for (;;) {
        const d = this.doc;
        // The "server not running" screen: look for it every few seconds, load once it answers.
        if (this.server.down && !this.server.starting && !d?.plan && this.target() && this.isShown()) {
          await sleep(cx, 4000);
          const up = await (await this.apiFor(this.target()?.pointer ?? null)).health().then(() => true, () => false);
          if (up && this.server.down) { this.retry(cx); this.touch(cx); }
          continue;
        }
        const live = !!d?.plan && (d.review?.status === "pending" || this.server.down) && this.isShown();
        if (!live) { was = null; await sleep(cx, 1000); continue; }
        if (was !== d) {
          // Just shown (or another plan): fresh data now, then the responsive cadence.
          if (Date.now() - (d.loadedAt ?? 0) > 1500) await this.refreshDoc(d, cx);
          was = d;
          since = Date.now();
        }
        await sleep(cx, pollDelay(Date.now() - since));
        if (this.doc === d && this.isShown()) await this.refreshDoc(d, cx);
      }
    });
  }

  // ---------------------------------------------------------------------------- data

  // The doc's fields, read through the view so the drawing code does not care which plan it is.
  get plan() { return this.diffMode()?.plan ?? this.doc?.plan ?? null; }
  get slug() { return this.doc?.slug ?? null; }
  set slug(v) { if (this.doc) this.doc.slug = v; }
  get threads() {
    const d = this.doc;
    if (!d) return [];
    // In a diff the words are the diff's, so threads are placed on those.
    const dp = this.diffPage();
    if (!dp) return d.threads;
    if (dp.thr?.src !== d.threads) {
      const wordsOf = (slug) => (slug === this.slug ? dp.words : d.plan.bySlug.has(slug) ? this.parsedIn(d, slug).words : null);
      dp.thr = { src: d.threads, list: threadsFromComments(d.comments, wordsOf) };
    }
    return dp.thr.list;
  }
  get images() { return this.doc?.images ?? new Map(); }
  get review() { return this.doc?.review ?? null; }

  /** Re-reads pointer files (`files`: only these; null: the whole folder). */
  async readPointers(files, cx) {
    const dir = `${this.home}/${POINTER_DIR}`;
    let list = files;
    if (!list) {
      const r = await exec("ls", ["-1", dir]).catch(() => null);
      const names = (r?.stdout ?? "").split("\n").filter((n) => n.endsWith(".json"));
      list = names.map((n) => `${dir}/${n}`);
      for (const t of [...this.pointers.keys()]) if (!names.includes(`${t}.json`)) { this.pointers.delete(t); this.pointerRaw.delete(t); }
    }
    let any = false;
    for (const f of list) {
      const terminal = terminalOfFile(f);
      if (!terminal) continue;
      const raw = await readTextFile(f).catch(() => null);
      if (raw === (this.pointerRaw.get(terminal) ?? null)) continue;
      any = true;
      const ptr = raw == null ? null : parsePointer(raw);
      this.pointerRaw.set(terminal, raw);
      if (ptr) this.pointers.set(terminal, ptr); else this.pointers.delete(terminal);
      // The pointer moves on every agent reply, resolve and decision: refresh what is loaded.
      const d = ptr && this.docs.get(this.docKey(ptr));
      if (d && d.plan && d.pointer?.updatedAt !== ptr.updatedAt) { d.pointer = ptr; await this.refreshDoc(d, cx); }
    }
    if (any) this.touch(cx);
  }

  docKey(ptr) { return `${ptr.projectKey}@${ptr.version}`; }

  /** The agent and pointer to show: { terminal, pointer } or null. */
  target() {
    let t;
    if (this.fixed) {
      const ptr = this.pointers.get(this.fixed);
      t = ptr ? { terminal: this.fixed, pointer: ptr } : null;
    } else t = planFor(this.pointers, focused(), panes());
    if (!t) return null;
    // A version picked in the switcher holds while the pointer still names the newest one the
    // pick was made on; a newer plan from the agent brings the newest version back.
    const newest = t.pointer.version;
    const pick = this.vpick.get(t.terminal);
    if (pick && pick.follow !== newest) this.vpick.delete(t.terminal);
    const list = this.versions(t.pointer.projectKey);
    return { terminal: t.terminal, pointer: pointerFor(t.pointer, shownVersion(newest, this.vpick.get(t.terminal), list), list), newest };
  }

  /** The project's versions with their review state, oldest first (empty until loaded). The shown version takes its live review. */
  versions(key = this.doc?.pointer.projectKey) {
    const list = this.projects.get(key)?.list ?? [];
    const d = this.doc;
    if (!d?.review || d.pointer.projectKey !== key) return list;
    return list.map((v) => (v.n === d.pointer.version && d.review.status in VERSION_STATES ? { ...v, status: d.review.status } : v));
  }

  /** Shows version n of the plan (null: ignored); the page stays when it exists there. */
  pickVersion(n, cx) {
    const t = this.target();
    if (n == null || !t || n === t.pointer.version) return;
    if (n === t.newest) this.vpick.delete(t.terminal); else this.vpick.set(t.terminal, { n, follow: t.newest });
    const keep = this.slug;
    const next = this.target();
    const d2 = next && this.docs.get(this.docKey(next.pointer));
    if (d2?.plan) {
      d2.slug = pageOr(d2.plan, keep);
      cx.spawn((cx) => this.refreshDoc(d2, cx, { force: true }));
    } else this.startPage = keep;
    this.wakeHost();
    this.touch(cx);
  }

  toggleDiff(cx) {
    this.diffOn = !this.diffOn;
    this.sel = this.pill = this.press = null;
    this.closeComposer();
    if (!this.diffOn && this.doc?.plan) this.slug = pageOr(this.doc.plan, this.slug);
    this.active = null;
    this.wakeHost();
    this.touch(cx);
  }

  /** The version a diff of the shown one compares with, or null (the first version has none). */
  diffBaseOf(d = this.doc) {
    if (!d) return null;
    return diffBase(d.pointer.version, this.baseOf.get(this.terminal), this.versions(d.pointer.projectKey));
  }

  stepDiffBase(step, cx) {
    const d = this.doc;
    const base = this.diffBaseOf();
    if (!d || base == null) return;
    this.baseOf.set(this.terminal, stepBase(d.pointer.version, base, step, this.versions()));
    this.sel = this.pill = this.press = null;
    this.closeComposer();
    this.active = null;
    this.wakeHost();
    this.touch(cx);
  }

  /** The loaded diff of the shown version against its base, when diff mode is on; else null. */
  diffMode() {
    const d = this.doc;
    if (!this.diffOn || !d?.plan) return null;
    const base = this.diffBaseOf(d);
    const x = base == null ? null : d.diffs.get(base);
    return x?.index ? x : null;
  }

  /** The diff of the shown page: { rows, words, stats, status, page }. */
  diffPage() {
    const df = this.diffMode();
    if (!df || !this.slug) return null;
    let dp = df.pages.get(this.slug);
    if (!dp) {
      const status = df.index.status.get(this.slug) ?? "unchanged";
      const pg = this.doc.plan.bySlug.get(this.slug);
      const now = pg ? pg.lines.join("\n") : "";
      const before = status === "added" ? "" : df.index.from.has(this.slug) ? df.index.from.get(this.slug) : now;
      dp = buildDiffPage(before, status === "removed" ? "" : now);
      dp.status = status;
      dp.base = df.base;
      dp.page = { words: dp.words, blocks: [], diff: true, dp };
      df.pages.set(this.slug, dp);
    }
    return dp;
  }

  /** Whether this copy is on screen (polling pauses when not). */
  isShown() {
    if (this.windowed) return true;
    const side = shared(VIEW_KEY);
    if (this.hasStack() && side != null && side !== PLAN_VIEW) return false;
    if (this.fixed) {
      const f = focused();
      const pane = panes().find((p) => p.terminal === this.fixed);
      return !pane || !f || pane.tab === f.tab;
    }
    return true;
  }

  applyStartProps() {
    const p = this.startProps;
    this.startProps = null;
    const n = this.page().words.length - 1;
    if (Array.isArray(p.select) && n >= 0) {
      this.sel = { anchor: Math.min(p.select[0], n), focus: Math.min(p.select[1], n) };
      this.pill = p.composer == null ? { x: 320, y: null } : null;
    }
    if (p.composer != null) this.openComposer(range(this.sel), String(p.composer));
    if (p.resolved) this.showResolved = true;
    if (typeof p.active === "number") this.active = this.threadsHere()[p.active]?.id ?? null;
  }

  // Key commands (keys.json "<key>": "plan-review.<command>", or `herdr-app do plan-review.<command>`).
  command(c, cx) {
    if (c === "send") {
      if (this.deciding) this.decide(cx);
      else if (this.composer) this.saveComposer("decision", cx);
      else if (this.replying) this.saveReply("decision", cx);
    }
    else if (c === "ask") { if (this.composer) this.saveComposer("ask", cx); else if (this.replying) this.saveReply("ask", cx); }
    else if (c === "comment") this.openComposer(range(this.sel));
    else if (c === "comment-page") this.openComposer(null);
    else if (c === "approve") this.openDecision("approve");
    else if (c === "request-changes") this.openDecision("reject");
    else if (c === "reply" && this.active && this.active !== "__composer") this.openReply(this.active);
    else if (c === "resolve" && this.active && this.active !== "__composer") this.toggleResolved(this.active, cx);
    else if (c === "next" || c === "prev") this.goto(neighbour(this.plan, this.slug, c === "next" ? 1 : -1), cx);
    else if (c === "resolved") this.showResolved = !this.showResolved;
    else if (c === "browser") this.openBrowser(cx);
    else if (c === "diff") this.toggleDiff(cx);
    else if (c === "versions") { if (this.versions().length > 0) this.versionsOpen = !this.versionsOpen; }
    else if (c === "prev-version" || c === "next-version") this.pickVersion(neighbourVersion(this.versions(), this.doc.pointer.version, c === "next-version" ? 1 : -1), cx);
  }

  sidebarOn() { return this.sidebar ?? this.width >= 1000; }

  hasStack() { try { return stackActive(layout()) !== null; } catch { return false; } }

  async apiFor(ptr) {
    const serverJson = this.install.home ? await readTextFile(`${this.install.home}/server.json`).catch(() => null) : null;
    return createApi(serverUrl({ pointer: ptr, install: this.install, serverJson }));
  }

  /** Loads a plan (once per version); a known one only takes the newer pointer. */
  async ensureDoc(t, cx) {
    const key = this.docKey(t.pointer);
    let d = this.docs.get(key);
    if (d && (d.plan || d.loading)) return d;
    if (!d) { d = { key, pointer: t.pointer, pages: new Map(), images: new Map(), diffs: new Map(), slug: null, plan: null, threads: [], comments: [], ver: 0 }; this.docs.set(key, d); }
    d.loading = true;
    d.error = null;
    d.pointer = t.pointer;
    this.touch(cx);
    try {
      d.api = await this.apiFor(t.pointer);
      const { pointer } = d;
      const [pl, review, comments] = await Promise.all([
        d.api.plan(pointer.projectKey, pointer.version),
        pointer.reviewId ? d.api.review(pointer.reviewId).catch((e) => { if (e.down) throw e; return null; }) : null,
        d.api.comments(pointer.projectKey, pointer.version),
        this.loadProject(d.api, pointer.projectKey),
      ]);
      d.plan = planFromDocs(pl.docs, pl.root);
      d.ver++;
      d.pages = new Map();
      d.review = review;
      d.reviewRaw = JSON.stringify(review);
      d.commentsRaw = JSON.stringify(comments);
      d.slug = this.startPage && d.plan.bySlug.has(this.startPage) ? this.startPage : d.plan.root;
      this.startPage = null;

      this.setThreads(d, comments);
      this.server.down = false;
      d.loadedAt = Date.now();
      await this.resolveImages(d);
    } catch (e) {
      if (e?.down) this.server.down = true;
      d.error = e?.down ? null : e?.message ?? String(e);
    }
    d.loading = false;
    this.touch(cx);
    return d;
  }

  /** New review state and comments from the server; redraws only when something changed. */
  async refreshDoc(d, cx, { force = false } = {}) {
    if (!d?.api || !d.plan) {
      if (d && !d.loading && !d.plan) { this.docs.delete(d.key); this.wakeHost(); }
      return;
    }
    try {
      const [review, comments] = await Promise.all([
        d.pointer.reviewId ? d.api.review(d.pointer.reviewId).catch((e) => { if (e.down) throw e; return d.review; }) : null,
        d.api.comments(d.pointer.projectKey, d.pointer.version),
      ]);
      const wasDown = this.server.down;
      this.server.down = false;
      const rr = JSON.stringify(review), cr = JSON.stringify(comments);
      if (!force && !wasDown && rr === d.reviewRaw && cr === d.commentsRaw) return;
      if (rr !== d.reviewRaw) { d.review = review; d.reviewRaw = rr; await this.loadProject(d.api, d.pointer.projectKey); }
      if (cr !== d.commentsRaw || force) { d.commentsRaw = cr; this.setThreads(d, comments); }
      this.touch(cx);
    } catch (e) {
      if (e?.down && !this.server.down) { this.server.down = true; this.touch(cx); }
    }
  }

  /** The project's versions and their reviews (the switcher). Errors leave the old list. */
  async loadProject(api, key) {
    const [proj, reviews] = await Promise.all([api.project(key).catch((e) => { if (e.down) throw e; return null; }), api.reviewsOf(key).catch((e) => { if (e.down) throw e; return []; })]);
    if (!proj) return;
    const list = versionList(proj.versions, reviews);
    const raw = JSON.stringify(list);
    if (this.projects.get(key)?.raw !== raw) this.projects.set(key, { list, raw });
  }

  /** Loads the diff of a doc's version against `base` once: the page-by-page changes. */
  async ensureDiff({ d, base }, cx) {
    if (!d?.api || d.diffs.has(base)) return;
    d.diffs.set(base, { loading: true });
    try {
      const index = diffIndex(await d.api.diff(d.pointer.projectKey, base, d.pointer.version));
      d.diffs.set(base, { base, index, plan: planWithRemoved(d.plan, index.removed), pages: new Map() });
    } catch (e) {
      d.diffs.delete(base);
      if (e?.down) this.server.down = true;
      else { this.diffOn = false; notify({ title: "Could not load the changes", body: e?.message ?? String(e), level: "error", timeout: 4500 }); }
    }
    this.touch(cx);
  }

  setThreads(d, comments) {
    d.comments = comments;
    d.threads = threadsFromComments(comments, (slug) => (d.plan.bySlug.has(slug) ? this.parsedIn(d, slug).words : null));
    if (d === this.doc) {
      this.storeVersion++;
      if (this.active && this.active !== COMPOSER && !d.threads.some((t) => t.id === this.active)) this.active = null;
    }
  }

  parsedIn(d, slug) {
    if (!d.pages.has(slug)) {
      const pg = d.plan.bySlug.get(slug);
      d.pages.set(slug, parsePage(pg.lines, pg.startLine, (s) => d.plan.bySlug.get(s)));
    }
    return d.pages.get(slug);
  }

  parsed(slug) { return this.parsedIn(this.doc, slug); }

  page() {
    if (!this.doc?.plan || !this.slug) return null;
    const dp = this.diffPage();
    if (dp) return dp.page;
    return this.doc.plan.bySlug.has(this.slug) ? this.parsed(this.slug) : null;
  }

  threadsHere() {
    const order = (t) => (t.kind === "page" ? -1 : t.words ? t.words[0] : 1e9);
    return this.threads.filter((t) => t.page === this.slug).sort((a, b) => order(a) - order(b) || a.createdAt - b.createdAt);
  }

  // Images: plans reference /api/images/<file>. Herdr draws images only from its own folder, so
  // each is copied there once: from agent-plan-review's images/ folder, else downloaded.
  async resolveImages(d) {
    const srcs = new Set();
    const walk = (bs) => bs.forEach((b) => { if (b.type === "image") srcs.add(b.src); if (b.type === "quote") walk(b.blocks); });
    for (const pg of d.plan.pages) walk(this.parsedIn(d, pg.slug).blocks);
    if (!srcs.size) return;
    const dir = `${this.home}/${IMAGE_DIR}`;
    await exec("mkdir", ["-p", dir]).catch(() => null);
    for (const src of srcs) {
      if (d.images.has(src)) continue;
      const m = IMAGE_RE.exec(src.replace(/[?#].*$/, ""));
      if (!m) { d.images.set(src, { missing: /^https?:/.test(src) ? "Web images are not shown here: Open in browser." : `Image not found: ${src}` }); continue; }
      const file = m[1];
      const abs = `${dir}/${file}`;
      const dims = async () => { const info = await exec("file", ["-b", abs]).catch(() => null); return info && /(\d+)\s*x\s*(\d+)/.exec(info.stdout); };
      let size = await dims();
      if (!size && this.install.home) { await exec("cp", [`${this.install.home}/images/${file}`, abs]).catch(() => null); size = await dims(); }
      if (!size) { await exec("curl", ["-sf", "--max-time", "10", "-o", abs, `${d.api.base}/api/images/${file}`]).catch(() => null); size = await dims(); }
      if (!size) { d.images.set(src, { missing: `Image not shown: ${file}` }); continue; }
      // Diagrams are rendered at 2–3× scale; show them at half their pixel width at most.
      d.images.set(src, { path: `${IMAGE_DIR}/${file}`, w: +size[1] / 2, h: +size[2] / 2 });
    }
  }

  // ---------------------------------------------------------------------------- server

  async startServer(cx) {
    const script = startScript(this.install, this.home);
    if (!script) return;
    this.server.starting = true;
    this.server.error = null;
    this.touch(cx);
    await exec("/bin/sh", ["-c", script]).catch((e) => { this.server.error = e?.message ?? String(e); });
    const ptr = this.target()?.pointer ?? null;
    let up = false;
    for (let i = 0; i < 40 && !up; i++) {
      await sleep(cx, 250);
      up = await (await this.apiFor(ptr)).health().then(() => true, () => false);
    }
    this.server.starting = false;
    if (!up) this.server.error = this.server.error ?? "The server did not start. Run `agent-plan-review serve` in a terminal to see why.";
    else this.retry(cx);
    this.touch(cx);
  }

  /** Forget plans that failed to load and ask again. */
  retry(cx) {
    this.server.down = false;
    for (const [k, d] of this.docs) if (!d.plan && !d.loading) this.docs.delete(k);
    if (this.doc?.plan) cx.spawn((cx) => this.refreshDoc(this.doc, cx, { force: true }));
    this.wakeHost();
  }

  // ---------------------------------------------------------------------------- actions

  /** Runs one server call for the shown plan, then refreshes it; errors become a toast. */
  async send(what, cx, fn, ok) {
    const d = this.doc;
    if (!d?.api || this.busy) return null;
    this.busy = what;
    this.touch(cx);
    let out = null;
    try {
      out = await fn(d.api, d);
      if (ok) notify({ title: typeof ok === "function" ? ok(out) : ok, level: "success", timeout: 2200 });
    } catch (e) {
      if (e?.down) this.server.down = true;
      notify({ title: e?.down ? "The review server is not running" : "Not sent", body: e?.down ? "Start it and try again." : e?.message ?? String(e), level: "error", timeout: 4500 });
      out = null;
    }
    this.busy = null;
    await this.refreshDoc(d, cx, { force: true });
    this.touch(cx);
    return out;
  }

  goto(slug, cx) {
    if (!slug || !this.plan.bySlug.has(slug)) return;
    if (slug !== this.slug) {
      this.slug = slug;
      this.sel = null;
      this.pill = null;
      this.active = null;
      this.closeComposer();
      this.closeReply();
    }
    if (cx) this.prepareUnits(cx);
  }

  /** Ask for the keyboard (see init): plan keys must not reach the hidden agent terminal. */
  wantKeys() {
    this.keysWanted = true;
    const w = this.keysWaker;
    if (w) { this.keysWaker = null; w(); }
  }

  flipBack() {
    if (this.windowed || !this.hasStack()) return;
    run("layout.select", { stack: STACK, child: AGENT_VIEW });
    setShared(VIEW_KEY, AGENT_VIEW);
    // Give the keyboard back to the tab's pane, so typing reaches the agent again.
    const pane = focused()?.pane;
    if (pane) run("pane.focus", { pane });
  }

  openWindow() {
    if (!this.doc || !this.terminal) return;
    openOverlay({ kind: "window", mod: "plan-review", key: `plan-${this.terminal}`, width: 1100, height: 760,
      props: { terminal: this.terminal, window: true, page: this.slug } });
    this.flipBack();
  }

  openBrowser(cx) {
    const d = this.doc;
    if (d?.api) cx.open_url(reviewPageUrl(d.api.base, d.pointer));
  }

  // ---------------------------------------------------------------------------- units

  pageKey() {
    const df = this.diffMode();
    return `${this.doc?.key}#${this.slug}#${this.doc?.ver}${df ? `#d${df.base}` : ""}`;
  }

  // The key of the scroll area and the window position: a diff scrolls on its own.
  viewKey() { return this.diffMode() ? `${this.slug}~d` : this.slug; }

  // Made in a handler or a task (never in render): the first ~1,500 words now, the rest a chunk per frame.
  prepareUnits(cx) {
    const key = this.pageKey();
    if (this.ui?.key === key) return;
    this.releaseUnits();
    const page = this.page();
    if (!page) return;
    // A diff page: one unit per row (removed rows too), so heights are measured per row and a
    // selection step redraws only the rows whose words changed tint.
    const { units, wordUnit } = page.diff
      ? { units: page.dp.rows.map((_r, k) => ({ id: k, block: k, kind: "row", from: 0, to: 0 })), wordUnit: Int32Array.from(page.words, (w) => w.row) }
      : makeUnits(page.blocks, page.words.length);
    const size = new Int32Array(units.length);
    for (const u of wordUnit) if (u >= 0) size[u]++;
    this.ui = { key, units, wordUnit, size, byBlock: page.diff ? null : unitsByBlock(units), diff: !!page.diff, ents: new Map(), next: 0, weights: new Map(), h: new Float64Array(units.length).fill(-1) };
    this.lastSig = this.tintSig();
    this.createUnits(cx, 1500);
  }

  createUnits(cx, budget) {
    const ui = this.ui;
    let words = 0;
    while (ui.next < ui.units.length && (words < budget || words === 0)) {
      const u = ui.units[ui.next++];
      ui.ents.set(u.id, cx.new(UnitView, { host: this.hostId, key: ui.key, unit: u.id }));
      words += ui.size[u.id] + 1;
    }
    if (ui.next < ui.units.length) this.wakeHost();
  }

  releaseUnits() {
    if (this.ui) for (const e of this.ui.ents.values()) { try { e.release(); } catch {} }
    this.ui = null;
  }

  wakeHost() {
    const w = this.waker;
    if (w) { this.waker = null; w(); } else this.wakePending = true;
  }

  // What the word tints depend on, besides the selection.
  tintSig() {
    const imgs = this.doc?.images ? [...this.doc.images.values()].filter((x) => x.path || x.missing).length : 0;
    return `${this.pageKey()}|${this.active}|${this.showResolved}|${this.storeVersion}|${this.textW}|${imgs}`;
  }

  // Redraw this view; when the tints may have changed, every unit too.
  touch(cx) {
    cx.notify();
    const sig = this.tintSig();
    if (this.ui && sig !== this.lastSig) {
      this.lastSig = sig;
      this.tints = null;
      for (const e of this.ui.ents.values()) cx.notify(e);
    }
  }

  // The selection: redraw only the units whose words changed tint.
  setSel(next, cx) {
    const before = range(this.sel);
    this.sel = next;
    if (!this.ui) return;
    for (const u of changedUnits(before, range(next), this.ui.wordUnit)) { const e = this.ui.ents.get(u); if (e) cx.notify(e); }
  }

  // A press on word i. Selection: press, drag, release. The release word (on_mouse_up on the
  // word under the pointer) always decides the end, so the selection is right even if no hover
  // events arrive while the button is held; when they do arrive, the tint follows live.
  // Runs in the unit's context: it redraws units itself and wakes this view only when needed.
  down(i, e, cx) {
    this.wordPressed = true;
    this.handle.focus();
    if (this.pill || this.confirmDelete) { this.pill = null; this.confirmDelete = null; this.wakeHost(); }
    if (e.modifiers?.shift && this.sel) {
      this.setSel(extend(this.sel, i), cx);
      this.press = { anchor: this.sel.anchor, focus: i, shift: true, clicks: 1, moved: true };
    } else if (e.click_count >= 3) {
      const [a, b] = flowRange(this.page().words, i);
      this.setSel({ anchor: a, focus: b }, cx);
      this.press = { anchor: a, focus: b, clicks: 3, moved: true };
    } else if (e.click_count === 2) {
      this.setSel({ anchor: i, focus: i }, cx);
      this.press = { anchor: i, focus: i, clicks: 2, moved: true };
    } else {
      this.press = { anchor: i, focus: i, clicks: 1, moved: false };
    }
  }

  // One drag step: only the units whose words changed tint are redrawn.
  drag(i, cx) {
    const p = this.press;
    if (!p || p.clicks >= 3 || p.focus === i) return;
    p.focus = i;
    if (i !== p.anchor) p.moved = true;
    this.setSel({ anchor: p.anchor, focus: i }, cx);
  }

  // Called from the root after the word and the content have seen the release.
  release(cx) {
    const p = this.press;
    this.press = null;
    if (!p) return;
    const i = p.up ?? p.focus;
    if (!p.moved && i === p.anchor && p.clicks === 1) {
      // A plain click: follow a link, focus a thread, or clear.
      this.setSel(null, cx);
      const w = this.page().words[i];
      const link = w.segs.find((s) => s.link)?.link;
      if (link?.slug && this.plan.bySlug.has(link.slug)) { this.goto(link.slug, cx); this.touch(cx); return; }
      if (link?.url && /^https?:/.test(link.url)) { cx.open_url(link.url); this.touch(cx); return; }
      const t = threadAt(this.threads, this.slug, i);
      this.active = t ? t.id : null;
      this.touch(cx);
      return;
    }
    if (p.clicks === 1 || p.shift) this.setSel({ anchor: p.shift ? this.sel.anchor : p.anchor, focus: i }, cx);
    const at = p.at;
    this.pill = at ? { x: at.x, y: at.y } : { x: 320, y: null };
    this.touch(cx);
  }

  copy(cx) {
    const r = range(this.sel);
    if (!r) return;
    cx.write_to_clipboard(rangeText(this.page().words, r));
    notify({ title: "Copied", body: `${r[1] - r[0] + 1} words`, level: "info", timeout: 1500 });
  }

  // A textarea with the usual wiring: ⌘↩ sends the default action, focus tracks typing.
  textState(placeholder, rows, onSubmit, text = "") {
    const state = TextareaState.new({ placeholder, value: text, rows });
    state.set_auto_grow(rows, rows + 7);
    state.on("submit", (e, cx) => { if (e.secondary) { onSubmit(cx); this.touch(cx); } });
    state.on("focus", () => { this.typing = true; });
    state.on("blur", () => { this.typing = false; });
    state.on("change", (_e, cx) => cx.notify());
    return state;
  }

  openComposer(r, text = "") {
    this.closeComposer();
    const state = this.textState(r ? "Comment on the selected text…" : "Comment on the whole page…", 3, (cx) => this.saveComposer("decision", cx), text);
    this.composer = { r, state, doc: this.doc };
    this.pill = null;
    if (r) this.active = COMPOSER;
    state.focus();
  }

  closeComposer() {
    if (!this.composer) return;
    this.composer.state.release();
    this.composer = null;
    this.typing = false;
    if (this.active === COMPOSER) this.active = null;
    this.handle.focus();
  }

  saveComposer(kind, cx) {
    const c = this.composer;
    const body = c?.state.value().trim();
    if (!body || c.doc !== this.doc || this.busy) return;
    const d = this.doc;
    const anchor = c.r ? anchorOf(this.page().words, c.r) : { line: null, lineEnd: null, quote: null };
    const input = withDelivery({ doc: this.slug, ...anchor, body }, d.review, d.pointer.version, kind);
    cx.spawn(async (cx) => {
      const made = await this.send("comment", cx, (api) => api.addComment(d.pointer.projectKey, d.pointer.version, input), () => sentLabel(input, d.review, d.pointer.version));
      if (!made) return;
      if (this.composer === c) this.closeComposer();
      this.setSel(null, cx);
      this.active = made.id ?? null;
      this.touch(cx);
    });
  }

  openReply(id) {
    this.closeReply();
    const state = this.textState("Reply…", 2, (cx) => this.saveReply("decision", cx));
    this.replying = { id, state, doc: this.doc };
    this.active = id;
    state.focus();
  }

  closeReply() {
    if (!this.replying) return;
    this.replying.state.release();
    this.replying = null;
    this.typing = false;
    this.handle.focus();
  }

  saveReply(kind, cx) {
    const r = this.replying;
    const body = r?.state.value().trim();
    if (!body || r.doc !== this.doc || this.busy) return;
    const d = this.doc;
    const input = withDelivery({ body }, d.review, d.pointer.version, kind);
    cx.spawn(async (cx) => {
      const made = await this.send("reply", cx, (api) => api.reply(d.pointer.projectKey, d.pointer.version, r.id, input), () => sentLabel(input, d.review, d.pointer.version));
      if (made && this.replying === r) this.closeReply();
      this.touch(cx);
    });
  }

  toggleResolved(id, cx) {
    const t = this.threads.find((x) => x.id === id);
    if (!t) return;
    const resolve = t.status === "open";
    const d = this.doc;
    if (resolve && !this.showResolved) this.active = null;
    cx.spawn((cx) => this.send("resolve", cx, (api) => api.resolve(d.pointer.projectKey, d.pointer.version, id, resolve)));
  }

  del(id, cx) {
    if (this.confirmDelete !== id) { this.confirmDelete = id; return; }
    this.confirmDelete = null;
    if (this.replying?.id === id) this.closeReply();
    if (this.active === id) this.active = null;
    const d = this.doc;
    cx.spawn((cx) => this.send("delete", cx, (api) => api.remove(d.pointer.projectKey, d.pointer.version, id), "Thread deleted"));
  }

  openDecision(kind) {
    this.closeDecision();
    const state = this.textState(kind === "approve" ? "Optional note for the agent…" : "Optional summary, e.g. “Focus on the migration”…", 2, (cx) => this.decide(cx));
    this.deciding = { kind, state, doc: this.doc };
    state.focus();
  }

  closeDecision() {
    if (!this.deciding) return;
    this.deciding.state.release();
    this.deciding = null;
    this.typing = false;
    this.handle.focus();
  }

  decide(cx) {
    const dc = this.deciding;
    const d = this.doc;
    if (!dc || dc.doc !== d || !d.review || this.busy) return;
    const summary = dc.state.value().trim() || undefined;
    const decision = dc.kind === "approve" ? "approve" : "reject";
    cx.spawn(async (cx) => {
      const res = await this.send("decide", cx, (api) => api.decide(d.review.id, decision, summary), (r) =>
        decision === "approve"
          ? r?.commentCount ? `Approved with ${r.commentCount} comment${r.commentCount === 1 ? "" : "s"}` : "Approved"
          : "Changes requested");
      if (res && this.deciding === dc) this.closeDecision();
      this.touch(cx);
    });
  }

  key(e, cx) {
    const k = e.keystroke;
    if (k === "escape") {
      if (this.versionsOpen) { this.versionsOpen = false; this.handle.focus(); }
      else if (this.deciding) this.closeDecision();
      else if (this.replying) this.closeReply();
      else if (this.composer) this.closeComposer();
      else if (this.sel || this.pill) { this.setSel(null, cx); this.pill = null; }
      else if (this.active) this.active = null;
      else if (this.hasStack() && !this.windowed) this.flipBack();
      else return;
      cx.stop_propagation();
      return this.touch(cx);
    }
    if (k === "cmd-enter" || k === "ctrl-enter") {
      if (this.deciding) this.decide(cx);
      else if (this.composer) this.saveComposer("decision", cx);
      else if (this.replying) this.saveReply("decision", cx);
      else return;
      cx.stop_propagation();
      return this.touch(cx);
    }
    if (this.typing || !this.page()) return;
    if (k === "cmd-c" && this.sel) { this.copy(cx); return cx.stop_propagation(); }
    if ((k === "enter" || k === "c") && this.sel) { this.openComposer(range(this.sel)); cx.stop_propagation(); return this.touch(cx); }
    const step = k === "]" || k === "alt-down" || k === "j" ? 1 : k === "[" || k === "alt-up" || k === "k" ? -1 : 0;
    if (step) { this.goto(neighbour(this.plan, this.slug, step), cx); cx.stop_propagation(); return this.touch(cx); }
    if (k === "r") { this.showResolved = !this.showResolved; return this.touch(cx); }
    if (k === "d") { this.toggleDiff(cx); cx.stop_propagation(); return this.touch(cx); }
    if (k === "v" && this.versions().length > 0) { this.versionsOpen = !this.versionsOpen; cx.stop_propagation(); return this.touch(cx); }
  }

  // ---------------------------------------------------------------------------- colours

  colors() {
    const t = theme();
    const dark = !!settings().dark;
    return {
      t, dark,
      sel: t.selection,
      comment: t.ansi3 + (dark ? "33" : "40"),
      commentActive: t.ansi3 + (dark ? "70" : "85"),
      resolved: t.dim + "26",
      codeBg: dark ? t.raised : t.chrome,
      chip: dark ? t.raised : t.hover,
      mono: settings().font_family ?? "JetBrains Mono",
      syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, number: t.ansi3, fn: t.ansi4, type: t.ansi6, punct: t.muted, plain: t.foreground },
    };
  }

  // ---------------------------------------------------------------------------- words

  // One word: an element that knows its index. Tints cover the trailing space only when the
  // next word in the same flow carries the same tint, so a tinted run reads as one band.
  // A plain word is one element ("word "); styled runs inside a word add one element each.
  word(w, words, ctx) {
    const { c, tints, sel, size } = ctx;
    const { t } = c;
    const bgOf = (i) => {
      if (inRange(sel, i)) return c.sel;
      const x = tints.get(i);
      if (!x) return null;
      return x.active ? c.commentActive : x.resolved ? c.resolved : c.comment;
    };
    const bg = bgOf(w.i);
    const prev = words[w.i - 1], next = words[w.i + 1];
    const contPrev = !!bg && prev && prev.flow === w.flow && bgOf(prev.i) === bg;
    const contNext = !!bg && next && next.flow === w.flow && bgOf(next.i) === bg && !!w.space;
    const spaceText = w.code ? w.space : w.space ? " " : "";
    const style = (d, s) => {
      if (s.bold) d = d.font_weight(650);
      if (s.italic || s.kind === "comment") d = d.italic();
      if (s.strike) d = d.line_through();
      if (s.link) d = d.text_color(t.accent).cursor_pointer();
      if (s.kind) d = d.text_color(c.syntax[s.kind] ?? t.foreground);
      return d;
    };
    const hooks = (el) => el.id(`w-${this.slug}-${w.i}`).flex_none().cursor_text()
      .on_mouse_down("left", (e, cx) => this.down(w.i, e, cx))
      .on_mouse_up("left", (_e, _cx) => { if (this.press) this.press.up = w.i; })
      .on_hover((h, cx) => { if (h && this.press) this.drag(w.i, cx); });
    const s0 = w.segs[0];
    const chip = (s) => s.code && !w.code;
    if (w.segs.length === 1 && !chip(s0) && !w.spaceCode && (!bg || contNext || !spaceText)) {
      return hooks(style(div(), s0)).child(s0.text + spaceText)
        .when(!!bg, (x) => x.bg(bg)).when(!!bg && !contPrev, (x) => x.rounded_l(3)).when(!!bg && !contNext, (x) => x.rounded_r(3));
    }
    const last = w.segs.length - 1;
    const segs = w.segs.map((s, k) => {
      let d = style(div(), s).child(s.text);
      if (chip(s)) {
        // An inline code chip: rounded at its own ends, which may be inside another word.
        const startChip = k > 0 ? !w.segs[k - 1].code : !(prev && prev.flow === w.flow && prev.spaceCode);
        const endChip = k < last ? !w.segs[k + 1].code : !w.spaceCode;
        return d.font_family(c.mono).text_size(size - 1.5).text_color(t.foreground).bg(bg ?? c.chip)
          .when(startChip, (x) => x.pl(3).rounded_l(4)).when(endChip, (x) => x.pr(3).rounded_r(4));
      }
      return d.when(!!bg, (x) => x.bg(bg)).when(!!bg && k === 0 && !contPrev, (x) => x.rounded_l(3)).when(!!bg && k === last && !contNext, (x) => x.rounded_r(3));
    });
    const space = spaceText ? div().child(spaceText).when(contNext, (x) => x.bg(bg)).when(!contNext && !!w.spaceCode && !w.code, (x) => x.bg(c.chip).font_family(c.mono).text_size(size - 1.5)) : null;
    return hooks(h_flex()).children(segs).when(!!space, (x) => x.child(space));
  }

  flow(f, ctx, opts = {}) {
    const words = this.page().words;
    const size = opts.size ?? BASE;
    const sub = { ...ctx, size };
    return h_flex().flex_wrap().w_full().min_w(0).items_center().text_size(size).line_height(`${opts.line ?? LINE}px`)
      .when(!!opts.weight, (x) => x.font_weight(opts.weight))
      .when(!!opts.color, (x) => x.text_color(opts.color))
      .when(!!opts.center, (x) => x.justify_center())
      .when(!!opts.right, (x) => x.justify_end())
      .children(f.words.map((w) => this.word(w, words, sub)));
  }

  // ---------------------------------------------------------------------------- blocks

  block(b, ctx, nested = false) {
    const { c } = ctx;
    const { t } = c;
    switch (b.type) {
      case "heading": {
        const size = [0, 27, 21, 17.5, 16, 15, 15][b.level];
        const line = Math.round(size * 1.35);
        return v_flex().w_full()
          .child(this.flow(b.flow, ctx, { size, line, weight: b.level === 1 ? 700 : 650 }))
          .when(b.level === 1, (x) => x.child(div().mt(10).h(1).w_full().bg(t.border)));
      }
      case "para":
        return this.flow(b.flow, ctx);
      case "hr":
        return div().w_full().py(6).child(div().h(1).w_full().bg(t.border));
      case "image": {
        const img = this.images.get(b.src);
        if (!img || img.missing) return div().w_full().p(14).rounded(8).border_1().border_color(t.border).text_color(t.dim).text_size(13).child(img?.missing ?? `Loading ${b.alt || "image"}…`);
        const w = Math.min(img.w, ctx.textW - 26);
        return v_flex().w_full().items_center().gap(8)
          .child(div().p(12).rounded(10).bg("#ffffff").border_1().border_color(t.border).child(image(img.path).w(w).h(w * img.h / img.w)))
          .when(!!b.alt, (x) => x.child(div().text_size(12.5).text_color(t.dim).child(b.alt)));
      }
      case "quote":
        return h_flex().w_full().items_start().gap(14)
          .child(div().w(3).flex_none().self_stretch().rounded(2).bg(t.accent + "88"))
          .child(v_flex().flex_1().min_w(0).gap(10).text_color(t.muted).children(b.blocks.map((x) => this.block(x, ctx, true))));
      case "list": return this.listPart(b, 0, b.items.length, ctx);
      case "table": return this.tableFrame(b, c).children([this.tablePart(b, 0, b.rows.length + 1, ctx)]);
      case "code": return this.codeFrame(b, c).child(this.codeBody(b, c).child(this.codePart(b, 0, b.lines.length, ctx)));
    }
    return div();
  }

  listPart(b, from, to, ctx) {
    const { t } = ctx.c;
    return v_flex().w_full().gap(4).children(b.items.slice(from, to).map((it, k) => {
      const n = from + k;
      const marker = it.check != null ? (it.check ? "☑" : "☐") : it.ordered ? `${it.number}.` : ["•", "◦", "▪"][it.depth % 3];
      const key = `${this.slug}:${b.line}:${n}`;
      return h_flex().id(`li-${key}`).w_full().items_start().pl(it.depth * 24)
        .on_size_change((sz, _cx) => this.measureSub(key, sz.height))
        .child(div().w(24).flex_none().text_size(BASE).line_height(`${LINE}px`).text_color(it.ordered ? t.muted : t.dim).child(marker))
        .child(div().flex_1().min_w(0).child(this.flow(it.flow, ctx)));
    }));
  }

  tableFrame(b, c) {
    return v_flex().w_full().rounded(8).border_1().border_color(c.t.border).overflow_hidden();
  }

  tableWeights(b) {
    const cache = this.ui?.weights;
    if (cache?.has(b.line)) return cache.get(b.line);
    const ws = b.header.map((_, k) => {
      const len = Math.max(...[b.header[k], ...b.rows.map((r) => r[k])].map((f) => f.words.reduce((n, w) => n + wordText(w).length + 1, 0)));
      return Math.max(1, Math.min(6, Math.sqrt(len)));
    });
    cache?.set(b.line, ws);
    return ws;
  }

  // Table rows [from, to): row 0 is the header.
  tablePart(b, from, to, ctx) {
    const { c } = ctx;
    const { t } = c;
    const cols = b.header.length;
    const ws = this.tableWeights(b);
    const all = [b.header, ...b.rows];
    return v_flex().w_full().children(all.slice(from, to).map((cells, k) => {
      const n = from + k;
      const head = n === 0, last = n === all.length - 1;
      return h_flex().id(`tr-${this.slug}:${b.line}:${n}`).w_full()
        .on_size_change((sz, _cx) => this.measureSub(`${this.slug}:${b.line}:${n}`, sz.height)).items_stretch()
        .when(!last, (x) => x.border_b(1).border_color(t.border)).when(head, (x) => x.bg(c.codeBg))
        .children(cells.map((f, j) => div().flex_grow(ws[j]).flex_basis(0).min_w(0).px(12).py(7).when(j < cols - 1, (x) => x.border_r(1).border_color(t.border))
          .child(this.flow(f, ctx, { size: 14, line: 22, weight: head ? 600 : null, center: b.align[j] === "center", right: b.align[j] === "right" }))));
    }));
  }

  // The code frame; its lines are drawn by codePart (one or more units).
  codeFrame(b, c) {
    const { t } = c;
    return v_flex().id(`code-${this.slug}-${b.line}`).w_full().rounded(8).border_1().border_color(t.border).bg(c.codeBg).overflow_hidden()
      .when(!!b.lang, (x) => x.child(h_flex().px(14).pt(8).text_size(11).text_color(t.dim).child(b.lang)));
  }

  codeBody(b, c) {
    return v_flex().id(`code-scroll-${this.slug}-${b.line}`).w_full().px(14).py(10).overflow_x_scrollbar().font_family(c.mono);
  }

  codePart(b, from, to, ctx) {
    const words = this.page().words;
    const sub = { ...ctx, size: 13 };
    return v_flex().children(b.lines.slice(from, to).map((ln) => h_flex().flex_none().text_size(13).line_height("21px")
      .when(!!ln.indent, (x) => x.child(div().flex_none().child(ln.indent)))
      .when(!ln.words.length, (x) => x.child(div().child(" ")))
      .children(ln.words.map((w) => this.word(w, words, sub)))));
  }

  // What every unit draws with: built once per change, not once per unit.
  renderCtx() {
    if (!this.tints || this.tintsSig !== this.tintSig()) {
      this.tintsSig = this.tintSig();
      this.tints = tintMap(this.threads, this.slug, this.active, this.showResolved);
    }
    return { c: this.colors(), tints: this.tints, sel: range(this.sel), size: BASE, textW: this.textW ?? TEXT_DEFAULT };
  }

  // One unit: a whole block, or a chunk of a list, table or code block.
  unitElement(key, id) {
    const ui = this.ui;
    if (!ui || ui.key !== key || !this.page()) return div();
    if (ui.diff) return this.diffRowElement(id, this.renderCtx());
    const u = ui.units[id];
    const b = this.page().blocks[u.block];
    const ctx = this.renderCtx();
    if (b.type === "list") return this.listPart(b, u.from, u.to, ctx);
    if (b.type === "table") return this.tablePart(b, u.from, u.to, ctx);
    if (b.type === "code") return this.codePart(b, u.from, u.to, ctx);
    return this.block(b, ctx);
  }

  // ---------------------------------------------------------------------------- diff

  // One row of a diff: line numbers, a +/- mark, and the line. Rows on the new side are drawn
  // word by word like the plan, so they select and comment the same way; removed rows are text.
  diffRowElement(id, ctx) {
    const dp = this.diffPage();
    const row = dp?.rows[id];
    if (!row) return div();
    const { c } = ctx;
    const { t } = c;
    const size = 12.5;
    const tint = row.kind === "add" ? t.ansi2 + "1c" : row.kind === "del" ? t.ansi1 + "1c" : null;
    const num = (n) => div().w(36).flex_none().text_right().text_size(11).line_height("20px").text_color(t.dim).child(n == null ? "" : String(n));
    const mark = row.kind === "add" ? "+" : row.kind === "del" ? "−" : "";
    const words = dp.words;
    const sub = { ...ctx, size };
    const body = row.kind === "del"
      ? div().flex_1().min_w(0).text_size(size).line_height("20px").text_color(t.muted).child(row.text.trim() ? row.text : " ")
      : h_flex().flex_1().min_w(0).flex_wrap().items_center().text_size(size).line_height("20px")
        .when(!!row.indent, (x) => x.child(div().flex_none().child(row.indent)))
        .when(!row.count, (x) => x.child(div().child(" ")))
        .children(words.slice(row.first, row.first + row.count).map((w) => this.word(w, words, sub)));
    return h_flex().w_full().items_start().gap(6).px(8).py(1).font_family(c.mono)
      .when(!!tint, (x) => x.bg(tint))
      .child(num(row.oldLine)).child(num(row.newLine))
      .child(div().w(12).flex_none().text_size(size).line_height("20px").text_color(row.kind === "add" ? t.ansi2 : t.ansi1).child(mark))
      .child(body);
  }

  // What the diff page shows: its rows with long unchanged runs folded into one "expand" entry.
  diffDisplay(dp) {
    const key = `${dp.xver ?? 0}|${this.allExpanded}`;
    if (dp.dispKey !== key) {
      dp.dispKey = key;
      dp.expanded ??= new Set();
      dp.disp = collapseRows(dp.rows, this.allExpanded ? new Set(dp.rows.map((_r, k) => k)) : dp.expanded);
      dp.rowDisp = new Int32Array(dp.rows.length);
      dp.disp.forEach((e, k) => { if (e.gap) for (let r = e.from; r < e.to; r++) dp.rowDisp[r] = k; else dp.rowDisp[e.row] = k; });
      dp.tops = null;
    }
    return dp.disp;
  }

  diffH(dp, row) {
    const m = this.ui?.h[row];
    if (m >= 0) return m;
    const per = Math.max(20, Math.floor(((this.textW ?? TEXT_DEFAULT) - 130) / 7.6));
    return Math.max(1, Math.ceil((dp.rows[row].text.length + 1) / per)) * 20 + 2;
  }

  gapRow(dp, e, c) {
    const { t } = c;
    return h_flex().id(`gap-${e.from}`).w_full().h(GAP_H).flex_none().px(10).gap(8).items_center().cursor_pointer().bg(t.chrome).text_size(12).text_color(t.dim)
      .border_t(1).border_b(1).border_color(t.border)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); dp.expanded.add(e.from); dp.xver = (dp.xver ?? 0) + 1; this.touch(cx); })
      .child(svg(ICON("unfold")).size(13))
      .child(`${e.count} unchanged line${e.count === 1 ? "" : "s"}`)
      .child(div().flex_1())
      .child(div().text_color(t.accent).child("Expand"));
  }

  // The rows of the diff page as mounted elements (only those near the viewport on a long
  // one; the rest are spacers of their height). Fills `out`; false while a row that should be
  // mounted has no view yet. Sets `dp.tops` (the y of every entry) for margin cards.
  diffBlocks(dp, c, win, after, out) {
    const ui = this.ui;
    const disp = this.diffDisplay(dp);
    const tops = new Float64Array(disp.length + 1);
    let y = 0, spacer = 0, complete = true;
    const flush = () => { if (spacer > 0) { out.push(div().w_full().h(spacer)); spacer = 0; } };
    for (let k = 0; k < disp.length; k++) {
      const e = disp[k];
      tops[k] = y;
      const h = e.gap ? GAP_H : this.diffH(dp, e.row);
      y += h;
      if (!complete) continue;
      const shown = y >= win.lo && y - h <= win.hi;
      if (!shown && !after.has(k)) { spacer += h; continue; }
      let el;
      if (e.gap) el = this.gapRow(dp, e, c);
      else if (!shown) el = div().w_full().h(h);
      else {
        const ent = ui.ents.get(e.row);
        if (!ent) { complete = false; continue; }
        const row = e.row;
        el = div().w_full().on_size_change((sz, _cx) => { if (this.ui === ui) ui.h[row] = sz.height; }).child(ent);
      }
      flush();
      out.push(el);
      if (after.has(k)) out.push(v_flex().w_full().py(10).gap(10).children(after.get(k)));
    }
    tops[disp.length] = y;
    flush();
    dp.tops = tops;
    return complete;
  }

  diffRowTop(dp, row) { return dp.tops && dp.rowDisp ? dp.tops[dp.rowDisp[row]] ?? 0 : 0; }

  // A block on the page: its frame (table border, code box) around its units. Only units near
  // the visible part of the page are mounted; the others are empty boxes of their height, so
  // a frame lays out a few screens of words, not the whole page. `win` = { lo, hi, y } in px
  // from the top of the text column; y is where this block starts and is moved past it.
  // Returns null when a unit that should be mounted has no view yet.
  blockView(b, k, c, win) {
    const ui = this.ui;
    const gap = b.type === "list" ? 4 : 0;
    win.y += b.type === "code" ? (b.lang ? 23 : 0) + 10 : b.type === "table" ? 1 : 0;
    const kids = [];
    for (const u of ui.byBlock.get(k)) {
      const h = this.unitH(u, b);
      const shown = win.y + h >= win.lo && win.y <= win.hi;
      win.y += h + gap;
      const e = ui.ents.get(u.id);
      if (shown && !e) return null;
      kids.push(shown
        ? div().w_full().on_size_change((sz, _cx) => { if (this.ui === ui) ui.h[u.id] = sz.height; }).child(e)
        : div().w_full().h(h));
    }
    win.y += b.type === "code" ? 10 : b.type === "table" ? 1 : 0;
    if (b.type === "list") return v_flex().w_full().gap(4).children(kids);
    if (b.type === "table") return this.tableFrame(b, c).children(kids);
    if (b.type === "code") return this.codeFrame(b, c).child(this.codeBody(b, c).children(kids));
    return kids[0];
  }

  // A unit's height: measured once it has been drawn, estimated before.
  unitH(u, b) {
    const m = this.ui.h[u.id];
    if (m >= 0) return m;
    const tw = this.textW ?? TEXT_DEFAULT;
    const lines = (f, w = tw, cw = 7.6) => Math.max(1, Math.ceil(f.words.reduce((n, x) => n + wordText(x).length + 1, 0) * cw / w));
    switch (b.type) {
      case "heading": { const size = [0, 27, 21, 17.5, 16, 15, 15][b.level]; return lines(b.flow, tw, size * 0.5) * Math.round(size * 1.35) + (b.level === 1 ? 11 : 0); }
      case "para": return lines(b.flow) * LINE;
      case "list": { let h = 0; for (let n = u.from; n < u.to; n++) h += lines(b.items[n].flow, tw - 24 - b.items[n].depth * 24) * LINE + 4; return h - 4; }
      case "table": return (u.to - u.from) * 37;
      case "code": return (u.to - u.from) * 21;
      case "quote": return b.blocks.reduce((h, x) => h + (x.flow ? lines(x.flow, tw - 17) * LINE : 40) + 10, -10);
      case "image": return 320;
      case "hr": return 13;
    }
    return 40;
  }

  // The scroll position is not readable directly: a wheel or move event over the page gives the
  // page's row (which scrolls) and the scroll area (which does not) in window coordinates, and
  // their difference is the offset. The mounted window moves in half-screen steps.
  scrolled(viewTop, delta, cx) {
    if (this.rowY == null || viewTop == null) return;
    const off = Math.max(0, viewTop - this.rowY - delta);
    const step = Math.max(200, (this.viewH ?? 800) / 2);
    const top = Math.floor(off / step) * step;
    if ((this.winTop.get(this.viewKey()) ?? 0) !== top) { this.winTop.set(this.viewKey(), top); cx.notify(); }
  }

  measureSub(key, h) {
    if (Math.abs((this.subH.get(key) ?? -1) - h) > 0.5) { this.subH.set(key, h); this.wakeHost(); }
  }

  // Space after each top-level block, so the cumulative heights give every block's y.
  spacing(b, next) {
    if (!next) return 8;
    if (next.type === "heading") return next.level === 1 ? 24 : next.level === 2 ? 30 : 22;
    if (b.type === "heading") return b.level === 1 ? 18 : 10;
    return 16;
  }

  measure(map, key, h, cx) {
    if (Math.abs((map.get(key) ?? -1) - h) > 0.5) { map.set(key, h); cx.notify(); }
  }

  // The y of word i in the text column: its block's top, plus the list item, table row or code
  // line it sits in. Inside a paragraph the line is unknown, so it is the paragraph's top.
  anchorY(i) {
    const page = this.page();
    const w = page.words[i];
    if (page.diff) return this.diffRowTop(page.dp, w.row);
    const b = page.blocks[w.block];
    let y = this.blockTop(w.block);
    const sub = (n) => this.subH.get(`${this.slug}:${b.line}:${n}`) ?? 26;
    if (b.type === "list") {
      const at = b.items.findIndex((it) => it.flow.id === w.flow);
      for (let n = 0; n < at; n++) y += sub(n) + 4;
    } else if (b.type === "table") {
      const at = [b.header, ...b.rows].findIndex((r) => r.some((f) => f.id === w.flow));
      for (let n = 0; n < at; n++) y += sub(n);
    } else if (b.type === "code") {
      const at = b.lines.findIndex((l) => l.id === w.flow);
      y += (b.lang ? 23 : 0) + 10 + Math.max(0, at) * 21 - 6;
    }
    return y;
  }

  blockTop(k) {
    let y = 0;
    for (let j = 0; j < k; j++) y += this.blockH.get(`${this.slug}:${j}`) ?? 60;
    return y;
  }

  // ---------------------------------------------------------------------------- threads

  /** Who the agent is: "Claude Code", the pane's program, or "Agent". */
  agentName() {
    const h = harnessName(this.review?.agent?.harness);
    if (h) return h;
    const pane = this.terminal && panes().find((p) => p.terminal === this.terminal);
    return pane?.program?.name || "Agent";
  }

  avatar(author, c, size = 22) {
    const { t } = c;
    const agent = author === "agent";
    return div().size(size).flex_none().rounded(size / 2).flex().items_center().justify_center()
      .bg(agent ? t.ansi5 + "33" : t.accent + "33").text_color(agent ? t.ansi5 : t.accent)
      .child(svg(ICON(agent ? "bot" : "user")).size(size * 0.6));
  }

  button(id, label, onClick, c, opts = {}) {
    const { t } = c;
    const off = !!opts.disabled;
    return h_flex().id(id).flex_none().gap(5).items_center().px(opts.px ?? 8).h(opts.h ?? 24).rounded(6).text_size(opts.size ?? 12)
      .when(!off, (x) => x.cursor_pointer()).when(off, (x) => x.opacity(0.5))
      .when(!!opts.primary, (x) => x.bg(t.solid ?? t.accent).text_color(t.solid_foreground ?? t.accent_foreground).when(!off, (y) => y.hover((s) => s.opacity(0.9))))
      .when(!!opts.danger, (x) => x.text_color(t.blocked).hover((s) => s.bg(t.blocked + "1c")))
      .when(!!opts.outline, (x) => x.border_1().border_color(t.input ?? t.border).text_color(opts.color ?? t.foreground).hover((s) => s.bg(t.hover)))
      .when(!opts.primary && !opts.danger && !opts.outline, (x) => x.text_color(opts.color ?? t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground)))
      .when(!!opts.icon, (x) => x.child(svg(ICON(opts.icon)).size(opts.iconSize ?? 13)))
      .when(label != null, (x) => x.child(label))
      .when(!!opts.active, (x) => x.bg(t.selected))
      .when(!!opts.tip, (x) => x.tooltip(opts.tip))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((e, cx) => { cx.stop_propagation(); if (off) return; onClick(e, cx); this.touch(cx); });
  }

  // A text box and its buttons. `actions`: [{ id, label, run(cx), primary?, icon? }]; the first
  // primary one is what ⌘↩ does.
  textarea(state, c, actions, onCancel, idBase) {
    const { t } = c;
    const empty = !state.value().trim();
    const busy = !!this.busy;
    const hint = div().text_size(11).text_color(t.dim).child(busy ? "Sending…" : "⌘↩ to send · Esc to cancel");
    return v_flex().w_full().gap(8)
      .child(div().w_full().rounded(7).border_1().border_color(t.accent + "aa").bg(t.background).px(8).py(6).text_size(13.5).text_color(t.foreground)
        .child(Textarea.new(state).w_full().border_0().bg(t.background)))
      // One action: hint and buttons on one row. Two ("Ask agent" + the decision batch): the
      // hint gets its own row, so the buttons fit a margin card.
      .when(actions.length > 1, (x) => x.child(hint.w_full()))
      .child(h_flex().w_full().items_center().gap(6)
        .child(actions.length > 1 ? div().flex_1() : hint.flex_1())
        .child(this.button(`${idBase}-cancel`, "Cancel", onCancel, c))
        .children(actions.map((a) => this.button(`${idBase}-${a.id}`, a.label, (_e, cx) => { if (!empty || a.allowEmpty) a.run(cx); }, c,
          { primary: !!a.primary && (!empty || a.allowEmpty), outline: !a.primary || (empty && !a.allowEmpty), icon: a.icon, disabled: busy, tip: a.tip, color: a.color }))));
  }

  // "Ask agent" (sent now, wakes the agent) next to the decision-batch action, as in the browser.
  sendActions(onSend) {
    const d = this.doc;
    const dv = delivery(d?.review, d?.pointer.version);
    const out = [];
    if (dv.canAsk) out.push({ id: "ask", label: "Ask agent", icon: "bot", run: (cx) => onSend("ask", cx), tip: dv.note });
    out.push({ id: "save", label: dv.decisionLabel, primary: true, run: (cx) => onSend("decision", cx), tip: dv.canAsk ? "Sent with your decision" : dv.note });
    return out;
  }

  composerCard(c) {
    const { t } = c;
    const r = this.composer.r;
    const quote = r ? rangeText(this.page().words, r) : null;
    return v_flex().id("composer").w_full().p(12).gap(10).rounded(10).bg(t.popover ?? t.surface).border_1().border_color(t.accent).shadow_md()
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_key_down((e, cx) => this.key(e, cx))
      .child(h_flex().gap(8).items_center()
        .child(this.avatar("you", c))
        .child(div().text_size(12.5).font_weight(600).text_color(t.foreground).child("You"))
        .child(div().text_size(12).text_color(t.dim).child(r ? "new comment" : "comment on the whole page")))
      .when(!!quote, (x) => x.child(this.quote(quote, c)))
      .child(this.textarea(this.composer.state, c, this.sendActions((kind, cx) => this.saveComposer(kind, cx)), () => this.closeComposer(), "composer"));
  }

  quote(text, c) {
    const { t } = c;
    const one = text.replace(/\s+/g, " ");
    return h_flex().w_full().items_start().gap(8)
      .child(div().w(2).flex_none().self_stretch().rounded(1).bg(t.ansi3))
      .child(div().flex_1().min_w(0).text_size(12.5).line_height("18px").italic().text_color(t.muted).child(one.length > 140 ? `${one.slice(0, 137)}…` : one));
  }

  card(th, c) {
    const { t } = c;
    const on = this.active === th.id;
    const resolved = th.status !== "open";
    const msgs = th.messages;
    const shown = on ? msgs : msgs.slice(0, 1);
    const agent = this.agentName();
    const message = (m, k) => v_flex().w_full().gap(4).when(k > 0, (x) => x.pt(10).border_t(1).border_color(t.border))
      .child(h_flex().gap(8).items_center()
        .child(this.avatar(m.author, c))
        .child(div().text_size(12.5).font_weight(600).text_color(t.foreground).child(m.author === "agent" ? agent : "You"))
        .child(div().text_size(11.5).text_color(t.dim).child(ago(m.at)))
        .when(m.author === "you" && m.delivery === "ask", (x) => x.child(this.chip("Asked", t.ansi5, c))))
      .child(div().pl(30).text_size(13.5).line_height("20px").text_color(t.foreground).child(m.body));
    const head = h_flex().w_full().gap(6).items_center()
      .when(th.kind === "page", (x) => x.child(this.chip("Whole page", t.accent, c)))
      .when(!!th.detached, (x) => x.child(this.chip(th.side === "old" ? "Removed text" : "Text changed", t.blocked, c)))
      .when(resolved, (x) => x.child(this.chip("Resolved", t.done ?? t.ansi2, c)))
      .when(th.kind === "range" && !!th.lines, (x) => x.child(div().text_size(11).text_color(t.dim).child(th.lines[0] === th.lines[1] ? `line ${th.lines[0]}` : `lines ${th.lines[0]}–${th.lines[1]}`)));
    const replyBox = this.replying?.id === th.id;
    // The agent asked to answer and has not yet: the last message is the human's Ask.
    const waiting = !resolved && msgs[msgs.length - 1]?.author === "you" && msgs[msgs.length - 1]?.delivery === "ask";
    return v_flex().id(`card-${th.id}`).w_full().p(12).gap(10).rounded(10).cursor_pointer()
      .bg(on ? (t.popover ?? t.surface) : t.surface).border_1().border_color(on ? t.ansi3 + "cc" : t.border)
      .when(on, (x) => x.shadow_md()).when(!on, (x) => x.hover((s) => s.border_color(t.input ?? t.border)))
      .when(resolved && !on, (x) => x.opacity(0.72))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { if (this.active !== th.id) { this.active = th.id; this.confirmDelete = null; this.touch(cx); } })
      .on_key_down((e, cx) => this.key(e, cx))
      .child(head)
      .when(th.kind === "range" && !!th.quote, (x) => x.child(this.quote(th.quote, c)))
      .children(shown.map(message))
      .when(!on && msgs.length > 1, (x) => x.child(div().pl(30).text_size(12).text_color(t.accent).child(`${msgs.length - 1} more repl${msgs.length === 2 ? "y" : "ies"}`)))
      .when(on && waiting, (x) => x.child(h_flex().pl(30).gap(6).items_center().text_size(12).text_color(t.dim)
        .child(div().text_color(t.ansi5).frames(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"], 90)).child(`Waiting for ${agent}…`)))
      .when(on && replyBox, (x) => x.child(this.textarea(this.replying.state, c, this.sendActions((kind, cx) => this.saveReply(kind, cx)), () => this.closeReply(), `reply-${th.id}`)))
      .when(on && !replyBox, (x) => x.child(h_flex().w_full().gap(2).items_center().pt(2)
        .when(!resolved, (y) => y.child(this.button(`reply-${th.id}`, "Reply", () => this.openReply(th.id), c, { icon: "reply" })))
        .child(div().flex_1())
        .child(this.button(`res-${th.id}`, resolved ? "Reopen" : "Resolve", (_e, cx) => this.toggleResolved(th.id, cx), c, { icon: resolved ? "rotate" : "check", color: resolved ? t.muted : t.done ?? t.ansi2, disabled: !!this.busy }))
        .child(this.button(`del-${th.id}`, this.confirmDelete === th.id ? "Delete?" : null, (_e, cx) => this.del(th.id, cx), c, { icon: "trash", danger: this.confirmDelete === th.id, tip: "Delete thread", disabled: !!this.busy }))));
  }

  chip(label, color, c) {
    return div().px(6).h(18).flex().items_center().rounded(4).text_size(10.5).font_weight(600).bg(color + "22").text_color(color).child(label);
  }

  visibleThreads() {
    return this.threadsHere().filter((th) => th.status === "open" || this.showResolved || th.id === this.active);
  }

  // In a diff, a thread on a line the diff shows as removed sits at that row; elsewhere 0.
  removedRow(th) {
    const page = this.page();
    if (!page?.diff || th.side !== "old") return null;
    return removedRowOf({ side: th.side, line: th.lines?.[0], baseVersion: th.baseVersion }, page.dp.rows, page.dp.base);
  }

  removedY(th) {
    const r = this.removedRow(th);
    return r == null ? 0 : this.diffRowTop(this.page().dp, r);
  }

  // Cards in the right margin, each at its anchor's y; overlaps pushed apart.
  margin(c) {
    const items = [];
    const cards = new Map();
    for (const th of this.visibleThreads()) {
      const y = th.kind === "page" ? 0 : th.words && !th.detached ? this.anchorY(th.words[0]) : this.removedY(th);
      items.push({ id: th.id, y, h: this.cardH.get(th.id) ?? 110 });
      cards.set(th.id, this.card(th, c));
    }
    if (this.composer && this.composer.doc === this.doc) {
      const y = this.composer.r ? this.anchorY(this.composer.r[0]) : 0;
      items.push({ id: COMPOSER, y, h: this.cardH.get(COMPOSER) ?? 170 });
      cards.set(COMPOSER, this.composerCard(c));
    }
    const pinned = this.composer ? COMPOSER : this.active;
    const tops = layoutMargin(items, pinned, 12);
    let bottom = 0;
    for (const it of items) bottom = Math.max(bottom, tops.get(it.id) + it.h);
    return div().relative().w(MARGIN_W).flex_none().min_h(bottom + 24)
      .children(items.map((it) => {
        const on = it.id === pinned;
        return div().id(`slot-${it.id}`).absolute().w(MARGIN_W).top(tops.get(it.id)).left(on ? -12 : 0)
          .transition("top", { duration: 180, easing: "ease-out" }).transition("left", { duration: 140, easing: "ease-out" })
          .on_size_change((s, cx) => this.measure(this.cardH, it.id, s.height, cx))
          .child(cards.get(it.id));
      }));
  }

  // ---------------------------------------------------------------------------- layout

  sidebarView(c) {
    const { t } = c;
    const counts = openCounts(this.threads);
    const rows = treeRows(this.plan);
    const d = this.doc;
    const df = this.diffMode();
    return v_flex().id("sidebar").when(this.windowed, (x) => x.on_mouse_down("left", (_e, cx) => cx.stop_propagation())).w(SIDEBAR_W).flex_none().h_full().bg(t.chrome).border_r(1).border_color(t.border)
      .child(v_flex().px(16).pt(16).pb(12).gap(4)
        .child(h_flex().gap(6).items_center().text_size(10.5).font_weight(600).text_color(t.dim).child(svg(ICON("file")).size(12)).child("PLAN"))
        .child(div().text_size(14).font_weight(600).line_height("19px").text_color(t.foreground).child(this.plan.title))
        .child(div().text_size(11.5).text_color(t.dim).truncate().child(`v${d.pointer.version}${df ? ` vs v${df.base}` : ""} · ${this.plan.pages.length} page${this.plan.pages.length === 1 ? "" : "s"}${d.pointer.cwd ? ` · ${d.pointer.cwd.split("/").pop()}` : ""}`))
        .when(this.versions().length > 0, (x) => x.child(div().w_full().pt(6).child(this.versionSelect(c, true)))))
      .child(v_flex().id("tree").flex_1().min_h(0).overflow_y_scrollbar().px(8).pb(8).gap(1)
        .children(rows.map((r) => {
          const on = r.slug === this.slug;
          const n = counts.get(r.slug) ?? 0;
          const status = df?.index.status.get(r.slug);
          const mark = PAGE_MARKS[status];
          return h_flex().id(`tree-${r.slug}`).w_full().h(30).pr(8).gap(6).items_center().rounded(6).cursor_pointer()
            .when(on, (x) => x.bg(t.selected)).when(!on, (x) => x.hover((s) => s.bg(t.hover)))
            .on_click((_e, cx) => { this.goto(r.slug, cx); this.handle.focus(); this.touch(cx); })
            .child(div().w(3).h(16).flex_none().rounded(2).when(on, (x) => x.bg(t.accent)))
            .child(h_flex().flex_none().h_full().children(r.guides.slice(1).map((_, g) => div().w(14).h_full())).when(r.depth > 0, (x) => x.child(div().w(12).h_full().flex().items_center().child(div().w(6).h(1).bg(t.border)))))
            .child(div().flex_1().min_w(0).truncate().text_size(13).text_color(status === "removed" ? t.dim : on ? t.foreground : r.depth === 0 ? t.foreground : t.muted).when(on || r.depth === 0, (x) => x.font_weight(600)).when(status === "removed", (x) => x.line_through()).child(r.title))
            .when(!!mark, (x) => x.child(div().id(`mark-${r.slug}`).flex_none().text_color(t[mark.color]).tooltip(mark.label).child(svg(ICON(mark.icon)).size(12))))
            .when(n > 0, (x) => x.child(div().flex_none().min_w(18).h(18).px(5).rounded(9).flex().items_center().justify_center().text_size(10.5).font_weight(600)
              .bg(on ? t.ansi3 : t.ansi3 + "33").text_color(on ? t.background : t.ansi3).child(String(n))));
        })))
      .child(v_flex().px(16).py(12).gap(5).border_t(1).border_color(t.border).text_size(11).text_color(t.dim)
        .child(this.hint("[  ]", "previous / next page", c))
        .child(this.hint("drag", "select words · shift-click extends", c))
        .child(this.hint("⏎", "comment · ⌘C copy · Esc clear", c))
        .child(this.hint("V", "switch plan version", c))
        .child(this.hint("R", "show resolved threads", c)));
  }

  hint(k, text, c) {
    const { t } = c;
    return h_flex().gap(8).items_center()
      .child(div().flex_none().min_w(34).px(4).h(17).rounded(4).border_1().border_color(t.border).flex().items_center().justify_center().font_family(c.mono).text_size(10).text_color(t.muted).child(k))
      .child(div().child(text));
  }

  topbar(c) {
    const { t } = c;
    const pg = this.plan.bySlug.get(this.slug);
    const crumbs = ancestors(this.plan, this.slug);
    const resolvedHere = this.threadsHere().filter((x) => x.status !== "open").length;
    const compact = this.width - (this.sidebarOn() ? SIDEBAR_W : 0) < 1000;
    return h_flex().id("topbar").w_full().h(46).flex_none().px(12).gap(6).items_center().border_b(1).border_color(t.border).bg(t.background)
      .child(this.button("toggle-sidebar", null, () => { this.sidebar = !this.sidebarOn(); }, c, { icon: "sidebar", iconSize: 15, px: 6, h: 28, tip: "Toggle page tree" }))
      .child(h_flex().flex_1().min_w(0).overflow_hidden().gap(6).items_center().text_size(13)
        .when(crumbs.length > 1, (x) => x.child(div().flex_none().text_color(t.dim).child("…")).child(svg(ICON("chevron-right")).size(12).flex_none().text_color(t.dim)))
        .when(crumbs.length > 0, (x) => x
          .child(div().id("crumb-parent").flex_shrink(1).min_w(40).max_w(220).truncate().text_color(t.dim).cursor_pointer().hover((st) => st.text_color(t.foreground))
            .tooltip(crumbs.map((a) => a.title).join(" › "))
            .on_click((_e, cx) => { this.goto(crumbs[crumbs.length - 1].slug, cx); this.touch(cx); }).child(crumbs[crumbs.length - 1].title))
          .child(svg(ICON("chevron-right")).size(12).flex_none().text_color(t.dim)))
        .child(div().flex_shrink(1).min_w(0).truncate().font_weight(600).text_color(t.foreground).child(pg.title)))
      .when(!!this.agentChip(c, compact), (x) => x.child(this.agentChip(c, compact)))
      // The sidebar holds the version selector; with it hidden, a small one stays here.
      .when(this.versions().length > 1 && !this.sidebarOn(), (x) => x.child(this.versionSelect(c, false)))
      .when(this.versions().length > 1, (x) => x.child(this.diffToggle(c, compact)))
      .child(this.button("page-comment", compact ? null : "Comment on page", () => this.openComposer(null), c, { icon: "message", outline: true, h: 28, px: compact ? 7 : 10, tip: "Comment on the whole page" }))
      .child(this.button("show-resolved", compact ? (resolvedHere ? String(resolvedHere) : null) : `Resolved${resolvedHere ? ` (${resolvedHere})` : ""}`, () => { this.showResolved = !this.showResolved; }, c,
        { icon: this.showResolved ? "eye" : "eye-off", h: 28, px: compact ? 7 : 10, color: this.showResolved ? t.foreground : t.muted, tip: "Show resolved threads (R)" }))
      .child(div().w(1).h(18).mx(4).bg(t.border))
      .child(this.button("open-browser", null, (_e, cx) => this.openBrowser(cx), c, { icon: "globe", px: 6, h: 28, tip: "Open in browser" }))
      .when(!this.windowed, (x) => x.child(this.button("open-window", null, () => this.openWindow(), c, { icon: "window", px: 6, h: 28, tip: "Open in a window" })))
      // A window: this bar drags it (presses elsewhere are stopped); ✕ closes it.
      .when(this.windowed, (x) => x.cursor_grab()
        .child(this.button("close-window", null, () => closeOverlay(props()?.overlay), c, { icon: "x", px: 6, h: 28, tip: "Close the window" })));
  }

  // The version selector: the shown version with its review state; a press opens the list of
  // every version, newest first. In the sidebar it is a full-width field, in the top bar (sidebar
  // hidden) a small button. `plan-review.versions` (V) toggles it.
  versionSelect(c, full) {
    const { t } = c;
    const list = this.versions();
    const shown = this.doc.pointer.version;
    const cur = list.find((v) => v.n === shown);
    if (!cur) return div();
    const st = VERSION_STATES[cur.status];
    const trigger = h_flex().id(full ? "ver-select" : "ver-select-bar").gap(7).items_center().px(full ? 10 : 8).h(full ? 30 : 28).rounded(7).cursor_pointer().text_size(full ? 12.5 : 12)
      .border_1().border_color(t.input ?? t.border).text_color(t.foreground).hover((s) => s.bg(t.hover))
      .when(full, (x) => x.w_full()).when(!full, (x) => x.flex_none())
      .when(this.versionsOpen, (x) => x.bg(t.selected))
      .tooltip(full ? "Switch version (V)" : `v${shown} · ${st.label} · switch version (V)`)
      .child(div().flex_none().text_color(t[st.color] ?? t.dim).child(svg(ICON(st.icon)).size(12)))
      .child(div().flex_none().font_weight(600).child(`v${shown}`))
      .when(full, (x) => x.child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(st.label)))
      .child(div().flex_none().text_color(t.dim).child(svg(ICON("chevron-down")).size(12)));
    const rows = [...list].reverse().map((v) => {
      const s = VERSION_STATES[v.status];
      const on = v.n === shown;
      return h_flex().id(`ver-${v.n}`).w_full().flex_none().h(30).px(8).gap(8).items_center().rounded(6).cursor_pointer().text_size(12.5)
        .when(on, (x) => x.bg(t.selected).text_color(t.foreground)).when(!on, (x) => x.text_color(t.muted).hover((h) => h.bg(t.hover).text_color(t.foreground)))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { cx.stop_propagation(); this.versionsOpen = false; this.pickVersion(v.n, cx); this.handle.focus(); })
        .child(div().flex_none().text_color(t[s.color] ?? t.dim).child(svg(ICON(s.icon)).size(12)))
        .child(div().flex_none().w(26).font_weight(on ? 650 : 500).child(`v${v.n}`))
        .child(div().flex_1().min_w(0).truncate().child(s.label))
        .child(div().flex_none().text_size(11).text_color(t.dim).child(v.createdAt ? ago(Date.parse(v.createdAt)) : ""))
        .child(div().flex_none().w(12).text_color(t.accent).child(on ? svg(ICON("check")).size(12) : ""));
    });
    const panel = v_flex().id("ver-list").w(288).max_h(360).overflow_y_scrollbar().p(4).gap(1).rounded(9).bg(t.popover ?? t.surface).border_1().border_color(t.border).shadow_lg()
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .children(rows);
    return Popover.new(full ? "ver-pop" : "ver-pop-bar").open(!!this.versionsOpen).anchor(full ? "top_left" : "top_right")
      .on_open_change((open, cx) => { this.versionsOpen = open; this.touch(cx); })
      .trigger(trigger).content(panel);
  }

  diffToggle(c, compact) {
    const { t } = c;
    const base = this.diffBaseOf();
    const on = this.diffOn && base != null;
    return this.button("diff-toggle", compact ? null : "Diff", (_e, cx) => this.toggleDiff(cx), c,
      { icon: "diff", outline: true, h: 28, px: compact ? 7 : 10, active: on, color: on ? t.foreground : t.muted, disabled: base == null,
        tip: base == null ? "No earlier version to compare with" : on ? "Back to the plan (D)" : `Show what changed since v${base} (D)` });
  }

  // Under the top bar in diff mode: what is compared, the totals, and the unchanged-lines switch.
  diffbar(c) {
    const { t } = c;
    const d = this.doc;
    const base = this.diffBaseOf();
    const df = this.diffMode();
    const dp = this.diffPage();
    const list = this.versions();
    const bv = list.find((v) => v.n === base);
    const st = VERSION_STATES[bv?.status ?? "none"];
    const older = stepBase(d.pointer.version, base, -1, list), newer = stepBase(d.pointer.version, base, 1, list);
    const stat = (n, sign, color) => div().flex_none().font_family(c.mono).text_size(11.5).font_weight(600).text_color(n ? color : t.dim).child(`${sign}${n}`);
    const pageChip = dp && ({ added: ["New page", t.ansi2], removed: ["Page removed", t.ansi1], unchanged: ["Page unchanged", t.dim] })[dp.status];
    const folds = dp ? dp.rows.some((r) => r.kind === "eq") : false;
    return h_flex().id("diffbar").w_full().h(34).flex_none().px(16).gap(8).items_center().border_b(1).border_color(t.border).bg(t.chrome).text_size(12).text_color(t.muted)
      .child(svg(ICON("diff")).size(13).flex_none())
      .child(div().flex_none().child(`v${d.pointer.version} compared with`))
      .child(this.button("base-older", null, (_e, cx) => this.stepDiffBase(-1, cx), c, { icon: "chevron-left", px: 4, h: 22, disabled: older === base, tip: "Compare with an older version" }))
      .child(h_flex().flex_none().gap(4).items_center().px(6).h(22).rounded(5).bg(t.hover).text_color(t.foreground).font_weight(600)
        .child(div().flex_none().text_color(t[st.color] ?? t.dim).child(svg(ICON(st.icon)).size(11))).child(`v${base}`))
      .child(this.button("base-newer", null, (_e, cx) => this.stepDiffBase(1, cx), c, { icon: "chevron-right", px: 4, h: 22, disabled: newer === base, tip: "Compare with a newer version" }))
      .when(!df, (x) => x.child(div().text_color(t.dim).child("Loading changes…")))
      .when(!!dp, (x) => x.child(stat(dp.stats.added, "+", t.ansi2)).child(stat(dp.stats.removed, "−", t.ansi1)))
      .when(!!pageChip, (x) => x.child(this.chip(pageChip[0], pageChip[1], c)))
      .child(div().flex_1())
      .when(!!df, (x) => x.child(div().flex_none().text_color(t.dim).child(`${df.index.changed} of ${df.plan.pages.length} page${df.plan.pages.length === 1 ? "" : "s"} changed`)))
      .when(folds, (x) => x.child(this.button("all-lines", this.allExpanded ? "Fold unchanged" : "Show all lines", () => { this.allExpanded = !this.allExpanded; }, c, { icon: "unfold", h: 24, px: 8, tip: "Fold or show the unchanged lines" })));
  }

  // Whose plan this is and its state: "Claude Code · Waiting for review".
  agentChip(c, compact = false) {
    const { t } = c;
    const d = this.doc;
    if (!d) return null;
    const tg = this.target();
    const old = !!tg && tg.pointer.version !== tg.newest;
    const st = (d.review ? STATES[d.review.status] : old ? { label: "No review", color: "dim" } : STATES[d.pointer.status]) ?? STATES.pending;
    const color = t[st.color] ?? t.accent;
    return h_flex().flex_none().gap(6).items_center().px(8).h(24).rounded(12).bg(color + "1f").text_size(11.5)
      .child(div().size(7).rounded(4).bg(color))
      .when(!compact, (x) => x.child(div().max_w(140).truncate().text_color(t.foreground).child(this.agentName())))
      .child(div().text_color(color).font_weight(600).child(st.label));
  }

  decisionBar(c) {
    const { t } = c;
    const d = this.doc;
    const open = this.threads.filter((x) => x.status === "open").length;
    const resolved = this.threads.length - open;
    const review = d.review;
    const dv = delivery(review, d.pointer.version);
    const state = decisionState(review);
    const tg = this.target();
    const older = !!tg && tg.pointer.version !== tg.newest;
    const tone = { done: t.done ?? t.ansi2, blocked: t.blocked, pending: t.ansi3, dim: t.dim }[state.tone];
    const bar = h_flex().id("decision").when(this.windowed, (x) => x.on_mouse_down("left", (_e, cx) => cx.stop_propagation())).w_full().h(56).flex_none().px(20).gap(10).items_center().border_t(1).border_color(t.border).bg(t.chrome)
      .child(h_flex().gap(8).items_center().flex_1().min_w(0).overflow_hidden().text_size(12.5).text_color(t.muted)
        .child(div().size(8).flex_none().rounded(4).bg(dv.onVersion ? (open ? t.ansi3 : t.done ?? t.ansi2) : tone))
        .when(!dv.onVersion, (x) => x.child(div().flex_none().font_weight(600).text_color(tone).child(older && !review ? "No review" : state.label)))
        .when(dv.onVersion, (x) => x.child(div().flex_none().child(`${open} open thread${open === 1 ? "" : "s"}`)))
        .when(resolved > 0, (x) => x.child(div().flex_none().text_color(t.dim).child(`· ${resolved} resolved`)))
        .child(div().min_w(0).truncate().text_color(t.dim).child(dv.onVersion
          ? open ? "· open threads go to the agent with your decision" : "· no open threads"
          : older ? `· an earlier version, v${tg.newest} is the latest`
          : review?.status === "rejected" ? "· the agent is revising the plan" : review?.status === "approved" ? "· the agent is building" : "")))
      .when(older, (x) => x.child(this.button("to-latest", `Go to v${tg.newest}`, (_e, cx) => this.pickVersion(tg.newest, cx), c, { outline: true, h: 32, px: 14, size: 13 })))
      .when(this.server.down, (x) => x.child(this.chip("Server not running", t.blocked, c)))
      .when(dv.onVersion, (x) => x
        .child(this.button("request-changes", "Request changes…", () => this.openDecision("reject"), c, { outline: true, h: 32, px: 14, size: 13, disabled: !!this.busy }))
        .child(this.button("approve", "Approve…", () => this.openDecision("approve"), c, { primary: true, icon: "check", h: 32, px: 14, size: 13, disabled: !!this.busy })));
    if (!this.deciding || this.deciding.doc !== d || !dv.onVersion) return bar;
    const approve = this.deciding.kind === "approve";
    return v_flex().w_full().flex_none()
      .child(v_flex().id("decide-panel").w_full().px(20).pt(14).pb(12).gap(10).border_t(1).border_color(t.border).bg(t.popover ?? t.surface)
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_key_down((e, cx) => this.key(e, cx))
        .child(div().text_size(13).font_weight(600).text_color(t.foreground).child(approve ? "Approve the plan" : "Request changes"))
        .child(div().text_size(12).text_color(t.muted).child(open
          ? `${open} open thread${open === 1 ? "" : "s"} go${open === 1 ? "es" : ""} to the agent with this decision; resolved threads do not.`
          : "No open threads. The summary below is all the agent gets."))
        .child(this.textarea(this.deciding.state, c, [{ id: "confirm", label: approve ? "Approve" : "Request changes", primary: true, allowEmpty: true, icon: approve ? "check" : null, run: (cx) => this.decide(cx) }],
          () => this.closeDecision(), "decide")))
      .child(bar);
  }

  pillView(c, contentW) {
    const { t } = c;
    const x = Math.max(8, Math.min(this.pill.x - 60, contentW - 230));
    // No release point (pre-selected): float just below the selection's last block.
    let y = this.pill.y;
    if (y == null) {
      const page = this.page();
      const w = page.words[range(this.sel)[1]];
      y = page.diff ? 36 + this.diffRowTop(page.dp, w.row) + this.diffH(page.dp, w.row) - 26 : 36 + this.blockTop(w.block) + (this.blockH.get(`${this.slug}:${w.block}`) ?? 40) - 26;
    }
    return h_flex().id("pill").absolute().left(x).top(y + 16).gap(2).p(3).rounded(9).bg(t.popover ?? t.surface).border_1().border_color(t.border).shadow_lg()
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .child(this.button("pill-comment", "Comment", () => this.openComposer(range(this.sel)), c, { icon: "message", primary: true, h: 26, px: 10, size: 12.5 }))
      .child(this.button("pill-copy", "Copy", (_e, cx) => this.copy(cx), c, { icon: "copy", h: 26, px: 8, size: 12.5 }))
      .child(div().px(6).text_size(11).text_color(t.dim).child("⏎ · ⌘C"));
  }

  // A full-pane message: an icon, a title, a line of text and buttons.
  screen(c, icon, title, text, buttons = []) {
    const { t } = c;
    return v_flex().size_full().items_center().justify_center().gap(14).bg(t.background)
      .child(div().size(52).rounded(26).bg(t.raised).flex().items_center().justify_center().text_color(t.dim).child(svg(ICON(icon)).size(24)))
      .child(div().text_size(18).font_weight(600).text_color(t.foreground).child(title))
      .child(div().max_w(420).text_size(13.5).line_height("20px").text_color(t.muted).text_center().child(text))
      .when(buttons.length > 0, (x) => x.child(h_flex().gap(8).items_center().pt(6).children(buttons)));
  }

  // The plan view over a tab whose agent submitted no plan.
  noPlan(c) {
    const { t } = c;
    const f = focused();
    const pane = panes().find((p) => p.pane === f?.pane && p.terminal) ?? panes().find((p) => p.tab === f?.tab && p.terminal);
    const who = pane?.program?.name || pane?.title || "This agent";
    const stack = !this.windowed && this.hasStack();
    return this.screen(c, "file", "This agent has no plan", `${who} in this tab has not submitted a plan. A plan shows here when the agent submits one.`, stack ? [
      this.button("empty-back", "Back to the agent", () => this.flipBack(), c, { icon: "chevron-left", outline: true, h: 30, px: 12, size: 13 }),
      h_flex().gap(6).items_center().text_size(12).text_color(t.dim).child("or press").child(this.keycap("⌘⇧R", c)),
    ] : []);
  }

  serverDown(c) {
    const s = this.server;
    const canStart = !!this.install.start;
    const text = s.error ?? (canStart
      ? "agent-plan-review is not answering, so this plan cannot load. Start it here; the agent and the browser use the same server."
      : "agent-plan-review is not answering. Run `agent-plan-review serve`, or `agent-plan-review herdr install` again so this view can start it.");
    return this.screen(c, "rotate", s.starting ? "Starting the review server…" : "The review server is not running", text, [
      ...(canStart ? [this.button("start-server", s.starting ? "Starting…" : "Start server", (_e, cx) => { if (!s.starting) cx.spawn((cx) => this.startServer(cx)); }, c, { primary: true, h: 30, px: 14, size: 13, disabled: s.starting })] : []),
      this.button("retry", "Try again", (_e, cx) => this.retry(cx), c, { outline: true, h: 30, px: 12, size: 13, disabled: s.starting }),
    ]);
  }

  keycap(k, c) {
    const { t } = c;
    return div().px(6).h(20).rounded(5).border_1().border_color(t.border).bg(t.surface).flex().items_center().font_family(c.mono).text_size(11).text_color(t.muted).child(k);
  }

  render(_cx) {
    const c = this.colors();
    const { t } = c;
    const root = v_flex().id("plan-review").size_full().bg(t.background).text_color(t.foreground).font_family(PROSE_FONT).track_focus(this.handle)
      .on_size_change((s, cx) => { if (Math.abs(s.width - this.width) > 1) { this.width = s.width; cx.notify(); } })
      .on_key_down((e, cx) => this.key(e, cx))
      .on_mouse_up("left", (_e, cx) => this.release(cx));
    // Just flipped to the plan: take the keyboard, so Esc and cmd-w reach the plan, not the hidden terminal.
    if (this.hasStack() && !this.windowed) {
      const shown = shared(VIEW_KEY) === PLAN_VIEW;
      if (shown && !this.wasShown) this.wantKeys();
      this.wasShown = shown;
    }
    // The plan of the agent in the focused tab. Switching agents (or versions) drops the
    // selection and drafts.
    const target = this.target();
    const d = target ? this.docs.get(this.docKey(target.pointer)) ?? null : null;
    if ((target?.terminal ?? null) !== this.terminal || d !== this.doc) {
      // Another agent while the plan shows (a tab, agent.next, a click): Herdr gave the keyboard to
      // that agent's terminal, which is hidden behind the plan. Take it back.
      if (target && (target.terminal ?? null) !== this.terminal && this.hasStack() && !this.windowed && shared(VIEW_KEY) === PLAN_VIEW) this.wantKeys();
      this.terminal = target?.terminal ?? null;
      this.doc = d;
      this.sel = this.pill = this.press = null;
      if (this.composer) { this.composer.state.release(); this.composer = null; }
      if (this.replying) { this.replying.state.release(); this.replying = null; }
      if (this.deciding) { this.deciding.state.release(); this.deciding = null; }
      this.confirmDelete = this.active = null;
      this.typing = false;
      this.storeVersion++;
      this.lastSig = null; // the units redraw without the old selection
      this.wakeHost();
    }
    if (target && (!d || (!d.plan && !d.loading && !d.error && !this.server.down))) { this.wantDoc = target; this.wakeHost(); }
    const wantBase = this.diffOn && d?.plan ? this.diffBaseOf(d) : null;
    if (wantBase != null && !d.diffs.has(wantBase)) { this.wantDiff = { d, base: wantBase }; this.wakeHost(); }
    if (!target) return root.child(this.noPlan(c));
    if (!d?.plan && this.server.down) return root.child(this.serverDown(c));
    if (d?.error) return root.child(this.screen(c, "file", "This plan did not load", d.error, [this.button("retry", "Try again", (_e, cx) => { this.docs.delete(d.key); this.wakeHost(); this.touch(cx); }, c, { outline: true, h: 30, px: 12, size: 13 })]));
    if (!this.plan || !this.slug) return root.child(div().p(24).text_color(t.dim).child("Loading plan…"));

    // The page may not exist in the diff (or version) now shown: fall back to the root.
    this.slug = pageOr(this.plan, this.slug);
    const page = this.page();
    if (page.diff) this.diffDisplay(page.dp);
    const mainW = this.width - (this.sidebarOn() ? SIDEBAR_W : 0);
    const marginMode = mainW - 2 * PAD - MARGIN_W - GAP >= TEXT_MIN;
    const textW = Math.max(300, mainW - 2 * PAD - (marginMode ? MARGIN_W + GAP : 0));
    const contentW = textW + (marginMode ? MARGIN_W + GAP : 0) + 2 * PAD;
    // The text width reaches the units through tintSig (images are sized to it).
    if (this.textW !== textW) { this.textW = textW; this.wakeHost(); }

    // Inline mode: cards go after the block their anchor ends in; page threads after the title.
    const after = new Map();
    if (!marginMode) {
      const put = (k, el) => { if (!after.has(k)) after.set(k, []); after.get(k).push(el); };
      // Cards go after the block (a diff: the display row) their anchor ends in.
      const where = (i) => (page.diff ? page.dp.rowDisp[page.words[i].row] : page.words[i].block);
      for (const th of this.visibleThreads()) {
        const removed = this.removedRow(th);
        const k = th.kind === "page" ? 0 : th.words && !th.detached ? where(th.words[1]) : removed != null ? page.dp.rowDisp[removed] : 0;
        put(k, this.card(th, c));
      }
      if (this.composer && this.composer.doc === this.doc) put(this.composer.r ? where(this.composer.r[1]) : 0, this.composerCard(c));
    }

    // The blocks (a diff: the rows) whose unit views exist (all but the tail of a page still being made).
    const blocks = [];
    const ready = this.ui?.key === this.pageKey();
    if (!ready) this.wakeHost();
    const V = this.viewH ?? 800, top = this.winTop.get(this.viewKey()) ?? 0;
    let complete = false;
    if (page.diff) {
      // A long diff mounts only the rows near the viewport.
      const windowed = this.virtual !== false && page.dp.rows.length > 300;
      const win = windowed ? { lo: top - 1.5 * V - 36, hi: top + 2.5 * V } : { lo: -Infinity, hi: Infinity };
      complete = ready && this.diffBlocks(page.dp, c, win, after, blocks);
    } else {
      // Long pages mount only the units near the viewport (VIRTUAL_WORDS); `plan-review.virtual` toggles it.
      const windowed = this.virtual !== false && page.words.length > VIRTUAL_WORDS;
      const win = windowed ? { lo: top - 1.5 * V - 36, hi: top + 2.5 * V, y: 0 } : { lo: -Infinity, hi: Infinity, y: 0 };
      for (let k = 0; ready && k < page.blocks.length; k++) {
        const b = page.blocks[k];
        const body = this.blockView(b, k, c, win);
        win.y += this.spacing(b, page.blocks[k + 1]);
        if (!body) break;
        const key = `${this.slug}:${k}`;
        blocks.push(v_flex().id(`blk-${key}`).w_full().pb(this.spacing(b, page.blocks[k + 1]))
          .on_size_change((s, cx) => this.measure(this.blockH, key, s.height, cx))
          .child(body)
          .when(after.has(k), (x) => x.child(v_flex().w_full().pt(14).gap(10).children(after.get(k)))));
      }
      complete = ready && blocks.length >= page.blocks.length;
    }
    if (!complete) blocks.push(div().py(8).text_size(13).text_color(t.dim).child(ready ? "Drawing the rest of the page…" : "Loading page…"));
    if (complete && !(page.diff ? page.dp.rows.length : page.blocks.length)) blocks.push(div().py(8).text_size(13).text_color(t.dim).child("This page is empty."));

    const content = div().id(`content-${this.viewKey()}`).relative().w(contentW).flex_none().px(PAD).pt(36).pb(120)
      .on_mouse_down("left", (_e, cx) => {
        // A press on empty space (not a word, card or button): clear the selection.
        if (this.wordPressed) { this.wordPressed = false; return; }
        this.handle.focus();
        if (this.sel || this.pill || this.active) { this.setSel(null, cx); this.pill = null; this.active = null; this.confirmDelete = null; this.touch(cx); }
      })
      .on_mouse_up("left", (e, _cx) => { if (this.press && e.local_position) this.press.at = e.local_position; })
      .child(h_flex().items_start().gap(GAP)
        .child(v_flex().w(textW).flex_none().children(blocks))
        .when(marginMode, (x) => x.child(this.margin(c))))
      .when(!!this.pill && !!this.sel, (x) => x.child(this.pillView(c, contentW)));

    const main = v_flex().flex_1().min_w(0).h_full()
      .child(this.topbar(c))
      .when(this.diffOn && this.diffBaseOf() != null, (x) => x.child(this.diffbar(c)))
      .child(div().id(`scroll-${this.viewKey()}`).flex_1().min_h(0).overflow_y_scrollbar()
        .when(this.windowed, (x) => x.on_mouse_down("left", (_e, cx) => cx.stop_propagation()))
        .on_size_change((sz, _cx) => { this.viewH = sz.height; })
        .on_scroll_wheel((e, cx) => this.scrolled(originY(e), -(e.delta?.y ?? 0), cx))
        .on_mouse_move((e, cx) => this.scrolled(originY(e), 0, cx))
        .child(h_flex().w_full().justify_center()
          .on_scroll_wheel((e, _cx) => { this.rowY = originY(e); })
          .on_mouse_move((e, _cx) => { this.rowY = originY(e); })
          .child(content)))
      .child(this.decisionBar(c));

    return root.relative()
      .child(h_flex().flex_1().min_h(0).w_full()
        .when(this.sidebarOn(), (x) => x.child(this.sidebarView(c)))
        .child(main));
  }
}
