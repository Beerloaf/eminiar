import { isSecretName } from "../adjudicator/redact.js";

/**
 * Staged diff -> the text commit advice may send off the machine (docs/design/jev-integration-options.md,
 * option C). The diff is the most sensitive text any decision feature handles, so this runs
 * BEFORE the generic redaction every client call applies and is stricter than it:
 *
 *  - files are filtered by a deny list (the config's commit.exclude plus a built-in floor that
 *    cannot be configured away: .env, keys, certificates, lock files, binaries) and an allow list
 *    of source/text extensions; a file that fails either is dropped, its name and content with it
 *  - only a hunk's ADDED lines are kept (no context, no removed lines, no hunk headers)
 *  - a secret-named assignment keeps its name and loses its value; long hex / base64 runs are
 *    replaced by a placeholder; every line is cut short
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
];

/**
 * Secret-bearing NAMES in data/config files (config/secrets.yaml, db_password.txt, api-keys.json,
 * auth_token.yml...). Source files named like this (token-bucket.ts) stay allowed: their values are
 * scrubbed line by line instead.
 */
const SECRET_NAME_PARTS = [
  "secret",
  "password",
  "passwd",
  "credential",
  "token",
  "api-key",
  "api_key",
  "apikey",
  "private-key",
  "private_key",
];
const DATA_EXTS = ["json", "yaml", "yml", "toml", "txt", "ini", "cfg", "conf", "properties", "xml"];
for (const part of SECRET_NAME_PARTS)
  for (const ext of DATA_EXTS) DIFF_DENY_FLOOR.push(`**/*${part}*.${ext}`);

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
  return globs.some((g) => {
    try {
      return globToRegExp(g).test(path);
    } catch {
      return false;
    }
  });
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
 * A value that carries on past its own line: lines after it belong to the secret and must not be
 * sent. Either everything more indented than the key (block scalars `| > |- >- |2`, YAML plain or
 * nested continuation) or everything up to and including the line that closes an open quote.
 */
interface Continuation {
  indent: number;
  quote?: string;
}

function continuation(raw: string, yaml: boolean): Continuation | undefined {
  const line = raw.replace(/\t/g, " ").trimEnd();
  const m = ASSIGN.exec(line);
  if (!m || !isSecretName(m[2] as string)) return undefined;
  const indent = (/^\s*(?:-\s+)*/.exec(line) as RegExpExecArray)[0].length;
  const value = (m[4] as string).trim();
  if (BLOCK_HEADER.test(value)) return { indent };
  const q = value[0];
  if (q === '"' || q === "'" || q === "`") {
    const closed = q === '"' ? /^"(?:[^"\\]|\\.)*"/ : q === "'" ? /^'(?:[^']|'')*'/ : /^`[^`]*`/;
    if (!closed.test(value)) return { indent, quote: q };
  }
  return yaml ? { indent } : undefined;
}

function leadingIndent(s: string): number {
  return /^[ \t]*/.exec(s)?.[0].replace(/\t/g, " ").length ?? 0;
}

/** Does `raw` hold the quote that closes a value opened with `q`? */
function closesQuote(raw: string, q: string): boolean {
  if (q === '"') return /^(?:[^"\\]|\\.)*"/.test(raw);
  return raw.includes(q);
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
    const yaml = /\.ya?ml$/i.test(path);
    let cont: Continuation | undefined;
    for (const l of sec.split("\n")) {
      if (l.startsWith("@@")) {
        cont = undefined;
        continue;
      }
      if (!l.startsWith("+") || l.startsWith("+++")) continue;
      const raw = l.slice(1);
      if (cont) {
        if (cont.quote) {
          if (closesQuote(raw, cont.quote)) cont = undefined;
          continue;
        }
        if (!raw.trim() || leadingIndent(raw) > cont.indent) continue;
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
