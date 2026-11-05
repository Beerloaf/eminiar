/**
 * Round-2 privacy review of the commit diff scrub (review-features-privacy-2):
 * N1 (#321) secret values that run on past their line, N3 (#322) the deny floor for
 * secret-bearing directories and data names, N2 (#323) hunks whose key is outside the hunk and
 * the default commit.exclude for Helm-style values files.
 */
import { describe, expect, it } from "vitest";
import { COMMIT_EXCLUDE } from "../../src/config.js";
import {
  DIFF_DENY_FLOOR,
  diffFileAllowed,
  matchesGlob,
  redactDiff,
} from "../../src/decisions/diff-redact.js";

/** One file, hunks given as their added lines; each hunk starts below line 1 by default. */
function diffOf(path: string, hunks: string[][], firstStart = 1): string {
  const body = hunks
    .map(
      (h, i) =>
        `@@ -${firstStart + i * 10},0 +${firstStart + i * 10},${h.length} @@\n${h.map((l) => `+${l}`).join("\n")}`,
    )
    .join("\n");
  return `diff --git a/${path} b/${path}\nindex 1..2 100644\n--- a/${path}\n+++ b/${path}\n${body}\n`;
}
const sent = (path: string, hunks: string[][], firstStart = 1) =>
  redactDiff(diffOf(path, hunks, firstStart), { maxChars: 8000 }).text;

describe("#321 values that run on past their line", () => {
  const cases: Array<[string, string, string[]]> = [
    ["TOML triple double quote", "conf/app.toml", ['password = """', "CANARY_1", '"""']],
    ["TOML triple single quote", "conf/app.toml", ["password = '''", "CANARY_1", "'''"]],
    [
      "TOML triple with text on the open line",
      "conf/app.toml",
      ['password = """CANARY_0', "CANARY_1", '"""'],
    ],
    ["Python triple quote", "src/a.py", ['password = """', "CANARY_1", '"""']],
    ["Python raw triple quote", "src/a.py", ["api_key = r'''", "CANARY_1", "'''"]],
    [
      "properties backslash continuation",
      "conf/app.properties.txt",
      ["db.password=abc\\", "CANARY_1\\", "CANARY_2"],
    ],
    ["shell backslash continuation", "scripts/a.sh", ['export DB_PASSWORD="abc" \\', "  CANARY_1"]],
    ["shell heredoc", "scripts/a.sh", ["export DB_PASSWORD=$(cat <<EOF", "CANARY_1", "EOF", ")"]],
    ["shell quoted heredoc", "scripts/a.sh", ["TOKEN=$(cat <<-'END'", "CANARY_1", "END"]],
    ["JSON key, value on the next line", "conf/app.json", ['  "token":', '    "CANARY_1"']],
    ["JSON key, blank line, then value", "conf/app.json", ['  "token":', "", '    "CANARY_1"']],
    [
      "JSON key, object on the next lines",
      "conf/app.json",
      ['  "credentials":', "  {", '    "user": "CANARY_1",', "  }"],
    ],
    ["JSON secret object", "conf/app.json", ['  "secret": {', '    "value": "CANARY_1"', "  }"]],
    ["Python call over lines", "src/a.py", ["password = get(", '    "CANARY_1",', ")"]],
    ["TS array over lines", "src/a.ts", ["const token = [", '  "CANARY_1",', "];"]],
    ["CRLF triple quote", "conf/app.toml", ['password = """\r', "CANARY_1\r", '"""\r']],
    ["CRLF backslash", "conf/app.properties.txt", ["db.password=abc\\\r", "CANARY_1\r"]],
    ["YAML tab-indented block body", "deploy/v.yaml", ["a:", "  db_password: |", "\tCANARY_1"]],
  ];
  for (const [name, path, lines] of cases)
    it(name, () => {
      const t = sent(path, [lines]);
      expect(t).not.toContain("CANARY");
      expect(t).toContain(`file ${path}`);
    });

  it("lines after the value is closed are sent again", () => {
    expect(sent("conf/app.toml", [['password = """', "CANARY_1", '"""', "port = 1"]])).toContain(
      "port = 1",
    );
    expect(
      sent("conf/app.properties.txt", [["db.password=a\\", "CANARY_1", "db.user=bob"]]),
    ).toContain("db.user=bob");
    expect(
      sent("scripts/a.sh", [["PASSWORD=$(cat <<EOF", "CANARY_1", "EOF", "echo done"]]),
    ).toContain("echo done");
    expect(sent("src/a.py", [["password = get(", '    "CANARY_1",', ")", "port = 1"]])).toContain(
      "port = 1",
    );
    expect(sent("conf/app.json", [['  "token":', '    "CANARY_1",', '  "name": "x"']])).toContain(
      '"name": "x"',
    );
  });

  it("a closed triple quote, an escaped backslash and a non-secret key carry nothing on", () => {
    expect(sent("conf/app.toml", [['password = """CANARY_0"""', "port = 1"]])).toContain(
      "port = 1",
    );
    expect(sent("conf/app.properties.txt", [["db.password=a\\\\", "visible"]])).toContain(
      "visible",
    );
    expect(sent("conf/app.toml", [['notes = """', "visible", '"""']])).toContain("visible");
  });

  it("an unterminated continuation ends at the next hunk", () => {
    const t = sent("scripts/a.sh", [["PASSWORD=$(cat <<EOF", "CANARY_1"], ["echo visible"]]);
    expect(t).not.toContain("CANARY");
    expect(t).toContain("echo visible");
  });

  it("stays linear on long pathological lines", () => {
    const long = [
      `password = \\${"\\".repeat(200_000)}`,
      `"token": ${"(".repeat(200_000)}`,
      `x = "${'\\"'.repeat(100_000)}`,
    ];
    const t0 = performance.now();
    redactDiff(diffOf("conf/app.toml", [long]), { maxChars: 8000 });
    redactDiff(diffOf("src/a.py", [long]), { maxChars: 8000 });
    expect(performance.now() - t0).toBeLessThan(500);
  });
});

describe("#323 hunks whose key is outside the hunk", () => {
  it("YAML: an indented line opening a hunk is dropped (block header in an earlier hunk or none)", () => {
    expect(sent("deploy/v.yaml", [["  CANARY_MIDBLOCK"]], 7)).not.toContain("CANARY");
    expect(sent("deploy/v.yaml", [["db_password: |"], ["  CANARY_TWOHUNK"]])).not.toContain(
      "CANARY",
    );
    expect(sent("deploy/v.yaml", [["    CANARY_1", "    CANARY_2"]], 1)).not.toContain("CANARY");
  });

  it("YAML: lines are sent again from the first column-0 line on, nested ones included", () => {
    const t = sent("deploy/v.yaml", [["  CANARY_1", "replicas: 3", "image:", "  tag: v2"]], 12);
    expect(t).not.toContain("CANARY");
    expect(t).toContain("replicas: 3");
    expect(t).toContain("  tag: v2");
  });

  it("TOML: lines inside a multi-line string or array opened above are dropped", () => {
    const t = sent("conf/app.toml", [["CANARY_1", '"""', "port = 1", "[db]", 'host = "h"']], 30);
    expect(t).not.toContain("CANARY");
    expect(t).not.toContain('"""');
    expect(t).toContain("port = 1");
    expect(t).toContain("[db]");
    expect(sent("conf/app.toml", [['  "CANARY_ARR",']], 30)).not.toContain("CANARY");
  });

  it("JSON: a bare value under a key above the hunk is dropped", () => {
    const t = sent("conf/app.json", [['    "CANARY_1"', "  },", '  "name": "x"']], 40);
    expect(t).not.toContain("CANARY");
    expect(t).toContain('"name": "x"');
  });

  it("source files are not affected", () => {
    expect(sent("src/a.ts", [["  return visible;"]], 50)).toContain("return visible");
  });

  it("the default commit.exclude covers Helm-style values files", () => {
    for (const p of [
      "deploy/values.yaml",
      "helm/values-prod.yaml",
      "helm/values.prod.yml",
      "charts/app/prod-values.yaml",
      "charts/app/prod_values.yml",
    ]) {
      expect(matchesGlob(p, COMMIT_EXCLUDE), p).toBe(true);
      expect(diffFileAllowed(p, COMMIT_EXCLUDE), p).toBe(false);
    }
    expect(matchesGlob("src/values.ts", COMMIT_EXCLUDE)).toBe(false);
  });
});

describe("#322 deny floor for secret-bearing directories and data names", () => {
  const denied = [
    "credentials/prod.yaml",
    "credential/prod.yaml",
    "secret/db.yaml",
    "secrets/db.yaml",
    "creds/x.json",
    "cred/x.json",
    "vault/prod.yaml",
    "vaults/prod.yaml",
    "private/x.txt",
    "keys/prod.json",
    "key/prod.json",
    "Secret/DB.YAML",
    "deploy/credentials/app.ts",
    ".docker/config.json",
    ".gnupg/pubring.txt",
    "infra/prod.tfvars.json",
    "terraform.tfvars.json",
    "terraform.tfstate",
    "terraform.tfstate.json",
    "terraform.tfstate.backup",
    "creds.json",
    "prod-creds.yaml",
    "auth.json",
    "config/auth.yml",
    "config/prod-auth.yaml",
    "vault.yml",
    "group_vars/all/vault.yml",
    "wallet.json",
    "mnemonic.txt",
    "keystore.json",
    "gcp-key.json",
    "firebase-adminsdk-abc.json",
    "bearer.json",
    "pass.txt",
    "htpasswd.txt",
    ".npmrc",
    ".pypirc",
    ".git-credentials",
    ".yarnrc.yml",
    ".dockerconfigjson",
  ];
  for (const p of denied) it(`denies ${p}`, () => expect(diffFileAllowed(p), p).toBe(false));

  it("still allows ordinary source, docs and data", () => {
    for (const p of [
      "src/token-bucket.ts",
      "src/auth.ts",
      "src/auth/session.ts",
      "docs/secrets-policy.md",
      "author.json",
      "monkey.json",
      "passport.json",
      "package.json",
      "src/keyboard/layout.ts",
      "docker/compose.yaml",
    ])
      expect(diffFileAllowed(p), p).toBe(true);
  });

  it("the floor holds against an empty commit.exclude", () => {
    expect(diffFileAllowed("credentials/prod.yaml", [])).toBe(false);
    expect(DIFF_DENY_FLOOR).toContain("**/credentials/**");
  });

  it("leaks of the review stay closed end to end", () => {
    const d = [
      diffOf("credentials/prod.yaml", [["value: CANARY_CREDDIR"]]),
      diffOf("secret/db.yaml", [["data: CANARY_SECRETDIR"]]),
      diffOf("infra/prod.tfvars.json", [['{"bootstrap": "CANARY_TFVJSON"}']]),
      diffOf("src/ok.ts", [["export const visible = 1;"]]),
    ].join("");
    const r = redactDiff(d, { maxChars: 8000 });
    expect(r.text).not.toContain("CANARY");
    expect(r.text).not.toContain("credentials/prod.yaml");
    expect(r.text).toContain("visible");
    expect(r.skipped).toBe(3);
  });

  it("the default commit.exclude mirrors the new directory and data names", () => {
    for (const p of [
      "credentials/prod.yaml",
      "secret/db.yaml",
      "creds/x.json",
      "vault/prod.yaml",
      "private/x.txt",
      "keys/prod.json",
      ".docker/config.json",
      ".gnupg/x",
      "creds.json",
      "prod-creds.yaml",
      "auth.json",
      "vault.yml",
      "prod.tfvars.json",
      "terraform.tfstate",
      ".npmrc",
      ".pypirc",
      ".git-credentials",
    ])
      expect(matchesGlob(p, COMMIT_EXCLUDE), p).toBe(true);
  });
});
