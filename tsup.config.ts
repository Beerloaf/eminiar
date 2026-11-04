import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
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

export default defineConfig([
  {
    ...shared,
    entry: { server: "src/server.ts", cli: "src/cli.ts" },
    // Split into app-* chunks. With splitting:false esbuild turns every dynamic import()
    // into a lazy __esm wrapper; once the lazily loaded graph (storage, memory, graph) reached
    // zod through the adjudicator, zod itself was wrapped and the MCP SDK's top-level
    // z.custom() ran before zod initialised: dist/server.js crashed at start with "Class2 is
    // not a constructor" (unit tests never load the bundle). Real chunks have no such
    // ordering hazard. Costs ~8 ms of server cold start (once per session) over the old
    // single file. Chunks sit in dist/ itself so import.meta.url paths (pluginRoot) hold.
    splitting: true,
    esbuildOptions(options) {
      options.chunkNames = "app-[name]-[hash]";
    },
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
