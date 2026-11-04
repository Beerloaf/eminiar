import { createHash } from "node:crypto";

/**
 * Text hygiene for the adjudicator (docs/design/adjudicator.md §6, §12): the cache key, the
 * 80-char head kept in the DB, and the text sent to a remote provider all pass through here.
 */

/** Unicode NFKC, CRLF → LF, trailing spaces and runs of blank lines collapsed, trimmed. */
export function normalize(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** sha256 hex of the normalised text: the same request always hashes the same. */
export function inputHash(text: string): string {
  return createHash("sha256").update(normalize(text)).digest("hex");
}

const SECRET_NAME =
  "[A-Za-z0-9_.-]*?(?:api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|secret|token|passw(?:or)?d|pwd|credentials?|authorization|\\bkey)[A-Za-z0-9_.-]*";

/** Ordered: the specific shapes first, the generic runs last. */
const RULES: Array<[RegExp, string | ((...m: string[]) => string)]> = [
  [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
    "[private key]",
  ],
  // Credentials inside URLs: scheme://user:pass@host
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, "$1***@"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer ***"],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, "sk-***"],
  [/\b(gh[pousr]|github_pat)_[A-Za-z0-9_]{20,}/g, "$1_***"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, "xox*-***"],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "AKIA***"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[jwt]"],
  // key=value, key: value, "key": "value" for secret-looking names
  [
    // (a value already masked above, e.g. "Bearer ***", is left as it is)
    new RegExp(
      `(${SECRET_NAME})(["']?\\s*[:=]\\s*)(["']?)(?!Bearer \\*\\*\\*)([^\\s"'&,;]+)\\3`,
      "gi",
    ),
    (_m, name = "", sep = "", q = "") => `${name}${sep}${q}***${q}`,
  ],
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "[email]"],
  [/\b[0-9a-fA-F]{32,}\b/g, "[hex]"],
  // base64 / base64url runs of 32+ chars mixing upper, lower and digits (not a word or a path)
  [
    /(?<![A-Za-z0-9+/_-])(?=[A-Za-z0-9+/_-]*\d)(?=[A-Za-z0-9+/_-]*[A-Z])(?=[A-Za-z0-9+/_-]*[a-z])[A-Za-z0-9+/_-]{32,}={0,2}/g,
    "[b64]",
  ],
];

/** Mask secrets, emails and long hex/base64 runs. Idempotent. */
export function redact(text: string): string {
  let out = text;
  for (const [re, to] of RULES)
    out = typeof to === "string" ? out.replace(re, to) : out.replace(re, to);
  return out;
}

/** The redacted head kept in the DB: at most n chars (code points), with "…" when cut. */
export function head(text: string, n = 80): string {
  const chars = Array.from(redact(normalize(text)).replace(/\s+/g, " "));
  if (chars.length <= n) return chars.join("");
  return `${chars.slice(0, Math.max(0, n - 1)).join("")}…`;
}

/** The only text a remote provider receives: normalised, redacted, cut to maxChars. */
export function forRemote(text: string, maxChars: number): string {
  return Array.from(redact(normalize(text)))
    .slice(0, maxChars)
    .join("");
}
