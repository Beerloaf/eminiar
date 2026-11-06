import { clean, isSecretName } from "../adjudicator/redact.js";

/**
 * Staged diff -> the text commit advice may send off the machine (docs/design/jev-integration-options.md,
 * option C). The diff is the most sensitive text any decision feature handles, so this runs
 * BEFORE the generic redaction every client call applies and is stricter than it. Where it is
 * unsure, it sends less:
 *
 *  - files are filtered by a deny list (the config's commit.exclude plus a built-in floor that
 *    cannot be configured away: .env, keys, certificates, tool credential files, Terraform vars
 *    and state, secret-bearing directories and data-file names, app config files that hold
 *    credentials by convention, lock files, binaries) and an allow list of source/text
 *    extensions; a file that fails either is dropped, its name and content with it. A rename or
 *    copy is checked on both sides, and a Kubernetes Secret manifest is dropped whole
 *  - only a hunk's ADDED lines are kept (no context, no removed lines, no hunk headers)
 *  - a secret-named assignment (in any of the forms below) keeps its name and loses its value,
 *    and every line its value runs on to (block scalars, open or triple quotes, backslash
 *    continuations, open brackets, heredocs, a value on the next line, a YAML list under the key)
 *    is dropped. Forms: `k = v`, `k: v`, `k := v`, `k => v`, `k ?= ||= ??= += -= v`, subscripts
 *    (`env['K'] = v`), typed and modified declarations (`private readonly k: string = v`),
 *    sigils (`$k`, `@k`), `define('K', v)` / `setenv("K", v)`, Dockerfile `ENV K v` / `ARG`,
 *    SQL `PASSWORD 'v'` / `IDENTIFIED BY 'v'` / `INSERT (…, password) VALUES …`, a `name: K` with
 *    a sibling `value:` (Kubernetes env), YAML `data:` / `stringData:`, TOML secret tables
 *  - in YAML/TOML/JSON, a hunk's leading lines whose key is outside the hunk are dropped (YAML,
 *    TOML bodies) or keep their key and lose their value (JSON and TOML keys)
 *  - long hex / base64 runs are replaced by a placeholder; every line is cut short
 *  - the whole text is cut to a small maxChars
 *
 * Pure and linear in the input.
 */

/** Always excluded, whatever commit.exclude says, whatever the file's extension. */
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
  "**/secrets/**",
  "**/.secrets/**",
  "**/.secrets*",
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
  "**/.pgpass",
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
  "**/_netrc",
  "**/.boto",
  "**/.s3cfg",
  "**/.my.cnf",
  "**/gh/hosts.yml",
  "**/*.ovpn",
  "**/*.age",
  "**/*.enc",
  // App config files that hold credentials by convention, by their fixed names (any extension:
  // wp-config.php and local_settings.py are source files that are secret stores).
  "**/wp-config*.php",
  "**/configuration.php",
  "**/LocalSettings.php",
  "**/settings.local.php",
  "**/app/etc/env.php",
  "**/local_settings.py",
  "**/settings_local.py",
  "**/config/database.yml",
  "**/application-prod*.*",
  "**/appsettings*.json",
  "**/local.settings.json",
  "**/serviceAccountKey*.json",
  "**/sa.json",
  "**/gcp.json",
  "**/keyfile*.json",
  "**/oauth*client*.json",
  "**/client_secret*.json",
  "**/docker/config.json",
  "**/.azure/**",
  "**/.config/gcloud/**",
  "**/gcloud/**",
  "**/helm/repositories.yaml",
  "**/*.kubeconfig",
];

/**
 * Secret stores by name, denied unless the file is a source module (SOURCE_MODULE): secrets.ts,
 * credentials.py or service-account.go hold code, and their values are scrubbed line by line;
 * secrets.json, credentials, kubeconfig-prod.yaml or passphrase.txt hold the data itself.
 */
export const DIFF_DENY_NAMES: string[] = [
  "**/credentials*",
  "**/secret.*",
  "**/secrets.*",
  "**/*.secrets.*",
  "**/*service-account*",
  "**/*service_account*",
  "**/*kubeconfig*",
  "**/htpasswd*",
  "**/*privatekey*",
  "**/*accesskey*",
  "**/passphrase*",
  "**/*-passphrase*",
  "**/*_passphrase*",
  "**/pw.txt",
  "**/pwd.txt",
  "**/otp.txt",
  "**/*recovery-codes*",
  "**/*recovery_codes*",
  "**/*backup-codes*",
  "**/*backup_codes*",
  "**/*seed-phrase*",
  "**/*seed_phrase*",
  "**/*seedphrase*",
  "**/*jwtkey*",
  "**/*jwt-key*",
  "**/*jwt_key*",
];

/** Source modules: a secret-store NAME (DIFF_DENY_NAMES) does not deny them. */
const SOURCE_MODULE = /\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|kts|swift|c|h|cc|cpp|hpp|cs|scala)$/i;

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
 * A directory named for secrets in a compound name (my-secrets/, secrets-prod/, sealed-secrets/,
 * secret-manager/, prod_credentials/, api-keys/): one of these words, split on - _ . and
 * camelCase, or a key-pair stem. Everything under it is denied, like SECRET_DIRS.
 */
const SECRET_DIR_WORDS = new Set([
  "secret",
  "secrets",
  "credential",
  "credentials",
  "cred",
  "creds",
  "password",
  "passwords",
  "passwd",
  "vault",
  "vaults",
]);
const SECRET_DIR_STEM = /(?:api|private|ssh|signing|access|secret)[-_]?keys?$/i;

function secretDir(segment: string): boolean {
  if (SECRET_DIR_STEM.test(segment)) return true;
  return segment
    .split(/[-_.]+|(?<=[a-z0-9])(?=[A-Z])/)
    .some((w) => SECRET_DIR_WORDS.has(w.toLowerCase()));
}

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
  if (!SOURCE_MODULE.test(path) && matchesGlob(path, DIFF_DENY_NAMES)) return false;
  if (
    path
      .split(/[\\/]+/)
      .slice(0, -1)
      .some(secretDir)
  )
    return false;
  return matchesGlob(path, DIFF_ALLOW);
}

// ---------------------------------------------------------------------------------------------
// Where a secret's value starts on a line. Every form gives two positions: `at`, where the
// redaction starts (everything from there to the end of the line goes), and `from`, where the
// value itself starts for the continuation check (after a `: Type =`, past `at`).
// ---------------------------------------------------------------------------------------------

interface Hit {
  at: number;
  from: number;
}

/**
 * A name anywhere on the line: an identifier with `-` and dotted parts (x-api-key,
 * process.env.API_KEY, cfg.token), optionally after `$` / `@` sigils ($password, @token), never
 * in the middle of a word.
 */
const NAME = /(?<![\w$@])[$@]{0,2}([A-Za-z_][\w-]*(?:\.[A-Za-z_][\w-]*)*)/g;
/**
 * What may follow a name for it to be assigned: a closing quote, markdown emphasis and subscript
 * (`['K'] =`, `**K**:`), a C# accessor block (`K { get; set; } =`), then `=`, `==`, `:`, `:=`,
 * `=>`, `?=`, `||=`, `&&=`, `??=`, `+=`, `-=` or `<<<` (`::` and `:/` are not).
 */
const OP =
  /["'`*]{0,3}\]?["'`*]{0,3}(?:[ \t]*\{[ \t]*(?:get|set|init)\b[^}]{0,40}\})?[ \t]*(?:\?\?=|\|\|=|&&=|\?=|\+=|-=|:=|=>|={1,3}|<<<|:(?![:/\\]))[ \t]*/y;
/** A call of a secret-named function (`setPassword(`, `SetBasicAuth(`): its arguments go. */
const CALL = /[ \t]*\(/y;
/** `name: Type = value`: the value proper starts after the `=`. */
const TYPE_THEN_EQ = /[A-Za-z_][\w.<>[\]?|, ]{0,60}?[ \t]*(?:\?\?=|\|\|=|\?=|=(?![=>]))[ \t]*/y;
/** `fn('NAME', value)`: a quoted secret name as the first of two arguments. */
const QUOTED_ARG = /["'`][ \t]*,[ \t]*/y;
/**
 * `NAME value` after a keyword: Dockerfile `ENV` / `ARG` / `LABEL`, C `#define`, csh `setenv`,
 * `set` (the `NAME=value` form is an assignment).
 */
const KEYWORD_SPACE =
  /^[ \t]*(?:ENV|ARG|LABEL|#[ \t]*define|setenv|set)[ \t]+([A-Za-z_][\w.-]*)[ \t]+(?=\S)/i;
/** SQL `PASSWORD 'x'`, `IDENTIFIED BY 'x'`, `IDENTIFIED WITH plugin BY 'x'`. */
const SQL_PASSWORD =
  /\b(?:PASSWORD|IDENTIFIED[ \t]+(?:WITH[ \t]+\w+[ \t]+)?BY(?:[ \t]+PASSWORD)?)[ \t]+(?=['"$])/i;
/** SQL `INSERT INTO t (name, password) VALUES …`. */
const SQL_VALUES = /\(([^()]{0,400})\)[ \t]*VALUES\b[ \t]*/i;
/** SQL `INSERT INTO api_keys … VALUES …`: a secret-named table. */
const SQL_TABLE =
  /\bINSERT[ \t]+INTO[ \t]+[`"[]?(?:\w+\.)?(\w+)[`"\]]?[^;]{0,400}?\bVALUES\b[ \t]*/i;
/** One-line `{name: DB_PASSWORD, value: x}` / `{"name": "DB_PASSWORD", "value": "x"}`. */
const NAME_PAIR =
  /(?<![\w-])["']?(?:name|key|parameter_?name|parameter_?key)["']?[ \t]*[:=][ \t]*["']?([A-Za-z_][\w.-]*)/gi;
const VALUE_PAIR = /(?<![\w-])["']?(?:value|parameter_?value)["']?[ \t]*[:=][ \t]*/i;
/** A type, not a value: `token: string,` in a signature or an interface. */
const TYPE_ONLY =
  /^(?:string|number|boolean|bigint|any|unknown|never|void|null|undefined|String|Number|Boolean|Int|Long|Bytes|str|int|bytes|bool)\b[ \t]*(?:\[\])?[ \t]*(?:[,;)|?]|$)/;

/** The first secret value on the line, in any of the forms above, or undefined. */
function secretAt(line: string): Hit | undefined {
  let best: Hit | undefined;
  const take = (h: Hit) => {
    if (!best || h.at < best.at) best = h;
  };
  NAME.lastIndex = 0;
  for (let m = NAME.exec(line); m; m = NAME.exec(line)) {
    if (!isSecretName(m[1] as string)) continue;
    const end = m.index + m[0].length;
    OP.lastIndex = end;
    const op = OP.exec(line);
    if (op) {
      const at = end + op[0].length;
      let from = at;
      if (/:[ \t]*$/.test(op[0])) {
        TYPE_THEN_EQ.lastIndex = at;
        const t = TYPE_THEN_EQ.exec(line);
        if (t) from = at + t[0].length;
      }
      take({ at, from });
      break;
    }
    CALL.lastIndex = end;
    const call = CALL.exec(line);
    if (call) {
      take({ at: end + call[0].length, from: end + call[0].length - 1 });
      break;
    }
    QUOTED_ARG.lastIndex = end;
    const before = line[m.index - 1];
    const arg = (before === '"' || before === "'" || before === "`") && QUOTED_ARG.exec(line);
    if (arg) {
      take({ at: end + arg[0].length, from: end + arg[0].length });
      break;
    }
  }
  const d = KEYWORD_SPACE.exec(line);
  if (d && isSecretName(d[1] as string)) take({ at: d[0].length, from: d[0].length });
  const s = SQL_PASSWORD.exec(line);
  if (s) take({ at: s.index + s[0].length, from: s.index + s[0].length });
  const v = SQL_VALUES.exec(line);
  if (
    v &&
    (v[1] as string)
      .split(",")
      .some((c) => isSecretName(c.trim().replace(/^["'`[]+|["'`\]]+$/g, "")))
  )
    take({ at: v.index + v[0].length, from: v.index + v[0].length });
  const t = SQL_TABLE.exec(line);
  if (t && isSecretName(t[1] as string))
    take({ at: t.index + t[0].length, from: t.index + t[0].length });
  NAME_PAIR.lastIndex = 0;
  for (let p = NAME_PAIR.exec(line); p; p = NAME_PAIR.exec(line)) {
    if (!isSecretName(p[1] as string)) continue;
    const val = VALUE_PAIR.exec(line);
    if (val) take({ at: val.index + val[0].length, from: val.index + val[0].length });
    break;
  }
  return best;
}

/** A key line whatever its name (`k = v`, `k: v`, `"k": v`, `- k: v`): where its value starts. */
const KEY_LINE =
  /^[ \t]*(?:-[ \t]+)*["']?[A-Za-z0-9_$@.][\w.$@-]*["']?[ \t]*(?:=>|:=|=|:(?![:/\\]))[ \t]*/;

function keyAt(line: string): Hit | undefined {
  const m = KEY_LINE.exec(line);
  return m ? { at: m[0].length, from: m[0].length } : undefined;
}

/** Values an unknown owner may keep: small numbers, booleans, empty containers, versions. */
const SAFE_VALUE =
  /^(?:[-+]?\d{1,5}(?:\.\d+)?|true|false|null|\[\s*\]|\{\s*\}|(["'])[\d^~<>=*!. ,|-]*\d\.[\d^~<>=*!.x ,|-]*\1)[ \t]*,?[ \t]*(?:#.*)?$/;

const BLOCK_HEADER = /^[|>][+-]?\d*[+-]?\s*(?:#.*)?$/;

/** Placeholders for long hex / base64 / vendor tokens, and the line cut. */
function finish(line: string): string {
  let out = line
    .replace(/\b[0-9a-fA-F]{32,}\b/g, "<hex>")
    .replace(/[A-Za-z0-9+/_-]{40,}={0,2}/g, "<blob>")
    .replace(
      /\b(?:sk|pk|ghp|gho|ghs|github_pat|xox[abprs]|AKIA|ASIA)[-_A-Za-z0-9]{12,}/g,
      "<token>",
    );
  if (out.length > MAX_LINE) out = `${out.slice(0, MAX_LINE)}…`;
  return out;
}

interface Scrubbed {
  /** The line to send; undefined = send nothing for it. */
  text?: string | undefined;
  /** How the secret value carries on past this line. */
  cont?: Continuation | undefined;
}

/**
 * One added line. `force`: the line's own key is secret whatever its name (a `value:` under a
 * secret `name:`, a TOML secret table, a key whose owner is outside the hunk); a forced line
 * with no key of its own is dropped. `safe`: a forced value may stay when SAFE_VALUE says so.
 */
function scrubLine(raw: string, o: { yaml: boolean; force?: boolean; safe?: boolean }): Scrubbed {
  const line = raw.replace(/\t/g, " ").trimEnd();
  if (!line.trim()) return {};
  const hit = o.force ? keyAt(line) : secretAt(line);
  if (o.force && !hit) return {};
  if (!hit) return { text: finish(line) };
  const value = line.slice(hit.at);
  if (TYPE_ONLY.test(value.trim()) || (o.safe && SAFE_VALUE.test(value.trim())))
    return { text: finish(line) };
  const text = /^["']?\s*$/.test(value) ? line : `${line.slice(0, hit.at)}<redacted>`;
  const indent = (/^\s*(?:-\s+)*/.exec(line) as RegExpExecArray)[0].length;
  return {
    text: finish(text),
    cont: valueContinuation(line.slice(hit.from).trim(), indent, o.yaml, true),
  };
}

/**
 * A secret value that carries on past its own line: the lines after it belong to the secret and
 * are never sent.
 *  - indent: everything more indented than the key (YAML block scalars `| > |- >- |2`, plain or
 *    nested continuation); with `seq`, a YAML list at the key's own column too (`key:` then
 *    `- item`, a compact sequence)
 *  - quote: up to and including the line that closes an open quote, a TOML/Python triple quote
 *    (`"""`, `'''`, also r/b/u/f-prefixed) or a JS template literal
 *  - backslash: while lines end in a backslash, plus the first line that does not (.properties,
 *    shell, Python)
 *  - brackets: until the brackets the value opened are closed again (`password = (`, `"token": {`)
 *  - heredoc: up to the terminator line (`$(cat <<EOF`, PHP `<<<EOT` … `EOT;`)
 *  - value: the key ends its line with nothing after it (`"token":` with the value on the next
 *    line): the next non-blank line is the value, and that line may open any of the above
 * Every kind also ends at the next hunk header (a hunk's added lines are one contiguous run).
 */
type Continuation =
  | { kind: "indent"; indent: number; seq: boolean }
  | { kind: "quote"; quote: string }
  | { kind: "backslash" }
  | { kind: "brackets"; depth: number }
  | { kind: "heredoc"; until: RegExp }
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
  if (BLOCK_HEADER.test(value)) return { kind: "indent", indent, seq: false };
  const here = HEREDOC.exec(value);
  // The terminator may be indented and followed by `;`, `,` or `)` (PHP 7.3+, Ruby <<~).
  if (here) return { kind: "heredoc", until: new RegExp(`^${here[2]}(?:[;,)]|$)`) };
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
  if (yaml) return { kind: "indent", indent, seq: !value };
  // An expression that goes on (`'a' +`, `isProd ?`, `x ||`, `'a' .`): the next line is the value.
  if (OPEN_EXPR.test(value)) return { kind: "value" };
  if (!value && allowPending) return { kind: "value" };
  return undefined;
}

function leadingIndent(s: string): number {
  return /^[ \t]*/.exec(s)?.[0].replace(/\t/g, " ").length ?? 0;
}

/** The column a line's key starts at: its indentation plus any `- ` list markers. */
function keyCol(s: string): number {
  return /^[ \t]*(?:-[ \t]+)*/.exec(s)?.[0].replace(/\t/g, " ").length ?? 0;
}

/** A comment line: it neither ends a value that carries on nor is one. */
const COMMENT_LINE = /^[ \t]*(?:\/\/|#|\/\*|\*|--[ \t]|<!--)/;
/**
 * A value that ends in a binary operator goes on on the next line (not a `,`: a list item or a
 * JSON member ends there).
 */
const OPEN_EXPR = /(?:[-+*/%.?:|&=]|=>|\band|\bor)$/;

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
      return cont.until.test(raw.trim()) ? undefined : cont;
    case "value":
      if (!raw.trim() || COMMENT_LINE.test(raw)) return cont;
      return valueContinuation(raw.replace(/\t/g, " ").trim(), 0, false, false);
    default:
      return cont;
  }
}

/** Does `raw` still belong to an indent continuation that started at `c`? */
function inIndent(c: { indent: number; seq: boolean }, raw: string): boolean {
  // A tab never indents YAML structure, so a tab-led line cannot end the value either.
  if (!raw.trim() || /^ *\t/.test(raw) || COMMENT_LINE.test(raw)) return true;
  const n = leadingIndent(raw);
  // A key with no value of its own (`passwords:`) also owns what follows at its own column
  // until the next mapping key: a compact `- item` list, or a stray scalar.
  return n > c.indent || (c.seq && n === c.indent && !YAML_KEY.test(raw));
}

/**
 * Structured data files where a hunk's first added lines may belong to a key the hunk does not
 * show (git diff -U0 has no context): an indented YAML line under a `db_password: |` header, a
 * column-0 YAML list item under a `passwords:` key, a TOML line inside a `"""` string, a
 * multi-line array or a `[secrets]` table, a bare JSON value under a `"token":` key, a JSON key
 * inside a `"credentials": {` object. Leading lines are dropped until one whose owner is known:
 * a column-0 YAML mapping key (not a `- item`) or `---`, a TOML `[table]` header or `key =`, a
 * JSON `"key":` at the top level (indented at most two spaces or one tab). Until then, a JSON
 * key, and a TOML key until a `[table]` header is seen, keeps its name and loses its value
 * (unless SAFE_VALUE). A TOML hunk that starts at line 1 has no table above it.
 */
type DataKind = "yaml" | "toml" | "json";

function dataKind(path: string): DataKind | undefined {
  if (/\.ya?ml$/i.test(path)) return "yaml";
  if (/\.toml$/i.test(path)) return "toml";
  if (/\.json$/i.test(path)) return "json";
  return undefined;
}

/** A YAML mapping key at the start of its line (not a `- item`, not a comment). */
const YAML_KEY = /^[ \t]*["']?[A-Za-z0-9_$.<][^:#]*?["']?[ \t]*:(?:[ \t]|$)/;
/** A column-0 mapping key or a document marker: its owner is the document itself. */
const YAML_ROOT =
  /^(?:---|\.\.\.)[ \t]*(?:#.*)?$|^["']?[A-Za-z0-9_$.<][^:#]*?["']?[ \t]*:(?:[ \t]|$)/;
const TOML_HEADER = /^[ \t]*\[\[?[ \t]*([^\]]+?)[ \t]*\]\]?[ \t]*(?:#.*)?$/;
const TOML_ROOT = /^\s*(?:\[\[?[^\]]+\]\]?\s*(?:#.*)?$|[A-Za-z0-9_.-]+\s*=|"[^"]*"\s*=)/;
const JSON_KEY = /^\s*"(?:[^"\\]|\\.)*"\s*:/;
const JSON_TOP = /^(?: {0,2}|\t)"(?:[^"\\]|\\.)*"\s*:/;

function rooted(kind: DataKind, raw: string): boolean {
  if (kind === "yaml") return YAML_ROOT.test(raw);
  if (kind === "toml") return TOML_ROOT.test(raw);
  return JSON_TOP.test(raw);
}

/** A TOML `[table]` header naming a secret: [secrets], [tokens], [database.credentials]. */
function secretTable(header: string): boolean {
  return header.split(".").some((s) => isSecretName(s.trim().replace(/^["']|["']$/g, "")));
}

/** A Kubernetes Secret: the whole manifest is a secret. */
const KIND_SECRET = /^\s*["']?kind["']?\s*:\s*["']?(?:Secret|SealedSecret)["']?\s*,?\s*$/;
/** YAML keys whose children are secret data (a Secret's `data:` / `stringData:`). */
const YAML_SECRET_PARENT = /^[ \t]*(?:-[ \t]+)*["']?(?:data|stringData)["']?[ \t]*:/;
/** `name: DB_PASSWORD` alone on its line: its sibling `value:` is the secret (Kubernetes env). */
const NAME_LINE =
  /^[ \t]*(?:-[ \t]+)?["']?(?:name|key|parameter_?name|parameter_?key)["']?[ \t]*:[ \t]*["']?([A-Za-z_][\w.-]*)["']?[ \t]*,?[ \t]*(?:#.*)?$/i;
const VALUE_LINE = /^[ \t]*(?:-[ \t]+)?["']?(?:value|parameter_?value)["']?[ \t]*:/i;

// ---------------------------------------------------------------------------------------------
// Paths of a section: `diff --git a/X b/Y`, `--- a/X`, `+++ b/Y`, `rename from/to`, `copy
// from/to`, any of them C-quoted. Every one of them must be allowed (a rename from .env to
// notes.txt sends nothing).
// ---------------------------------------------------------------------------------------------

/** Git's C-style quoting ("a/s\303\251crets/x"): undefined when it does not parse. */
function unquote(s: string): string | undefined {
  if (!s.startsWith('"')) return s;
  if (!s.endsWith('"') || s.length < 2) return undefined;
  const bytes: number[] = [];
  const body = s.slice(1, -1);
  const esc: Record<string, number> = {
    n: 10,
    t: 9,
    r: 13,
    '"': 34,
    "\\": 92,
    a: 7,
    b: 8,
    f: 12,
    v: 11,
  };
  for (let i = 0; i < body.length; i++) {
    const c = body[i] as string;
    if (c !== "\\") {
      for (const b of Buffer.from(c, "utf8")) bytes.push(b);
      continue;
    }
    const n = body[i + 1];
    if (n === undefined) return undefined;
    if (/[0-7]/.test(n)) {
      const oct = /^[0-7]{1,3}/.exec(body.slice(i + 1))?.[0] as string;
      bytes.push(Number.parseInt(oct, 8) & 0xff);
      i += oct.length;
    } else if (n in esc) {
      bytes.push(esc[n] as number);
      i++;
    } else return undefined;
  }
  return Buffer.from(bytes).toString("utf8");
}

/** Strip a leading `a/` or `b/` (git's default prefixes). */
const unprefix = (p: string | undefined): string | undefined =>
  p === undefined ? undefined : p.replace(/^[ab]\//, "");

interface SectionPaths {
  /** The path shown in the text. */
  show?: string | undefined;
  /** Every path the section names; all of them must be allowed. */
  all: string[];
  /** A path could not be read (a malformed quote). */
  bad: boolean;
}

function sectionPaths(sec: string): SectionPaths {
  const all: string[] = [];
  let bad = false;
  const add = (p: string | undefined) => {
    if (p === undefined) bad = true;
    else if (p && p !== "/dev/null" && !all.includes(p)) all.push(p);
  };
  const nl = sec.indexOf("\n");
  const head = (nl < 0 ? sec : sec.slice(0, nl)).replace(/\r$/, "");
  let show: string | undefined;
  // The git header: a quoted half (git quotes a path with `"`, `\` or non-ASCII bytes), or
  // every split at " b/" (an unquoted path may hold spaces).
  if (head.includes('"')) {
    const q =
      /^("(?:[^"\\]|\\.)*"|a\/[^"]*?) ("(?:[^"\\]|\\.)*")$/.exec(head) ??
      /^("(?:[^"\\]|\\.)*") (b\/[^"]*)$/.exec(head);
    if (!q) bad = true;
    else {
      add(unprefix(unquote(q[1] as string)));
      show = unprefix(unquote(q[2] as string));
      add(show);
    }
  } else if (head.startsWith("a/")) {
    let splits = 0;
    for (let i = head.indexOf(" b/"); i >= 0 && splits < 16; i = head.indexOf(" b/", i + 1)) {
      splits++;
      const a = head.slice(2, i);
      const b = head.slice(i + 3);
      add(a);
      add(b);
      if (a === b || show === undefined) show = b;
    }
    if (!splits) bad = true;
  } else bad = true;
  // The extended header lines up to the first hunk.
  const end = sec.search(/^@@/m);
  for (const l of (end < 0 ? sec : sec.slice(0, end)).split("\n").slice(1)) {
    const line = l.replace(/\r$/, "");
    const m = /^(?:--- |\+\+\+ |rename from |rename to |copy from |copy to )(.*)$/.exec(line);
    if (!m) continue;
    const p = unquote(m[1] as string);
    const plain = line.startsWith("---") || line.startsWith("+++") ? unprefix(p) : p;
    add(plain);
    if (
      plain !== undefined &&
      plain !== "/dev/null" &&
      /^(?:\+\+\+ |rename to |copy to )/.test(line)
    )
      show = plain;
  }
  return { show, all, bad };
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
    const paths = sectionPaths(sec);
    const path = paths.show;
    if (
      paths.bad ||
      !path ||
      !paths.all.length ||
      paths.all.some((p) => !diffFileAllowed(p, o.exclude))
    ) {
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
    const lines = sec.split("\n");
    const firstHunk = lines.findIndex((l) => l.startsWith("@@"));
    // A Kubernetes Secret manifest (any line of the hunks says so) is dropped whole.
    if (
      firstHunk >= 0 &&
      lines.slice(firstHunk).some((l) => /^[-+ ]/.test(l) && KIND_SECRET.test(clean(l.slice(1))))
    ) {
      skipped++;
      continue;
    }
    const added: string[] = [];
    const addedCol: number[] = [];
    const kind = dataKind(path);
    const yaml = kind === "yaml";
    let cont: Continuation | undefined;
    let orphan = false;
    /** TOML: the table the current line is in (unknown = above the hunk). */
    let table: "known" | "unknown" | "secret" = "known";
    /** A `name: <secret>` mapping whose sibling `value:` is masked (its key column). */
    let item: number | undefined;
    /** The last `value:` sent, which a later sibling `name: <secret>` takes back. */
    let lastValue: { col: number; at: number } | undefined;
    const push = (s: Scrubbed, col: number) => {
      if (s.text !== undefined) {
        added.push(s.text);
        addedCol.push(col);
      }
      cont = s.cont;
    };
    for (const l of lines) {
      if (l.startsWith("@@")) {
        cont = undefined;
        item = undefined;
        lastValue = undefined;
        orphan = kind !== undefined;
        const start = /^@@ -\S+ \+(\d+)/.exec(l);
        table = kind === "toml" && start?.[1] !== "1" ? "unknown" : "known";
        continue;
      }
      if (!l.startsWith("+") || l.startsWith("+++")) continue;
      const raw = clean(l.slice(1));
      if (cont) {
        if (cont.kind !== "indent") {
          cont = consume(cont, raw);
          continue;
        }
        if (inIndent(cont, raw)) continue;
        cont = undefined;
      }
      if (orphan) {
        if (!raw.trim()) continue;
        if (!rooted(kind as DataKind, raw)) {
          // A JSON key whose object starts above the hunk: its name, never its value.
          if (kind === "json" && JSON_KEY.test(raw))
            push(scrubLine(raw, { yaml, force: true, safe: true }), keyCol(raw));
          continue;
        }
        orphan = false;
      }
      const col = keyCol(raw);
      const blank = !raw.trim();
      if (kind === "toml") {
        const h = TOML_HEADER.exec(raw);
        if (h) {
          table = secretTable(h[1] as string) ? "secret" : "known";
          push(scrubLine(raw, { yaml }), col);
          continue;
        }
        if (table !== "known") {
          push(scrubLine(raw, { yaml, force: true, safe: table === "unknown" }), col);
          continue;
        }
      }
      let force = yaml && YAML_SECRET_PARENT.test(raw);
      if (kind === "yaml" || kind === "json") {
        const indent = leadingIndent(raw);
        if (!blank && item !== undefined && indent < item) item = undefined;
        if (!blank && lastValue && indent < lastValue.col) lastValue = undefined;
        const nm = NAME_LINE.exec(raw);
        if (nm && isSecretName(nm[1] as string)) {
          item = col;
          // A `value:` sent above in the same mapping: mask it, drop what nested under it.
          if (lastValue && lastValue.col === col) {
            const { at } = lastValue;
            const masked = scrubLine(added[at] as string, { yaml, force: true }).text;
            const keep = added
              .slice(at + 1)
              .map((t, i) => [t, addedCol[at + 1 + i] as number] as const)
              .filter(([, c]) => c <= col);
            added.splice(at);
            addedCol.splice(at);
            if (masked !== undefined) {
              added.push(masked);
              addedCol.push(col);
            }
            for (const [t, c] of keep) {
              added.push(t);
              addedCol.push(c);
            }
            lastValue = undefined;
          }
        }
        if (item !== undefined && col === item && VALUE_LINE.test(raw)) force = true;
      }
      const s = scrubLine(raw, { yaml, force });
      if (
        !force &&
        s.text !== undefined &&
        (kind === "yaml" || kind === "json") &&
        VALUE_LINE.test(raw)
      )
        lastValue = { col, at: added.length };
      push(s, col);
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
