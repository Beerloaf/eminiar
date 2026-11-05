import { spawnSync } from "node:child_process";
import { appendFileSync, cpSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error: a plain .mjs build script without type declarations
import { checkHookChunks } from "../../scripts/check-bundle.mjs";

const check = checkHookChunks as (hook: string, files: string[]) => string[];
const root = join(__dirname, "..", "..");

describe("checkHookChunks", () => {
  const ok = 'import "./hook-chunk-ABC123.js";\nimport("./hook-async-DEF456.js");';
  it("accepts one shared chunk and known lazy entries", () => {
    expect(check(ok, ["hook.js", "hook-chunk-ABC123.js", "hook-async-DEF456.js"])).toEqual([]);
  });
  it("rejects an unknown lazy chunk", () => {
    expect(check(ok, ["hook-chunk-ABC123.js", "hook-terms-XYZ789.js"])[0]).toMatch(/hook-terms/);
  });
  it("rejects hook.js loading more than one file up front", () => {
    expect(check('import "./hook-chunk-A.js";\nimport "./hook-chunk-B.js";', [])[0]).toMatch(
      /2 file/,
    );
  });
});

// Scratch copy of the repo with a stray lazy import in src/hooks/dispatch.ts: the build must fail.
describe("a stray import() in the hook build", () => {
  it("fails the tsup build with the HOOK_LAZY message", () => {
    const dir = mkdtempSync(join(tmpdir(), "em-hook-chunks-"));
    try {
      for (const f of ["src", "package.json", "tsconfig.json", "tsup.config.ts"])
        cpSync(join(root, f), join(dir, f), { recursive: true });
      symlinkSync(join(root, "node_modules"), join(dir, "node_modules"));
      appendFileSync(join(dir, "src/hooks/dispatch.ts"), '\nvoid import("../storage/terms.js");\n');
      const r = spawnSync(join(root, "node_modules/.bin/tsup"), [], {
        cwd: dir,
        encoding: "utf8",
      });
      expect(r.status).not.toBe(0);
      expect(`${r.stdout}${r.stderr}`).toMatch(/not in HOOK_LAZY/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
