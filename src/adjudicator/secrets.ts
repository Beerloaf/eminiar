import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { paths } from "../paths.js";

/**
 * Provider keys for the adjudicator (docs/design/adjudicator.md §6). The key file
 * ~/.eminiar/adjudicator.key is JSON {"typesafe": "...", "openai:groq": "...", ...}, mode 0600,
 * written only by `eminiar adjudicator key set` (temp file + rename). Keys never go into
 * config, argv, logs, the DB or any payload: callers get the key from resolveKey() at the
 * moment they send a request, and show only keySource plus mask().
 */

/** "typesafe" or "openai:<preset>". */
export type KeyId = string;
export type KeySource = "env" | "file" | "none";

export interface KeyResolution {
  /** Present only when source is env or file. Never log, store or return it in a payload. */
  key?: string;
  source: KeySource;
  /** The env var the key came from (source env). */
  envName?: string;
  /** The key file exists but is readable by group/others, so it was not read. */
  refused?: "permissions";
}

export interface KeyFileStatus {
  path: string;
  exists: boolean;
  /** Permission bits (e.g. 0o600), when the file exists. */
  mode?: number;
  /** False when any group/other bit (0o077) is set; doctor then suggests `chmod 600`. */
  secure: boolean;
}

/** Generic fallback env var, checked after the provider's own. */
export const GENERIC_KEY_ENV = "EMINIAR_ADJUDICATOR_KEY";

interface Cached {
  keys: Record<string, string>;
  refused: boolean;
}
let cached: Cached | undefined;

/** Test seam: forget the cached key file (EMINIAR_HOME changes between tests). */
export function resetSecrets(): void {
  cached = undefined;
}

const checksMode = () => process.platform !== "win32";

export function keyFileStatus(): KeyFileStatus {
  const path = paths().adjudicatorKey;
  try {
    const mode = statSync(path).mode & 0o777;
    return { path, exists: true, mode, secure: !checksMode() || (mode & 0o077) === 0 };
  } catch {
    return { path, exists: false, secure: true };
  }
}

function parseKeys(text: string): Record<string, string> {
  try {
    const raw = JSON.parse(text) as unknown;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) if (typeof v === "string" && v) out[k] = v;
    return out;
  } catch {
    return {};
  }
}

function load(): Cached {
  if (cached) return cached;
  const st = keyFileStatus();
  if (!st.exists) cached = { keys: {}, refused: false };
  else if (!st.secure) cached = { keys: {}, refused: true };
  else {
    try {
      cached = { keys: parseKeys(readFileSync(st.path, "utf8")), refused: false };
    } catch {
      cached = { keys: {}, refused: false };
    }
  }
  return cached;
}

/**
 * Resolution order: the env var named by keyEnv, the provider's own env var
 * (TYPESAFE_API_KEY, GROQ_API_KEY, ...), EMINIAR_ADJUDICATOR_KEY, then the key file.
 * `fileOnly` skips every env var: a local (loopback) provider only ever gets a key the user
 * stored for exactly that provider id, never one from the environment (§6).
 */
export function resolveKey(
  id: KeyId,
  opts: {
    keyEnv?: string | undefined;
    providerEnv?: string | undefined;
    env?: NodeJS.ProcessEnv | undefined;
    fileOnly?: boolean | undefined;
  } = {},
): KeyResolution {
  const env = opts.env ?? process.env;
  const names = opts.fileOnly ? [] : [opts.keyEnv, opts.providerEnv, GENERIC_KEY_ENV];
  for (const name of names) {
    const v = name ? env[name]?.trim() : undefined;
    if (name && v) return { key: v, source: "env", envName: name };
  }
  const file = load();
  const key = file.keys[id];
  if (key) return { key, source: "file" };
  return file.refused ? { source: "none", refused: "permissions" } : { source: "none" };
}

/** Ids that have a key in the key file (not the keys). Empty when the file is refused. */
export function storedKeyIds(): KeyId[] {
  return Object.keys(load().keys).sort();
}

/** Read the file for a rewrite, whatever its mode: the user is replacing it with a 0600 copy. */
function readForWrite(): Record<string, string> {
  try {
    return parseKeys(readFileSync(paths().adjudicatorKey, "utf8"));
  } catch {
    return {};
  }
}

function writeKeys(keys: Record<string, string>): void {
  const file = paths().adjudicatorKey;
  if (Object.keys(keys).length === 0) {
    try {
      unlinkSync(file);
    } catch {
      // already gone
    }
    cached = { keys: {}, refused: false };
    return;
  }
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    // `wx` + 0600: the temp file is never readable by anyone else, even for a moment.
    writeFileSync(tmp, `${JSON.stringify(keys, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    renameSync(tmp, file);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // nothing to clean up
    }
    throw err;
  }
  cached = { keys: { ...keys }, refused: false };
}

/** Store a key for one provider (`eminiar adjudicator key set`). */
export function setKey(id: KeyId, key: string): void {
  const k = key.trim();
  if (!k || /\s/.test(k)) throw new Error("a key must be non-empty and contain no whitespace");
  writeKeys({ ...readForWrite(), [id]: k });
}

/** Remove one provider's key, or every key when no id is given. Returns whether anything changed. */
export function clearKey(id?: KeyId): boolean {
  const keys = readForWrite();
  if (id === undefined) {
    const had = Object.keys(keys).length > 0 || keyFileStatus().exists;
    writeKeys({});
    return had;
  }
  if (!(id in keys)) return false;
  delete keys[id];
  writeKeys(keys);
  return true;
}

/** The only form a key may be shown in: the last 4 chars, and only for keys long enough to spare them. */
export function mask(key: string | undefined): string {
  if (!key) return "none";
  return key.length >= 12 ? `****${key.slice(-4)}` : "****";
}
