import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// @ts-expect-error: a plain .mjs build script without type declarations
import { checkBundle, findWrappers } from "../../scripts/check-bundle.mjs";

const check = checkBundle as (name: string, text: string, opts?: { noLazy?: boolean }) => string[];
type Wrapper = { kind: "esm" | "cjs"; init: string; path: string | null };
const wrappersOf = findWrappers as (text: string) => Wrapper[];

/** esbuild's shape for a lazily initialised module. */
const wrapper = (init: string, path: string, body = "") =>
  `// ${path}\nvar ${init} = __esm({\n  "${path}"() {\n    "use strict";\n    init_esm_shims();\n${body}  }\n});\n`;

const SHIMS = wrapper("init_esm_shims", "node_modules/tsup/assets/esm_shims.js");
const ZOD = wrapper("init_zod", "node_modules/zod/index.js");

describe("checkBundle", () => {
  it("accepts a self-contained file whose only wrapper is the ESM shim", () => {
    const text = `${SHIMS}import Database from "better-sqlite3";\ninit_esm_shims();\nconst x = 1;\n`;
    expect(check("server.js", text, { noLazy: true })).toEqual([]);
  });

  it("rejects static, dynamic and require loads of a sibling chunk", () => {
    for (const line of [
      'import { a } from "./app-chunk-ABC.js";',
      'import "./app-chunk-ABC.js";',
      'const m = await import("./app-indexer-XYZ.js");',
      'const m = require("../dist/app-x.js");',
    ]) {
      const p = check("server.js", `${SHIMS}${line}\n`);
      expect(p, line).toHaveLength(1);
      expect(p[0]).toMatch(/self-contained/);
    }
  });

  it("ignores package imports and an import of a runtime URL", () => {
    const text = `import fg from "fast-glob";\nconst tf = await import("@huggingface/transformers");\nconst m = await import(pathToFileURL(abs).href);\n`;
    expect(check("cli.js", text)).toEqual([]);
  });

  it("rejects zod wrapped lazily while an unwrapped module initialises it (the Class2 crash)", () => {
    const text = `${SHIMS}${ZOD}// node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js\ninit_zod();\nvar S = custom();\n`;
    const p = check("server.js", text);
    expect(p).toHaveLength(1);
    expect(p[0]).toMatch(/Class2 is not a constructor/);
  });

  it("rejects zod wrapped lazily while the SDK is bundled unwrapped (re-export, no init call)", () => {
    const text = `${SHIMS}${ZOD}// node_modules/@modelcontextprotocol/sdk/dist/esm/types.js\nvar AssertObjectSchema = custom();\n`;
    expect(check("server.js", text)[0]).toMatch(/@modelcontextprotocol\/sdk\/dist\/esm\/types\.js/);
  });

  it("accepts zod wrapped lazily when only wrapped modules initialise it (the CLI)", () => {
    const cmd = wrapper("init_em_graph", "src/tools/em_graph.ts", "    init_zod();\n");
    const text = `${SHIMS}${ZOD}${cmd}init_esm_shims();\nconst run = async () => { init_em_graph(); };\n`;
    expect(check("cli.js", text)).toEqual([]);
  });

  it("rejects any lazy wrapper in the server, naming the modules", () => {
    const text = `${SHIMS}${wrapper("init_indexer", "src/index/indexer.ts")}`;
    expect(check("cli.js", text)).toEqual([]);
    const p = check("server.js", text, { noLazy: true });
    expect(p).toHaveLength(1);
    expect(p[0]).toMatch(/1 lazily initialised module\(s\) \(src\/index\/indexer\.ts\)/);
  });
});

describe("checkBundle on real esbuild bundles", () => {
  let dir = "";
  // tsup injects this file (shims: true); bundling with it reproduces init_esm_shims.
  const shim = createRequire(import.meta.url).resolve("tsup/assets/esm_shims.js");

  const files: Record<string, string> = {
    "tla.ts":
      'import { readFile } from "node:fs/promises";\nexport const txt = await readFile(import.meta.filename, "utf8");\n',
    "plain.ts": "export const one = 1;\n",
    "node_modules/dep/package.json": '{ "name": "dep", "main": "index.cjs" }\n',
    "node_modules/dep/index.cjs": "module.exports = { dir: __dirname };\n",
    "dynamic-tla.ts": 'const m = await import("./tla.js");\nconsole.log(m.txt.length);\n',
    "dynamic-plain.ts": 'const m = await import("./plain.js");\nconsole.log(m.one);\n',
    "static.ts":
      'import { one } from "./plain.js";\nimport { readFileSync } from "node:fs";\nconsole.log(one, readFileSync);\n',
    "shim.ts": 'import dep from "dep";\nconsole.log(dep.dir);\n',
  };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "check-bundle-"));
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, rel)), { recursive: true });
      writeFileSync(join(dir, rel), text);
    }
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const bundle = async (
    entry: string,
    opts: { minify?: boolean; minifySyntax?: boolean; inject?: string[] } = {},
  ) => {
    const r = await build({
      entryPoints: [join(dir, entry)],
      absWorkingDir: dir,
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node20",
      splitting: false,
      write: false,
      logLevel: "silent",
      ...opts,
    });
    const out = r.outputFiles[0];
    if (!out) throw new Error(`esbuild wrote nothing for ${entry}`);
    return out.text;
  };

  it("rejects a dynamic import of a module with top-level await (async wrapper)", async () => {
    const text = await bundle("dynamic-tla.ts");
    expect(text).toMatch(/async "tla\.ts"\(\)/);
    const p = check("server.js", text, { noLazy: true });
    expect(p).toHaveLength(1);
    expect(p[0]).toMatch(/1 lazily initialised module\(s\) \(tla\.ts\)/);
  });

  it("rejects a dynamic import of a module without top-level await", async () => {
    const p = check("server.js", await bundle("dynamic-plain.ts"), { noLazy: true });
    expect(p).toHaveLength(1);
    expect(p[0]).toMatch(/1 lazily initialised module\(s\) \(plain\.ts\)/);
  });

  it("finds the wrappers under --minify-syntax (merged var) and full --minify (arrow form)", async () => {
    for (const opts of [{ minifySyntax: true }, { minify: true }]) {
      const text = await bundle("dynamic-tla.ts", opts);
      const w = wrappersOf(text);
      expect(
        w.filter((x) => x.kind === "esm"),
        JSON.stringify(opts),
      ).toHaveLength(1);
      expect(check("server.js", text, { noLazy: true }), JSON.stringify(opts)).toHaveLength(1);
    }
    expect(wrappersOf(await bundle("dynamic-plain.ts", { minify: true }))).toEqual([
      expect.objectContaining({ kind: "esm", path: null }),
    ]);
  });

  it("accepts a clean static bundle", async () => {
    const text = await bundle("static.ts");
    expect(wrappersOf(text)).toEqual([]);
    expect(check("server.js", text, { noLazy: true })).toEqual([]);
  });

  it("accepts the ESM shim alone, beside a bundled CommonJS package", async () => {
    const text = await bundle("shim.ts", { inject: [shim] });
    const w = wrappersOf(text);
    expect(w).toEqual([
      expect.objectContaining({ kind: "esm", init: "init_esm_shims" }),
      { kind: "cjs", init: "require_dep", path: "node_modules/dep/index.cjs" },
    ]);
    expect(check("server.js", text, { noLazy: true })).toEqual([]);
  });
});
