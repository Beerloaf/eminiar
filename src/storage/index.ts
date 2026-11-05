import type { ProjectContext } from "../context.js";
import type { StorageAdapter } from "./adapter.js";
import { SqliteAdapter } from "./sqlite/adapter.js";

const open = new Map<string, StorageAdapter>();

/** Lock wait for adapters opened from now on; undefined keeps the adapter's own default. */
let busyTimeoutMs: number | undefined;

/**
 * Shorten how long one statement waits for the write lock of another process. A hook sets
 * this before it opens a database: its whole run has a few seconds, and the wait is added up
 * over every statement. Adapters already open keep the value they were opened with.
 */
export function setStorageBusyTimeout(ms: number | undefined): void {
  busyTimeoutMs = ms;
}

/** One adapter per project DB per process. Hooks pass `vectors: false` to skip loading sqlite-vec. */
export function getStorage(ctx: ProjectContext, opts: { vectors?: boolean } = {}): StorageAdapter {
  const key = `${ctx.dbPath}|${opts.vectors === false ? "novec" : "vec"}`;
  let adapter = open.get(key);
  if (!adapter) {
    adapter = new SqliteAdapter(ctx.dbPath, {
      dims: ctx.config.embeddings.dims,
      vectors: opts.vectors ?? true,
      ...(busyTimeoutMs === undefined ? {} : { busyTimeoutMs }),
    });
    open.set(key, adapter);
  }
  return adapter;
}

export function closeAllStorage(): void {
  for (const a of open.values()) a.close();
  open.clear();
}
