/**
 * Query-param URL state — project/version/doc/review are encoded in the
 * search string so every view is bookmarkable and survives reload.
 * Updates use history.pushState/replaceState + a custom event (pushState
 * doesn't fire popstate), exposed through useSyncExternalStore.
 */

import { useCallback, useMemo, useSyncExternalStore } from 'react';

const EVENT = 'plan-review:urlchange';

function subscribe(cb: () => void): () => void {
  window.addEventListener('popstate', cb);
  window.addEventListener(EVENT, cb);
  return () => {
    window.removeEventListener('popstate', cb);
    window.removeEventListener(EVENT, cb);
  };
}

function getSnapshot(): string {
  return window.location.search;
}

export interface UrlParams {
  project: string | null;
  version: number | null;
  doc: string | null;
  review: string | null;
  view: 'preview' | 'diff';
  diffFrom: number | null;
  diffMode: 'split' | 'unified';
  /** `?picker=1`: open the project picker (links from the Herdr mod). */
  picker: boolean;
}

export function useParams(): UrlParams {
  const search = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return useMemo(() => {
    const q = new URLSearchParams(search);
    const view = q.get('view') === 'diff' ? 'diff' : 'preview';
    const diffMode = q.get('mode') === 'unified' ? 'unified' : 'split';
    return {
      project: q.get('project'),
      version: q.get('version') ? Number(q.get('version')) : null,
      doc: q.get('doc'),
      review: q.get('review'),
      view,
      diffFrom: q.get('from') ? Number(q.get('from')) : null,
      diffMode,
      picker: q.get('picker') === '1',
    };
  }, [search]);
}

/** Update search params. `push` for user-initiated navigation, else replace. */
export function setParams(
  updates: Record<string, string | number | null | undefined>,
  opts?: { push?: boolean },
): void {
  const q = new URLSearchParams(window.location.search);
  for (const [name, value] of Object.entries(updates)) {
    if (value == null || value === '') q.delete(name);
    else q.set(name, String(value));
  }
  const url = `${window.location.pathname}?${q.toString()}${window.location.hash}`;
  if (opts?.push) window.history.pushState(null, '', url);
  else window.history.replaceState(null, '', url);
  window.dispatchEvent(new Event(EVENT));
}

/** Convenience hook returning a stable setter. */
export function useSetParams() {
  return useCallback(setParams, []);
}
