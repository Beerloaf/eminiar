import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, extname, join, relative, resolve } from "node:path";
import type { ProjectContext } from "../context.js";
import { getContext } from "../context.js";
import { type DocSource, readManifestAt } from "../docs/manifest.js";
import { git } from "../history/log.js";
import { loadPermissionRules } from "../permissions/settings.js";
import { confinePath } from "../sandbox/file.js";
import { renderProjectBrief } from "../session/brief.js";
import {
  commitContext,
  fileContext,
  fileSymbols,
  memoriesForFile,
  recallForText,
  recordShown,
} from "../session/recall.js";
import { type RoutingEvent, recordRouting } from "../session/routing-stats.js";
import { serverAlive } from "../session/server-alive.js";
import type { StorageAdapter } from "../storage/adapter.js";
import { getStorage } from "../storage/index.js";
import { isSwarmTool, swarmPreAgent, swarmStampCaller, swarmTouch } from "../swarm/hooks.js";
import { contextModeInstalled, effectiveRoutingMode } from "./coexist.js";
import { hookLog } from "./log.js";
import type { HookHandler, HookInput, HookOutput } from "./types.js";

const SYMBOL_KINDS = [
  "function",
  "class",
  "method",
  "interface",
  "trait",
  "type",
  "enum",
  "variable",
];

/** The longest identifier-like run in a Grep/Glob pattern (`parse\w+File` → `parse`). */
export function literalOf(pattern: string): string | undefined {
  const runs = pattern.match(/[A-Za-z_][A-Za-z0-9_]{2,}/g) ?? [];
  const best = runs.sort((a, b) => b.length - a.length)[0];
  return best && !/^(ts|js|tsx|jsx|src|lib|test|spec|index)$/i.test(best) ? best : undefined;
}

/**
 * Graph symbols whose name contains the pattern's literal: a jump target instead of a
 * grep, delivered as context without blocking the call.
 */
export function symbolHints(db: StorageAdapter, pattern: string): string | undefined {
  const lit = literalOf(pattern);
  if (!lit) return undefined;
  const nodes = db.graphFindNodes({ query: lit, kinds: SYMBOL_KINDS, limit: 5 });
  if (!nodes.length) return undefined;
  const list = nodes
    .map((n) => `${n.kind} ${n.name} (${n.path}:${n.start_line ?? "?"})`)
    .join("; ");
  return `eminiar graph: symbols matching "${lit}": ${list}. em_symbols {name_path, include_body: true} reads one; {mode:"references"} lists its callers.`;
}

/** Why a file is not fully in the graph, so absence of callers is not over-trusted. */
export function coverageHint(db: StorageAdapter, rel: string): string | undefined {
  const row = db.fileIndexGet(rel);
  if (!row || row.status === "indexed") return undefined;
  return `eminiar graph: ${rel} is ${row.status}${row.reason ? ` (${row.reason})` : ""}; graph answers about it may be incomplete.`;
}

/** A history read: [1] the options before the subcommand (`-C dir`), [2] it, [3] its arguments. */
const GIT_HISTORY =
  /(?:^|[;&|]\s*)git\s+((?:(?:-C|--git-dir|--work-tree)[= ]\S+\s+|--no-pager\s+)*)(log|blame|shortlog|show|whatchanged|reflog)\b([^;&|]*)/;
/** One commit, printed short: `git log -1 --format=%H` is a lookup, not a history read. */
const ONE_COMMIT = /(^|\s)(-1|-n\s*1|-n1|--max-count[= ]1)(?=\s|$)/;

/**
 * The em_history call that answers a `git log` / `blame` / `show` / `shortlog` command,
 * or undefined when the command is not a history read (or prints a file, like
 * `git show HEAD:path`).
 */
export function historyCall(cmd: string): string | undefined {
  const m = GIT_HISTORY.exec(cmd);
  if (!m) return undefined;
  const sub = m[2]!;
  const rest = (m[3] ?? "").trim();
  const args = rest.split(/\s+/).filter(Boolean);
  const q = (s: string) => JSON.stringify(s.replace(/^['"]|['"]$/g, ""));
  const positional = (a: string) => !a.startsWith("-");
  if (sub === "show") {
    if (/\S+:\S+/.test(rest)) return undefined; // `git show REF:path` prints a file
    const sha = args.find(positional);
    return `{action:"commit", sha:${q(sha ?? "HEAD")}}`;
  }
  if (sub === "blame") {
    const path = args.filter(positional).pop();
    return path ? `{action:"file", path:${q(path)}}` : undefined;
  }
  if (sub === "log" && ONE_COMMIT.test(rest) && !/(^|\s)(-p|--patch|--stat)\b/.test(rest))
    return undefined;
  const lineRange = /-L\s*:?([^:\s]+):(\S+)/.exec(rest);
  if (lineRange) {
    const [, fn, file] = lineRange;
    return /^[A-Za-z_$]/.test(fn!)
      ? `{action:"symbol", name_path:${q(`${file}#${fn}`)}}`
      : `{action:"file", path:${q(file!)}}`;
  }
  const grep = /--grep[= ]("[^"]*"|'[^']*'|\S+)/.exec(rest);
  if (grep) return `{action:"search", query:${q(grep[1]!)}}`;
  const author = /--author[= ]("[^"]*"|'[^']*'|\S+)/.exec(rest);
  const range = args.find((a) => positional(a) && /\.\.\.?/.test(a));
  if (range) {
    const [a, b] = range.split(/\.\.\.?/);
    return `{action:"branch", name:${q(b || a || "HEAD")}}`;
  }
  const dash = args.indexOf("--");
  const path =
    dash !== -1
      ? args[dash + 1]
      : args.find((a) => positional(a) && /[/.]/.test(a) && !/^[0-9a-f]{7,40}$/i.test(a));
  if (path) return `{action:"file", path:${q(path)}}`;
  if (author) return `{action:"timeline", author:${q(author[1]!)}}`;
  if (sub === "shortlog") return `{action:"timeline"}`;
  return `{action:"overview"}`;
}

/**
 * The directory the first history read in these segments runs in: the shell's, moved by each
 * `cd` before it and by `git -C`. Undefined when the shell decides (`cd $X`, `cd -`) or git is
 * pointed at a repository directly (`--git-dir`, `--work-tree`).
 */
function historyDir(segments: string[], cwd: string): string | undefined {
  let dir: string | undefined = cwd;
  for (const segment of segments) {
    const m = GIT_HISTORY.exec(segment);
    if (m) {
      const opts = m[1] ?? "";
      if (/--(git-dir|work-tree)\b/.test(opts)) return undefined;
      for (const c of opts.matchAll(/-C[= ](\S+)/g)) dir = dir && changeDir(dir, c[1]!);
      return dir;
    }
    const cd = /^\(?\s*(?:cd|pushd)\b(.*)$/.exec(segment);
    if (cd) dir = dir && changeDir(dir, cd[1]!);
  }
  return dir;
}

/** Where `cd <arg>` from `dir` lands, or undefined when only the shell knows. */
function changeDir(dir: string, arg: string): string | undefined {
  const a = arg.trim().replace(/^(['"])(.*)\1$/, "$2") || "~";
  if (/^-|^~[^/]|[\s$`*?[\]{}()\\]/.test(a)) return undefined;
  return a === "~" || a.startsWith("~/") ? join(homedir(), a.slice(1)) : resolve(dir, a);
}

/**
 * Is `dir` in the root's own repository: under the root, with the nearest `.git` (a folder, or
 * a worktree's file) at or above the root rather than in a nested repository on the way?
 */
function inRootRepo(root: string, dir: string): boolean {
  try {
    const top = realpathSync(root);
    let inside = false;
    for (let d = realpathSync(dir); ; d = dirname(d)) {
      if (d === top) inside = true;
      if (existsSync(join(d, ".git"))) return inside;
      if (dirname(d) === d) return false; // no repository at all
    }
  } catch {
    return false; // a directory that does not exist: git fails there too
  }
}

export interface Suggestion {
  tool: string;
  reason: string;
  /** Which rule fired (heavy, pipe, big-read, history, symbol, …), for routing statistics. */
  rule?: string;
  /** For Agent/Task in enforce mode: prefix the prompt instead of denying. */
  prefixPrompt?: string;
  /** Context only, never a denial (the native tool is still the right one). */
  annotateOnly?: boolean;
}

/** What preToolUse already knows that changes a suggestion. */
export interface SuggestExtra {
  /** For Grep: the pattern's identifier when the graph defines symbols by that name. */
  symbol?: string | undefined;
  /** For Bash: the directory relative paths resolve against (the hook's cwd). */
  cwd?: string | undefined;
}

/** Registered documentation sources (default manifest location; cheap, cached by the OS). */
function docsSources(root: string): DocSource[] {
  try {
    // `root` keeps a committed docs.json symlink that points outside the project unread.
    return readManifestAt(join(root, ".eminiar", "docs.json"), root).sources;
  } catch {
    return [];
  }
}

/** The documentation source whose seed hosts cover this URL, if any. */
export function docsSourceFor(url: string, root: string): string | undefined {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
  for (const s of docsSources(root)) {
    for (const u of s.urls ?? []) {
      try {
        const h = new URL(u).hostname.toLowerCase();
        if (host === h || host.endsWith(`.${h.replace(/^(www|docs|developer|developers)\./, "")}`))
          return s.name;
      } catch {
        // skip malformed seed
      }
    }
  }
  return undefined;
}

/**
 * Commands that usually print a lot. kubectl, docker, curl, wget, make and `npm run` reach this only
 * in their read-only forms: `staysNative` keeps the others native first.
 */
const HEAVY_BASH =
  /^\s*(git\s+(log|diff|show|blame)|npm\s+(test|run|ls|list|outdated|audit|why)|pnpm\s+(test|run|ls|list|outdated|why)|yarn\s+(test|run|list|why)|npx\s+(vitest|jest|tsc|eslint|biome)|cat\s|head\s|tail\s|find\s|grep\s|rg\s|ls\s+-[a-zA-Z]*R|tree\b|curl\s|wget\s|docker\s|kubectl\s|du\s|df\s|ps\s|lsof\s|brew\s+(list|outdated)|pip\s+(list|freeze)|cargo\s+(test|build)|go\s+(test|build)|make\b|pytest\b|mvn\b|gradle\b)/;
const TINY_BASH =
  /^\s*(git\s+(status|branch)\b[^|]*|pwd|ls(\s+-[a-zA-Z]+)?(\s+\S+)?|echo\s.*|which\s+\S+|node\s+-v|npm\s+-v|cd\s+\S+|mkdir\s.*|touch\s.*|cp\s.*|mv\s.*|rm\s.*|chmod\s.*|date|whoami)\s*$/;
const BIG_TEXT_EXT = new Set([
  ".log",
  ".json",
  ".jsonl",
  ".csv",
  ".tsv",
  ".xml",
  ".txt",
  ".ndjson",
  ".sql",
  ".har",
]);
/**
 * Files Read shows to the model as images or pages, not as text. em_execute_file only returns
 * what code prints, so routing these there loses the content instead of saving context.
 * (SVG is text and stays routable.)
 */
const VISUAL_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".pdf"]);

/**
 * A command with its heredoc bodies cut out: they are data, not commands to classify. The rest of
 * the `<<EOF` line stays (`cat <<EOF | kubectl apply -f -`).
 */
export function withoutHeredocs(cmd: string): string {
  return cmd.replace(/<<-?\s*(['"]?)(\w+)\1([^\n]*)\n[\s\S]*?\n\s*\2\s*(?=\n|$)/g, "<<$2$3");
}

/** Split `s` at every unquoted position where `sep` returns the separator's length. */
function splitUnquoted(s: string, sep: (s: string, i: number) => number): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | undefined;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (quote) {
      cur += ch;
      if (ch === quote && s[i - 1] !== "\\") quote = undefined;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      cur += ch;
      continue;
    }
    const n = sep(s, i);
    if (n) {
      out.push(cur);
      cur = "";
      i += n - 1;
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out.map((p) => p.trim()).filter(Boolean);
}

/** The simple commands a shell line runs in sequence: split at `;`, `&&`, `||` and newlines. */
export function commandSegments(cmd: string): string[] {
  return splitUnquoted(cmd, (s, i) => {
    const ch = s[i];
    if (ch === ";" || ch === "\n") return 1;
    if ((ch === "&" || ch === "|") && s[i + 1] === ch) return 2;
    return 0;
  });
}

/** The stages of one pipeline: `a | b | c` → [a, b, c]. */
function pipeStages(segment: string): string[] {
  return splitUnquoted(segment, (s, i) => (s[i] === "|" && s[i + 1] !== "|" ? 1 : 0));
}

/** Lines a `head` / `tail` stage keeps: its -n / -N argument, or the default 10. */
function headLines(stage: string): number {
  const m = /(?:^|\s)(?:-n\s*=?\s*|-)(\d+)(?=\s|$)|--lines[= ](\d+)/.exec(stage);
  return m ? Number(m[1] ?? m[2]) : 10;
}

/** The most lines a bounded final stage may print before it counts as a lot. */
const BOUNDED_LINES = 400;

/** Does this pipe stage cap the output (`head -40`, `tail -5`, `wc -l`)? */
function bounds(stage: string): boolean {
  if (/^\s*wc\b/.test(stage)) return true;
  if (!/^\s*(head|tail)\b/.test(stage) || /(^|\s)-c\b|--bytes\b/.test(stage)) return false;
  return headLines(stage) <= BOUNDED_LINES;
}

/**
 * Commands whose point is a side effect: commits, installs, file writes, deploys, running a
 * project's own scripts or recipes (`make`, `npm run <x>`: judged in CHANGES below). Their output
 * is secondary and the native Bash tool is where Claude Code's permission prompts live, so a
 * command containing one is never redirected to the sandbox.
 */
const MUTATING =
  /^(git\s+(?:(?:-[Cc]\s*[^-\s]\S*|--(?:git-dir|work-tree)[= ]\S+|--no-pager)\s+)*(add|commit|checkout|switch|push|pull|fetch|merge|rebase|stash|reset|restore|cherry-pick|revert|tag|init|clone|worktree|mv|rm|am|apply|submodule|clean|branch\s(?:.*\s)?(-[dDmM]|--delete|--move)|config(?:\s+--(?:global|local|system|worktree))*\s+(?:set|unset|--(?:unset|unset-all|add|replace-all|rename-section|remove-section|edit)|-e|\w[\w.-]*\s+\S+))|npm\s+(install|i|ci|uninstall|un|link|publish|version|update|up|dedupe|audit\s+fix)|pnpm\s+(install|i|add|remove|rm|update|up|link|audit\s.*--fix)|yarn\s+(add|remove|install|upgrade)|pip3?\s+(install|uninstall)|cargo\s+(add|install)|brew\s+(install|uninstall|upgrade)|gh\s+(pr|issue|release|repo)\s+(create|edit|merge|close|comment|delete|ready)|terraform\s+(?:-\S+\s+)*(apply|destroy|import|taint|untaint|state\s+(rm|mv|push))|helm\s+(?:-\S+\s+(?:[^-\s]\S*\s+)?)*(install|upgrade|uninstall|rollback|delete)|mvnw?\s.*\s(deploy|install|release:\S*)|gradlew?\s.*[\s:](publish|upload)\w*|rm|mv|cp|mkdir|rmdir|touch|chmod|chown|ln|sed\s+(?:-\S+\s+)*-i|tee|eval|sh|bash|zsh|find\s.*\s-(delete|exec|execdir|ok|okdir))(?![\w-])/;
/**
 * Commands that run the one after them, with the options they take (`sudo -u root`, `timeout 30`).
 * Each option is either one that takes a value or one that does not, never both: an ambiguous
 * split backtracks exponentially on a line of many flags.
 */
const RUNNERS = [
  String.raw`sudo(?:\s+(?:-[ugCDhpRrtTU]\s*[^-\s]\S*|-(?![ugCDhpRrtTU])\S+))*`,
  String.raw`env(?:\s+(?:-[uC]\s*[^-\s]\S*|-(?![uC])\S+))*`,
  String.raw`(?:xargs|parallel)(?:\s+(?:-[nILPsdEaj]\s*[^-\s]\S*|-(?![nILPsdEaj])\S+))*`,
  String.raw`timeout(?:\s+(?:-[sk]\s*[^-\s]\S*|-(?![sk])\S+))*\s+\d\S*`,
  String.raw`nice(?:\s+-n\s*\S+|\s+-\d+)?`,
  String.raw`stdbuf(?:\s+-[ioe]\s*\S+)*`,
  String.raw`(?:time|command)(?:\s+-p)?`,
  "nohup",
  String.raw`[A-Z_][A-Z0-9_]*=\S*`,
];
/** Shell grammar before a command: `{ rm x; }`, `( … )`, `! cmd`, `then cmd`, `do cmd` …. */
const SHELL_WORDS = /^(?:\s*(?:[({!]|(?:then|do|else|exec|if|elif|while|until)\s))*\s*/;
/** What runs the command after it, which is the one to judge: `sudo`, `FOO=1`, `xargs -0` …. */
const RUNNER = new RegExp(String.raw`^\s*(?:(?:${RUNNERS.join("|")})\s+)*`);
/**
 * A redirection into a file (`> f`, `>> f`, `&> f`, `cmd>f`; not /dev/null, not `2>&1`) writes
 * something. `=>` and `->` are not redirections.
 */
const WRITES_FILE = /(?<![-=>])>{1,2}\s*(?!&)(?!\/dev\/null)\S/;
/** A program read from a pipe (`curl … | python3`): whatever it does, it does like `| sh`. */
const RUNS_STDIN = /^(python3?|node|perl|ruby|deno|bun)(\s+-\S*)*$/;
/** Commands that never finish (follow, `--watch`): em_execute would only time out on them. */
const FOLLOWS =
  /^((kubectl|docker)(\s.*)?\s(-f|-w|--follow)(?=[\s=]|$)|tail(\s.*)?\s(-[a-zA-Z]*[fF]|--follow)|.*\s--watch(All)?(?=[\s=]|$))/;

/**
 * curl sending or saving something: a method other than GET / HEAD, a body, an upload, an output
 * file, a config file. In a flag cluster, everything after `X` is its value (`-sXGET`).
 */
const CURL_SENDS =
  /\s(?:-(?:(?!X)[a-zA-Z])*[dFTOoK]|(?:-[a-zA-Z]*X|--request)(?![\s=]*['"]?(?:GET|HEAD)\b)|--(?:data|json|form|upload-file|output|remote-name|config))/;
/** wget printing instead of saving: `-O -`, `-qO-`, `--output-document=-`, or `--spider`. */
const WGET_PRINTS = /\s(?:-[a-zA-Z]*O\s*-|--output-document[= ]-|--spider)(?=\s|$)/;
const WGET_SENDS = /\s--(post-data|post-file|body-data|body-file|method)\b/;
const KUBECTL_READS =
  /^(get|describe|logs|top|explain|api-resources|api-versions|events|version|cluster-info|config\s+(view|get-contexts|current-context)|rollout\s+(status|history)|auth\s+can-i)\b/;
const DOCKER_READS =
  /^(ps|logs|images|inspect|history|version|info|stats\s.*--no-stream|(container|image|network|volume)\s+(ls|inspect)|compose\s+(ps|logs|config|images|ls)|system\s+df)\b/;
/** Scripts that only test or check (`test:unit`, `lint`, `typecheck`), not ones that fix or write. */
const CHECK_SCRIPT = /^(t|test|lint|type-?check|check)(?=$|[:.-])(?![\w:.-]*(fix|write|update))/;
/** Arguments that turn a check into a write: `-- --fix`, `--write`, `-u` (update snapshots). */
const FIX_ARGS =
  /(?:^|\s)(--fix|--write|--apply(-unsafe)?|-u|--update(-?[sS]napshots?)?)(?=[\s=]|$)/;
/** npx tools that only check or test, unless told to fix or write. */
const NPX_CHECKS = /^(vitest|jest|tsc|eslint|biome|prettier)\b/;
/** pnpm / yarn words that are their own read-only commands, not scripts (`pnpm ls`, `yarn why`). */
const PM_READS = /^(ls|list|outdated|why|info|view|audit|licenses|bin|root|help)$/;
/**
 * Options that take the next word, before a subcommand: one set for kubectl and docker globals
 * (`-n prod`, `--context x`, `-H host`) and package-manager ones (`--prefix a`, `--filter web`).
 */
const VALUE_OPTS = new Set([
  "-n",
  "--namespace",
  "--context",
  "--cluster",
  "--kubeconfig",
  "--user",
  "-s",
  "--server",
  "--token",
  "--as",
  "-H",
  "--host",
  "-c",
  "--config",
  "-l",
  "--log-level",
  "-j",
  "--prefix",
  "-C",
  "--dir",
  "--cwd",
  "-w",
  "--workspace",
  "-F",
  "--filter",
]);

/** The words after the options before them: ` -n prod get pods` → [get, pods]. */
function afterOptions(args: string): string[] {
  const words = args.trim().split(/\s+/);
  let i = 0;
  while (words[i]?.startsWith("-")) i += VALUE_OPTS.has(words[i]!) ? 2 : 1;
  return words.slice(i);
}

const subcommand = (args: string) => afterOptions(args).join(" ");

/**
 * `npm run <script>`, `yarn <script>`, `pnpm --filter x <script>`: anything but a test or check
 * script run as a check. npm's own commands (`npm ls`) are not scripts; MUTATING names those that
 * change something.
 */
function runsScript(tool: string, args: string): boolean {
  const words = afterOptions(args);
  let script = words.shift();
  if (script === "run" || script === "run-script") script = words.shift();
  else if (script === undefined || PM_READS.test(script) || (tool === "npm" && script !== "test"))
    return false;
  if (script === undefined) return false; // `npm run` lists the scripts
  return !CHECK_SCRIPT.test(script) || FIX_ARGS.test(words.join(" "));
}

/** `make`: recipes run anything; only test / check / lint targets, not told to fix, read. */
function makeChanges(args: string): boolean {
  const targets = afterOptions(args).filter((w) => w && !w.includes("="));
  return !targets.length || !targets.every((t) => CHECK_SCRIPT.test(t)) || FIX_ARGS.test(args);
}

/** `gh api`: a method other than GET, fields (which make it a POST), or a GraphQL mutation. */
function ghApiSends(args: string): boolean {
  if (!/^\s+api\s/.test(args)) return false;
  const method = /\s(?:-X|--method)[\s=]*['"]?(\w+)/.exec(args)?.[1];
  if (method) return method.toUpperCase() !== "GET";
  if (/\sgraphql\b/.test(args)) return /\bmutation\b/.test(args);
  return /\s(-[fF]|--field|--raw-field|--input)\b/.test(args);
}

/**
 * Tools with read-only forms worth routing (`kubectl logs`, `curl -s url`, `npm test`): does
 * this call (the arguments after the tool's name) change something instead?
 */
const CHANGES = new Map<string, (args: string) => boolean>([
  ["curl", (a) => CURL_SENDS.test(a)],
  ["wget", (a) => !WGET_PRINTS.test(a) || WGET_SENDS.test(a)],
  ["kubectl", (a) => !KUBECTL_READS.test(subcommand(a))],
  ["docker", (a) => !DOCKER_READS.test(subcommand(a))],
  ["gh", ghApiSends],
  ["make", makeChanges],
  ["npx", (a) => !NPX_CHECKS.test(subcommand(a)) || FIX_ARGS.test(a)],
  ["npm", (a) => runsScript("npm", a)],
  ["pnpm", (a) => runsScript("pnpm", a)],
  ["yarn", (a) => runsScript("yarn", a)],
]);

/** The commands inside `$(…)`, backticks and process substitutions `<(…)` / `>(…)`, innermost first. */
function substitutions(segment: string): string[] {
  const found: string[] = [];
  const inner = /[$<>]\(([^()]*)\)|`([^`]*)`/g;
  for (let s = segment, prev = ""; s !== prev; ) {
    prev = s;
    s = s.replace(inner, (_, a: string | undefined, b: string | undefined) => {
      found.push(a ?? b ?? "");
      return "_";
    });
  }
  return found;
}

/**
 * Must this segment run natively? It changes something (in any pipe stage), or it never
 * finishes. Each stage is judged by the command a runner prefix
 * starts, by its name without a path (`sudo /usr/bin/kubectl delete …` is `kubectl delete …`).
 */
function staysNative(segment: string): boolean {
  // Quoted text is data (`rg 'Promise<string>'`, `jq 'select(.n>3)'`), not a redirection.
  if (WRITES_FILE.test(segment.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, "''"))) return true;
  return pipeStages(segment).some((stage, i) => {
    const cmd = stage
      .replace(SHELL_WORDS, "")
      .replace(RUNNER, "")
      .replace(/^\S*\//, "");
    const [, tool = "", args = ""] = /^(\S+)([\s\S]*)$/.exec(cmd) ?? [];
    return (
      MUTATING.test(cmd) ||
      FOLLOWS.test(cmd) ||
      (i > 0 && RUNS_STDIN.test(cmd)) ||
      CHANGES.get(tool)?.(args) === true
    );
  });
}

/** Output size Read tolerates natively; a `cat` of that much is the same read through Bash. */
const READ_LIMIT = 200 * 1024;
const BIG_TEXT_LIMIT = 20 * 1024;

/** Flags of grep / rg that take the next token as their value. */
const GREP_VALUE_FLAGS = new Set([
  "-e",
  "-f",
  "-m",
  "-A",
  "-B",
  "-C",
  "-d",
  "-g",
  "-t",
  "-T",
  "--regexp",
  "--file",
  "--max-count",
  "--after-context",
  "--before-context",
  "--context",
  "--include",
  "--exclude",
  "--glob",
  "--type",
]);

/**
 * The files a `cat` / `grep` / `rg` stage reads, or undefined when a glob, variable,
 * directory or missing operand makes them unknowable (`grep -r x src`, `cat *.log`).
 */
function fileOperands(stage: string, cwd: string): string[] | undefined {
  const tokens = stage.trim().split(/\s+/);
  const cmd = tokens[0]!;
  const isGrep = /^(grep|egrep|fgrep|rg)$/.test(cmd);
  const files: string[] = [];
  let patternGiven = !isGrep;
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t === "--") {
      files.push(...tokens.slice(i + 1));
      break;
    }
    if (t.startsWith("-") && t.length > 1) {
      if (/^-[ef]$|^--(regexp|file)$/.test(t)) patternGiven = true;
      if (GREP_VALUE_FLAGS.has(t)) i++;
      continue;
    }
    if (!patternGiven) {
      patternGiven = true;
      continue;
    }
    files.push(t);
  }
  if (!files.length) return undefined;
  const out: string[] = [];
  for (let f of files) {
    if (/[*?[\]{}$`\\]/.test(f)) return undefined;
    f = f.replace(/^['"]|['"]$/g, "");
    if (f.startsWith("~/")) f = join(homedir(), f.slice(2));
    out.push(resolve(cwd, f));
  }
  return out;
}

/**
 * Bytes a `cat` / `grep` stage can print at most (the files it reads), or undefined when
 * that is unknowable. A missing file costs nothing: one error line.
 */
function stageBytes(stage: string, cwd: string): number | undefined {
  const files = fileOperands(stage, cwd);
  if (!files) return undefined;
  let total = 0;
  for (const f of files) {
    try {
      const st = statSync(f);
      if (st.isDirectory()) return undefined;
      if (BIG_TEXT_EXT.has(extname(f).toLowerCase()) && st.size > BIG_TEXT_LIMIT)
        return READ_LIMIT + st.size;
      total += st.size;
    } catch {
      // missing: an error line
    }
  }
  return total;
}

/** A `sed -n 'A,Bp'` range: at most B-A+1 lines. */
function sedRangeLines(stage: string): number | undefined {
  const m = /^\s*sed\s+(?:-\S+\s+)*-n\s+['"]?(\d+),(\d+)p['"]?/.exec(stage);
  return m ? Number(m[2]) - Number(m[1]) + 1 : undefined;
}

interface Heavy {
  rule: string;
  text: string;
}

/**
 * Is the first stage of a pipeline bounded on its own: a short head / tail / sed range,
 * a `du -s`, a `grep -l` / `-c`, or a cat / grep over named files small enough for Read?
 * Later stages only narrow it. Returns a Heavy when it is known to be big instead.
 */
function firstStageBound(first: string, cwd: string): true | Heavy | undefined {
  if (/^\s*(head|tail)\s/.test(first)) return bounds(first) || undefined;
  const sed = sedRangeLines(first);
  if (sed !== undefined) return sed <= BOUNDED_LINES || undefined;
  if (/^\s*du\s+-[a-zA-Z]*s/.test(first)) return true;
  if (/^\s*git\s+log\b/.test(first) && ONE_COMMIT.test(first)) return true;
  if (
    /^\s*(grep|egrep|fgrep|rg)\s/.test(first) &&
    /(^|\s)-[a-zA-Z]*[lLcq][a-zA-Z]*(?=\s|$)|--(files-with-matches|files-without-match|count|quiet)\b/.test(
      first,
    )
  )
    return true;
  if (/^\s*(cat|grep|egrep|fgrep|rg)\s/.test(first)) {
    const bytes = stageBytes(first, cwd);
    if (bytes === undefined) return undefined;
    if (bytes <= READ_LIMIT) return true; // what Read would show anyway
    return { rule: "big-read", text: `reads about ${Math.round(bytes / 1024)} KB` };
  }
  return undefined;
}

/**
 * Read-only commands whose output can be long: a filter after them still reads all of it. Not
 * `env`: em_execute runs with an allowlisted environment, so it would answer about a different one.
 */
const READ_SOURCE =
  /^\s*(ls|cat|sed|awk|cut|sort|uniq|tr|nl|echo|printf|ps|lsof|jq|yq|diff|strings|xxd|od|git\s+(diff|ls-files|ls-tree|grep|status|show|log|blame|branch|rev-list|for-each-ref|cat-file)|gh\s+(api|pr\s+(list|view|diff|checks)|issue\s+(list|view)|run\s+(list|view)|search))\b/;
/** Stages that only filter what they are given; the pipe rule needs one that does not bound it. */
const FILTERS =
  /^\s*(grep|egrep|fgrep|rg|sort|uniq|jq|head|tail|wc|cut|tr|column|less|awk|sed|python3?\s+-m\s+json\.tool)\b/;
const UNBOUNDED_FILTERS = /^\s*(grep|rg|sort|uniq|jq|less)\b/;

/** Why one simple command would print a lot, or undefined when its output is bounded. */
function heavySegment(segment: string, cwd: string): Heavy | undefined {
  if (TINY_BASH.test(segment)) return undefined;
  const stages = pipeStages(segment);
  const first = stages[0];
  if (!first) return undefined;
  // `… | head -40` caps whatever came before it.
  if (stages.length > 1 && bounds(stages[stages.length - 1]!)) return undefined;
  // A later stage that does something with the output (`| patch -p1`, `| psql db`) may change
  // something: only a pipe through known filters is routed.
  const rest = stages.slice(1);
  if (!rest.every((s) => FILTERS.test(s))) return undefined;
  const bound = firstStageBound(first, cwd);
  if (bound === true) return undefined;
  if (bound) return bound;
  if (HEAVY_BASH.test(first)) return { rule: "heavy", text: "usually prints a lot" };
  // Only a source known to just read: an unknown one (`ssh`, `psql`, `aws`) may change something.
  if (READ_SOURCE.test(first) && rest.some((s) => UNBOUNDED_FILTERS.test(s)))
    return { rule: "pipe", text: "streams an unbounded output through a filter" };
  return undefined;
}

/** A short label for a command segment in a reason or a log line. */
function headOf(segment: string, n = 60): string {
  const one = segment.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

/**
 * Routing for a Bash command, one simple command at a time: a command that changes
 * something stays native; a history read goes to em_history; a segment that prints a lot
 * (and is not capped by `| head`, and is not a cat of what Read would show anyway) goes to
 * em_execute.
 */
function bashSuggestion(raw: string, root: string, cwd: string): Suggestion | undefined {
  const cmd = withoutHeredocs(raw);
  if (!cmd.trim()) return undefined;
  const segments = commandSegments(cmd);
  // `$(…)` and backticks run too: their commands are judged like the line's own.
  if ([...segments, ...substitutions(cmd).flatMap(commandSegments)].some(staysNative))
    return undefined;
  // git history reads have a classified answer: fixes traced to their origin, risk per
  // file, branches vs base — em_history, not a raw log through em_execute. em_history reads
  // the root's repository only, so a read of another one (or of none) is judged like any command.
  const history = historyCall(cmd);
  const dir = history && historyDir(segments, cwd);
  if (history && dir && inRootRepo(root, dir)) {
    return {
      tool: "em_history",
      rule: "history",
      reason: `the git history is already classified (commit kinds, fixes traced to the change that caused them, risk per file); em_history ${history} answers this without the raw log`,
    };
  }
  for (const segment of segments) {
    const heavy = heavySegment(segment, cwd);
    if (!heavy) continue;
    return {
      tool: "em_execute",
      rule: heavy.rule,
      reason: `\`${headOf(segment)}\` ${heavy.text}; em_execute {language:"shell", code, intent} keeps the output out of context and returns only matching sections`,
    };
  }
  return undefined;
}

/** Would em_execute_file accept this path? It is given the root as a real path, like the server. */
function executeFileTakes(root: string, fp: string): boolean {
  try {
    const real = realpathSync(root);
    confinePath(real, resolve(root, fp), loadPermissionRules(real));
    return true;
  } catch {
    return false;
  }
}

/** Decide whether a native tool call is better served by an em_* tool. */
export function suggest(
  toolName: string,
  input: Record<string, unknown>,
  root: string,
  extra: SuggestExtra = {},
): Suggestion | undefined {
  switch (toolName) {
    case "Bash":
      return bashSuggestion(String(input.command ?? ""), root, extra.cwd ?? root);
    case "Read": {
      const fp = String(input.file_path ?? "");
      if (!fp) return undefined;
      // An offset or limit is a window the model already chose: bounded, like `sed -n 'A,Bp'`.
      if (input.offset != null || input.limit != null) return undefined;
      const ext = extname(fp).toLowerCase();
      if (VISUAL_EXT.has(ext)) return undefined;
      try {
        const st = statSync(resolve(root, fp));
        if (st.size > 200 * 1024 || (BIG_TEXT_EXT.has(ext) && st.size > 20 * 1024)) {
          // em_execute_file refuses a file outside the root (Claude Code's own saved tool
          // outputs among them) and what a Read deny or ask rule matches; leave the native Read
          // to Claude Code's own permission check instead of redirecting to a dead end.
          if (!executeFileTakes(root, fp)) return undefined;
          return {
            tool: "em_execute_file",
            rule: "big-read",
            reason: `${fp} is ${Math.round(st.size / 1024)} KB; em_execute_file {path, code} processes it in the sandbox so only what you print enters context`,
          };
        }
      } catch {
        // missing file: let Read report it
      }
      return undefined;
    }
    case "Grep": {
      const content = input.output_mode === "content" && !input.head_limit;
      if (extra.symbol) {
        // The graph already knows this identifier: symbol-level answers beat raw matches.
        // A files-only grep is cheap, so that one is annotated rather than denied.
        return {
          tool: "em_symbols",
          rule: "symbol",
          annotateOnly: !content,
          reason: `the graph indexes "${extra.symbol}": em_symbols {name_path:"${extra.symbol}", mode:"references"} lists its uses, {include_body:true} its definition; em_search {queries:["${extra.symbol}"], source:"code"} finds the code by symbol`,
        };
      }
      if (content) {
        return {
          tool: "em_execute",
          rule: "content-grep",
          reason: `content-mode grep can be large; em_execute with rg and an intent returns only matching sections (em_search {queries, mode:"regex"} scans the indexed files with context)`,
        };
      }
      return undefined;
    }
    case "WebFetch": {
      const url = String(input.url ?? "");
      const covered = url ? docsSourceFor(url, root) : undefined;
      return {
        tool: "em_fetch_and_index",
        reason: covered
          ? `this site is already indexed as documentation source "${covered}" — em_docs {action:"lookup", query} answers from the index; em_fetch_and_index {url, queries} fetches one page if it is missing`
          : `em_fetch_and_index {url, queries} indexes the page and returns only the relevant sections; em_docs {action:"add", url} keeps documentation permanently`,
      };
    }
    case "WebSearch": {
      const sources = docsSources(root);
      if (!sources.length) return undefined;
      const names = sources.slice(0, 10).map((s) => s.name);
      return {
        tool: "em_docs",
        annotateOnly: true,
        reason: `${sources.length} documentation source(s) are indexed locally (${names.join(", ")}${sources.length > 10 ? ", …" : ""}); em_docs {action:"lookup", query} answers from them without a web round trip`,
      };
    }
    case "Agent":
    case "Task":
      return {
        tool: "em_*",
        reason:
          "subagents should prefer em_execute / em_batch_execute / em_search over Bash, Read and Grep",
        prefixPrompt:
          'Use the eminiar tools (em_execute, em_batch_execute, em_execute_file, em_fetch_and_index, em_search, em_symbols, em_history) instead of Bash/Read/Grep/WebFetch whenever output may be large; return only derived answers. Check em_recall {query} for project decisions and constraints before proposing changes, em_history {action:"file", path} before editing a file, em_symbols / em_search {source:"code"} before grepping for an identifier, and em_docs {action:"lookup", query} before WebFetch/WebSearch for anything the project depends on.\n\n',
      };
    default:
      return undefined;
  }
}

/** Project-relative path of a tool's file_path, or undefined when it is outside the project. */
function projectRel(ctx: ProjectContext, fp: string): string | undefined {
  if (!fp) return undefined;
  let abs = resolve(ctx.root, fp);
  try {
    abs = realpathSync(abs); // the project root is a real path; tool paths may go through symlinks
  } catch {
    // missing file (a Write creating it, or Read about to report it)
  }
  const rel = relative(ctx.root, abs).split("\\").join("/");
  return rel.startsWith("..") ? undefined : rel;
}

/**
 * Non-blocking context for navigation tools: matching graph symbols for Grep/Glob
 * patterns, coverage gaps for files about to be read. Never denies anything.
 */
function graphContext(ctx: ProjectContext, input: HookInput): string | undefined {
  try {
    const db = getStorage(ctx, { vectors: false });
    if (!db.graphCounts().nodes) return undefined;
    if (input.tool_name === "Grep" || input.tool_name === "Glob") {
      const pattern = String(input.tool_input?.pattern ?? "");
      return pattern ? symbolHints(db, pattern) : undefined;
    }
    if (input.tool_name === "Read") {
      const rel = projectRel(ctx, String(input.tool_input?.file_path ?? ""));
      return rel ? coverageHint(db, rel) : undefined;
    }
  } catch {
    // hints are optional
  }
  return undefined;
}

const FILE_TOOLS = new Set(["Read", "Edit", "MultiEdit", "Write"]);
const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write"]);

/**
 * Before a file is read or edited: the memories about it (linked, naming its path or one
 * of its symbols) and its fix history; before an edit, also its fan-in. Each once per
 * context window, again after `recall.repeatAfter` prompts.
 */
function fileKnowledge(ctx: ProjectContext, input: HookInput): string | undefined {
  if (!ctx.config.recall.onFile || !FILE_TOOLS.has(input.tool_name ?? "")) return undefined;
  try {
    const rel = projectRel(ctx, String(input.tool_input?.file_path ?? ""));
    if (!rel) return undefined;
    const db = getStorage(ctx, { vectors: false });
    const sessionId = input.session_id || undefined;
    const repeatAfter = ctx.config.recall.repeatAfter;
    const edit = EDIT_TOOLS.has(input.tool_name ?? "");
    const results = [
      memoriesForFile(db, rel, { sessionId, symbols: fileSymbols(db, rel), repeatAfter }),
      fileContext(db, rel, { sessionId, edit, repeatAfter }),
    ];
    const shown = results.filter((r) => r.text);
    if (!shown.length) return undefined;
    if (sessionId)
      recordShown(
        db,
        sessionId,
        shown.flatMap((r) => r.keys),
        { path: "file" },
      );
    return shown.map((r) => r.text).join("\n");
  } catch {
    return undefined;
  }
}

/** Files a `git commit` command will include: the index, plus tracked changes with -a. */
function commitFiles(root: string, cmd: string): string[] {
  const list = (args: string[]) =>
    git(root, args, { allowFail: true })
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  const files = new Set(list(["diff", "--cached", "--name-only"]));
  if (/\s(-[a-zA-Z]*a[a-zA-Z]*|--all)\b/.test(cmd))
    for (const f of list(["diff", "--name-only"])) files.add(f);
  return [...files];
}

/** Before `git commit`: the bug-prone and widely imported files it includes. */
function commitKnowledge(ctx: ProjectContext, input: HookInput): string | undefined {
  if (!ctx.config.recall.onCommit || input.tool_name !== "Bash") return undefined;
  const cmd = withoutHeredocs(String(input.tool_input?.command ?? ""));
  if (!/(^|[;&|]\s*)git\s+commit\b/.test(cmd)) return undefined;
  try {
    const db = getStorage(ctx, { vectors: false });
    return commitContext(db, commitFiles(ctx.root, cmd)) || undefined;
  } catch {
    return undefined;
  }
}

/** Words of a URL worth searching for (`/docs/api/rate-limits` → `docs api rate limits`). */
function urlWords(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname.split(".").slice(0, -1).join(" ")} ${u.pathname.replace(/[/_\-.]+/g, " ")}`;
  } catch {
    return "";
  }
}

/** Before WebSearch / WebFetch: the indexed doc pages that already answer it. */
async function webKnowledge(ctx: ProjectContext, input: HookInput): Promise<string | undefined> {
  if (!ctx.config.recall.onWeb) return undefined;
  const ti = input.tool_input ?? {};
  const text =
    input.tool_name === "WebSearch"
      ? String(ti.query ?? "")
      : input.tool_name === "WebFetch"
        ? `${String(ti.prompt ?? "")} ${urlWords(String(ti.url ?? ""))}`
        : "";
  if (!text.trim()) return undefined;
  try {
    const db = getStorage(ctx, { vectors: false });
    const r = await recallForText(db, text, { maxMemories: 0, maxDocs: 3, path: "web" });
    if (!r.text) return undefined;
    const pages = r.text.split("\n").filter((l) => l.startsWith("- docs:"));
    return [
      'eminiar docs: the local documentation index already has pages on this — try em_docs {action:"lookup", query} before the web:',
      ...pages,
    ].join("\n");
  } catch {
    return undefined;
  }
}

function joinHints(...hints: Array<string | undefined>): string | undefined {
  const h = hints.filter(Boolean);
  return h.length ? h.join("\n") : undefined;
}

function withContext(
  out: HookOutput | undefined,
  extra: string | undefined,
): HookOutput | undefined {
  if (!extra) return out;
  if (!out)
    return { hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: extra } };
  const cur = out.hookSpecificOutput?.additionalContext;
  return {
    ...out,
    hookSpecificOutput: {
      ...out.hookSpecificOutput,
      hookEventName: "PreToolUse",
      additionalContext: cur ? `${cur}\n${extra}` : extra,
    },
  };
}

export const preToolUse: HookHandler = async (
  input: HookInput,
): Promise<HookOutput | undefined> => {
  if (!input.tool_name || !input.tool_input) return undefined;
  // em_swarm is eminiar's own tool: stamp (or strip) its caller, never route or annotate it.
  if (isSwarmTool(input.tool_name)) return swarmStampCaller(input);
  const ctx = getContext(input.cwd);
  // A swarm worker starting a tool is alive: keep its capacity slot and its task.
  if (input.agent_id) swarmTouch(ctx, input);
  // Swarm capacity holds in every routing mode, and a denial wins over everything else.
  const spawn = swarmPreAgent(ctx, input);
  if (spawn?.kind === "deny") return spawn.output;
  // A swarm worker is briefed at SubagentStart; a prompt brief as well would say it twice.
  const out = await route(ctx, input as RoutedInput, spawn?.kind === "worker");
  // The adjudicator (off by default) is loaded only when enabled, so off costs this one check.
  // It extends routing's output (the Agent model joins routing's one updatedInput); never denies.
  if (!ctx.config.adjudicator.enabled || input.client === "cursor") return out;
  try {
    const { afterRouting } = await import("../adjudicator/hooks.js");
    return await afterRouting(ctx, input, spawn, out);
  } catch {
    return out;
  }
};

type RoutedInput = HookInput & { tool_name: string; tool_input: Record<string, unknown> };

/** Routing proper: knowledge hints, then the routing mode's decision for this call. */
async function route(
  ctx: ProjectContext,
  input: RoutedInput,
  swarmWorker: boolean,
): Promise<HookOutput | undefined> {
  // Project knowledge is pushed in every routing mode: switching routing off should not
  // hide decisions, fix history or the docs that are already indexed.
  const memo = joinHints(
    fileKnowledge(ctx, input),
    commitKnowledge(ctx, input),
    await webKnowledge(ctx, input),
  );
  const mode = effectiveRoutingMode(ctx.config);
  if (mode === "off") return withContext(undefined, memo);
  const coexisting = contextModeInstalled() && ctx.config.routing.deferToContextMode;
  // context-mode already routes these; adding a second opinion only confuses the model.
  if (coexisting && ["Bash", "Read", "Grep", "WebFetch"].includes(input.tool_name))
    return withContext(undefined, memo);

  const graph = graphContext(ctx, input);
  const hint = joinHints(graph, memo);
  // graphContext names matching symbols only when the graph has them: that is the signal
  // to route a Grep for the identifier to em_symbols / em_search instead of rg.
  const symbol =
    input.tool_name === "Grep" && graph
      ? literalOf(String(input.tool_input.pattern ?? ""))
      : undefined;
  const s = suggest(input.tool_name, input.tool_input, ctx.root, { symbol, cwd: input.cwd });
  const record = routingRecorder(ctx, input, s);
  if (!s) {
    record("allow");
    return withContext(undefined, hint);
  }
  if (s.annotateOnly) {
    record("annotate", "annotate-only");
    return withContext(annotate(s), hint);
  }

  if (mode === "enforce") {
    if (s.prefixPrompt) {
      const prompt = String(input.tool_input.prompt ?? "");
      if (prompt.startsWith(s.prefixPrompt)) return undefined;
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          updatedInput: {
            ...input.tool_input,
            prompt: s.prefixPrompt + (swarmWorker ? "" : await briefFor(ctx, prompt)) + prompt,
          },
        },
      };
    }
    // Denying only makes sense if there is an em_* server to retry with. If none is
    // running for this project (failed to start, not yet connected, dev checkout
    // without the plugin loaded), fall back to annotating so Claude is never stranded.
    if (!serverAlive(ctx)) {
      hookLog(
        "info",
        `enforce → annotate for ${input.tool_name}: no eminiar MCP server running for ${ctx.root}`,
      );
      record("annotate", "no-server");
      return withContext(
        annotate(
          s,
          " eminiar MCP server is not running, so this call is allowed; /em-doctor explains.",
        ),
        hint,
      );
    }
    record("deny");
    hookLog("info", `deny ${input.tool_name} → ${s.tool} [${s.rule ?? "?"}]: ${callHead(input)}`);
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `eminiar: ${s.reason}. Retry with ${s.tool}.${hint ? ` ${hint}` : ""}`,
      },
    };
  }
  // Annotate mode: subagents get the project brief as context since their prompt is untouched.
  record("annotate", "mode");
  const extra =
    s.prefixPrompt && !swarmWorker
      ? joinHints((await briefFor(ctx, String(input.tool_input.prompt ?? ""))).trim(), hint)
      : hint;
  return withContext(annotate(s), extra);
}

/** Native tools routing may redirect; their every call is counted, denied or not. */
const ROUTED_TOOLS = new Set(["Bash", "Read", "Grep", "WebFetch", "WebSearch"]);

/** The command, path, pattern or URL of a native call, shortened for a log line. */
function callHead(input: HookInput): string {
  const t = input.tool_input ?? {};
  const v = t.command ?? t.file_path ?? t.pattern ?? t.url ?? t.query ?? "";
  return headOf(String(v), 120);
}

/**
 * A recorder for this call's routing decision: one `routing` event per native call, so
 * em_stats can show how often Bash / Read / Grep are intercepted and by which rule. Never
 * throws; a call that cannot be recorded is still routed.
 */
function routingRecorder(
  ctx: ProjectContext,
  input: HookInput,
  s: Suggestion | undefined,
): (decision: RoutingEvent["decision"], why?: string) => void {
  const tool = input.tool_name ?? "";
  const sessionId = input.session_id;
  if (!sessionId || !ROUTED_TOOLS.has(tool)) return () => {};
  return (decision, why) => {
    try {
      recordRouting(getStorage(ctx, { vectors: false }), sessionId, {
        tool,
        decision,
        target: s?.tool,
        rule: s?.rule,
        why,
        head: callHead(input),
      });
    } catch {
      // statistics are optional
    }
  };
}

/**
 * The project brief for a subagent prompt, plus the memories and doc pages matching its
 * task: a subagent starts cold and never sees the parent's SessionStart or prompt recall.
 */
async function briefFor(ctx: ProjectContext, task: string): Promise<string> {
  const parts: string[] = [];
  try {
    const db = getStorage(ctx, { vectors: false });
    const brief = renderProjectBrief(ctx, db, 1200);
    if (brief)
      parts.push(
        `Project brief (eminiar):\n${brief}\nVerify structure with em_symbols / em_graph_impact before reading files; check em_index_status before claiming something is unused.`,
      );
    const { recall } = ctx.config;
    if (recall.onAgent && task) {
      const r = await recallForText(db, task, {
        maxMemories: recall.maxMemories,
        maxDocs: recall.maxDocs,
        path: "agent",
      });
      if (r.text) parts.push(r.text);
    }
  } catch {
    // the brief is optional
  }
  return parts.length ? `${parts.join("\n\n")}\n\n` : "";
}

function annotate(s: Suggestion, note = ""): HookOutput {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext: `eminiar: ${s.reason} (${s.tool}).${note}`.slice(0, 400),
    },
  };
}
