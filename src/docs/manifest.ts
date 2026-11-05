import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { ProjectContext } from "../context.js";
import type { StorageAdapter } from "../storage/adapter.js";

/** Index source tag prefix for every documentation page: `docs:<name>`. */
export const DOCS_PREFIX = "docs:";

/** One registered documentation source: a local path or a set of URL seeds to crawl. */
export interface DocSource {
  /** Slug, unique in the manifest; the index tag is `docs:<name>`. */
  name: string;
  kind: "url" | "path";
  /** URL seeds (kind `url`); same-origin pages under each seed's directory are crawled. */
  urls?: string[] | undefined;
  /** Project-relative file or directory (kind `path`). */
  path?: string | undefined;
  /** Globs for a directory path (default: the config `index.docs` globs). */
  glob?: string[] | undefined;
  /** Where the source came from: `npm:zod`, `pypi:fastapi`, `go:<module>`, `env:SUMSUB`, `image:nats`, `files:terraform`, `manual`. */
  provider?: string | undefined;
  title?: string | undefined;
  crawl?: { depth?: number | undefined; maxPages?: number | undefined } | undefined;
  ttlHours?: number | undefined;
  tags?: string[] | undefined;
  notes?: string | undefined;
  addedAt: string;
}

export interface DocsManifest {
  version: 1;
  sources: DocSource[];
}

/** What the last sync of a source did; kept in the project DB, not in the committed manifest. */
export interface DocsSyncState {
  at: number;
  pages: number;
  documents: number;
  chunks: number;
  errors: string[];
  skipped: number;
  ms: number;
}

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function docsTag(name: string): string {
  return `${DOCS_PREFIX}${name}`;
}

export function nameFromTag(tag: string): string | undefined {
  return tag.startsWith(DOCS_PREFIX) ? tag.slice(DOCS_PREFIX.length) : undefined;
}

export function isValidName(name: string): boolean {
  return NAME_RE.test(name);
}

/** `@aws-sdk/client-s3` → `aws-sdk-client-s3`, `Sumsub KYC` → `sumsub-kyc`. */
export function slugify(input: string): string {
  const s = input
    .toLowerCase()
    .replace(/^@/, "")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "");
  return (s || "source").slice(0, 64);
}

export function manifestPathAt(root: string, rel = ".eminiar/docs.json"): string {
  return join(root, rel);
}

export function manifestPath(ctx: ProjectContext): string {
  return manifestPathAt(ctx.root, ctx.config.docs.manifest);
}

function empty(): DocsManifest {
  return { version: 1, sources: [] };
}

function normalize(raw: unknown): DocsManifest {
  if (!raw || typeof raw !== "object") return empty();
  const sources = Array.isArray((raw as DocsManifest).sources) ? (raw as DocsManifest).sources : [];
  const out: DocSource[] = [];
  const seen = new Set<string>();
  for (const s of sources) {
    if (!s || typeof s !== "object" || typeof s.name !== "string") continue;
    if (!isValidName(s.name) || seen.has(s.name)) continue;
    if (s.kind !== "url" && s.kind !== "path") continue;
    if (s.kind === "url" && !(Array.isArray(s.urls) && s.urls.length)) continue;
    if (s.kind === "path" && typeof s.path !== "string") continue;
    seen.add(s.name);
    out.push({
      ...s,
      addedAt: typeof s.addedAt === "string" ? s.addedAt : new Date(0).toISOString(),
    });
  }
  return { version: 1, sources: out };
}

/**
 * Largest manifest read, in bytes. The real one is a few KB; the bound keeps a hostile repo
 * (a committed symlink, or a project-set `docs.manifest`) from making every hook read a huge
 * file or a device.
 */
export const MANIFEST_MAX_BYTES = 1024 * 1024;

/** What is at a manifest path: nothing, a manifest, or a file that was not read (and why). */
export type ManifestProbe =
  | { state: "missing" }
  | { state: "ok"; manifest: DocsManifest }
  | { state: "refused"; reason: string };

/**
 * Thrown by every manifest write when a file is present but was not read: writing would replace
 * the committed sources with only the ones this call knows about.
 */
export class ManifestRefusedError extends Error {
  readonly file: string;
  readonly reason: string;
  constructor(file: string, reason: string) {
    super(
      `refusing to write the docs manifest ${file}: ${reason}, so it was not read and writing it would drop its sources; fix or move it, then retry`,
    );
    this.name = "ManifestRefusedError";
    this.file = file;
    this.reason = reason;
  }
}

/**
 * Look at a manifest file without trusting it: a regular file of at most MANIFEST_MAX_BYTES
 * holding a JSON object is `ok`; no entry is `missing`; anything else (too large, a directory,
 * a device, a FIFO, a dangling symlink, unreadable, not JSON) is `refused`.
 */
export function probeManifestAt(file: string): ManifestProbe {
  let fd: number | undefined;
  try {
    // statSync follows symlinks; checking first keeps a FIFO or device from ever being opened.
    const st = statSync(file, { throwIfNoEntry: false });
    if (!st) {
      // A dangling symlink would have a write create its target, wherever that points.
      return lstatSync(file, { throwIfNoEntry: false })
        ? { state: "refused", reason: "it is a symlink to a missing file" }
        : { state: "missing" };
    }
    if (!st.isFile()) return { state: "refused", reason: "it is not a regular file" };
    if (st.size > MANIFEST_MAX_BYTES) return { state: "refused", reason: tooLarge(st.size) };
    // O_NONBLOCK: a path swapped for a FIFO after the stat cannot block the open.
    fd = openSync(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    const fst = fstatSync(fd);
    if (!fst.isFile()) return { state: "refused", reason: "it is not a regular file" };
    if (fst.size > MANIFEST_MAX_BYTES) return { state: "refused", reason: tooLarge(fst.size) };
    // Read at most the size seen, so a file growing after the fstat is not followed.
    const buf = Buffer.alloc(fst.size);
    let off = 0;
    while (off < buf.length) {
      const n = readSync(fd, buf, off, buf.length - off, off);
      if (n === 0) break;
      off += n;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(buf.toString("utf8", 0, off));
    } catch {
      return { state: "refused", reason: "it is not valid JSON" };
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      return { state: "refused", reason: "it is not a JSON object" };
    return { state: "ok", manifest: normalize(raw) };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // Removed between the stat and the open: nothing is there to lose.
    if (code === "ENOENT") return { state: "missing" };
    return { state: "refused", reason: `it could not be read (${code ?? (err as Error).message})` };
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // already closed or invalid; nothing to release
      }
    }
  }
}

function tooLarge(size: number): string {
  return `it is ${size} bytes, over the ${MANIFEST_MAX_BYTES}-byte limit`;
}

/**
 * Read a manifest file; a missing, malformed or oversized file, or a path that is not a
 * regular file (a directory, a device, a FIFO, also through a symlink), reads as empty.
 * For readers only (hooks fail open): a write must use readManifestForWrite.
 */
export function readManifestAt(file: string): DocsManifest {
  const p = probeManifestAt(file);
  return p.state === "ok" ? p.manifest : empty();
}

export function readManifest(ctx: ProjectContext): DocsManifest {
  return readManifestAt(manifestPath(ctx));
}

/**
 * Read the manifest to change it: a missing one is empty, a present one that was not read
 * throws ManifestRefusedError instead of reading as empty.
 */
export function readManifestForWrite(ctx: ProjectContext): DocsManifest {
  const file = manifestPath(ctx);
  const p = probeManifestAt(file);
  if (p.state === "refused") throw new ManifestRefusedError(file, p.reason);
  return p.state === "ok" ? p.manifest : empty();
}

/** Write the manifest; throws ManifestRefusedError rather than replace a file it could not read. */
export function writeManifest(ctx: ProjectContext, m: DocsManifest): string {
  const file = manifestPath(ctx);
  const p = probeManifestAt(file);
  if (p.state === "refused") throw new ManifestRefusedError(file, p.reason);
  mkdirSync(dirname(file), { recursive: true });
  const sorted = {
    version: 1 as const,
    sources: [...m.sources].sort((a, b) => a.name.localeCompare(b.name)),
  };
  writeFileSync(file, `${JSON.stringify(sorted, null, 2)}\n`);
  return file;
}

export type DocSourceInput = Omit<DocSource, "addedAt"> & { addedAt?: string | undefined };

/** Validate and fill one source; throws on a bad name or an empty definition. */
export function makeSource(input: DocSourceInput): DocSource {
  const name = isValidName(input.name) ? input.name : slugify(input.name);
  if (!isValidName(name)) throw new Error(`invalid source name "${input.name}"`);
  const urls = (input.urls ?? []).map((u) => u.trim()).filter(Boolean);
  for (const u of urls) {
    let parsed: URL;
    try {
      parsed = new URL(u);
    } catch {
      throw new Error(`${name}: "${u}" is not a URL`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
      throw new Error(`${name}: only http(s) URLs can be crawled`);
  }
  const path = input.path?.trim();
  if (input.kind === "url" && !urls.length) throw new Error(`${name}: a url source needs urls`);
  if (input.kind === "path" && !path) throw new Error(`${name}: a path source needs a path`);
  if (path && (path.startsWith("/") || path.startsWith("..")))
    throw new Error(`${name}: path must be inside the project`);
  const src: DocSource = {
    name,
    kind: input.kind,
    addedAt: input.addedAt ?? new Date().toISOString(),
  };
  if (input.kind === "url") src.urls = [...new Set(urls)];
  if (input.kind === "path") src.path = path;
  if (input.glob?.length) src.glob = input.glob;
  if (input.provider) src.provider = input.provider;
  if (input.title) src.title = input.title;
  if (input.crawl && (input.crawl.depth !== undefined || input.crawl.maxPages !== undefined))
    src.crawl = {
      ...(input.crawl.depth !== undefined ? { depth: input.crawl.depth } : {}),
      ...(input.crawl.maxPages !== undefined ? { maxPages: input.crawl.maxPages } : {}),
    };
  if (input.ttlHours !== undefined) src.ttlHours = input.ttlHours;
  if (input.tags?.length) src.tags = [...new Set(input.tags)];
  if (input.notes) src.notes = input.notes;
  return src;
}

/** Add or replace sources by name; returns which were new and which replaced an entry. */
export function upsertSources(
  ctx: ProjectContext,
  inputs: DocSourceInput[],
): { added: string[]; updated: string[]; file: string } {
  const m = readManifestForWrite(ctx);
  const added: string[] = [];
  const updated: string[] = [];
  for (const input of inputs) {
    const src = makeSource(input);
    const i = m.sources.findIndex((s) => s.name === src.name);
    if (i === -1) {
      m.sources.push(src);
      added.push(src.name);
    } else {
      m.sources[i] = { ...src, addedAt: m.sources[i]!.addedAt };
      updated.push(src.name);
    }
  }
  const file = writeManifest(ctx, m);
  return { added, updated, file };
}

export function removeSource(ctx: ProjectContext, name: string): boolean {
  const m = readManifestForWrite(ctx);
  const before = m.sources.length;
  m.sources = m.sources.filter((s) => s.name !== name);
  if (m.sources.length === before) return false;
  writeManifest(ctx, m);
  return true;
}

export function getSource(ctx: ProjectContext, name: string): DocSource | undefined {
  return readManifest(ctx).sources.find((s) => s.name === name);
}

const SYNC_KEY = (name: string) => `docs.sync.${name}`;

export function syncState(db: StorageAdapter, name: string): DocsSyncState | undefined {
  const raw = db.metaGet(SYNC_KEY(name));
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as DocsSyncState;
  } catch {
    return undefined;
  }
}

export function setSyncState(db: StorageAdapter, name: string, state: DocsSyncState): void {
  db.metaSet(SYNC_KEY(name), JSON.stringify(state));
}

export function clearSyncState(db: StorageAdapter, name: string): void {
  db.metaSet(SYNC_KEY(name), "");
}
