import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { defineConfig, type Options } from "tsup";

// Native and heavy deps stay external so they resolve from node_modules at runtime
// (better-sqlite3 has a .node binary; transformers/tree-sitter are large and optional).
const shared: Options = {
  format: ["esm"],
  target: "node22",
  platform: "node",
  outDir: "dist",
  sourcemap: true,
  dts: false,
  shims: true,
  // Bundled CommonJS packages (fast-glob) call require() for Node builtins; give the
  // ESM output a real `require` so esbuild's shim does not throw at load time.
  banner: {
    js: 'import { createRequire as __emCreateRequire } from "node:module"; const require = __emCreateRequire(import.meta.url);',
  },
  // tsup externalises every package.json dependency by default, so zod, the MCP SDK
  // and fast-glob were resolved file by file from node_modules at start-up (~500
  // module loads, two thirds of the server's boot time). Bundling the pure-JS ones
  // leaves a handful of files to read; turndown stays external and is required lazily.
  noExternal: ["zod", "@modelcontextprotocol/sdk", "fast-glob", "ignore"],
  external: [
    "better-sqlite3",
    "sqlite-vec",
    "@huggingface/transformers",
    "onnxruntime-node",
    "web-tree-sitter",
    "tsx",
  ],
};

/** Everything the hook build writes: dist/hook.js(.map) and its dist/hook-*.js(.map) chunks. */
const HOOK_OUTPUT = ["hook.js", "hook.js.map", "hook-*"];

const SRC = resolve("src") + sep;
/** The modules src/hook.ts imports statically: everything a hook process loads up front. */
const HOOK_STATIC = ["src/hooks/dispatch.ts", "src/hooks/log.ts"].map((p) => resolve(p));
/**
 * What an adjudicator-on hook process loads on top of that: the adjudicator's hook handlers and
 * everything they reach statically (engine, config, redaction, providers, breaker). Importing them
 * from every lazy entry puts them in one more shared chunk instead of five, so an adjudicator-on
 * prompt or Bash hook loads hook.js + the shared hook chunks + that chunk (4 files, not 7).
 */
const HOOK_ADJUDICATOR = ["src/adjudicator/hooks.ts", "src/adjudicator/async.ts"].map((p) =>
  resolve(p),
);
/** The hook build's lazy entries: every internal module reached through import(). */
const HOOK_LAZY =
  /[\\/]src[\\/](adjudicator[\\/](hooks|async)|decisions[\\/](hooks|run-job|features[\\/][a-z-]+))\.ts$/;

/**
 * esbuild splits a module into its own chunk for every distinct set of entries (hook.js plus each
 * import() target) that reaches it. The lazy adjudicator and decision-feature entries each reach
 * a different slice of what hook.js loads statically, so hook.js ended up loading ten files
 * instead of three, and each file costs the hook process a read, a parse and a link (F7: about
 * +0.9 ms p50 over the pre-branch hook with everything off). In this build only, every lazy entry
 * also imports what hook.ts imports. They run inside a hook process that has loaded those modules
 * already, so nothing changes at run time, but every statically loaded module is now reached by
 * the same set of entries and lands in one shared chunk: hook.js loads two files. The server and
 * CLI builds are untouched (dist/server.js must not gain hook code, see check-bundle.mjs).
 * onEnd fails the build when an import() target is not covered by HOOK_LAZY.
 */
function oneSharedHookChunk(): NonNullable<Options["esbuildPlugins"]>[number] {
  return {
    name: "one-shared-hook-chunk",
    setup(build) {
      const lazy = new Set<string>();
      build.onResolve({ filter: /^\.\.?\// }, (args) => {
        if (args.kind === "dynamic-import" && `${args.resolveDir}${sep}`.startsWith(SRC))
          lazy.add(resolve(args.resolveDir, args.path).replace(/\.js$/, ".ts"));
        return undefined;
      });
      build.onLoad({ filter: HOOK_LAZY }, (args) => {
        const src = readFileSync(args.path, "utf8");
        const hub = [...HOOK_STATIC, ...HOOK_ADJUDICATOR]
          .map((p) => `import ${JSON.stringify(p)};`)
          .join("\n");
        return {
          contents: `${src}\n${hub}\n`,
          loader: "ts",
          resolveDir: dirname(args.path),
        };
      });
      // esbuild and tsup ignore result.errors edits made in onEnd, so the guard has to throw.
      build.onEnd(() => {
        const missed = [...lazy].filter((p) => !HOOK_LAZY.test(p));
        if (missed.length)
          throw new Error(
            `one-shared-hook-chunk: import() of ${missed.join(", ")} is not in HOOK_LAZY (tsup.config.ts); add it so hook.js keeps loading one shared chunk`,
          );
      });
    },
  };
}

export default defineConfig([
  {
    ...shared,
    entry: { server: "src/server.ts", cli: "src/cli.ts" },
    // One self-contained file per entry, no chunks. The MCP server and `eminiar ui` /
    // `eminiar upgrade` are long-lived processes run from the stable copy that `eminiar
    // upgrade` reinstalls in place: a chunk they had not loaded yet would vanish under them
    // (ERR_MODULE_NOT_FOUND until /mcp reconnect). Without splitting esbuild turns each
    // dynamic import() of an internal module into a lazy __esm wrapper, and wrappers spread
    // to everything that module imports: once that reached zod while the MCP SDK imported zod
    // eagerly, the SDK's top-level z.custom() ran before zod initialised and dist/server.js
    // crashed at start ("Class2 is not a constructor"). So everything the server reaches
    // imports internal modules statically (dynamic import() only for external packages), and
    // scripts/check-bundle.mjs, run by `npm run build`, fails the build if dist/server.js has
    // a lazy wrapper, either file references a chunk, or zod is wrapped while something loads
    // it eagerly. The CLI keeps its per-command dynamic imports (lazy, so `eminiar --version`
    // does not initialise everything); there zod is wrapped but only ever initialised by
    // other wrapped modules, and the SDK is not bundled, which the guard also checks.
    splitting: false,
    // Cleans dist except the hook build's output, which runs in parallel and cleans its own.
    clean: HOOK_OUTPUT.map((p) => `!${p}`),
  },
  {
    ...shared,
    entry: { hook: "src/hook.ts" },
    // The hook runs once per tool call, so it is split: the adjudicator (off by default) is
    // reached only through dynamic import() and lands in its own chunks, loaded when it is
    // enabled. Without splitting esbuild inlines those imports and every hook process pays
    // to parse them (~3 ms p50). Chunks sit next to hook.js, not in a subfolder, so
    // import.meta.url-relative paths (src/version.ts pluginRoot) resolve the same.
    splitting: true,
    clean: false,
    esbuildOptions(options) {
      options.chunkNames = "hook-[name]-[hash]";
    },
    esbuildPlugins: [
      oneSharedHookChunk(),
      {
        name: "clean-hook-output",
        setup(build) {
          // Chunk names carry a content hash, so drop the previous build's before writing.
          build.onStart(() => {
            if (!existsSync("dist")) return;
            for (const f of readdirSync("dist")) {
              if (f === "hook.js" || f === "hook.js.map" || f.startsWith("hook-")) {
                rmSync(join("dist", f), { force: true });
              }
            }
          });
        },
      },
    ],
  },
]);
