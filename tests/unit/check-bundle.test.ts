import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { build } from "esbuild";
import { build as tsupBuild } from "tsup";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// @ts-expect-error: a plain .mjs build script without type declarations
import * as guard from "../../scripts/check-bundle.mjs";

const { checkBundle, findWrappers, minifiedShim, wrapperHelpers } = guard;

const check = checkBundle as (name: string, text: string, opts?: { noLazy?: boolean }) => string[];
type Wrapper = { kind: "esm" | "cjs"; init: string; path: string | null };
const wrappersOf = findWrappers as (text: string) => Wrapper[];
const shimOf = (text: string) =>
  (minifiedShim as (t: string, esm: Set<string>) => string | null)(
    text,
    (wrapperHelpers as (t: string) => { esm: Set<string> })(text).esm,
  );

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

  // The minified shape of tsup's ESM shim, with the arrow-form __esm helper `x`.
  const MIN_HEAD =
    'var x=(o,e)=>()=>(o&&(e=o(o=0)),e);import F from"path";import{fileURLToPath as L}from"url";';

  it("accepts tsup's minified ESM shim, bare or with its __dirname / __filename setup", () => {
    for (const shim of [
      'var h=x(()=>{"use strict"});',
      "var h=x(()=>{});",
      "var P,R,i,h=x(()=>{P=()=>L(import.meta.url),R=()=>F.dirname(P()),i=R()});",
      'var P,R,i,n,h=x(()=>{"use strict";P=()=>L(import.meta.url),R=()=>F.dirname(P()),i=R(),n=P()});',
    ]) {
      const text = `${MIN_HEAD}${shim}h();console.log(1);`;
      expect(shimOf(text), shim).toBe("h");
      expect(check("server.js", text, { noLazy: true }), shim).toEqual([]);
    }
  });

  it("rejects a minified internal module that only looks like the shim", () => {
    for (const [body, culprit] of [
      // not right after the shim's imports, though its body is just "use strict"
      ['var h=x(()=>{"use strict"});var i=x(()=>{"use strict"});', "i"],
      // right after the imports, but it calls an init (internal modules call the shim's);
      // the real shim is then out of place too, so it fails as well
      ['var i=x(()=>{"use strict";h()});var h=x(()=>{});', "i, h"],
      // right after the imports, but its body does more than the shim's setup
      ['var l,i=x(()=>{"use strict";l=1});', "i"],
      ["var l,i=x(()=>{l=L(import.meta.url),g()});", "i"],
      ["var P,i=x(()=>{P=()=>F.dirname(Q())});", "i"],
      // an async wrapper is a module with top-level await, never the shim
      ['var i=x(async()=>{"use strict"});', "i"],
    ]) {
      const text = `${MIN_HEAD}${body}`;
      const p = check("server.js", text, { noLazy: true });
      expect(p, body).toHaveLength(1);
      expect(p[0], body).toMatch(new RegExp(`lazily initialised module\\(s\\) \\(${culprit}\\)`));
    }
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

describe("checkBundle on real tsup --minify builds (shims: true)", () => {
  let dir = "";
  const files: Record<string, string> = {
    "tsconfig.json": '{ "compilerOptions": { "strict": true, "target": "ES2022" } }\n',
    "loose.json": '{ "compilerOptions": { "target": "ES2022" } }\n',
    "plain.ts": "export const one = 1;\n",
    "strict.ts": '"use strict";\nexport const one = 1;\n',
    "node_modules/dep/package.json": '{ "name": "dep", "main": "index.cjs" }\n',
    "node_modules/dep/index.cjs": "module.exports = { dir: __dirname };\n",
    "node_modules/bare/package.json": '{ "name": "bare", "main": "index.cjs" }\n',
    "node_modules/bare/index.cjs": "module.exports = { two: 2 };\n",
    // no __dirname anywhere: the shim's setup is tree-shaken, as in dist/server.js
    "clean.ts":
      'import { one } from "./plain.js";\nimport bare from "bare";\nconsole.log(one, bare.two);\n',
    // the shim is only wrapped when a bundled CommonJS package needs it lazily
    "clean-dirname.ts":
      'import { one } from "./plain.js";\nimport dep from "dep";\nconsole.log(one, dep.dir, __dirname, __filename);\n',
    "dynamic-plain.ts": 'const m = await import("./plain.js");\nconsole.log(m.one);\n',
    "dynamic-strict.ts": 'const m = await import("./strict.js");\nconsole.log(m.one);\n',
  };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "check-bundle-tsup-"));
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, rel)), { recursive: true });
      writeFileSync(join(dir, rel), text);
    }
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  /** A tsup build as tsup.config.ts does it (one file, ESM, shims), but fully minified. */
  const tsup = async (entry: string, tsconfig = "tsconfig.json") => {
    const name = `${entry.replace(/\.ts$/, "")}-${tsconfig.replace(/\.json$/, "")}`;
    const outDir = join(dir, "out");
    await tsupBuild({
      entry: { [name]: join(dir, entry) },
      format: ["esm"],
      platform: "node",
      target: "node22",
      shims: true,
      splitting: false,
      minify: true,
      noExternal: ["dep", "bare"],
      outDir,
      tsconfig: join(dir, tsconfig),
      config: false,
      silent: true,
    });
    // .js or .mjs, depending on the package.json tsup finds from the working directory
    const out = readdirSync(outDir).find((f) => f === `${name}.js` || f === `${name}.mjs`);
    if (!out) throw new Error(`tsup wrote nothing for ${entry}`);
    return readFileSync(join(outDir, out), "utf8");
  };

  it("accepts a clean minified build whose only wrapper is the ESM shim", async () => {
    for (const [entry, tsconfig] of [
      ["clean.ts", "tsconfig.json"],
      ["clean.ts", "loose.json"],
      ["clean-dirname.ts", "tsconfig.json"],
      ["clean-dirname.ts", "loose.json"],
    ] as const) {
      const text = await tsup(entry, tsconfig);
      const label = `${entry} ${tsconfig}`;
      const esm = wrappersOf(text).filter((w) => w.kind === "esm");
      expect(esm, label).toHaveLength(1);
      expect(esm[0]?.path, label).toBeNull();
      expect(shimOf(text), label).toBe(esm[0]?.init);
      expect(check("server.js", text, { noLazy: true }), label).toEqual([]);
    }
    // the strict tsconfig gives the shape a real minified dist/server.js has
    expect(await tsup("clean.ts")).toMatch(/=[\w$]+\(\(\)=>\{"use strict"\}\)/);
  });

  it("still rejects a minified dynamic import of a tiny internal module", async () => {
    for (const entry of ["dynamic-plain.ts", "dynamic-strict.ts"]) {
      const text = await tsup(entry);
      const p = check("server.js", text, { noLazy: true });
      expect(p, entry).toHaveLength(1);
      expect(p[0], entry).toMatch(/1 lazily initialised module\(s\)/);
      const shim = shimOf(text);
      expect(shim, entry).not.toBeNull();
      expect(p[0], entry).not.toContain(`(${shim})`);
    }
  });
});
