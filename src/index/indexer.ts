import { readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import fg from "fast-glob";
import { redactSecrets } from "../adjudicator/redact.js";
import { chunk, hashText, type Kind, kindToContentType } from "../chunker/index.js";
import { finalize, type RawChunk } from "../chunker/types.js";
import type { StorageAdapter } from "../storage/adapter.js";
import type { ContentType, Source } from "../storage/types.js";

export interface IndexInput {
  source: Source;
  title: string;
  content: string;
  uri?: string | undefined;
  kind?: Kind | undefined;
  contentType?: ContentType | undefined;
  sessionId?: string | undefined;
  meta?: Record<string, unknown> | undefined;
  /** Pre-cut chunks (e.g. symbol-aligned code); skips the generic chunker. */
  chunks?: RawChunk[] | undefined;
  /** Re-chunk even when the content is unchanged (the chunking itself changed). */
  force?: boolean | undefined;
}

export interface IndexResult {
  documentId: number;
  created: boolean;
  chunks: number;
  chars: number;
  kind: Kind;
  /** The chunker found nothing in non-empty content, so the whole content became one chunk. */
  fallback: boolean;
}

/**
 * Captured output: what em_execute, em_execute_file, em_batch_execute and em_fetch_and_index
 * store. Unlike a project file or a memory, the index holds the only copy, it outlives the session
 * and any later em_search reads it, so secrets are masked before it is chunked. What the tools
 * show inline (small outputs, the head/tail preview) is as printed; sections they return for an
 * intent or queries come from this masked copy.
 */
const CAPTURED = new Set<Source>(["exec", "batch", "url"]);

/** Bump when the masking rules change enough that stored output should be masked again. */
const CAPTURED_MASK_VERSION = "1";

/** A captured document as stored: title, content, pre-cut chunks and string meta masked. */
function maskCaptured(input: IndexInput): IndexInput {
  const meta = input.meta
    ? Object.fromEntries(
        Object.entries(input.meta).map(([k, v]) => [
          k,
          typeof v === "string" ? redactSecrets(v) : v,
        ]),
      )
    : undefined;
  return {
    ...input,
    title: redactSecrets(input.title),
    content: redactSecrets(input.content),
    meta,
    chunks: input.chunks?.map((c) => ({
      ...c,
      title: redactSecrets(c.title),
      body: redactSecrets(c.body),
    })),
  };
}

/** How long one slice of the re-mask may read and mask before it writes and yields to tool calls. */
const REMASK_SLICE_MS = 20;

/**
 * The pause after a slice that wrote. Another process waiting on the lock retries on its own
 * schedule (every 25-50 ms by then), so a lock taken again at once would starve it; this leaves
 * it a gap as long as the remask's longest hold.
 */
const REMASK_GAP_MS = 40;

/** A busy database: retry after 50 ms, doubling to 2 s, and give up after this many in a row. */
const REMASK_BUSY_TRIES = 40;
const REMASK_BUSY_FIRST_MS = 50;
const REMASK_BUSY_MAX_MS = 2000;

/** The lock wait of the remask's own progress write (the default is 2000 ms, which stalls tool calls). */
const REMASK_LOCK_WAIT_MS = 40;

const isBusy = (err: unknown): boolean =>
  /^SQLITE_(BUSY|LOCKED)/.test(String((err as { code?: unknown } | null)?.code ?? ""));

const sleep = (ms: number) =>
  new Promise<void>((resolve) => (ms > 0 ? setTimeout(resolve, ms) : setImmediate(resolve)));

/** `fn`, retried with a growing pause while another process holds the database. */
async function whenFree<T>(fn: () => T): Promise<T> {
  for (let tries = 1; ; tries++) {
    try {
      return fn();
    } catch (err) {
      if (!isBusy(err) || tries >= REMASK_BUSY_TRIES) throw err;
      await sleep(Math.min(REMASK_BUSY_MAX_MS, REMASK_BUSY_FIRST_MS * 2 ** (tries - 1)));
    }
  }
}

/**
 * `<CAPTURED_MASK_VERSION>:<id>`: every captured document up to that id is masked under these
 * rules. Document ids are AUTOINCREMENT, so they are never handed out again below it.
 */
const CAPTURED_MASK_KEY = "captured_mask_upto";

/**
 * Mask captured output stored before it was masked (or under older rules) in place. The server
 * runs it in its warm-up on every start: the first run goes over the whole database, and later
 * ones only over the documents stored since, which catches output that an older eminiar still
 * running on the same database stored unmasked meanwhile. It yields every REMASK_SLICE_MS so a
 * tool call is never queued behind it, pauses REMASK_GAP_MS after each write so hooks get the
 * lock, waits out a busy database (a second server starting with this one), and records where it
 * got to after each slice, so a server stopped halfway resumes there. Hooks never run it. Returns
 * the number of rows (chunks and document titles) that changed.
 */
export async function remaskCapturedOutput(db: StorageAdapter): Promise<number> {
  const saved = db.metaGet(CAPTURED_MASK_KEY);
  const [version, id] = (saved ?? "").split(":");
  let afterId = version === CAPTURED_MASK_VERSION ? Number(id) || 0 : 0;
  let pointer = saved;
  let changed = 0;
  const shortWait = <T>(fn: () => T): T =>
    db.adjudicator.withLockWait ? db.adjudicator.withLockWait(REMASK_LOCK_WAIT_MS, fn) : fn();
  for (;;) {
    const slice = await whenFree(() =>
      db.remaskDocuments([...CAPTURED], redactSecrets, afterId, REMASK_SLICE_MS),
    );
    changed += slice.changed;
    afterId = slice.lastId;
    // Written after the slice, not inside its transactions: a stop between the two only redoes
    // documents that are already masked, which changes nothing.
    const next = `${CAPTURED_MASK_VERSION}:${afterId}`;
    if (next !== pointer) {
      await whenFree(() => shortWait(() => db.metaSet(CAPTURED_MASK_KEY, next)));
      pointer = next;
    }
    if (slice.done) return changed;
    await sleep(slice.wrote ? REMASK_GAP_MS : 0);
  }
}

/** Chunk + store one piece of content. Unchanged uri+content is a no-op (created=false). */
export function indexContent(db: StorageAdapter, raw: IndexInput): IndexResult {
  const input = CAPTURED.has(raw.source) ? maskCaptured(raw) : raw;
  const kind =
    input.kind ??
    (input.contentType === "code" ? "code" : input.contentType === "json" ? "json" : undefined);
  const cut = input.chunks
    ? { chunks: finalize(input.chunks, input.contentType ?? "code"), kind: kind ?? "code" }
    : chunk(input.content, input.title, kind, input.uri);
  const k = cut.kind;
  // Nothing may index to nothing: content the chunker could not cut is stored whole.
  const fallback = cut.chunks.length === 0 && input.content.trim().length > 0;
  const chunks = fallback
    ? finalize(
        [
          {
            title: input.title,
            body: input.content,
            startLine: 1,
            endLine: input.content.split("\n").length,
          },
        ],
        kindToContentType(k),
      )
    : cut.chunks;
  const contentHash = hashText(input.content);
  const existing = input.uri ? db.findDocumentByUri(input.uri) : undefined;
  if (existing && existing.content_hash === contentHash) {
    if (!input.force) {
      return {
        documentId: existing.id,
        created: false,
        chunks: chunks.length,
        chars: input.content.length,
        kind: k,
        fallback,
      };
    }
    db.deleteDocument(existing.id);
  }
  const { id, created } = db.upsertDocument(
    {
      source: input.source,
      title: input.title,
      uri: input.uri,
      contentType: chunks[0]?.contentType ?? "prose",
      contentHash,
      sessionId: input.sessionId,
      meta: input.meta,
    },
    chunks,
  );
  return {
    documentId: id,
    created,
    chunks: chunks.length,
    chars: input.content.length,
    kind: k,
    fallback,
  };
}

export const MAX_FILE_BYTES = 2 * 1024 * 1024;

export interface IndexPathSummary {
  files: number;
  indexed: number;
  unchanged: number;
  skipped: Array<{ path: string; reason: string }>;
  chunks: number;
  /** Files whose chunker found no sections and that were indexed as one chunk. */
  fallbacks: number;
}

/** Index a file or every file under a directory matching `globs` (relative to the directory). */
export interface IndexPathOptions {
  source?: Source | undefined;
  globs?: string[] | undefined;
  recursive?: boolean | undefined;
  ignore?: string[] | undefined;
  /** Rewrite a file before indexing (e.g. render an OpenAPI spec as markdown); undefined keeps it as is. */
  transform?:
    | ((
        content: string,
        rel: string,
      ) => { content: string; title?: string | undefined; kind?: Kind | undefined } | undefined)
    | undefined;
}

export function indexPath(
  db: StorageAdapter,
  root: string,
  target: string,
  opts: IndexPathOptions = {},
): IndexPathSummary {
  const abs = resolve(root, target);
  const summary: IndexPathSummary = {
    files: 0,
    indexed: 0,
    unchanged: 0,
    skipped: [],
    chunks: 0,
    fallbacks: 0,
  };
  const st = statSync(abs);
  const files = st.isDirectory()
    ? fg.sync(opts.globs ?? ["**/*.md"], {
        cwd: abs,
        absolute: true,
        onlyFiles: true,
        deep: opts.recursive === false ? 1 : Number.POSITIVE_INFINITY,
        ignore: opts.ignore ?? ["**/node_modules/**", "**/.git/**", "**/dist/**", "**/build/**"],
        dot: false,
      })
    : [abs];
  for (const file of files) {
    summary.files++;
    const rel = relative(root, file) || file;
    try {
      const size = statSync(file).size;
      if (size > MAX_FILE_BYTES) {
        summary.skipped.push({ path: rel, reason: `too large (${size} bytes)` });
        continue;
      }
      const content = readFileSync(file, "utf8");
      if (content.includes("\u0000")) {
        summary.skipped.push({ path: rel, reason: "binary" });
        continue;
      }
      const t = opts.transform?.(content, rel);
      const r = indexContent(db, {
        source: opts.source ?? "file",
        title: t?.title ? `${t.title} (${rel})` : rel,
        content: t?.content ?? content,
        kind: t?.kind,
        uri: `file://${file}`,
      });
      if (r.created) summary.indexed++;
      else summary.unchanged++;
      summary.chunks += r.chunks;
      if (r.fallback) summary.fallbacks++;
    } catch (err) {
      summary.skipped.push({ path: rel, reason: (err as Error).message });
    }
  }
  return summary;
}
