import { isSecretName } from "../adjudicator/redact.js";

/**
 * Staged diff -> the text commit advice may send off the machine (docs/design/jev-integration-options.md,
 * option C). The diff is the most sensitive text any decision feature handles, so this runs
 * BEFORE the generic redaction every client call applies and is stricter than it:
 *
 *  - files are filtered by a deny list (the config's commit.exclude plus a built-in floor that
 *    cannot be configured away: .env, keys, certificates, tool credential files, Terraform vars
 *    and state, secret-bearing directories and data-file names, lock files, binaries) and an
 *    allow list of source/text extensions; a file that fails either is dropped, its name and
 *    content with it
 *  - only a hunk's ADDED lines are kept (no context, no removed lines, no hunk headers)
 *  - a secret-named assignment keeps its name and loses its value, and every line its value runs
 *    on to (block scalars, open or triple quotes, backslash continuations, open brackets,
 *    heredocs, a value on the next line) is dropped
 *  - in YAML/TOML/JSON, a hunk's leading lines whose key is outside the hunk are dropped
 *  - long hex / base64 runs are replaced by a placeholder; every line is cut short
 *  - the whole text is cut to a small maxChars
 *
 * Pure and linear in the input.
 */

/** Always excluded, whatever commit.exclude says. */
export const DIFF_DENY_FLOOR: string[] = [
  "**/.env",
  "**/.env.*",
  "**/*.env",
  "**/*.pem",
  "**/*.key",
  "**/*.p12",
  "**/*.pfx",
  "**/*.jks",
  "**/*.keystore",
  "**/*.crt",
  "**/*.cer",
  "**/id_rsa*",
  "**/id_ed25519*",
  "**/id_ecdsa*",
  "**/*.kdbx",
  "**/.npmrc",
  "**/.netrc",
  "**/.pypirc",
  "**/credentials*",
  "**/secrets/**",
  "**/.secrets/**",
  "**/secret.*",
  "**/secrets.*",
  "**/.secrets*",
  "**/*.secrets.*",
  "**/*.secret",
  "**/*.env.*",
  "**/*.p8",
  "**/*.ppk",
  "**/*.gpg",
  "**/*.key.*",
  "**/*.pem.*",
  "**/*.p12.*",
  "**/*.pfx.*",
  "**/*.tfvars",
  "**/*service-account*",
  "**/*service_account*",
  "**/.pgpass",
  "**/kubeconfig*",
  "**/.kube/**",
  "**/.aws/**",
  "**/.ssh/**",
  "**/*.lock",
  "**/package-lock.json",
  "**/npm-shrinkwrap.json",
  "**/pnpm-lock.yaml",
  "**/yarn.lock",
  "**/*.min.*",
  "**/*.map",
  "**/*.sqlite*",
  "**/*.db",
  // Terraform variables and state in any form (state holds every resource attribute in clear).
  "**/*.tfvars.*",
  "**/*.tfstate",
  "**/*.tfstate.*",
  // Credential stores of package managers, registries and tools, by their fixed names.
  "**/.dockercfg",
  "**/.dockerconfigjson",
  "**/.git-credentials",
  "**/.yarnrc*",
  "**/.htpasswd",
  "**/htpasswd*",
  "**/_netrc",
  "**/.boto",
  "**/.s3cfg",
  "**/.my.cnf",
  "**/gh/hosts.yml",
  "**/*.ovpn",
  "**/*.age",
  "**/*.enc",
];

/**
 * Directories that hold secrets whatever their files are called (credentials/prod.yaml,
 * secret/db.yaml, keys/prod.json, .docker/config.json): everything under them is denied, source
 * files included. Singular and plural, case-insensitive (matchesGlob).
 */
export const SECRET_DIRS = [
  "secret",
  "secrets",
  ".secret",
  ".secrets",
  "credential",
  "credentials",
  ".credentials",
  "cred",
  "creds",
  "vault",
  "vaults",
  ".vault",
  "private",
  "key",
  "keys",
  ".docker",
  ".gnupg",
  ".password-store",
];
for (const d of SECRET_DIRS) DIFF_DENY_FLOOR.push(`**/${d}/**`);

/**
 * Secret-bearing NAMES in data/config files (config/secrets.yaml, db_password.txt, api-keys.json,
 * prod-creds.yaml, vault.yml, wallet.json...). Source files named like this (token-bucket.ts) stay
 * allowed: their values are scrubbed line by line instead.
 */
const SECRET_NAME_PARTS = [
  "secret",
  "password",
  "passwd",
  "credential",
  "creds",
  "token",
  "api-key",
  "api_key",
  "apikey",
  "private-key",
  "private_key",
  "vault",
  "wallet",
  "mnemonic",
  "keystore",
  "htpasswd",
  "bearer",
  "adminsdk",
];
/**
 * Exact stems, alone or after a `-`, `_` or `.`: auth.json, gcp-key.json, db_pass.txt are secret
 * stores, author.json, monkey.json and passport.json are not.
 */
const SECRET_STEMS = ["auth", "key", "pass"];
const DATA_EXTS = ["json", "yaml", "yml", "toml", "txt", "ini", "cfg", "conf", "properties", "xml"];
for (const ext of DATA_EXTS) {
  for (const part of SECRET_NAME_PARTS) DIFF_DENY_FLOOR.push(`**/*${part}*.${ext}`);
  for (const stem of SECRET_STEMS)
    for (const g of [`${stem}`, `*-${stem}`, `*_${stem}`, `*.${stem}`])
      DIFF_DENY_FLOOR.push(`**/${g}.${ext}`);
}

/** Only these file kinds are sent (extension, or a well-known bare name). */
export const DIFF_ALLOW = [
  "**/*.ts",
  "**/*.tsx",
  "**/*.js",
  "**/*.jsx",
  "**/*.mjs",
  "**/*.cjs",
  "**/*.py",
  "**/*.go",
  "**/*.rs",
  "**/*.java",
  "**/*.kt",
  "**/*.rb",
  "**/*.php",
  "**/*.cs",
  "**/*.c",
  "**/*.h",
  "**/*.cc",
  "**/*.cpp",
  "**/*.hpp",
  "**/*.swift",
  "**/*.sh",
  "**/*.sql",
  "**/*.css",
  "**/*.scss",
  "**/*.html",
  "**/*.md",
  "**/*.txt",
  "**/*.json",
  "**/*.yaml",
  "**/*.yml",
  "**/*.toml",
  "**/Makefile",
  "**/Dockerfile",
];

const MAX_LINE = 160;
const MAX_FILES = 40;
/** A hard ceiling whatever the config asks for. */
export const DIFF_MAX_CHARS = 8000;

const compiled = new Map<string, RegExp | null>();

/** A glob's RegExp, built once per glob (the floor alone is a few hundred). */
function globRegExp(glob: string): RegExp | null {
  let re = compiled.get(glob);
  if (re === undefined) {
    try {
      re = globToRegExp(glob);
    } catch {
      re = null;
    }
    if (compiled.size < 4096) compiled.set(glob, re);
  }
  return re;
}

function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          i++;
          re += "(?:.*/)?";
        } else re += ".*";
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, "i");
}

/** Does `path` match any glob? `*` stays inside a segment, `**` crosses them; case-insensitive. */
export function matchesGlob(path: string, globs: readonly string[]): boolean {
  return globs.some((g) => globRegExp(g)?.test(path) ?? false);
}

/** Is a file's diff allowed to leave the machine at all? */
export function diffFileAllowed(path: string, exclude: readonly string[] = []): boolean {
  if (matchesGlob(path, DIFF_DENY_FLOOR) || matchesGlob(path, exclude)) return false;
  return matchesGlob(path, DIFF_ALLOW);
}

const ASSIGN =
  /^(\s*(?:-\s+)*(?:export\s+)?(?:default\s+)?(?:const\s+|let\s+|var\s+)?["']?)([A-Za-z_][\w.-]*)(["']?\s*(?:=>|:=|[:=])\s*)(.*)$/;
const BLOCK_HEADER = /^[|>][+-]?\d*[+-]?\s*(?:#.*)?$/;

function scrubLine(raw: string): string | undefined {
  let line = raw.replace(/\t/g, " ").trimEnd();
  if (!line.trim()) return undefined;
  const m = ASSIGN.exec(line);
  if (m && isSecretName(m[2] as string) && !/^["']?\s*$/.test(m[4] as string))
    line = `${m[1]}${m[2]}${m[3]}<redacted>`;
  line = line
    .replace(/\b[0-9a-fA-F]{32,}\b/g, "<hex>")
    .replace(/[A-Za-z0-9+/_-]{40,}={0,2}/g, "<blob>")
    .replace(
      /\b(?:sk|pk|ghp|gho|ghs|github_pat|xox[abprs]|AKIA|ASIA)[-_A-Za-z0-9]{12,}/g,
      "<token>",
    );
  if (line.length > MAX_LINE) line = `${line.slice(0, MAX_LINE)}…`;
  return line;
}

/**
 * A secret value that carries on past its own line: the lines after it belong to the secret and
 * are never sent.
 *  - indent: everything more indented than the key (YAML block scalars `| > |- >- |2`, plain or
 *    nested continuation)
 *  - quote: up to and including the line that closes an open quote, a TOML/Python triple quote
 *    (`"""`, `'''`, also r/b/u/f-prefixed) or a JS template literal
 *  - backslash: while lines end in a backslash, plus the first line that does not (.properties,
 *    shell, Python)
 *  - brackets: until the brackets the value opened are closed again (`password = (`, `"token": {`)
 *  - heredoc: up to the terminator line (`$(cat <<EOF`)
 *  - value: the key ends its line with nothing after it (`"token":` with the value on the next
 *    line): the next non-blank line is the value, and that line may open any of the above
 * Every kind also ends at the next hunk header (a hunk's added lines are one contiguous run).
 */
type Continuation =
  | { kind: "indent"; indent: number }
  | { kind: "quote"; quote: string }
  | { kind: "backslash" }
  | { kind: "brackets"; depth: number }
  | { kind: "heredoc"; until: string }
  | { kind: "value" };

const TRIPLE = /^(?:[rRbBuUfF]{1,2})?("""|''')/;
const HEREDOC = /<<[-~]?\s*(["']?)([A-Za-z_]\w*)\1/;

/** Does `s` end in an odd number of backslashes (a line continuation)? A loop, not a regex. */
function endsWithBackslash(s: string): boolean {
  let n = 0;
  for (let i = s.length - 1; i >= 0 && s[i] === "\\"; i--) n++;
  return n % 2 === 1;
}

/** Brackets opened minus closed outside quoted strings; linear. */
function bracketDepth(s: string): number {
  let d = 0;
  let q = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === "\\") i++;
      else if (c === q) q = "";
      continue;
    }
    if (c === '"' || c === "'" || c === "`") q = c;
    else if (c === "(" || c === "[" || c === "{") d++;
    else if (c === ")" || c === "]" || c === "}") d--;
  }
  return d;
}

/** How a secret's value (already trimmed) carries on, if it does. */
function valueContinuation(
  value: string,
  indent: number,
  yaml: boolean,
  allowPending: boolean,
): Continuation | undefined {
  if (BLOCK_HEADER.test(value)) return { kind: "indent", indent };
  const here = HEREDOC.exec(value);
  if (here) return { kind: "heredoc", until: here[2] as string };
  const triple = TRIPLE.exec(value);
  if (triple) {
    if (!value.slice(triple[0].length).includes(triple[1] as string))
      return { kind: "quote", quote: triple[1] as string };
  } else {
    const q = value[0];
    if (q === '"' || q === "'" || q === "`") {
      const closed = q === '"' ? /^"(?:[^"\\]|\\.)*"/ : q === "'" ? /^'(?:[^']|'')*'/ : /^`[^`]*`/;
      if (!closed.test(value)) return { kind: "quote", quote: q };
    }
  }
  const depth = bracketDepth(value);
  if (depth > 0) return { kind: "brackets", depth };
  if (endsWithBackslash(value)) return { kind: "backslash" };
  if (yaml) return { kind: "indent", indent };
  if (!value && allowPending) return { kind: "value" };
  return undefined;
}

function continuation(raw: string, yaml: boolean): Continuation | undefined {
  const line = raw.replace(/\t/g, " ").trimEnd();
  const m = ASSIGN.exec(line);
  if (!m || !isSecretName(m[2] as string)) return undefined;
  const indent = (/^\s*(?:-\s+)*/.exec(line) as RegExpExecArray)[0].length;
  return valueContinuation((m[4] as string).trim(), indent, yaml, true);
}

function leadingIndent(s: string): number {
  return /^[ \t]*/.exec(s)?.[0].replace(/\t/g, " ").length ?? 0;
}

/** Does `raw` hold the quote that closes a value opened with `q`? */
function closesQuote(raw: string, q: string): boolean {
  if (q === '"') return /^(?:[^"\\]|\\.)*"/.test(raw);
  return raw.includes(q);
}

/** Consume `raw` under `cont`: the continuation left after it (undefined = it ended). */
function consume(cont: Continuation, raw: string): Continuation | undefined {
  switch (cont.kind) {
    case "quote":
      return closesQuote(raw, cont.quote) ? undefined : cont;
    case "backslash":
      return endsWithBackslash(raw.trimEnd()) ? cont : undefined;
    case "brackets": {
      const depth = cont.depth + bracketDepth(raw);
      return depth > 0 ? { kind: "brackets", depth } : undefined;
    }
    case "heredoc":
      return raw.trim() === cont.until ? undefined : cont;
    case "value":
      if (!raw.trim()) return cont;
      return valueContinuation(raw.replace(/\t/g, " ").trim(), 0, false, false);
    default:
      return cont;
  }
}

/**
 * Structured data files where a hunk's first added lines may belong to a key the hunk does not
 * show (git diff -U0 has no context): an indented YAML line under a `db_password: |` header, a
 * TOML line inside a `"""` string or a multi-line array, a bare JSON value under a `"token":` key.
 * Their leading lines are dropped until one whose owner is known: a YAML line at column 0, a
 * TOML `key =` or `[table]` line, a JSON `"key":` line. The hunk header's line numbers are not
 * trusted for this (a new file loses at most a leading `{` or comment).
 */
type DataKind = "yaml" | "toml" | "json";

function dataKind(path: string): DataKind | undefined {
  if (/\.ya?ml$/i.test(path)) return "yaml";
  if (/\.toml$/i.test(path)) return "toml";
  if (/\.json$/i.test(path)) return "json";
  return undefined;
}

const TOML_ROOT = /^\s*(?:\[\[?[^\]]+\]\]?\s*(?:#.*)?$|[A-Za-z0-9_.-]+\s*=|"[^"]*"\s*=)/;
const JSON_KEY = /^\s*"(?:[^"\\]|\\.)*"\s*:/;

function rooted(kind: DataKind, raw: string): boolean {
  if (kind === "yaml") return leadingIndent(raw) === 0;
  if (kind === "toml") return TOML_ROOT.test(raw);
  return JSON_KEY.test(raw);
}

export interface RedactedDiff {
  /** What may be sent: per allowed file, a header and its scrubbed added lines. */
  text: string;
  /** Files whose added lines made it in (possibly cut). */
  files: number;
  /** Files dropped by the deny/allow lists, or left out once the budget ran out. */
  skipped: number;
}

/**
 * The sendable form of a unified diff (`git diff --cached -U0`). Added lines only; denied or
 * unlisted files, deletions and renames of nothing leave no trace in the text.
 */
export function redactDiff(
  diff: string,
  o: { maxChars: number; exclude?: readonly string[] },
): RedactedDiff {
  const budget = Math.max(0, Math.min(o.maxChars, DIFF_MAX_CHARS));
  const out: string[] = [];
  let used = 0;
  let files = 0;
  let skipped = 0;

  const sections = diff.split(/^diff --git /m).slice(1);
  for (const sec of sections) {
    const nl = sec.indexOf("\n");
    const head = nl < 0 ? sec : sec.slice(0, nl);
    const pm = / b\/(.+)$/.exec(head);
    const path = pm?.[1];
    if (!path || !diffFileAllowed(path, o.exclude)) {
      skipped++;
      continue;
    }
    if (/^Binary files /m.test(sec) || /^GIT binary patch/m.test(sec)) {
      skipped++;
      continue;
    }
    if (files >= MAX_FILES || used >= budget) {
      skipped++;
      continue;
    }
    const added: string[] = [];
    const kind = dataKind(path);
    const yaml = kind === "yaml";
    let cont: Continuation | undefined;
    let orphan = false;
    for (const l of sec.split("\n")) {
      if (l.startsWith("@@")) {
        cont = undefined;
        orphan = kind !== undefined;
        continue;
      }
      if (!l.startsWith("+") || l.startsWith("+++")) continue;
      const raw = l.slice(1);
      if (orphan) {
        if (!raw.trim() || !rooted(kind as DataKind, raw)) continue;
        orphan = false;
      }
      if (cont) {
        if (cont.kind !== "indent") {
          cont = consume(cont, raw);
          continue;
        }
        // A tab never indents YAML structure, so a tab-led line cannot end the value either.
        if (!raw.trim() || /^ *\t/.test(raw) || leadingIndent(raw) > cont.indent) continue;
        cont = undefined;
      }
      const s = scrubLine(raw);
      if (s !== undefined) added.push(s);
      cont = continuation(raw, yaml);
    }
    if (!added.length) continue;
    const block = `file ${path}\n${added.join("\n")}\n`;
    const room = budget - used;
    out.push(block.length > room ? block.slice(0, room) : block);
    used += Math.min(block.length, room);
    files++;
  }
  return { text: out.join("").trimEnd(), files, skipped };
}
