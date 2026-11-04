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

// ---------------------------------------------------------------------------------------------
// Secret-looking names. A name is split into words (on _ . - and camelCase) and is secret when
// its last word is a secret word, optionally followed only by harmless qualifiers (`_v2`,
// `_base`, `_hash`). So JWT_SIGNING_KEY, DB_PASS, _authToken, x-api-key and secret_key_base
// are secret, while keyEnv, apiKeyName, token_count and max_tokens are not.
// ---------------------------------------------------------------------------------------------

const SECRET_WORDS = new Set([
  "key",
  "token",
  "secret",
  "secrets",
  "pass",
  "password",
  "passwd",
  "passphrase",
  "pwd",
  "pw",
  "credential",
  "credentials",
  "creds",
  "auth",
  "authorization",
  "pat",
]);
/** A single lowercase word that ends in one of these is secret too (PGPASSWORD, APIKEY). */
const SECRET_WORD_SUFFIX =
  /(?:password|passwd|passphrase|secret|token|apikey|accesskey|secretkey|privatekey|authkey|signingkey|masterkey)$/;
const SECRET_QUALIFIERS = new Set([
  "base",
  "hash",
  "value",
  "val",
  "b64",
  "base64",
  "enc",
  "encrypted",
  "raw",
  "plain",
  "str",
  "string",
  "live",
  "prod",
  "test",
  "data",
]);

/** Exported for tests: is this identifier the name of a secret? */
export function isSecretName(name: string): boolean {
  const words = name
    .split(/[_.-]+|(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/)
    .map((w) => w.toLowerCase())
    .filter(Boolean);
  for (let i = words.length - 1; i >= 0; i--) {
    const w = words[i] as string;
    if (SECRET_WORDS.has(w) || SECRET_WORD_SUFFIX.test(w)) return true;
    if (!SECRET_QUALIFIERS.has(w) && !/^v?\d+$/.test(w)) return false;
  }
  return false;
}

/** Values that name or reference a secret rather than being one: left as they are. */
const NOT_A_SECRET_VALUE =
  /^(?:true|false|null|nil|none|undefined|yes|no|on|off|\*+|\[[a-z ]+\]|\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|process\.env\.[A-Za-z_][A-Za-z0-9_]*|<[^>]*>|\d{1,4})$/i;

// name = value, name: value, "name": "value", 'name' => 'value', name := value, --name=value.
// Two steps keep it linear: ASSIGN_NAME finds `name<sep>` (a name starts only at an identifier
// boundary, and whether it is secret is decided in code: an alternation of secret words inside
// the regex backtracks badly on long identifier runs), and only for a secret name does the
// sticky ASSIGN_VALUE read the value. A non-secret name never consumes the text after it, so
// `.env: FOO_KEY=x` and `https://…?token=x` are still found.
const ASSIGN_NAME = /(?<![A-Za-z0-9_.-])([A-Za-z0-9_.-]+)(["'`]?[ \t]*(?::=|=>|[:=])[ \t]*)/g;
// A quoted value may contain spaces and escapes and is capped, so an unclosed quote stays cheap.
// A bare value runs to whitespace or a quote, or to a `&` / `;` / `,` that ends the value (the
// end of the text, or the next `name=` pair); it never starts with `=`, `<`, a bracket or a YAML
// block indicator.
const ASSIGN_VALUE = new RegExp(
  [
    "(?!(?:Basic|Bearer|Token|Digest|Negotiate|NTLM)[ \\t]+\\*\\*\\*)",
    "(?:",
    "([\"'`])((?:(?!\\1)[^\\\\\\n]|\\\\.){0,512})\\1", // 1 quote, 2 quoted value
    "|",
    "([^\\s\"'`&;,=<\\[{(|>](?:[^\\s\"'`&;,]|[&;,](?=[^\\s\"'`&;,])(?![A-Za-z0-9_.\\- ]*=))*)", // 3 bare
    ")",
  ].join(""),
  "y",
);

function maskAssignments(text: string): string {
  ASSIGN_NAME.lastIndex = 0;
  let out = "";
  let last = 0;
  for (let m = ASSIGN_NAME.exec(text); m; m = ASSIGN_NAME.exec(text)) {
    if (!isSecretName(m[1] as string)) continue;
    const start = m.index + m[0].length;
    ASSIGN_VALUE.lastIndex = start;
    const v = ASSIGN_VALUE.exec(text);
    if (!v) continue;
    const [value, q, quoted, bare] = v;
    const raw = q ? (quoted ?? "") : (bare ?? "");
    if (!raw || NOT_A_SECRET_VALUE.test(raw)) continue;
    out += text.slice(last, start) + (q ? `${q}***${q}` : "***");
    last = start + value.length;
    ASSIGN_NAME.lastIndex = last;
  }
  return out + text.slice(last);
}

/**
 * YAML block scalars under a secret key (`db_password: >` / `key: |-` followed by indented
 * lines): every following line indented deeper than the key is masked. Line-based, linear.
 */
function maskYamlBlocks(text: string): string {
  if (!/:[ \t]*[|>]/.test(text)) return text;
  const lines = text.split("\n");
  const header =
    /^([ \t]*)(?:-[ \t]+)?["']?([A-Za-z0-9_.-]+)["']?[ \t]*:[ \t]*[|>][+-]?[1-9]?[ \t\r]*$/;
  for (let i = 0; i < lines.length; i++) {
    const h = header.exec(lines[i] as string);
    if (!h || !isSecretName(h[2] as string)) continue;
    const indent = (h[1] as string).length;
    let last = i; // the last line of the block (blank lines after it are kept)
    let pad = ""; // the block's own indentation
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j] as string;
      if (line.trim() === "") continue;
      const n = (/^[ \t]*/.exec(line) as RegExpExecArray)[0].length;
      if (n <= indent) break;
      if (last === i) pad = line.slice(0, n);
      last = j;
    }
    if (last === i) continue;
    lines.splice(i + 1, last - i, `${pad}***`);
    i++;
  }
  return lines.join("\n");
}

type Rule =
  | [RegExp, string | ((...m: string[]) => string)]
  | ["assignments", typeof maskAssignments];

/** Ordered: the specific shapes first, the generic runs last. */
const RULES: Rule[] = [
  // PEM / OpenSSH / PGP private key blocks, whole (to the END line, or the end of the text).
  [
    /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]{0,60}-----|$)/g,
    "[private key]",
  ],
  // Credentials inside URLs: scheme://user:pass@host, scheme://:pass@host
  [/\b([a-z][a-z0-9+.-]{0,30}:\/\/)[^\s/:@]*:[^\s/@]+@/gi, "$1***@"],
  // Authorization / Proxy-Authorization headers: the scheme stays, the credentials go.
  [
    /\b((?:Proxy-)?Authorization["']?[ \t]*[:=][ \t]*["']?)(?!(?:(?:Basic|Bearer|Token|Digest|Negotiate|NTLM|ApiKey|Key)[ \t]+)?\*\*\*)(?:(Basic|Bearer|Token|Digest|Negotiate|NTLM|ApiKey|Key)[ \t]+)?[^\s"'`]+/gi,
    (_m: string, pre = "", scheme = "") => `${pre}${scheme ? `${scheme} ` : ""}***`,
  ],
  [/\bBearer[ \t]+(?!\*\*\*)[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer ***"],
  // curl -u / --user user:pass (the user stays)
  [/(?<!\S)(-u|--user)([ \t]*=?[ \t]*)(["']?)([^\s:"'@]+):(?!\*\*\*)[^\s"']+\3/g, "$1$2$3$4:***$3"],
  // --password x, --token x, --api-key x, --client-secret x … (the `=` form is an assignment)
  [
    /(?<!\S)(--(?:[a-z0-9]+-){0,4}(?:password|passwd|pass|passphrase|token|secret|api-?key|access-key|secret-key|auth-token|credentials?))([ \t]+)(?!-|\*\*\*)(?:(["'])[^\n]{0,256}?\3|[^\s"']+)/gi,
    "$1$2$3***$3",
  ],
  // mysql / mariadb -p<password> (attached; `-p` alone prompts)
  [
    /\b((?:mysql|mysqldump|mysqladmin|mariadb|mariadb-dump)\b[^\n]{0,300}?(?<!\S)-p)(?![\s*])(?:(["'])[^\n]{0,256}?\2|[^\s"']+)/g,
    "$1$2***$2",
  ],
  // Prose: "the password is Wint3rIsComing" (only when the word looks like a password).
  [
    /\b(pass(?:word|phrase|wd)[ \t]+(?:is|was)[ \t]*:?[ \t]+)(["']?)(?=[^\s"']{0,128}[\d!@#$%^&*])(?!\*\*\*)[^\s"']{4,128}\2/gi,
    "$1$2***$2",
  ],
  [/\b(sk|rk|pk)_(live|test)_[A-Za-z0-9]{10,}/g, "$1_$2_***"],
  [/\bwhsec_[A-Za-z0-9]{16,}/g, "whsec_***"],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, "sk-***"],
  [/\b(gh[pousr]|github_pat)_[A-Za-z0-9_]{20,}/g, "$1_***"],
  [/\bglpat-[A-Za-z0-9_-]{20,}/g, "glpat-***"],
  [/\bnpm_[A-Za-z0-9]{36,}/g, "npm_***"],
  [/\bhf_[A-Za-z0-9]{30,}/g, "hf_***"],
  [/\bxox[a-z]-[A-Za-z0-9-]{10,}/g, "xox*-***"],
  [/\b(hooks\.slack\.com\/services\/)[A-Za-z0-9/]{10,}/g, "$1***"],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "AKIA***"],
  [/\bAIza[0-9A-Za-z_-]{35}/g, "AIza***"],
  [/\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g, "SG.***"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[jwt]"],
  ["assignments", maskAssignments],
  // (the local part starts at the start of its run, not at every \b inside it: `--a-a-a…`)
  [/(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "[email]"],
  [/\b[0-9a-fA-F]{24,}\b/g, "[hex]"],
  // base64 / base64url runs of 32+ chars mixing upper, lower and digits (not a word or a path)
  [
    /(?<![A-Za-z0-9+/_-])(?=[A-Za-z0-9+/_-]*\d)(?=[A-Za-z0-9+/_-]*[A-Z])(?=[A-Za-z0-9+/_-]*[a-z])[A-Za-z0-9+/_-]{32,}={0,2}/g,
    "[b64]",
  ],
];

/** Mask secrets, emails and long hex/base64 runs. Idempotent; linear in the input. */
export function redact(text: string): string {
  let out = maskYamlBlocks(text);
  for (const rule of RULES) {
    if (rule[0] === "assignments") out = rule[1](out);
    else if (typeof rule[1] === "string") out = out.replace(rule[0], rule[1]);
    else out = out.replace(rule[0], rule[1]);
  }
  return out;
}

/** The redacted head kept in the DB: at most n chars (code points), with "…" when cut. */
export function head(text: string, n = 80): string {
  const chars = Array.from(redact(normalize(maskYamlBlocks(text))).replace(/\s+/g, " "));
  if (chars.length <= n) return chars.join("");
  return `${chars.slice(0, Math.max(0, n - 1)).join("")}…`;
}

/** The only text a remote provider receives: normalised, redacted, cut to maxChars. */
export function forRemote(text: string, maxChars: number): string {
  // YAML blocks first: normalize() collapses the indentation that delimits them.
  return Array.from(redact(normalize(maskYamlBlocks(text))))
    .slice(0, maxChars)
    .join("");
}
