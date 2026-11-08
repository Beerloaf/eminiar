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

/** How long one slice of the re-mask may hold the server before it yields to tool calls. */
const REMASK_SLICE_MS = 20;

/**
 * Mask captured output stored before it was masked (or under older rules) in place, once per
 * database. The server runs it in its warm-up; it yields every REMASK_SLICE_MS so a tool call is
 * never queued behind it, and records where it got to, so a server stopped halfway resumes there.
 * Hooks never run it. Returns the number of chunks that changed.
 */
export async function remaskCapturedOutput(db: StorageAdapter): Promise<number> {
  if (db.metaGet("captured_mask_version") === CAPTURED_MASK_VERSION) return 0;
  const [version, id] = (db.metaGet("captured_mask_resume") ?? "").split(":");
  let afterId = version === CAPTURED_MASK_VERSION ? Number(id) || 0 : 0;
  let changed = 0;
  for (;;) {
    const slice = db.remaskDocuments([...CAPTURED], redactSecrets, afterId, REMASK_SLICE_MS);
    changed += slice.changed;
    if (slice.done) break;
    afterId = slice.lastId;
    // Written after the slice, not inside its transactions: a stop between the two only redoes
    // documents that are already masked, which changes nothing.
    db.metaSet("captured_mask_resume", `${CAPTURED_MASK_VERSION}:${afterId}`);
    await new Promise((resolve) => setImmediate(resolve));
  }
  db.metaSet("captured_mask_version", CAPTURED_MASK_VERSION);
  db.metaDelete("captured_mask_resume");
  return changed;
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
