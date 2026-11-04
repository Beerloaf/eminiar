// Build guard for the single-file dist/server.js and dist/cli.js (see tsup.config.ts).
// Fails when either file loads a sibling chunk (an in-place `eminiar upgrade` would delete it
// under a running server or `eminiar ui`), when zod is wrapped in a lazy __esm initialiser
// while bundled code loads it eagerly (the "Class2 is not a constructor" start-up crash), or
// when the server has any lazy wrapper at all: everything it reaches imports internal modules
// statically, so a wrapper means a dynamic import() of an internal module crept back in.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** tsup's ESM shim is the one wrapper every module calls eagerly; it imports nothing. */
const ALLOWED_WRAPPERS = new Set(["init_esm_shims"]);
const ZOD = /node_modules\/zod\//;
const SDK = /node_modules\/@modelcontextprotocol\/sdk\//;

/**
 * The problems in one bundle's text; empty when it is fine.
 * @param {string} name file name for the messages
 * @param {string} text bundle source
 * @param {{ noLazy?: boolean }} [opts] noLazy: no lazy __esm wrapper may exist (the server)
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

  // var init_x = __esm({ "path/to/module.js"() { … } })
  const wrappers = [...text.matchAll(/\bvar (init_\w+) = __esm\(\{\s*"([^"]+)"\s*\(\)/g)].map(
    (m) => ({ init: m[1], path: m[2] }),
  );
  const lazy = wrappers.filter((w) => !ALLOWED_WRAPPERS.has(w.init));

  const zodInits = new Set(wrappers.filter((w) => ZOD.test(w.path)).map((w) => w.init));
  if (zodInits.size) {
    // An unwrapped module that imports zod calls its init at the top level, unindented.
    const eager = [...text.matchAll(/^(init_\w+)\(\);$/gm)]
      .map((m) => m[1])
      .filter((i) => zodInits.has(i));
    // An unwrapped SDK module may reach zod through a re-export with no init call at all.
    const sdkWrapped = new Set(wrappers.filter((w) => SDK.test(w.path)).map((w) => tail(w.path)));
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
        .map((w) => tail(w.path))
        .join(
          ", ",
        )}${lazy.length > 6 ? ", …" : ""}): something it reaches uses a dynamic import() of an internal module. Import it statically; only external packages may be imported dynamically.`,
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
    ...checkBundle("dist/server.js", readFileSync(join(dist, "server.js"), "utf8"), {
      noLazy: true,
    }),
    ...checkBundle("dist/cli.js", readFileSync(join(dist, "cli.js"), "utf8")),
  ];
  if (problems.length) {
    for (const p of problems) console.error(`check-bundle: ${p}`);
    process.exit(1);
  }
  console.log("check-bundle: dist/server.js and dist/cli.js are self-contained; zod loads safely");
}
