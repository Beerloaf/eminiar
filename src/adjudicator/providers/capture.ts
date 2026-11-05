import { isSecretName, redact } from "../redact.js";
import type { CapturedBody } from "../types.js";

/**
 * Field-by-field scrub and cap for a captured provider exchange (Jev request capture, design
 * blackboard design-xchg). No node: imports.
 *
 * A JSON value is scrubbed STRUCTURALLY: every string leaf and every object key goes through
 * scrubKey(), then the value is stringified, so the stored text stays valid JSON and redact()'s
 * key=value shapes cannot eat structure (usage.input_tokens stays a number). A string under a
 * secret name (redact.ts isSecretName: client_secret, api_key, authorization, …) or a cookie
 * header is masked whole, as redact() would mask `name: value` in text. A body that is not JSON
 * is scrubbed as text. The cap applies AFTER scrubbing, so the key can never survive as a prefix
 * at the cut. This is the "redacted once more" copy: the strings were already redacted when the
 * request was built, so masked spans may differ from the bytes sent.
 *
 * Bounded work (review-xchg R6): a body longer than SCRUB_WINDOW is never parsed or scrubbed
 * whole; only its head is, since at most EXCHANGE_BODY_MAX characters are stored anyway.
 *
 * It never stores a header: callers hand it the request body and the response only.
 */

/** Characters kept per captured request or answer; longer bodies are cut and flagged. */
export const EXCHANGE_BODY_MAX = 65_536;
/**
 * At most this many characters of a raw text body are scrubbed; a longer one is not parsed and
 * only its head is kept (head-only, json false, truncated). Twice the cap leaves room for the
 * scrub to shrink the head (a base64 run collapses to "[b64]") and still fill the stored copy.
 */
export const SCRUB_WINDOW = EXCHANGE_BODY_MAX * 2;
/** Nesting guard for the structural walk; real bodies are a handful of levels deep. */
const MAX_DEPTH = 64;

/** Header names whose whole value is a credential although isSecretName() does not say so. */
const SECRET_HEADERS = new Set(["cookie", "set-cookie", "proxy-authorization"]);

/**
 * The same cleaning redact() starts with (redact.ts clean()): Default_Ignorable characters
 * stripped, NFKC, stripped again. Used to find a key that an echo hid with a zero-width
 * character or wrote in fullwidth forms.
 */
const IGNORABLE = /\p{Default_Ignorable_Code_Point}/gu;
function unhide(s: string): string {
  return s.replace(IGNORABLE, "").normalize("NFKC").replace(IGNORABLE, "");
}

function replaceAll(s: string, needle: string): string {
  return s.includes(needle) ? s.split(needle).join("***") : s;
}

/**
 * Remove the key and anything token-shaped (review-xchg R2). The key is replaced verbatim, then
 * once more in the cleaned text, before and after redact(): redact() strips zero-width
 * characters and applies NFKC, so `tsk9\u200BQw…` or the fullwidth form of the key would
 * otherwise turn into the plain key after the verbatim replace. A key shorter than 4 characters
 * is ignored (it would mangle every word). http.ts scrub() is this function.
 */
export function scrubKey(s: string, key?: string): string {
  if (!key || key.length < 4) return redact(s);
  const plain = unhide(key);
  let out = unhide(replaceAll(s, key));
  if (plain.length >= 4) out = replaceAll(out, plain);
  out = redact(out);
  return plain.length >= 4 ? replaceAll(out, plain) : out;
}

/**
 * Drop a trailing prefix of the key from text that was cut out of a longer one: a key that
 * straddled the cut is not a whole key, so scrubKey() could not replace it (review-xchg R3).
 */
function dropKeyTail(s: string, key?: string): string {
  if (!key || key.length < 4) return s;
  const plain = unhide(key);
  for (let n = Math.min(plain.length - 1, s.length); n > 0; n--)
    if (s.endsWith(plain.slice(0, n))) return s.slice(0, s.length - n);
  return s;
}

/**
 * Scrub the first `window` characters of text. When text is longer, only that head is scrubbed
 * (bounded work) and a key prefix left at its end is dropped, so whatever later cut is applied to
 * the result, no part of a key can be in it. Callers cut the result, never the raw text.
 */
export function scrubHead(text: string, window: number, key?: string): string {
  if (text.length <= window) return scrubKey(text, key);
  return dropKeyTail(scrubKey(text.slice(0, window), key), key);
}

/** A value that names or holds nothing secret: left alone under a secret name. */
function trivial(s: string): boolean {
  return s === "" || /^\*+$/.test(s);
}

function walk(v: unknown, key: string | undefined, depth: number, secret: boolean): unknown {
  if (typeof v === "string") return secret && !trivial(v) ? "***" : scrubKey(v, key);
  if (v === null || typeof v !== "object") return v;
  if (depth >= MAX_DEPTH) return "[too deep]";
  // An array under a secret name holds secrets too; an object's own names decide for its fields.
  if (Array.isArray(v)) return v.map((x) => walk(x, key, depth + 1, secret));
  // A null-prototype target: a "__proto__" key is stored as an own property, not a setter call.
  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [k, x] of Object.entries(v)) {
    const name = scrubKey(k, key);
    // Judged on the cleaned name, so `client\u200Bsecret` is still a secret name (R5).
    const hidden = unhide(k);
    const secret = isSecretName(hidden) || SECRET_HEADERS.has(hidden.toLowerCase());
    out[name] = walk(x, key, depth + 1, secret);
  }
  return out;
}

function cap(text: string, json: boolean): CapturedBody {
  return text.length > EXCHANGE_BODY_MAX
    ? { text: text.slice(0, EXCHANGE_BODY_MAX), json, bytes: text.length, truncated: true }
    : { text, json, bytes: text.length, truncated: false };
}

/** A JSON value (the request object, or a parsed response) as scrubbed, capped JSON text. */
export function captureBody(value: unknown, key?: string): CapturedBody {
  if (value === undefined) return { text: "", json: false, bytes: 0, truncated: false };
  return cap(JSON.stringify(walk(value, key, 0, false)) ?? "", true);
}

/**
 * A raw response body: scrubbed structurally when it parses as JSON, else as text. `parsed` is
 * the body already parsed by the caller (http.ts on a 2xx), so it is not parsed twice. A body
 * longer than SCRUB_WINDOW is neither parsed nor scrubbed whole: its head is (R6).
 */
export function captureText(text: string, key?: string, parsed?: unknown): CapturedBody {
  if (text.length > SCRUB_WINDOW) {
    return {
      text: scrubHead(text, SCRUB_WINDOW, key).slice(0, EXCHANGE_BODY_MAX),
      json: false,
      bytes: text.length,
      truncated: true,
    };
  }
  if (parsed !== undefined) return captureBody(parsed, key);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return cap(scrubKey(text, key), false);
  }
  return captureBody(value, key);
}
