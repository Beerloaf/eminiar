import { describe, expect, it } from "vitest";
// @ts-expect-error: a plain .mjs build script without type declarations
import { checkBundle } from "../../scripts/check-bundle.mjs";

const check = checkBundle as (name: string, text: string, opts?: { noLazy?: boolean }) => string[];

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
