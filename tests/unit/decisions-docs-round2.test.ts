import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { getContext, resetContextCache } from "../../src/context.js";
import { consentLine } from "../../src/decisions/consent.js";
import { isPublicName, scorable } from "../../src/decisions/features/docs.js";
import { discoverDocs } from "../../src/docs/discover.js";

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "em-docs2-"));
  for (const [f, t] of Object.entries(files)) {
    mkdirSync(dirname(join(root, f)), { recursive: true });
    writeFileSync(join(root, f), t);
  }
  return root;
}
const sent = (root: string) => {
  resetContextCache();
  return scorable(discoverDocs(getContext(root))).map((p) => p.provider);
};
const lock = (names: string[], host = "registry.npmjs.org") =>
  JSON.stringify({
    packages: Object.fromEntries(
      names.map((n) => [`node_modules/${n}`, { resolved: `https://${host}/${n}/-/${n}.tgz` }]),
    ),
  });

beforeEach(() => resetContextCache());

describe("docs triage sends only verified public names", () => {
  it("an unscoped npm name with a plain range and no lockfile evidence is not sent", () => {
    const root = repo({
      "package.json": JSON.stringify({ name: "a", dependencies: { "internal-zz": "^1.0.0" } }),
    });
    expect(sent(root)).not.toContain("npm:internal-zz");
  });

  it("a lockfile entry resolved from registry.npmjs.org verifies the name; a private host does not", () => {
    const pkg = JSON.stringify({ name: "a", dependencies: { "pub-zz": "^1", "priv-zz": "^1" } });
    const root = repo({
      "package.json": pkg,
      "package-lock.json": JSON.stringify({
        packages: {
          "node_modules/pub-zz": { resolved: "https://registry.npmjs.org/pub-zz/-/p.tgz" },
          "node_modules/priv-zz": { resolved: "https://npm.corp.internal/priv-zz/-/p.tgz" },
        },
      }),
    });
    const s = sent(root);
    expect(s).toContain("npm:pub-zz");
    expect(s).not.toContain("npm:priv-zz");
  });

  it("workspace members are never sent even when the lockfile says registry", () => {
    const root = repo({
      "package.json": JSON.stringify({
        name: "mono",
        workspaces: ["packages/*"],
        dependencies: { "sibling-zz": "*", "pub-zz": "^1" },
      }),
      "packages/sibling/package.json": JSON.stringify({ name: "sibling-zz" }),
      "package-lock.json": lock(["sibling-zz", "pub-zz"]),
    });
    const s = sent(root);
    expect(s).toContain("npm:pub-zz");
    expect(s).not.toContain("npm:sibling-zz");
  });

  it("an .npmrc default registry other than the public one verifies nothing", () => {
    const root = repo({
      "package.json": JSON.stringify({ name: "a", dependencies: { "pub-zz": "^1" } }),
      "package-lock.json": lock(["pub-zz"]),
      ".npmrc": "registry=https://npm.corp.internal/\n",
    });
    expect(sent(root)).not.toContain("npm:pub-zz");
  });

  it("github.com Go modules are not sent, vendor-run hosts are, and replace or go.work stops both", () => {
    const mod = (extra = "") =>
      `module m\nrequire (\n  github.com/acme/private v1.0.0\n  go.uber.org/zzunk v0.1.0\n)\n${extra}`;
    expect(sent(repo({ "go.mod": mod() }))).toEqual(
      expect.arrayContaining(["go:go.uber.org/zzunk"]),
    );
    expect(sent(repo({ "go.mod": mod() }))).not.toContain("go:github.com/acme/private");
    expect(sent(repo({ "go.mod": mod("replace go.uber.org/zzunk => ../api\n") }))).not.toContain(
      "go:go.uber.org/zzunk",
    );
    expect(sent(repo({ "go.mod": mod(), "go.work": "go 1.21\nuse .\n" }))).not.toContain(
      "go:go.uber.org/zzunk",
    );
  });

  it("pypi names need a uv.lock pypi.org entry, and any declared private index voids it", () => {
    const uv = '[[package]]\nname = "pub-zz"\nsource = { registry = "https://pypi.org/simple" }\n';
    const req = "pub-zz==1\nother-zz==1\n";
    expect(sent(repo({ "requirements.txt": req }))).not.toContain("pypi:pub-zz");
    const ok = sent(repo({ "requirements.txt": req, "uv.lock": uv }));
    expect(ok).toContain("pypi:pub-zz");
    expect(ok).not.toContain("pypi:other-zz");
    for (const extra of [
      { "pyproject.toml": '[[tool.uv.index]]\nname = "c"\nurl = "https://x.corp/simple"\n' },
      { "pyproject.toml": '[[tool.poetry.source]]\nname = "c"\nurl = "https://x.corp/simple"\n' },
      { "pip.conf": "[global]\nindex-url = https://x.corp/simple\n" },
      { "requirements.txt": "--index-url https://pypi.org.evil.example/simple\npub-zz==1\n" },
    ]) {
      expect(sent(repo({ "requirements.txt": req, "uv.lock": uv, ...extra }))).not.toContain(
        "pypi:pub-zz",
      );
    }
  });

  it("catalogue packages still pass and a non-registry name never does", () => {
    const root = repo({
      "package.json": JSON.stringify({ name: "a", dependencies: { zod: "^3" } }),
    });
    resetContextCache();
    const p = discoverDocs(getContext(root)).providers.find((x) => x.provider === "npm:zod");
    expect(p && isPublicName(p)).toBe(true);
    expect(isPublicName({ ...p!, nonRegistry: true })).toBe(false);
  });

  it("the packages consent line promises only verified names", () => {
    const t = consentLine("packages", { origin: "https://x", maxChars: 1 });
    expect(t).toMatch(/names only, never versions/);
    expect(t).toMatch(/lockfile/);
    expect(t).not.toMatch(/no private or internal hosts/);
  });
});
