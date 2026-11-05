// Build guard for the single-file dist/server.js and dist/cli.js (see tsup.config.ts).
// Fails when either file loads a sibling chunk (an in-place `eminiar upgrade` would delete it
// under a running server or `eminiar ui`), when zod is wrapped in a lazy __esm initialiser
// while bundled code loads it eagerly (the "Class2 is not a constructor" start-up crash), or
// when the server has any lazy wrapper at all: everything it reaches imports internal modules
// statically, so a wrapper means a dynamic import() of an internal module crept back in.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** tsup's ESM shim is the one wrapper every module calls eagerly; it imports nothing. */
const ALLOWED_WRAPPERS = new Set(["init_esm_shims"]);
const SHIM_PATH = /(?:^|\/)tsup\/assets\/esm_shims\.js$/;
const ZOD = /node_modules\/zod\//;
const SDK = /node_modules\/@modelcontextprotocol\/sdk\//;
const ID = "[\\w$]+";
const esc = (s) => s.replace(/\$/g, "\\$");

/**
 * The names of esbuild's lazy-wrapper helpers in a bundle. Unminified they are `__esm` and
 * `__commonJS`; with minified identifiers they are recognised by the shape of their definition:
 *   __esm      = (fn, res) => function __init() { return fn && (res = (0, fn[…])(fn = 0)), res; }
 *   __commonJS = (cb, mod) => function __require() { return mod || (0, cb[…])((mod = { exports: {} }).exports, mod), mod.exports; }
 * or the arrow forms `(o,t)=>()=>(o&&(t=o(o=0)),t)` and `(o,t)=>()=>(t||o((t={exports:{}}).exports,t),t.exports)`.
 * @param {string} text
 * @returns {{ esm: Set<string>, cjs: Set<string> }}
 */
export function wrapperHelpers(text) {
  const esm = new Set(["__esm"]);
  const cjs = new Set(["__commonJS"]);
  const def = new RegExp(
    `(?:\\bvar|\\blet|\\bconst|,)\\s*(${ID})\\s*=\\s*\\(\\s*(${ID})\\s*,\\s*(${ID})\\s*\\)\\s*=>\\s*` +
      `(?:function\\s*(?:${ID})?\\s*\\(\\s*\\)\\s*\\{\\s*return\\b|\\(\\s*\\)\\s*=>)`,
    "g",
  );
  for (const m of text.matchAll(def)) {
    const [, name, a, b] = m;
    const body = text.slice(m.index + m[0].length, m.index + m[0].length + 240);
    if (
      new RegExp(`^\\s*\\(?\\s*${esc(a)}\\s*&&\\s*\\(\\s*${esc(b)}\\s*=`).test(
        body,
      ) &&
      new RegExp(`\\(\\s*${esc(a)}\\s*=\\s*0\\s*\\)`).test(body)
    )
      esm.add(name);
    else if (
      new RegExp(`^\\s*\\(?\\s*${esc(b)}\\s*\\|\\|`).test(body) &&
      /exports\s*:\s*\{\s*\}/.test(body)
    )
      cjs.add(name);
  }
  return { esm, cjs };
}

/**
 * Every esbuild lazy wrapper in a bundle: each `<binding> = __esm(` / `__commonJS(` call site,
 * under whatever name the helper has, with the module path read from the first key of its
 * argument. The shapes esbuild emits:
 *   var init_x = __esm({ "src/x.ts"() { … } })             a module
 *   var init_x = __esm({ async "src/x.ts"() { … } })       a module with top-level await
 *   var a, init_x = __esm({ … })                            --minify-syntax merges the vars
 *   var require_x = __commonJS({ "node_modules/x/i.js"(exports, module) { … } })
 *   n=c(()=>{ … }) / n=c(async()=>{ … })                   full minify: no path survives
 * @param {string} text
 * @returns {{ kind: "esm" | "cjs", init: string, path: string | null }[]}
 */
export function findWrappers(text) {
  const { esm, cjs } = wrapperHelpers(text);
  const helpers = [...esm, ...cjs].map(esc).join("|");
  const call = new RegExp(
    `(?<![\\w$.])(${ID})\\s*=\\s*(${helpers})\\s*\\(`,
    "g",
  );
  // { "path"() / { async "path"() — the module path as the first (only) method name
  const keyed =
    /^\s*\{\s*(?:async\s*)?(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')\s*\(/;
  // (…) => / async (…) => / function (…) — the minified forms, which carry no path
  const fn = /^\s*(?:async\s*)?(?:\([^)]*\)\s*=>|function\b)/;
  /** @type {{ kind: "esm" | "cjs", init: string, path: string | null }[]} */
  const out = [];
  for (const m of text.matchAll(call)) {
    const arg = text.slice(m.index + m[0].length, m.index + m[0].length + 1024);
    const k = keyed.exec(arg);
    if (!k && !fn.test(arg)) continue; // a plain call of a shadowed minified name
    out.push({
      kind: esm.has(m[2]) ? "esm" : "cjs",
      init: m[1],
      path: k ? (k[1] ?? k[2]) : null,
    });
  }
  return out;
}

/**
 * The init name of tsup's ESM shim under full --minify, where neither its name nor its path
 * survives, or null. It is recognised by its whole shape, which no internal module can have:
 * it is the wrapper right after the shim's own `path` / `url` imports, and its body is at most
 * `"use strict"` (tsconfig strict) plus the shim's setup, the only statements in it:
 *   import F from"path";import{fileURLToPath as L}from"url";var h=x(()=>{"use strict"});
 *   import F from"path";import{fileURLToPath as L}from"url";var P,R,i,m=x(()=>{P=()=>L(import.meta.url),R=()=>F.dirname(P()),i=R()});
 * An internal module's body always calls the shim's init (tsup injects the shim into every
 * file), so even one that holds nothing but "use strict" does not match. Only the first such
 * wrapper counts: a bundle has one shim.
 * @param {string} text
 * @param {Set<string>} esm the __esm helper names (see wrapperHelpers)
 * @returns {string | null}
 */
export function minifiedShim(text, esm) {
  const helpers = [...esm].map(esc).join("|");
  const q = `["'](?:node:)?`;
  const m = new RegExp(
    `\\bimport\\s+(${ID})\\s+from\\s*${q}path["']\\s*;?\\s*` +
      `import\\s*\\{\\s*fileURLToPath(?:\\s+as\\s+(${ID}))?\\s*\\}\\s*from\\s*${q}url["']\\s*;?\\s*` +
      `var\\s+(?:${ID}\\s*,\\s*)*(${ID})\\s*=\\s*(?:${helpers})\\s*\\(\\s*\\(\\s*\\)\\s*=>\\s*\\{([^{}]*)\\}\\s*\\)`,
  ).exec(text);
  if (!m) return null;
  const [, pathName, urlName = "fileURLToPath", init, body] = m;
  const p = esc(pathName);
  const u = esc(urlName);
  const stmts = body
    .replace(/^\s*(?:"use strict"|'use strict')\s*;?/, "")
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean);
  const defined = new Set();
  for (const s of stmts) {
    const a =
      new RegExp(
        `^(${ID})\\s*=\\s*\\(\\s*\\)\\s*=>\\s*${u}\\s*\\(\\s*import\\.meta\\.url\\s*\\)$`,
      ).exec(s) ??
      new RegExp(
        `^(${ID})\\s*=\\s*\\(\\s*\\)\\s*=>\\s*${p}\\.dirname\\s*\\(\\s*(${ID})\\s*\\(\\s*\\)\\s*\\)$`,
      ).exec(s) ??
      new RegExp(`^(${ID})\\s*=\\s*(${ID})\\s*\\(\\s*\\)$`).exec(s);
    // The setup only calls getters it defined itself, before the call.
    if (!a || (a[2] !== undefined && !defined.has(a[2]))) return null;
    defined.add(a[1]);
  }
  return init;
}

/** tsup's ESM shim: known by its init name or its path, or (minified) by minifiedShim. */
const isShim = (w, minShim) =>
  ALLOWED_WRAPPERS.has(w.init) ||
  (w.path !== null && SHIM_PATH.test(w.path)) ||
  (w.kind === "esm" && w.path === null && w.init === minShim);

/**
 * A lazy wrapper the server must not have: any __esm module but the shim, or a __commonJS
 * module outside node_modules. Bundled CommonJS packages are always __commonJS-wrapped.
 */
const isLazyInternal = (w, minShim) =>
  !isShim(w, minShim) &&
  (w.kind === "esm" || (w.path !== null && !w.path.includes("node_modules/")));

/**
 * The problems in one bundle's text; empty when it is fine.
 * @param {string} name file name for the messages
 * @param {string} text bundle source
 * @param {{ noLazy?: boolean }} [opts] noLazy: no lazy wrapper of internal code may exist (the server)
 * @returns {string[]}
 */
export function checkBundle(name, text, opts = {}) {
  const problems = [];

  const chunks = new Set();
  for (const m of text.matchAll(
    /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)["'](\.{1,2}\/[^"']+)["']/g,
  )) {
    chunks.add(m[1]);
  }
  if (chunks.size)
    problems.push(
      `${name} loads sibling file(s) ${[...chunks].slice(0, 5).join(", ")}: it must be one self-contained file (splitting: false), or an in-place upgrade deletes them under a running process`,
    );

  const all = findWrappers(text);
  const wrappers = all.filter((w) => w.kind === "esm");
  const minShim = minifiedShim(text, wrapperHelpers(text).esm);
  const lazy = all.filter((w) => isLazyInternal(w, minShim));

  const zodInits = new Set(
    wrappers
      .filter((w) => w.path !== null && ZOD.test(w.path))
      .map((w) => w.init),
  );
  if (zodInits.size) {
    // An unwrapped module that imports zod calls its init at the top level, unindented.
    const eager = [...text.matchAll(/^([\w$]+)\(\);$/gm)]
      .map((m) => m[1])
      .filter((i) => zodInits.has(i));
    // An unwrapped SDK module may reach zod through a re-export with no init call at all.
    const sdkWrapped = new Set(
      wrappers
        .filter((w) => w.path !== null && SDK.test(w.path))
        .map((w) => tail(w.path)),
    );
    const sdkEager = [...text.matchAll(/^\/\/ (\S+)$/gm)]
      .map((m) => m[1])
      .filter((p) => SDK.test(p) && !sdkWrapped.has(tail(p)));
    if (eager.length || sdkEager.length)
      problems.push(
        `${name} wraps zod in a lazy __esm initialiser but loads it eagerly too (${[...new Set(eager)].concat(sdkEager.slice(0, 2).map(tail)).join(", ")}): the MCP SDK's top-level z.custom() runs before zod initialises ("Class2 is not a constructor"). Replace the dynamic import() that reaches zod with a static import.`,
      );
  }

  if (opts.noLazy && lazy.length)
    problems.push(
      `${name} has ${lazy.length} lazily initialised module(s) (${lazy
        .slice(0, 6)
        .map((w) => (w.path === null ? w.init : tail(w.path)))
        .join(
          ", ",
        )}${lazy.length > 6 ? ", …" : ""}): something it reaches uses a dynamic import() or require() of an internal module. Import it statically; only external packages may be imported dynamically.`,
    );

  return problems;
}

/**
 * The hook build's lazy entries, as the chunk names esbuild gives them (hook-<name>-<hash>.js):
 * one per import() target listed in HOOK_LAZY in tsup.config.ts. A new lazy entry must be added
 * here too. Any other hook-*.js besides the shared hook-chunk-*.js is an import() nobody agreed to.
 */
export const HOOK_LAZY_CHUNKS = [
  "async",
  "commit",
  "compaction",
  "docs",
  "hooks",
  "memory",
  "recall",
  "run-job",
  "swarm",
];

/**
 * The problems in the hook build; empty when it is fine. dist/hook.js must load exactly one file
 * statically (the shared chunk, see oneSharedHookChunk in tsup.config.ts), and every other
 * dist/hook-*.js must be a known lazy entry.
 * @param {string} hookText dist/hook.js
 * @param {string[]} files file names in dist/
 * @returns {string[]}
 */
export function checkHookChunks(hookText, files) {
  const problems = [];
  const stat = new Set();
  for (const m of hookText.matchAll(
    /(?:\bfrom\s*|\bimport\s+)["'](\.\/[^"']+)["']/g,
  ))
    stat.add(m[1]);
  if (stat.size !== 1)
    problems.push(
      `dist/hook.js statically loads ${stat.size} file(s) (${[...stat].join(", ") || "none"}); it must load exactly one shared chunk, so every hook process reads two files`,
    );
  const known = new RegExp(
    `^hook-(?:chunk|${HOOK_LAZY_CHUNKS.join("|")})-[A-Za-z0-9_]+\\.js$`,
  );
  const stray = files.filter((f) => /^hook-.*\.js$/.test(f) && !known.test(f));
  if (stray.length)
    problems.push(
      `unexpected hook chunk(s) ${stray.join(", ")}: a new import() reached the hook build. Add it to HOOK_LAZY in tsup.config.ts and HOOK_LAZY_CHUNKS in scripts/check-bundle.mjs, or import it statically`,
    );
  return problems;
}

/** A module path from node_modules on, or from src on, for messages and comparison. */
function tail(p) {
  const i = p.lastIndexOf("node_modules/");
  if (i >= 0) return p.slice(i + "node_modules/".length);
  const s = p.lastIndexOf("src/");
  return s >= 0 ? p.slice(s) : p;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const dist = join(dirname(dirname(fileURLToPath(import.meta.url))), "dist");
  const problems = [
    ...checkBundle(
      "dist/server.js",
      readFileSync(join(dist, "server.js"), "utf8"),
      {
        noLazy: true,
      },
    ),
    ...checkBundle("dist/cli.js", readFileSync(join(dist, "cli.js"), "utf8")),
    ...checkHookChunks(
      readFileSync(join(dist, "hook.js"), "utf8"),
      readdirSync(dist),
    ),
  ];
  if (problems.length) {
    for (const p of problems) console.error(`check-bundle: ${p}`);
    process.exit(1);
  }
  console.log(
    "check-bundle: dist/server.js and dist/cli.js are self-contained; zod loads safely; hook.js loads one shared chunk",
  );
}
