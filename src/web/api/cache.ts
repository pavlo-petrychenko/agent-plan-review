/**
 * Tiny SWR-style cache: keyed async data with prefix invalidation.
 *
 * Snapshot strategy: a monotonically increasing version counter feeds
 * useSyncExternalStore. Any mutation bumps the counter (entries themselves
 * are treated as immutable), so every subscribed component re-renders on
 * change — simple and correct for an app of this size.
 *
 * Invalidation semantics: the cache remembers the fetcher used for each key,
 * so `invalidate(prefix)` drops matching entries AND immediately re-fetches
 * them — mutations reflect in the UI without remounting anything.
 */

import { useCallback, useEffect, useRef } from 'react';
import { useSyncExternalStore } from 'react';

interface Entry {
  data?: unknown;
  error?: string;
  loading: boolean;
}

class ApiCache {
  private entries = new Map<string, Entry>();
  private fetchers = new Map<string, () => Promise<unknown>>();
  private listeners = new Set<() => void>();
  private version = 0;

  subscribeAll = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };

  getVersion = (): number => this.version;

  private changed(): void {
    this.version++;
    this.listeners.forEach((cb) => cb());
  }

  getSnapshot(key: string): Entry | undefined {
    return this.entries.get(key);
  }

  async refetch<T>(key: string, fetcher?: () => Promise<T>): Promise<void> {
    const fn = fetcher ?? this.fetchers.get(key);
    if (!fn) return;
    this.fetchers.set(key, fn as () => Promise<unknown>);
    const previous = this.entries.get(key)?.data;
    this.entries.set(key, { ...(previous !== undefined ? { data: previous } : {}), loading: true });
    this.changed();
    try {
      const data = await fn();
      this.entries.set(key, { data, loading: false });
    } catch (err) {
      this.entries.set(key, {
        ...(previous !== undefined ? { data: previous } : {}),
        error: err instanceof Error ? err.message : String(err),
        loading: false,
      });
    } finally {
      this.changed();
    }
  }

  /** Fetch unless fresh data already exists. */
  fetch<T>(key: string, fetcher: () => Promise<T>): void {
    this.fetchers.set(key, fetcher as () => Promise<unknown>);
    const existing = this.entries.get(key);
    if ((existing?.data !== undefined || existing?.error) && !existing?.loading) return;
    if (existing?.loading) return;
    void this.refetch(key, fetcher);
  }

  /** Drop matching entries and re-fetch the ones something is watching. */
  invalidate(prefix: string): void {
    const targets: string[] = [];
    for (const key of [...this.entries.keys()]) {
      if (key.startsWith(prefix)) {
        this.entries.delete(key);
        targets.push(key);
      }
    }
    // Also catch watched-but-never-fetched keys (e.g. conditional hooks).
    for (const key of this.fetchers.keys()) {
      if (key.startsWith(prefix) && !targets.includes(key)) targets.push(key);
    }
    if (targets.length === 0) return;
    this.changed();
    for (const key of targets) {
      queueMicrotask(() => void this.refetch(key));
    }
  }
}

export const apiCache = new ApiCache();

// ---------------------------------------------------------------------------
// hooks
// ---------------------------------------------------------------------------

export interface UseApiResult<T> {
  data: T | undefined;
  error: string | undefined;
  loading: boolean;
  reload: () => void;
}

/**
 * Read cached API data for `key`, fetching on first use. Pass `null` as key
 * to disable (conditional fetching).
 */
export function useApi<T>(key: string | null, fetcher: () => Promise<T>): UseApiResult<T> {
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  useSyncExternalStore(apiCache.subscribeAll, apiCache.getVersion, apiCache.getVersion);

  useEffect(() => {
    if (!key) return;
    apiCache.fetch(key, fetcherRef.current);
  }, [key]);

  const reload = useCallback(() => {
    if (key) void apiCache.refetch(key);
  }, [key]);

  const entry = key ? apiCache.getSnapshot(key) : undefined;
  return {
    data: entry?.data as T | undefined,
    error: entry?.error,
    loading: entry?.loading ?? false,
    reload,
  };
}

/** Invalidate every cached entry under the given prefixes. */
export function invalidate(...prefixes: string[]): void {
  for (const p of prefixes) apiCache.invalidate(p);
}
