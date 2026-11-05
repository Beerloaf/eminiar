import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import fg from "fast-glob";
import type { ProjectContext } from "../context.js";
import {
  type CatalogEntry,
  type CatalogKind,
  catalogLookup,
  mergedCatalog,
  type Tier,
} from "./catalog.js";
import { readManifest, slugify } from "./manifest.js";

export interface LocalCandidate {
  /** Suggested source name. */
  name: string;
  /** Project-relative path to register (a file, or a directory with `glob`). */
  path: string;
  glob?: string[] | undefined;
  recursive?: boolean | undefined;
  files: number;
  bytes: number;
  why: string;
  /** Sub-project directory (empty for the root project). */
  project: string;
  registered: boolean;
}

export type Confidence = "catalog" | "registry" | "probe" | "unknown";

export interface ProviderCandidate {
  name: string;
  /** `npm:zod`, `pypi:fastapi`, `go:<module>`, `env:SUMSUB`, `image:mongo`, `files:terraform`, `api:<host>`. */
  provider: string;
  title: string;
  urls: string[];
  crawl?: { depth?: number | undefined; maxPages?: number | undefined } | undefined;
  /**
   * catalog = URLs known offline; registry = a package registry resolves them; probe = an API
   * host whose documentation site is guessed and verified at add time; unknown = needs a URL.
   */
  confidence: Confidence;
  /** For catalogue providers: service | infra | library (see CatalogEntry.tier). Non-catalogue API and doc-link candidates count as service. */
  tier?: Tier | undefined;
  usedBy: string[];
  evidence: string[];
  tags?: string[] | undefined;
  registered: boolean;
  /**
   * True when every manifest line that named this package takes it from a git, URL or path source
   * rather than the public registry. The docs triage never sends such names.
   */
  nonRegistry?: boolean | undefined;
  /**
   * True only when the project's own files show every mention of this package comes from the
   * default public registry (lockfile `resolved`/`source` entries pointing at registry.npmjs.org,
   * registry.yarnpkg.com or pypi.org; a Go module on a vendor-run host with no replace or go.work).
   * Absent means unverified, and the docs triage then sends the name only if it is in the catalogue.
   */
  publicVerified?: boolean | undefined;
  /**
   * Set only by the opt-in docs triage (src/decisions/features/docs.ts) when it is live: how much
   * a coding agent benefits from this package's documentation, 0..1, and whether the triage
   * recommends indexing it. Absent otherwise, so discovery is unchanged.
   */
  docsScore?: number | undefined;
  recommended?: boolean | undefined;
}

export interface Discovery {
  root: string;
  projects: string[];
  local: LocalCandidate[];
  providers: ProviderCandidate[];
}

export interface DiscoverOptions {
  includeDev?: boolean | undefined;
  subprojects?: boolean | undefined;
  maxProjects?: number | undefined;
}

const IGNORE = [
  "**/node_modules/**",
  "**/.git/**",
  "**/dist/**",
  "**/build/**",
  "**/coverage/**",
  "**/vendor/**",
  "**/.venv/**",
  "**/venv/**",
  "**/site-packages/**",
  "**/.next/**",
  "**/.nuxt/**",
  "**/target/**",
];

/** Env var first tokens that name a concern, not a provider. */
const GENERIC_ENV = new Set([
  "NODE",
  "PORT",
  "HOST",
  "HOSTNAME",
  "LOG",
  "LOGLEVEL",
  "ENV",
  "ENVIRONMENT",
  "APP",
  "API",
  "DEBUG",
  "SECRET",
  "SECRETS",
  "SESSION",
  "CORS",
  "MAX",
  "MIN",
  "ENABLE",
  "ENABLED",
  "DISABLE",
  "FEATURE",
  "FEATURES",
  "DEFAULT",
  "PUBLIC",
  "PRIVATE",
  "INTERNAL",
  "BASE",
  "URL",
  "URI",
  "TIMEOUT",
  "RATE",
  "CACHE",
  "DB",
  "DATABASE",
  "ADMIN",
  "USER",
  "USERS",
  "EMAIL",
  "SMTP",
  "SERVICE",
  "SERVICES",
  "SERVICEDIR",
  "TRACING",
  "METRICS",
  "CRON",
  "QUEUE",
  "WORKER",
  "WORKERS",
  "TEST",
  "CI",
  "HTTP",
  "HTTPS",
  "PATH",
  "HOME",
  "TZ",
  "LOCALE",
  "REGION",
  "VERSION",
  "BUILD",
  "DEPLOY",
  "DEPLOYMENT",
  "WEBHOOK",
  "CALLBACK",
  "RETRY",
  "BATCH",
  "LIMIT",
  "ALLOWED",
  "ALLOW",
  "DENY",
  "KEY",
  "TOKEN",
  "OTP",
  "SMS",
  "PUSH",
  "NOTIFICATION",
  "NOTIFICATIONS",
  "COMPANY",
  "TENANT",
  "TENANTS",
  "DATA",
  "FILE",
  "FILES",
  "UPLOAD",
  "STORAGE",
  "VITE",
  "NEXT",
  "REACT",
  "NUXT",
  "LOCAL",
  "REMOTE",
  "SERVER",
  "CLIENT",
  "FRONTEND",
  "BACKEND",
  "WEB",
  "MOBILE",
  "STAGING",
  "PRODUCTION",
  "PROD",
  "DEV",
  "DEVELOPMENT",
  "SIGNING",
  "ENCRYPTION",
  "HASH",
  "SALT",
  "COOKIE",
  "CSRF",
  "AUTH",
  "OAUTH",
  "SSO",
  "LANG",
  "LANGUAGE",
  "CURRENCY",
  "COUNTRY",
  "FEE",
  "FEES",
  "PRICE",
  "AMOUNT",
  "ID",
  "NAME",
  "TITLE",
  "DOMAIN",
  "ORIGIN",
  "ORIGINS",
  "SUPPORT",
  "CONTACT",
  "SEED",
  "MIGRATION",
  "MIGRATIONS",
  "SCHEDULER",
  "SCHEDULE",
  "INTERVAL",
  "POLL",
  "HEARTBEAT",
  "HEALTH",
  "READY",
  "LIVENESS",
  "READINESS",
  "GRACEFUL",
  "SHUTDOWN",
]);

const SKIP_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".svg", ".pdf", ".zip", ".ico"]);

function readText(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

function readJson(file: string): Record<string, unknown> | undefined {
  const t = readText(file);
  if (!t) return undefined;
  try {
    return JSON.parse(t) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function sizeOf(files: string[]): number {
  let n = 0;
  for (const f of files) {
    try {
      n += statSync(f).size;
    } catch {
      // vanished
    }
  }
  return n;
}

/** Dot-directories that hold documentation worth indexing; every other hidden directory is skipped. */
const VISIBLE_DOT_DIRS = new Set([".github", ".claude", ".cursor", ".gitlab", ".circleci"]);

function hiddenPath(cwd: string, file: string): boolean {
  const parts = relative(cwd, file).split("/");
  return parts.slice(0, -1).some((p, i) => {
    if (!p.startsWith(".")) return false;
    // .claude holds agents and skills worth indexing, but also Claude Code's worktree checkouts
    if (p === ".claude") return !["agents", "skills", "commands"].includes(parts[i + 1] ?? "");
    return !VISIBLE_DOT_DIRS.has(p);
  });
}

function glob(cwd: string, patterns: string[], deep = 6): string[] {
  try {
    return fg
      .sync(patterns, {
        cwd,
        absolute: true,
        onlyFiles: true,
        deep,
        dot: true,
        ignore: IGNORE,
        caseSensitiveMatch: false,
      })
      .filter((f) => !hiddenPath(cwd, f));
  } catch {
    return [];
  }
}

/** Root plus, when asked, one level of sub-projects (a multi-repo workspace or a monorepo). */
function findProjects(root: string, opts: DiscoverOptions): string[] {
  const out = [root];
  if (opts.subprojects === false) return out;
  const markers = ["package.json", "pyproject.toml", "go.mod", "requirements.txt", "Cargo.toml"];
  const found = new Set<string>();
  for (const m of markers) {
    for (const f of glob(root, [`*/${m}`, `*/*/${m}`], 3)) {
      const dir = join(f, "..");
      const rel = relative(root, dir);
      if (!rel || rel.split("/").some((p) => p.startsWith(".") || p === "node_modules")) continue;
      found.add(dir);
    }
  }
  const max = opts.maxProjects ?? 40;
  // git worktrees and copies of the same package carry the same name: scan the first only
  const seenNames = new Set<string>();
  const nameOf = (dir: string) => {
    const pkg = readJson(join(dir, "package.json"));
    return typeof pkg?.name === "string" ? pkg.name : undefined;
  };
  const rootName = nameOf(root);
  if (rootName) seenNames.add(rootName);
  for (const d of [...found].sort()) {
    if (out.length >= max + 1) break;
    // skip nested projects whose parent is already listed (packages inside a workspace repo)
    if (out.some((p) => p !== root && d.startsWith(`${p}/`))) continue;
    const name = nameOf(d);
    if (name) {
      if (seenNames.has(name)) continue;
      seenNames.add(name);
    }
    out.push(d);
  }
  return out;
}

interface Signal {
  kind: CatalogKind;
  key: string;
  project: string;
  /** The manifest takes this dependency from a git, URL or path source, not the registry. */
  nonRegistry?: boolean;
  /** The project's own files show this dependency comes from the default public registry. */
  publicVerified?: boolean;
}

/** Hosts that mean the default public registry for npm and PyPI. */
const PUBLIC_NPM_REGISTRY = /^https:\/\/(registry\.npmjs\.org|registry\.yarnpkg\.com)\//;
const PUBLIC_PYPI_HOSTS = new Set(["pypi.org", "files.pythonhosted.org"]);

/** Go module hosts run by a vendor, whose modules are public by convention. github.com is not one. */
const PUBLIC_GO_HOSTS =
  /^(golang\.org|google\.golang\.org|gopkg\.in|go\.uber\.org|k8s\.io|sigs\.k8s\.io|cloud\.google\.com|go\.opentelemetry\.io)\//;

function urlHost(u: string): string | undefined {
  try {
    return new URL(u.trim()).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

/** Directories whose lockfiles and registry config apply to `dir`: the project, then the root. */
function scopeDirs(dir: string, root: string): string[] {
  return dir === root ? [root] : [dir, root];
}

/** Does an .npmrc in scope point the default registry somewhere other than the public one? */
function npmRegistryOverridden(dirs: string[]): boolean {
  for (const d of dirs) {
    const rc = readText(join(d, ".npmrc"));
    if (!rc) continue;
    for (const m of rc.matchAll(/^\s*registry\s*=\s*(\S+)/gm)) {
      if (!PUBLIC_NPM_REGISTRY.test(m[1]!.replace(/\/?$/, "/"))) return true;
    }
  }
  return false;
}

/** Top-level npm package names a lockfile in scope resolves from the public registry. */
function npmVerifiedNames(dirs: string[]): Set<string> {
  const ok = new Set<string>();
  if (npmRegistryOverridden(dirs)) return ok;
  for (const d of dirs) {
    const lock = readJson(join(d, "package-lock.json"));
    const pk = lock?.packages as Record<string, { resolved?: unknown }> | undefined;
    if (pk && typeof pk === "object") {
      for (const [k, v] of Object.entries(pk)) {
        const m = /^node_modules\/([^/]+)$/.exec(k);
        if (m && typeof v?.resolved === "string" && PUBLIC_NPM_REGISTRY.test(v.resolved))
          ok.add(m[1]!);
      }
    }
    const yarn = readText(join(d, "yarn.lock"));
    if (yarn) {
      for (const block of yarn.split(/\n\s*\n/)) {
        const head = /^"?([^@\s"][^@"]*)@/m.exec(block.trim())?.[1];
        const res = /^\s*resolved\s+"?([^"\s]+)/m.exec(block)?.[1];
        if (head && res && PUBLIC_NPM_REGISTRY.test(res)) ok.add(head);
      }
    }
  }
  return ok;
}

/** Names of the repo's own packages (workspace members, sub-projects): never public registry names. */
function localPackageNames(root: string, projects: string[]): Set<string> {
  const names = new Set<string>();
  const dirs = new Set(projects);
  const rootPkg = readJson(join(root, "package.json"));
  const ws = rootPkg?.workspaces;
  const patterns: string[] = [];
  if (Array.isArray(ws)) patterns.push(...ws.filter((x): x is string => typeof x === "string"));
  else if (ws && typeof ws === "object" && Array.isArray((ws as { packages?: unknown }).packages))
    patterns.push(
      ...((ws as { packages: unknown[] }).packages.filter(
        (x) => typeof x === "string",
      ) as string[]),
    );
  const pnpm = readText(join(root, "pnpm-workspace.yaml"));
  if (pnpm) for (const m of pnpm.matchAll(/^\s*-\s*["']?([^"'\s#]+)/gm)) patterns.push(m[1]!);
  for (const pat of patterns) {
    if (pat.startsWith("!")) continue;
    try {
      for (const d of fg.sync(`${pat.replace(/\/$/, "")}/package.json`, {
        cwd: root,
        ignore: ["**/node_modules/**"],
        deep: 4,
      }))
        dirs.add(join(root, d, ".."));
    } catch {
      // an unreadable pattern adds nothing
    }
  }
  for (const d of dirs) {
    const n = readJson(join(d, "package.json"))?.name;
    if (typeof n === "string") names.add(n);
  }
  return names;
}

function pipIndexLinesPrivate(text: string): boolean {
  for (const m of text.matchAll(
    /^\s*(?:--)?(?:extra[-_]index[-_]url|index[-_]url|find[-_]links|-i|-f)\b[\s=:]+(\S+)/gim,
  )) {
    const h = urlHost(m[1]!);
    if (!h || !PUBLIC_PYPI_HOSTS.has(h)) return true;
  }
  return false;
}

/** Is a non-default Python package index declared anywhere in scope? Then no name is verified. */
function pythonIndexPrivate(dirs: string[]): boolean {
  for (const d of dirs) {
    const py = readText(join(d, "pyproject.toml"));
    if (
      py &&
      (/^\s*\[\[?tool\.(uv\.index|poetry\.source|pdm\.source)\]\]?/m.test(py) ||
        /^\s*(extra-)?index-url\s*=/m.test(py) ||
        /^\s*find-links\s*=/m.test(py))
    )
      return true;
    for (const f of ["pip.conf", "pip.ini", "uv.toml", "setup.cfg", "requirements.txt"]) {
      const t = readText(join(d, f));
      if (t && pipIndexLinesPrivate(t)) return true;
    }
    for (const f of ["requirements-dev.txt", "requirements.in", "constraints.txt"]) {
      const t = readText(join(d, f));
      if (t && pipIndexLinesPrivate(t)) return true;
    }
  }
  return false;
}

/** Python package names a lockfile in scope records as coming from pypi.org. */
function pythonVerifiedNames(dirs: string[]): Set<string> {
  const ok = new Set<string>();
  if (pythonIndexPrivate(dirs)) return ok;
  for (const d of dirs) {
    const uv = readText(join(d, "uv.lock"));
    if (uv) {
      for (const block of uv.split(/^\[\[package\]\]/m).slice(1)) {
        const name = /^name\s*=\s*"([^"]+)"/m.exec(block)?.[1];
        const reg = /^source\s*=\s*\{\s*registry\s*=\s*"([^"]+)"/m.exec(block)?.[1];
        const h = reg ? urlHost(reg) : undefined;
        if (name && h && PUBLIC_PYPI_HOSTS.has(h)) ok.add(name.toLowerCase());
      }
    }
    const pf = readJson(join(d, "Pipfile.lock"));
    const sources = pf?._meta as { sources?: { url?: string; name?: string }[] } | undefined;
    const onlyPypi =
      Array.isArray(sources?.sources) &&
      sources.sources.length > 0 &&
      sources.sources.every((s) => {
        const h = typeof s.url === "string" ? urlHost(s.url) : undefined;
        return !!h && PUBLIC_PYPI_HOSTS.has(h);
      });
    if (pf && onlyPypi) {
      for (const sec of ["default", "develop"]) {
        const m = pf[sec] as Record<string, { index?: string; version?: string }> | undefined;
        if (!m || typeof m !== "object") continue;
        for (const [n, v] of Object.entries(m)) if (v?.index === "pypi") ok.add(n.toLowerCase());
      }
    }
  }
  return ok;
}

function npmSignals(
  dir: string,
  includeDev: boolean,
  project: string,
  root: string,
  localNames: Set<string>,
): Signal[] {
  const pkg = readJson(join(dir, "package.json"));
  if (!pkg) return [];
  const verified = npmVerifiedNames(scopeDirs(dir, root));
  const sections = ["dependencies", ...(includeDev ? ["devDependencies"] : [])];
  const out: Signal[] = [];
  for (const s of sections) {
    const deps = pkg[s];
    if (!deps || typeof deps !== "object") continue;
    for (const [name, ver] of Object.entries(deps as Record<string, string>)) {
      if (name.startsWith("@types/")) continue;
      if (typeof ver === "string" && /^(workspace:|file:|link:)/.test(ver)) continue;
      const other =
        typeof ver === "string" &&
        /^(git|https?:|github:|gitlab:|bitbucket:|[\w.-]+\/[\w.-]+$)/.test(ver);
      const own = localNames.has(name);
      out.push({
        kind: "npm",
        key: name,
        project,
        ...(other || own ? { nonRegistry: true } : {}),
        ...(!other && !own && verified.has(name) ? { publicVerified: true } : {}),
      });
    }
  }
  return out;
}

function pythonSignals(dir: string, project: string, root: string): Signal[] {
  const out: Signal[] = [];
  const dirs = scopeDirs(dir, root);
  const verified = pythonVerifiedNames(dirs);
  const privateIndex = pythonIndexPrivate(dirs);
  const editable = (spec: string) => /@|:\/\/|^\s*-e\b|\bfile:|\.\.?\//.test(spec);
  const py = readText(join(dir, "pyproject.toml"));
  if (py) {
    const block = /dependencies\s*=\s*\[([\s\S]*?)\]/.exec(py)?.[1] ?? "";
    for (const m of block.matchAll(/["']([A-Za-z0-9_.-]+)([^"']*)/g)) {
      const key = m[1]!.toLowerCase();
      const non = privateIndex || editable(m[2] ?? "");
      out.push({
        kind: "pypi",
        key,
        project,
        ...(non ? { nonRegistry: true } : {}),
        ...(!non && verified.has(key) ? { publicVerified: true } : {}),
      });
    }
  }
  const req = readText(join(dir, "requirements.txt"));
  if (req) {
    // a private index may serve any name in the file: none of them counts as public
    for (const line of req.split("\n")) {
      const name = /^\s*([A-Za-z0-9_.-]+)/.exec(line)?.[1];
      if (name && !line.trim().startsWith("#") && !line.trim().startsWith("-")) {
        const key = name.toLowerCase();
        const non = privateIndex || editable(line);
        out.push({
          kind: "pypi",
          key,
          project,
          ...(non ? { nonRegistry: true } : {}),
          ...(!non && verified.has(key) ? { publicVerified: true } : {}),
        });
      }
    }
  }
  return out;
}

function goSignals(dir: string, project: string, root: string): Signal[] {
  const mod = readText(join(dir, "go.mod"));
  if (!mod) return [];
  const out: Signal[] = [];
  // a go.work or any replace directive may point modules at local or private sources
  const workspace = scopeDirs(dir, root).some((d) => existsSync(join(d, "go.work")));
  const replaced = mod.includes("=>");
  const push = (key: string) => {
    const ok = !workspace && !replaced && PUBLIC_GO_HOSTS.test(key);
    out.push({
      kind: "go",
      key,
      project,
      ...(workspace || replaced ? { nonRegistry: true } : {}),
      ...(ok ? { publicVerified: true } : {}),
    });
  };
  const block = /require\s*\(([\s\S]*?)\)/g;
  for (const m of mod.matchAll(block))
    for (const line of m[1]!.split("\n")) {
      const path = /^\s*([^\s/]+\/[^\s]+)\s+v/.exec(line)?.[1];
      if (path && !/\/\/\s*indirect/.test(line)) push(path);
    }
  for (const m of mod.matchAll(/^require\s+([^\s(]+)\s+v/gm)) push(m[1]!);
  return out;
}

function imageSignals(dir: string, project: string): Signal[] {
  const out: Signal[] = [];
  for (const f of glob(
    dir,
    ["docker-compose*.yml", "docker-compose*.yaml", "compose*.yml", "compose*.yaml"],
    1,
  )) {
    const t = readText(f) ?? "";
    for (const m of t.matchAll(/^\s*image:\s*["']?([^"'\s#]+)/gm)) {
      const img = m[1]!;
      if (img.includes("${")) continue;
      out.push({ kind: "image", key: img, project });
    }
  }
  return out;
}

interface EnvScan {
  signals: Signal[];
  /** Unknown first tokens with the vars that carried them. */
  unknownPrefixes: Map<string, string[]>;
}

function envSignals(dir: string, project: string, catalog: CatalogEntry[]): EnvScan {
  const signals: Signal[] = [];
  const unknownPrefixes = new Map<string, string[]>();
  for (const f of glob(dir, [".env.example", ".env.sample", ".env.template", ".env.dist"], 1)) {
    const t = readText(f) ?? "";
    for (const m of t.matchAll(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]+)\s*=/gm)) {
      const name = m[1]!;
      if (catalogLookup("env", name, catalog)) {
        signals.push({ kind: "env", key: name, project });
        continue;
      }
      const token = name.split("_")[0]!;
      if (token.length < 3 || GENERIC_ENV.has(token)) continue;
      const list = unknownPrefixes.get(token) ?? [];
      if (!list.includes(name)) list.push(name);
      unknownPrefixes.set(token, list);
    }
  }
  return { signals, unknownPrefixes };
}

const CODE_GLOBS = [
  "**/*.{ts,tsx,js,jsx,mjs,cjs,py,go,rb,php,java,kt,cs,rs,swift,dart,ex,exs}",
  ".env.example",
  ".env.sample",
  ".env.template",
];

/** Hosts that show up in code but are not APIs the project talks to. */
const NOT_API_HOSTS = [
  "localhost",
  "example.com",
  "example.org",
  "example.net",
  "w3.org",
  "schema.org",
  "json-schema.org",
  "purl.org",
  "xmlns.com",
  "github.com",
  "githubusercontent.com",
  "gist.github.com",
  "npmjs.com",
  "npmjs.org",
  "yarnpkg.com",
  "pypi.org",
  "unpkg.com",
  "jsdelivr.net",
  "cdnjs.cloudflare.com",
  "fonts.googleapis.com",
  "fonts.gstatic.com",
  "googletagmanager.com",
  "google-analytics.com",
  "youtube.com",
  "youtu.be",
  "twitter.com",
  "x.com",
  "www.facebook.com",
  "facebook.com",
  "linkedin.com",
  "instagram.com",
  "medium.com",
  "stackoverflow.com",
  "wikipedia.org",
  "mozilla.org",
  "nodejs.org",
  "typescriptlang.org",
  "vitejs.dev",
  "vuejs.org",
  "react.dev",
  "reactjs.org",
  "apple.com",
  "play.google.com",
  "chrome.google.com",
  "microsoft.com",
  "opensource.org",
  "creativecommons.org",
  "gnu.org",
  "apache.org",
  "swagger.io",
  "openapis.org",
  "jwt.io",
  "ietf.org",
  "rfc-editor.org",
  "iana.org",
  "semver.org",
  "keepachangelog.com",
  "conventionalcommits.org",
  "shields.io",
  "badge.fury.io",
  "sonarcloud.io",
  "codecov.io",
  "ngrok.io",
  "ngrok-free.app",
  "connect.facebook.net",
  "hotjar.com",
  "segment.com",
  "segment.io",
  "intercom.io",
  "clarity.ms",
  "doubleclick.net",
  "googlesyndication.com",
  "gstatic.com",
  "sentry-cdn.com",
  "polyfill.io",
  "cloudfront.net",
];
const NOT_API_SUFFIX = [
  ".local",
  ".test",
  ".invalid",
  ".example",
  ".internal",
  ".localhost",
  ".svc",
  ".cluster.local",
];
const TWO_LEVEL_TLDS = new Set([
  "co.uk",
  "co.za",
  "com.au",
  "com.br",
  "co.jp",
  "co.in",
  "co.nz",
  "org.uk",
  "net.au",
  "ac.uk",
  "gov.uk",
  "co.ke",
  "com.ng",
  "com.mx",
  "com.ar",
  "co.id",
  "com.sg",
  "com.hk",
  "com.tr",
]);
const URL_RE =
  /https?:\/\/((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,})(?::\d+)?(\/[^\s'"`<>)\]},;]*)?/gi;
const CALL_RE =
  /\b(fetch|axios|got|ky|superagent|undici|request|http\.(?:get|post|request)|https\.(?:get|post|request)|requests\.(?:get|post|put|patch|delete|request)|httpx|urllib|aiohttp|HttpClient|RestTemplate|WebClient|http\.NewRequest|baseURL|baseUrl|base_url|BASE_URL|_URL\b|_URI\b|_ENDPOINT\b|endpoint|apiUrl|API_URL|graphql|webhook)\b/i;
const API_PATH_RE = /^\/(api|v\d+|graphql|oauth2?|rest|rpc|webhooks?|sandbox|services?)\b/i;
const API_HOST_RE =
  /^(api|apis|sandbox|gateway|graph|hooks|rest|ws|sdk|auth|accounts|login|oauth|connect|payments?|checkout|test-api|api-sandbox|staging-api)[.-]/i;

/** `api.eu.sumsub.com` → `sumsub.com`; respects common two-level public suffixes. */
export function rootDomain(host: string): string {
  const parts = host.toLowerCase().split(".");
  if (parts.length <= 2) return host.toLowerCase();
  const last2 = parts.slice(-2).join(".");
  return TWO_LEVEL_TLDS.has(last2) ? parts.slice(-3).join(".") : last2;
}

function isApiHostCandidate(host: string): boolean {
  const h = host.toLowerCase();
  if (NOT_API_SUFFIX.some((s) => h.endsWith(s))) return false;
  return !NOT_API_HOSTS.some((n) => h === n || h.endsWith(`.${n}`));
}

interface ApiHit {
  host: string;
  calls: number;
  mentions: number;
  samples: string[];
  /** OpenAPI / Swagger / Postman documents referenced by URL — the best possible seed. */
  specUrls: string[];
  project: string;
}

/** A documentation page linked from code (`https://docs.vendor.io/...`): a seed, not a call. */
interface DocLink {
  host: string;
  urls: string[];
  samples: string[];
  project: string;
}

const SPEC_URL_RE =
  /(openapi|swagger|api-docs|postman_collection|asyncapi)[^/]*\.(json|ya?ml)$|\/(openapi|swagger)\.json$|\/v[23]\/api-docs/i;
const TEST_PATH_RE =
  /(^|\/)(__tests__|__mocks__|__fixtures__|tests?|specs?|fixtures?|mocks?|e2e|cypress|stories)\/|\.(test|spec|stories)\.[cm]?[jt]sx?$|_test\.go$|test_[^/]*\.py$|_test\.py$/i;
const DOC_HOST_RE =
  /^(docs?|developer|developers|devdocs|apidocs|api-docs|help|support|learn|guide|guides|manual|wiki)\./i;
const DOC_HOST_SUFFIX =
  /\.(readthedocs\.io|gitbook\.io|github\.io|gitlab\.io|netlify\.app|vercel\.app|mintlify\.app|readme\.io|redoc\.ly|stoplight\.io)$/i;
const DOC_PATH_RE =
  /^\/(docs?|documentation|developers?|guides?|learn|reference|manual|wiki|help|en|latest|stable|v\d+(\.\d+)*\/docs)(\/|$)/i;
const COMMENT_RE = /^\s*(\/\/|#|\*|\/\*|<!--|--|;|'''|""")/;
/** Example text shown in an input (`placeholder="https://..."`) is not a link the code follows. */
const PLACEHOLDER_RE = /\bplaceholder\b/i;
/**
 * A source file naming this many distinct external hosts is a reference table (a docs
 * catalogue, a link list, a CSP allow-list), not code that integrates with each of them.
 */
const REFERENCE_TABLE_HOSTS = 15;

function isDocLink(host: string, path: string): boolean {
  return (
    DOC_HOST_RE.test(host) ||
    DOC_HOST_SUFFIX.test(host) ||
    (DOC_PATH_RE.test(path) && !API_HOST_RE.test(host))
  );
}

/**
 * Outbound HTTP calls in source: every URL literal whose line looks like a request, whose
 * path looks like an API, or whose host is named like one. Test and fixture files are
 * skipped, comment lines and documentation-looking URLs only count as mentions, and the
 * documentation links are collected separately as seeds for the knowledge base.
 */
function apiSignals(
  dir: string,
  project: string,
): { hits: Map<string, ApiHit>; docLinks: Map<string, DocLink> } {
  const hits = new Map<string, ApiHit>();
  const docLinks = new Map<string, DocLink>();
  const files = glob(dir, CODE_GLOBS, 8)
    .filter((f) => !/\.min\.(js|mjs|cjs)$/.test(f))
    .filter((f) => !TEST_PATH_RE.test(relative(dir, f)))
    .slice(0, 4000);
  for (const file of files) {
    let size = 0;
    try {
      size = statSync(file).size;
    } catch {
      continue;
    }
    if (size > 400 * 1024) continue;
    const text = readText(file);
    if (!text || text.includes("\u0000")) continue;
    const rel = relative(dir, file).split("\\").join("/");
    const isEnv = basename(file).startsWith(".env");
    const lines = text.split("\n");
    const found: { host: string; path: string; line: string; i: number }[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (!line.includes("http") || PLACEHOLDER_RE.test(line)) continue;
      for (const m of line.matchAll(URL_RE)) {
        const host = m[1]!.toLowerCase();
        if (isApiHostCandidate(host)) found.push({ host, path: m[2] ?? "/", line, i });
      }
    }
    if (new Set(found.map((f) => f.host)).size >= REFERENCE_TABLE_HOSTS) continue;
    for (const { host, path, line, i } of found) {
      const comment = COMMENT_RE.test(line);
      const spec = SPEC_URL_RE.test(path);
      if (!spec && isDocLink(host, path)) {
        if (comment && !isEnv) continue;
        const link = docLinks.get(host) ?? { host, urls: [], samples: [], project };
        const full = `https://${host}${path.replace(/[#?].*$/, "")}`;
        if (!link.urls.includes(full) && link.urls.length < 3) link.urls.push(full);
        if (link.samples.length < 3) link.samples.push(`${rel}:${i + 1}`);
        docLinks.set(host, link);
        continue;
      }
      const callLike =
        !comment &&
        (spec || isEnv || CALL_RE.test(line) || API_PATH_RE.test(path) || API_HOST_RE.test(host));
      const cur = hits.get(host) ?? {
        host,
        calls: 0,
        mentions: 0,
        samples: [],
        specUrls: [],
        project,
      };
      if (callLike) cur.calls++;
      else cur.mentions++;
      if (callLike && cur.samples.length < 3) cur.samples.push(`${rel}:${i + 1}`);
      if (spec) {
        const full = `https://${host}${path}`;
        if (!cur.specUrls.includes(full) && cur.specUrls.length < 4) cur.specUrls.push(full);
      }
      hits.set(host, cur);
    }
  }
  return { hits, docLinks };
}

/** `docs.momentco.io` → `momentco`, `zapper.gitbook.io` → `zapper`, `api.foo.co.za` → `foo`. */
export function providerSlug(host: string): string {
  const h = host.toLowerCase();
  if (DOC_HOST_SUFFIX.test(h)) return slugify(h.split(".")[0]!);
  const root = rootDomain(h);
  return slugify(root.replace(/\.[a-z.]+$/, ""));
}

function fileSignals(dir: string, project: string): Signal[] {
  const out: Signal[] = [];
  const has = (patterns: string[], deep = 4) => glob(dir, patterns, deep).length > 0;
  if (has(["**/*.tf"])) out.push({ kind: "files", key: "terraform", project });
  if (has(["Dockerfile", "Dockerfile.*", "**/Dockerfile"], 2))
    out.push({ kind: "files", key: "docker", project });
  if (has([".github/workflows/*.yml", ".github/workflows/*.yaml"], 3))
    out.push({ kind: "files", key: "github-actions", project });
  if (has(["**/Chart.yaml"])) out.push({ kind: "files", key: "helm", project });
  const yamls = glob(
    dir,
    [
      "k8s/**/*.y?(a)ml",
      "kubernetes/**/*.y?(a)ml",
      "manifests/**/*.y?(a)ml",
      "deploy/**/*.y?(a)ml",
      "deployment/**/*.y?(a)ml",
      "infra/**/*.y?(a)ml",
    ],
    5,
  ).slice(0, 40);
  let k8s = false;
  let istio = false;
  let karpenter = false;
  for (const y of yamls) {
    const t = readText(y) ?? "";
    if (/^apiVersion:/m.test(t)) k8s = true;
    if (/networking\.istio\.io|security\.istio\.io/.test(t)) istio = true;
    if (/karpenter\.sh/.test(t)) karpenter = true;
  }
  if (k8s) out.push({ kind: "files", key: "kubernetes", project });
  if (istio) out.push({ kind: "files", key: "istio", project });
  if (karpenter) out.push({ kind: "files", key: "karpenter", project });
  return out;
}

type Registered = (c: Pick<LocalCandidate, "name" | "path" | "glob">) => boolean;

function localCandidates(
  root: string,
  dir: string,
  project: string,
  isRegistered: Registered,
): LocalCandidate[] {
  const out: LocalCandidate[] = [];
  const prefix = project ? `${slugify(basename(dir))}-` : "";
  const rel = (abs: string) => relative(root, abs).split("\\").join("/");
  const push = (c: Omit<LocalCandidate, "project" | "registered">) => {
    if (!c.files) return;
    out.push({ ...c, project, registered: isRegistered(c) });
  };

  const guides = glob(
    dir,
    [
      "README.md",
      "readme.md",
      "ARCHITECTURE.md",
      "CONTRIBUTING.md",
      "CHANGELOG.md",
      "AGENTS.md",
      "CLAUDE.md",
      "SECURITY.md",
    ],
    1,
  );
  if (guides.length)
    push({
      name: `${prefix}readme`,
      path: rel(dir) || ".",
      glob: guides.map((g) => basename(g)),
      recursive: false,
      files: guides.length,
      bytes: sizeOf(guides),
      why: "project readme and top-level guides",
    });

  for (const d of ["docs", "doc", "documentation"]) {
    const abs = join(dir, d);
    if (!existsSync(abs)) continue;
    const files = glob(abs, ["**/*.md", "**/*.mdx", "**/*.rst", "**/*.txt"]).filter(
      (f) => !SKIP_EXT.has(f.slice(f.lastIndexOf("."))),
    );
    push({
      name: `${prefix}docs`,
      path: rel(abs),
      glob: ["**/*.md", "**/*.mdx", "**/*.rst", "**/*.txt"],
      files: files.length,
      bytes: sizeOf(files),
      why: `${d}/ directory`,
    });
    break;
  }

  for (const d of [
    "adr",
    "adrs",
    "docs/adr",
    "docs/adrs",
    "doc/adr",
    "docs/decisions",
    "decisions",
  ]) {
    const abs = join(dir, d);
    if (!existsSync(abs)) continue;
    if (out.some((c) => c.path && rel(abs).startsWith(`${c.path}/`))) break; // already inside docs/
    const files = glob(abs, ["**/*.md"]);
    push({
      name: `${prefix}adr`,
      path: rel(abs),
      glob: ["**/*.md"],
      files: files.length,
      bytes: sizeOf(files),
      why: "architecture decision records",
    });
    break;
  }

  const agent = glob(
    dir,
    [
      ".github/copilot-instructions.md",
      ".github/instructions/**/*.md",
      ".github/agents/*.md",
      ".github/skills/**/*.md",
      ".claude/agents/*.md",
      ".claude/skills/**/*.md",
      ".cursor/rules/**/*.md?(c)",
    ],
    4,
  );
  if (agent.length)
    push({
      name: `${prefix}agent-instructions`,
      path: rel(dir) || ".",
      glob: [
        ".github/copilot-instructions.md",
        ".github/instructions/**/*.md",
        ".github/agents/*.md",
        ".github/skills/**/*.md",
        ".claude/agents/*.md",
        ".claude/skills/**/*.md",
        ".cursor/rules/**/*.md?(c)",
      ],
      files: agent.length,
      bytes: sizeOf(agent),
      why: "Copilot / Claude / Cursor instructions",
    });

  const api = glob(
    dir,
    [
      "**/openapi*.{yaml,yml,json}",
      "**/swagger*.{yaml,yml,json}",
      "**/*.postman_collection.json",
      "**/asyncapi*.{yaml,yml,json}",
      "**/*.graphql",
      "**/*.proto",
    ],
    4,
  );
  if (api.length)
    push({
      name: `${prefix}api-specs`,
      path: rel(dir) || ".",
      glob: api.map((f) => relative(dir, f).split("\\").join("/")),
      files: api.length,
      bytes: sizeOf(api),
      why: "OpenAPI / Postman / GraphQL / protobuf specs",
    });

  const env = glob(dir, [".env.example", ".env.sample", ".env.template", ".env.dist"], 1);
  if (env.length)
    push({
      name: `${prefix}env-example`,
      path: rel(dir) || ".",
      glob: env.map((f) => basename(f)),
      recursive: false,
      files: env.length,
      bytes: sizeOf(env),
      why: "environment variable reference",
    });

  const infra = glob(
    dir,
    [
      "**/*.tf",
      "**/*.tfvars.example",
      "k8s/**/*.y?(a)ml",
      "manifests/**/*.y?(a)ml",
      "helm/**/*.y?(a)ml",
      "charts/**/*.y?(a)ml",
      "docker-compose*.y?(a)ml",
      "compose*.y?(a)ml",
      ".github/workflows/*.y?(a)ml",
    ],
    5,
  );
  if (infra.length)
    push({
      name: `${prefix}deploy-config`,
      path: rel(dir) || ".",
      glob: [
        "**/*.tf",
        "**/*.tfvars.example",
        "k8s/**/*.y?(a)ml",
        "manifests/**/*.y?(a)ml",
        "helm/**/*.y?(a)ml",
        "charts/**/*.y?(a)ml",
        "docker-compose*.y?(a)ml",
        "compose*.y?(a)ml",
        ".github/workflows/*.y?(a)ml",
      ],
      files: infra.length,
      bytes: sizeOf(infra),
      why: "Terraform, Kubernetes, Helm, Compose and CI workflow files",
    });
  return out;
}

/**
 * Scan the project (and its immediate sub-projects) for documentation worth indexing:
 * local docs, specs and instructions, plus the third-party libraries, services and
 * infrastructure it depends on, matched to their documentation through the catalogue.
 * Offline; nothing is fetched. Already-registered sources are flagged, not repeated.
 */
export function discoverDocs(ctx: ProjectContext, opts: DiscoverOptions = {}): Discovery {
  const root = ctx.root;
  const catalog = mergedCatalog(ctx.config.docs.catalog as CatalogEntry[]);
  const manifest = readManifest(ctx);
  const registeredProviders = new Set(
    manifest.sources.map((s) => s.provider).filter(Boolean) as string[],
  );
  const registeredNames = new Set(manifest.sources.map((s) => s.name));
  // a local candidate is registered by name, or by the same path with the same globs
  const sameGlobs = (a: string[] | undefined, b: string[] | undefined) =>
    [...(a ?? [])].sort().join("\n") === [...(b ?? [])].sort().join("\n");
  const isRegistered: Registered = (c) =>
    registeredNames.has(c.name) ||
    manifest.sources.some(
      (s) => s.kind === "path" && s.path === c.path && sameGlobs(s.glob, c.glob),
    );
  const projects = findProjects(root, opts);
  const includeDev = opts.includeDev ?? ctx.config.docs.discover.includeDev;
  // external APIs are indexed in full; libraries and infrastructure keep the catalogue's small crawl
  const full = ctx.config.docs.crawl.api;
  const crawlFor = (e: CatalogEntry) => (e.tier === "service" ? full : e.crawl);

  const localNames = localPackageNames(root, projects);
  const local: LocalCandidate[] = [];
  const signals: Signal[] = [];
  const unknownEnv = new Map<string, { vars: string[]; projects: Set<string> }>();
  const apiHits = new Map<string, ApiHit[]>();
  const docLinks = new Map<string, DocLink[]>();
  for (const dir of projects) {
    const project = dir === root ? "" : relative(root, dir).split("\\").join("/");
    // a sub-project's code is scanned once, as part of itself, not again under the root
    const own = dir === root && projects.length > 1 ? undefined : dir;
    local.push(...localCandidates(root, dir, project, isRegistered));
    signals.push(...npmSignals(dir, includeDev, project, root, localNames));
    signals.push(...pythonSignals(dir, project, root));
    signals.push(...goSignals(dir, project, root));
    signals.push(...imageSignals(dir, project));
    signals.push(...fileSignals(dir, project));
    const api = apiSignals(own ?? dir, project);
    const inSubproject = (samples: string[]) =>
      own === undefined &&
      projects.some(
        (p) => p !== root && samples.some((s) => s.startsWith(`${relative(root, p)}/`)),
      );
    for (const hit of api.hits.values()) {
      if (inSubproject(hit.samples)) continue;
      const list = apiHits.get(hit.host) ?? [];
      list.push(hit);
      apiHits.set(hit.host, list);
    }
    for (const link of api.docLinks.values()) {
      if (inSubproject(link.samples)) continue;
      const list = docLinks.get(link.host) ?? [];
      list.push(link);
      docLinks.set(link.host, list);
    }
    const env = envSignals(dir, project, catalog);
    signals.push(...env.signals);
    for (const [token, vars] of env.unknownPrefixes) {
      const cur = unknownEnv.get(token) ?? { vars: [], projects: new Set<string>() };
      for (const v of vars) if (!cur.vars.includes(v)) cur.vars.push(v);
      cur.projects.add(project || ".");
      unknownEnv.set(token, cur);
    }
  }

  const byName = new Map<string, ProviderCandidate>();
  const add = (
    c: Omit<ProviderCandidate, "usedBy" | "evidence" | "registered"> & {
      usedBy: string;
      evidence: string;
      nonRegistry?: boolean | undefined;
      publicVerified?: boolean | undefined;
    },
  ) => {
    const cur = byName.get(c.name);
    if (cur) {
      if (!c.nonRegistry) delete cur.nonRegistry;
      if (!c.publicVerified) delete cur.publicVerified;
      if (!cur.usedBy.includes(c.usedBy)) cur.usedBy.push(c.usedBy);
      if (!cur.evidence.includes(c.evidence)) cur.evidence.push(c.evidence);
      return;
    }
    byName.set(c.name, {
      name: c.name,
      provider: c.provider,
      title: c.title,
      urls: c.urls,
      crawl: c.crawl,
      confidence: c.confidence,
      tier: c.tier,
      tags: c.tags,
      usedBy: [c.usedBy],
      evidence: [c.evidence],
      registered: registeredNames.has(c.name) || registeredProviders.has(c.provider),
      ...(c.nonRegistry ? { nonRegistry: true } : {}),
      ...(c.publicVerified ? { publicVerified: true } : {}),
    });
  };

  for (const s of signals) {
    const project = s.project || ".";
    const entry = catalogLookup(s.kind, s.key, catalog);
    const evidence = `${s.kind}:${s.key}`;
    if (entry) {
      add({
        name: entry.id,
        provider: `${s.kind}:${s.key}`,
        title: entry.title,
        urls: entry.urls,
        crawl: crawlFor(entry),
        confidence: "catalog",
        tier: entry.tier ?? "library",
        tags: entry.tags,
        usedBy: project,
        evidence,
      });
      // a catalogue hit is registered if any of its evidence providers is
      const c = byName.get(entry.id)!;
      if (!c.registered && registeredProviders.has(`${s.kind}:${s.key}`)) c.registered = true;
      continue;
    }
    if (s.kind === "npm" || s.kind === "pypi" || s.kind === "go") {
      add({
        name: slugify(s.key.replace(/^github\.com\//, "")),
        provider: `${s.kind}:${s.key}`,
        title: s.key,
        urls: [],
        confidence: "registry",
        usedBy: project,
        evidence,
        ...(s.nonRegistry ? { nonRegistry: true } : {}),
        ...(s.publicVerified ? { publicVerified: true } : {}),
      });
    } else if (s.kind === "image" && !s.key.includes(".") && !s.key.includes("/")) {
      // official-looking image we do not know; the project's own images carry a registry host
      add({
        name: slugify(s.key.split(":")[0]!),
        provider: `image:${s.key.split(":")[0]}`,
        title: s.key.split(":")[0]!,
        urls: [],
        confidence: "unknown",
        usedBy: project,
        evidence,
      });
    }
  }
  for (const [token, info] of unknownEnv) {
    if (info.vars.length < 2) continue;
    const provider = `env:${token}`;
    for (const p of info.projects)
      add({
        name: slugify(token),
        provider,
        title: token,
        urls: [],
        confidence: "unknown",
        usedBy: p,
        evidence: `${info.vars.slice(0, 4).join(", ")}${info.vars.length > 4 ? ", …" : ""}`,
      });
  }

  // Third-party APIs called from code: catalogue hosts join their provider; unknown hosts are
  // grouped by root domain and resolved by probing the usual documentation locations at add time.
  for (const [host, list] of apiHits) {
    const calls = list.reduce((n, h) => n + h.calls, 0);
    if (!calls) continue;
    const entry = catalogLookup("api", host, catalog);
    const specUrls = [...new Set(list.flatMap((h) => h.specUrls))];
    for (const h of list) {
      if (!h.calls) continue; // a mention-only project is not a user of the API
      const evidence = `api:${host} (${h.samples.slice(0, 2).join(", ")})${specUrls.length ? ` · spec ${specUrls[0]}` : ""}`;
      if (entry) {
        add({
          name: entry.id,
          provider: `api:${host}`,
          title: entry.title,
          urls: [...entry.urls, ...specUrls],
          crawl: full,
          confidence: "catalog",
          tier: entry.tier ?? "library",
          tags: entry.tags,
          usedBy: h.project || ".",
          evidence,
        });
        const c = byName.get(entry.id)!;
        for (const u of specUrls) if (!c.urls.includes(u)) c.urls.push(u);
      } else {
        const domain = rootDomain(host);
        // a referenced spec document is a complete seed; without one the docs site is probed at add time
        add({
          name: slugify(domain.replace(/\.[a-z.]+$/, "")),
          provider: `api:${host}`,
          title: `${domain} API`,
          urls: specUrls,
          crawl: { depth: specUrls.length ? 0 : full.depth, maxPages: full.maxPages },
          confidence: specUrls.length ? "catalog" : "probe",
          usedBy: h.project || ".",
          evidence,
        });
      }
    }
  }

  // Documentation pages linked from code: a catalogue host joins its provider; anything else
  // becomes a ready seed (URLs known). A link on an API's root domain upgrades that API's
  // probe candidate so nothing needs guessing.
  for (const [host, list] of docLinks) {
    const urls = [...new Set(list.flatMap((l) => l.urls))].slice(0, 3);
    const entry = catalogLookup("api", host, catalog);
    for (const l of list) {
      const evidence = `link:${host} (${l.samples.slice(0, 2).join(", ")})`;
      if (entry) {
        add({
          name: entry.id,
          provider: `link:${host}`,
          title: entry.title,
          urls: entry.urls,
          crawl: full,
          confidence: "catalog",
          tier: entry.tier ?? "library",
          tags: entry.tags,
          usedBy: l.project || ".",
          evidence,
        });
        continue;
      }
      const name = providerSlug(host);
      const existing = byName.get(name);
      if (existing && existing.confidence === "probe") {
        existing.urls = urls;
        existing.confidence = "catalog";
        existing.crawl = full;
        if (!existing.evidence.includes(evidence)) existing.evidence.push(evidence);
        if (!existing.usedBy.includes(l.project || ".")) existing.usedBy.push(l.project || ".");
        continue;
      }
      add({
        name,
        provider: `link:${host}`,
        title: `${host} (documentation linked from code)`,
        urls,
        crawl: full,
        confidence: "catalog",
        usedBy: l.project || ".",
        evidence,
      });
    }
  }

  for (const c of byName.values())
    c.tier ??=
      c.provider.startsWith("api:") || c.provider.startsWith("link:") ? "service" : "library";

  const order: Record<Confidence, number> = { catalog: 0, registry: 1, probe: 2, unknown: 3 };
  const providers = [...byName.values()].sort(
    (a, b) =>
      order[a.confidence] - order[b.confidence] ||
      b.usedBy.length - a.usedBy.length ||
      a.name.localeCompare(b.name),
  );
  return {
    root,
    projects: projects.map((p) => (p === root ? "." : relative(root, p))),
    local,
    providers,
  };
}
