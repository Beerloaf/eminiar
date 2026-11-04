import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error: a plain .mjs build script without type declarations
import { checkBundle } from "../../scripts/check-bundle.mjs";

const check = checkBundle as (name: string, text: string, opts?: { noLazy?: boolean }) => string[];
const dist = join(__dirname, "..", "..", "dist");

// The built server and CLI must survive `eminiar upgrade` reinstalling dist/ in place under
// them, and start without the lazy-zod crash (tsup.config.ts, scripts/check-bundle.mjs).
describe("built dist/server.js and dist/cli.js", () => {
  it("are self-contained single files with no lazy-zod hazard", () => {
    for (const f of ["server.js", "cli.js"])
      if (!existsSync(join(dist, f)))
        throw new Error(`dist/${f} is missing: run \`npm run build\` first`);
    expect(readdirSync(dist).filter((f) => /^app-.*\.js$/.test(f))).toEqual([]);
    expect(
      check("dist/server.js", readFileSync(join(dist, "server.js"), "utf8"), { noLazy: true }),
    ).toEqual([]);
    expect(check("dist/cli.js", readFileSync(join(dist, "cli.js"), "utf8"))).toEqual([]);
  });
});
