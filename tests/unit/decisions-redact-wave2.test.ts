/**
 * Wave 2 fixes: continuation lines under secret-named keys (F1) and the widened deny floor (F2).
 */
import { describe, expect, it } from "vitest";
import { COMMIT_EXCLUDE } from "../../src/config.js";
import { diffFileAllowed, matchesGlob, redactDiff } from "../../src/decisions/diff-redact.js";

function diffOf(path: string, added: string[]): string {
  return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -0,0 +1,${added.length} @@\n${added.map((l) => `+${l}`).join("\n")}\n`;
}
const text = (path: string, added: string[]) =>
  redactDiff(diffOf(path, added), { maxChars: 8000 }).text;

describe("block scalars and multi-line values under secret keys", () => {
  for (const ind of ["|", ">", "|-", ">-", "|+", ">+", "|2", "|-  # note"]) {
    it(`masks the body of \`db_password: ${ind}\``, () => {
      const t = text("deploy/values.yaml", [
        "name: app",
        `db_password: ${ind}`,
        "  CANARY_BLOCK_s3cret",
        "",
        "    deeper CANARY_DEEP",
        "replicas: 3",
      ]);
      expect(t).not.toContain("CANARY");
      expect(t).toContain("name: app");
      expect(t).toContain("replicas: 3");
    });
  }

  it("masks list items", () => {
    expect(text("a.yml", ["- api_key: |", "    CANARY_LIST", "- other: 1"])).not.toContain(
      "CANARY",
    );
  });

  it("masks a multi-line double-quoted value up to its closing quote", () => {
    const t = text("c.json", ['"password": "CANARY_Q1', "CANARY_Q2", 'CANARY_Q3",', '"name": "x"']);
    expect(t).not.toContain("CANARY");
    expect(t).toContain('"name": "x"');
    expect(text("c.yaml", ["secret: '", "  CANARY_SQ", "  end'", "ok: 1"])).not.toContain("CANARY");
  });

  it("masks nested and continued yaml values, and stops at the next sibling", () => {
    const t = text("c.yaml", [
      "secret_key: abc",
      "  CANARY_PLAIN",
      "secrets:",
      "  nested: CANARY_N",
      "after: 1",
    ]);
    expect(t).not.toContain("CANARY");
    expect(t).toContain("after: 1");
  });

  it("does not carry masking across hunks or onto non-secret keys", () => {
    const d =
      "diff --git a/v.yaml b/v.yaml\n@@ -1 +1 @@\n+db_password: |\n@@ -9 +9 @@\n+  keep_me: 1\n";
    expect(redactDiff(d, { maxChars: 8000 }).text).toContain("keep_me");
    expect(text("v.yaml", ["notes: |", "  visible text"])).toContain("visible text");
  });
});

describe("deny floor covers secret-bearing names", () => {
  const denied = [
    "config/secrets.yaml",
    "config/secrets.json",
    ".secrets.yml",
    "config/production.env.json",
    "config/prod.env.local",
    "app/credentials.json",
    ".aws/credentials",
    "keys/id_rsa.pub",
    "keys/server.pem",
    "keys/server.key",
    "keys/store.p12",
    "keys/server.pem.bak",
    "gcp/service-account-prod.json",
    "service-account.json",
    ".netrc",
    ".pgpass",
    "deploy/kubeconfig",
    "deploy/kubeconfig-prod.yaml",
    "ops/db_password.txt",
    "ops/api-keys.yaml",
    "ops/auth_token.json",
    "infra/prod.tfvars",
  ];
  for (const p of denied)
    it(`drops ${p} whole`, () => {
      expect(diffFileAllowed(p)).toBe(false);
      const r = redactDiff(diffOf(p, ["foo: CANARY_SECRETSYAML_plain"]), { maxChars: 8000 });
      expect(r.text).not.toContain("CANARY");
      expect(r.text).not.toContain(p);
      expect(r.skipped).toBe(1);
    });

  it("keeps ordinary source and docs", () => {
    for (const p of [
      "src/token-bucket.ts",
      "docs/secrets-policy.md",
      "src/auth.ts",
      "package.json",
    ])
      expect(diffFileAllowed(p), p).toBe(true);
  });

  it("the default commit exclude mirrors the main names", () => {
    for (const p of [
      "config/secrets.yaml",
      ".secrets.yml",
      "a.env.json",
      "gcp/service-account-x.json",
      ".pgpass",
    ])
      expect(matchesGlob(p, COMMIT_EXCLUDE), p).toBe(true);
  });
});
