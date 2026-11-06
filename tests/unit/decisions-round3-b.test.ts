import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error: a plain .mjs build script without type declarations
import { checkHookChunks } from "../../scripts/check-bundle.mjs";
import { getContext, resetContextCache } from "../../src/context.js";
import { consentLine } from "../../src/decisions/consent.js";
import { isPublicName, scorable } from "../../src/decisions/features/docs.js";
import { discoverDocs } from "../../src/docs/discover.js";
import { SqliteAdapter } from "../../src/storage/sqlite/adapter.js";

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "em-r3b-"));
  for (const [f, t] of Object.entries(files)) {
    mkdirSync(dirname(join(root, f)), { recursive: true });
    writeFileSync(join(root, f), t);
  }
  return root;
}

beforeEach(() => resetContextCache());

describe("#344 a team's docs.catalog entries are not well-known public names", () => {
  const pkg = JSON.stringify({
    name: "a",
    dependencies: { "acme-secret": "^1.0.0", zod: "^3.0.0" },
  });
  const sentFor = (config: unknown) => {
    const root = repo({
      "package.json": pkg,
      "eminiar.config.json": JSON.stringify(config),
    });
    resetContextCache();
    const d = discoverDocs(getContext(root));
    return { d, sent: scorable(d).map((p) => p.provider) };
  };

  it("a private dependency registered under docs.catalog is never scored", () => {
    const { d, sent } = sentFor({
      docs: {
        catalog: [
          {
            id: "acme-secret",
            title: "Acme",
            urls: ["https://docs.acme.internal"],
            npm: ["acme-secret"],
          },
        ],
      },
    });
    const p = d.providers.find((x) => x.provider === "npm:acme-secret");
    expect(p?.confidence).toBe("catalog");
    expect(p?.builtinCatalog).toBeUndefined();
    expect(p && isPublicName(p)).toBe(false);
    expect(sent).not.toContain("npm:acme-secret");
  });

  it("a wildcard team entry does not make every dependency public", () => {
    const { sent } = sentFor({
      docs: { catalog: [{ id: "all", title: "All", urls: ["https://x.internal"], npm: ["*"] }] },
    });
    expect(sent).not.toContain("npm:acme-secret");
  });

  it("a built-in catalogue package still counts, with or without team entries", () => {
    const { d } = sentFor({
      docs: {
        catalog: [
          { id: "acme-secret", title: "A", urls: ["https://a.internal"], npm: ["acme-secret"] },
        ],
      },
    });
    const z = d.providers.find((x) => x.provider === "npm:zod");
    expect(z?.builtinCatalog).toBe(true);
    expect(z && isPublicName(z)).toBe(true);
  });
});

describe("#349 the consent text names what the classes send", () => {
  const o = { origin: "https://x", maxChars: 1 };
  it("session lists errors, assistant replies, git commands and URL paths", () => {
    const t = consentLine("session", o);
    expect(t).toMatch(/errors and tool output/);
    expect(t).toMatch(/assistant's own replies/);
    expect(t).toMatch(/git commands including commit messages/);
    expect(t).toMatch(/URL paths and queries/);
  });
  it("swarm does not promise blackboard posts as sent data", () => {
    const t = consentLine("swarm", o);
    expect(t).toMatch(/blackboard posts are never sent/);
    expect(t).not.toMatch(/and redacted blackboard posts/);
  });
  it("packages names the bundled catalogue only", () => {
    expect(consentLine("packages", o)).toMatch(/bundled catalogue[^;]*docs\.catalog/);
  });
});

describe("#338 no dead helped/hurt surface", () => {
  it("the feature summary has no helped/hurt and the store has no feedback()", () => {
    const db = new SqliteAdapter(join(mkdtempSync(join(tmpdir(), "em-r3b-db-")), "e.db"), {
      vectors: false,
    });
    try {
      const s = db.decisions.summary().recall;
      expect("helped" in s).toBe(false);
      expect("hurt" in s).toBe(false);
      expect("feedback" in db.decisions).toBe(false);
    } finally {
      db.db.close();
    }
  });
  it("the docs no longer promise it", () => {
    const dash = readFileSync(join(__dirname, "../../docs/dashboard.md"), "utf8");
    expect(dash).not.toMatch(/latency, helped\/hurt/);
  });
});

describe("#340 an adjudicator-on hook loads few files", () => {
  const files = ["hook.js", "hook-chunk-A.js", "hook-hooks-H.js", "hook-chunk-B.js"];
  const texts: Record<string, string> = {
    "hook-chunk-A.js": "",
    "hook-hooks-H.js": 'import "./hook-chunk-B.js";\nimport "./hook-chunk-A.js";',
    "hook-chunk-B.js": 'import "./hook-chunk-A.js";',
  };
  const hook = 'import "./hook-chunk-A.js";\nimport("./hook-hooks-H.js");';
  const read = (f: string) => texts[f];
  it("accepts hook.js + shared + hooks + one core chunk", () => {
    expect(checkHookChunks(hook, files, read)).toEqual([]);
  });
  it("fails when the hook handlers drag in more chunks", () => {
    const more: Record<string, string> = {
      ...texts,
      "hook-chunk-B.js": 'import "./hook-chunk-C.js";\nimport "./hook-chunk-D.js";',
    };
    const p = checkHookChunks(
      hook,
      [...files, "hook-chunk-C.js", "hook-chunk-D.js"],
      (f: string) => more[f],
    );
    expect(p.join("\n")).toMatch(/adjudicator-on prompt or Bash hook loads 6 files/);
  });
});
