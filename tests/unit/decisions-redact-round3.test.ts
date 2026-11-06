/**
 * Round-3 privacy review (review-features-privacy-3-findings F1, F3, F4, F5;
 * review-features-correctness-4 F2): tasks #343, #336, #345, #346, #347.
 *  - #343 compaction's readablePaths ran ahead of the redactor and cut `scheme://` off DSNs;
 *    redact() had no scheme-less `user:pass@host` rule
 *  - #336 the YAML "key visible" rule took column-0 list items as roots; Kubernetes
 *    `- name: X_PASSWORD` + `value:` went out whole; secrets.ts (a source module) was denied
 *  - #345 assignment forms the diff scrub missed (subscripts, typed declarations, operators,
 *    sigils, heredocs, define(), Dockerfile ENV, SQL)
 *  - #346 plural/list secret names, Kubernetes Secret manifests, TOML secret tables
 *  - #347 app config secret stores, keyless stores, compound secret directories, renames
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { forRemote, isSecretName, redact } from "../../src/adjudicator/redact.js";
import {
  type AdjudicatorConfig,
  AdjudicatorConfigSchema,
  COMMIT_EXCLUDE,
} from "../../src/config.js";
import { createDecisionClient } from "../../src/decisions/client.js";
import { diffFileAllowed, matchesGlob, redactDiff } from "../../src/decisions/diff-redact.js";
import { feature, readablePaths } from "../../src/decisions/features/compaction.js";
import type { DecisionProvider } from "../../src/decisions/providers/types.js";
import { renderGuide } from "../../src/session/guide.js";
import { SqliteAdapter } from "../../src/storage/sqlite/adapter.js";

/** One file, hunks given as their added lines; hunk i starts at line firstStart + 10 i. */
function diffOf(path: string, hunks: string[][], firstStart = 1): string {
  const body = hunks
    .map(
      (h, i) =>
        `@@ -${firstStart + i * 10},0 +${firstStart + i * 10},${h.length} @@\n${h.map((l) => `+${l}`).join("\n")}`,
    )
    .join("\n");
  return `diff --git a/${path} b/${path}\nindex 1..2 100644\n--- a/${path}\n+++ b/${path}\n${body}\n`;
}
/** What the commit feature sends: the scrubbed diff, then the client's forRemote. */
const sent = (path: string, hunks: string[][], firstStart = 1) =>
  forRemote(redactDiff(diffOf(path, hunks, firstStart), { maxChars: 8000 }).text, 8000);

describe("#343 compaction paths never run ahead of the redactor", () => {
  const ROOT = "/Users/alice/acme-billing";
  const leaks: Array<[string, string]> = [
    ["Error: ECONNREFUSED DATABASE_URL=postgres://admin:CANARY_A@10.2.3.4/prod", "CANARY_A"],
    ["connect postgres://admin:CANARY_B@db.internal.example.com:5432/prod", "CANARY_B"],
    ["admin:CANARY_C@localhost:5432/prod failed", "CANARY_C"],
    ["mongodb://u:CANARY_D@h1.corp.example.com,h2.corp.example.com/db?replicaSet=x", "CANARY_D"],
    ["sftp://deploy:CANARY_E@files.corp.example.com/uploads/x", "CANARY_E"],
    ["git clone https://ghp_CANARYabcdefghijklmnopqrstuvwxyz0@github.com/a/b", "CANARY"],
    ["token: /Users/bob/Other/Project9/lib/Deep/CANARY_F.ts", "CANARY_F"],
  ];
  for (const [text, canary] of leaks)
    it(`readablePaths + forRemote: ${text.slice(0, 48)}`, () => {
      const out = forRemote(readablePaths(text, ROOT), 4000);
      expect(out).not.toContain(canary);
    });

  it("keeps the host and user readable, the password goes", () => {
    expect(forRemote(readablePaths("x postgres://admin:pw9@10.2.3.4/prod", ROOT), 400)).toBe(
      "x postgres://***@10.2.3.4/prod",
    );
  });

  it("still shortens paths and strips the project root", () => {
    expect(readablePaths(`at connect ${ROOT}/src/db.ts:12`, ROOT)).toBe("at connect src/db.ts:12");
    expect(readablePaths("/Users/bob/Other/Project9/lib/Deep/File.ts changed", ROOT)).toBe(
      "Deep/File.ts changed",
    );
    expect(readablePaths(`**Files Modified**: ${ROOT}/src/a.ts | ${ROOT}/src/b.ts`, ROOT)).toBe(
      "**Files Modified**: src/a.ts | src/b.ts",
    );
  });

  it("a key-shaped path segment stays masked after shortening", () => {
    const out = readablePaths("/var/tmp/cache/ghp_abcdefghijklmnopqrstuvwxyz0123/x.json", ROOT);
    expect(out).not.toContain("abcdefghijklmnopqrstuvwxyz0123");
  });

  it("private-use placeholder characters in the input cannot inject a path", () => {
    const out = readablePaths(`a 0 b ${ROOT}/src/x.ts`, ROOT);
    expect(out).not.toMatch(/[]/);
  });

  it("redact(): scheme-less and protocol-relative credentials, user-only tokens", () => {
    expect(redact("admin:pw@10.2.3.4/prod")).toBe("admin:***@10.2.3.4/prod");
    expect(redact("//admin:pw@h/x")).toBe("//admin:***@h/x");
    expect(redact("u:pa:ss@[::1]:5432")).toBe("u:***@[::1]:5432");
    expect(redact("https://abcdefghijklmnop1234@github.com/a")).toBe("https://***@github.com/a");
    expect(redact("ssh://git@github.com/a")).not.toContain("***");
    // The [email] rule no longer decides: the password is gone before it runs.
    expect(redact("admin:Sup3r@db.example.com")).not.toContain("Sup3r");
  });

  it("redact() stays linear on colon/at runs", () => {
    const t0 = performance.now();
    redact(`${"a:".repeat(50_000)}@`);
    redact(`${":".repeat(100_000)}x@y`);
    redact(`//${"u".repeat(100_000)}:p@h`);
    expect(performance.now() - t0).toBeLessThan(1500);
  });

  it("end to end: a failing command's DSN never reaches the provider", async () => {
    const SID = "s3";
    const db = new SqliteAdapter(join(mkdtempSync(join(tmpdir(), "cmp3-")), "e.db"), {
      vectors: false,
    });
    try {
      db.eventInsert({
        sessionId: SID,
        category: "user_prompt",
        priority: 1,
        payload: { text: "fix the payments tests" },
      });
      db.eventInsert({
        sessionId: SID,
        category: "error",
        priority: 2,
        payload: {
          tool: "Bash",
          error:
            "Error: password authentication failed\n    at connect /Users/alice/acme-billing/src/db.ts:12\nDATABASE_URL=postgres://admin:CANARY_ERR_URLPW@10.2.3.4/prod",
        },
      });
      db.eventInsert({
        sessionId: SID,
        category: "files",
        priority: 2,
        payload: { path: "/Users/alice/acme-billing/src/ledger.ts" },
      });
      const snapshotId = db.snapshotInsert({
        sessionId: SID,
        trigger: "auto",
        body: renderGuide(db, SID),
      });
      const seen: string[] = [];
      const provider: DecisionProvider = {
        id: "openai-compatible",
        remote: false,
        model: "m",
        maxPairs: 40,
        maxRequests: 2,
        supports: () => true,
        ask: async (batch) => {
          seen.push(JSON.stringify(batch));
          return { answers: {}, tokensIn: 1, costUsd: null, latencyMs: 1, model: "m" };
        },
      };
      const config = AdjudicatorConfigSchema.parse({
        enabled: true,
        provider: "openai-compatible",
        openai: { preset: "ollama" },
        features: { compaction: { enabled: true, shadow: true } },
      }) as AdjudicatorConfig;
      const client = createDecisionClient("compaction", {
        config,
        db,
        context: "job",
        env: {} as NodeJS.ProcessEnv,
        provider,
      });
      await feature.runJob?.(
        {
          v: 1,
          feature: "compaction",
          projectRoot: "/Users/alice/acme-billing",
          sessionId: SID,
          payload: { sessionId: SID, snapshotId },
        },
        client,
        db,
      );
      expect(seen.length).toBeGreaterThan(0);
      const all = seen.join("\n");
      expect(all).not.toContain("CANARY_ERR_URLPW");
      expect(all).toContain("10.2.3.4/prod");
      expect(all).not.toContain("/Users/alice");
    } finally {
      db.db.close();
    }
  });
});

describe("#336 YAML roots, Kubernetes name/value pairs, source modules named secrets", () => {
  it("a column-0 list item opening a hunk belongs to a key above it", () => {
    const t = sent("deploy/app.yaml", [["- hunter2-prod-db-pass", "replicas: 3"]], 12);
    expect(t).not.toContain("hunter2");
    expect(t).toContain("replicas: 3");
  });

  it("a compact list under a secret key (same column) is dropped", () => {
    const t = sent("deploy/app.yaml", [["passwords:", "- CANARY_1", "- CANARY_2", "next: ok"]]);
    expect(t).not.toContain("CANARY");
    expect(t).toContain("next: ok");
  });

  it("a comment or stray scalar after an empty secret key does not end it", () => {
    expect(sent("conf/a.yaml", [["password:", "# note", "CANARY_1"]])).not.toContain("CANARY");
  });

  const k8s: Array<[string, string[]]> = [
    [
      "name then value",
      [
        "env:",
        "  - name: DB_PASSWORD",
        "    value: CANARY_K1",
        "  - name: LOG_LEVEL",
        "    value: debug",
      ],
    ],
    [
      "value then name",
      [
        "env:",
        "  - value: CANARY_K2",
        "    name: DB_PASSWORD",
        "  - name: LOG_LEVEL",
        "    value: debug",
      ],
    ],
    [
      "block scalar value",
      [
        "env:",
        "  - name: API_TOKEN",
        "    value: |",
        "      CANARY_K3",
        "  - name: LOG_LEVEL",
        "    value: debug",
      ],
    ],
    [
      "flow mapping",
      ["env:", "  - {name: DB_PASSWORD, value: CANARY_K4}", "  - {name: LOG_LEVEL, value: debug}"],
    ],
  ];
  for (const [label, lines] of k8s)
    it(`Kubernetes env: ${label}`, () => {
      const t = sent("deploy/app.yaml", [lines]);
      expect(t).not.toContain("CANARY");
      expect(t).toContain("LOG_LEVEL");
      expect(t).toContain("debug");
    });

  it("JSON name/value objects (ECS task definitions)", () => {
    const t = sent("deploy/task.json", [
      [
        '  "environment": [',
        "    {",
        '      "name": "DB_PASSWORD",',
        '      "value": "CANARY_J1"',
        "    },",
        '    { "name": "STAGE", "value": "prod" }',
        "  ]",
      ],
    ]);
    expect(t).not.toContain("CANARY");
    expect(t).toContain('"prod"');
  });

  it("src/adjudicator/secrets.ts and other source modules named secrets are allowed", () => {
    for (const p of [
      "src/adjudicator/secrets.ts",
      "lib/secrets.py",
      "pkg/secrets.go",
      "src/secrets.rs",
      "src/credentials.ts",
      "src/service-account.ts",
      "src/kubeconfig.ts",
    ]) {
      expect(diffFileAllowed(p), p).toBe(true);
      expect(diffFileAllowed(p, COMMIT_EXCLUDE), p).toBe(true);
    }
    for (const p of [
      "config/secrets.yml",
      "secrets.json",
      "credentials",
      "credentials.json",
      "secrets.php",
      "secrets.sh",
    ])
      expect(diffFileAllowed(p, COMMIT_EXCLUDE), p).toBe(false);
  });

  it("a source module named secrets still has its values scrubbed", () => {
    const t = sent("src/adjudicator/secrets.ts", [
      ['const apiKey = "CANARY_SRC";', "export function load() {}"],
    ]);
    expect(t).not.toContain("CANARY");
    expect(t).toContain("export function load()");
  });
});

describe("#345 assignment forms", () => {
  const cases: Array<[string, string, string[]]> = [
    ["Python os.environ subscript", "src/a.py", ["os.environ['DB_PASSWORD'] = 'CANARY'"]],
    ["dict subscript", "src/a.py", ["cfg['token'] = 'CANARY'"]],
    ["header subscript", "src/a.ts", ["headers['x-api-key'] = 'CANARY'"]],
    ["TS modifiers and type", "src/a.ts", ["  private readonly apiKey: string = 'CANARY';"]],
    ["Kotlin typed val", "src/A.kt", ['val password: String = "CANARY"']],
    ["Makefile ?=", "Makefile", ["API_KEY ?= CANARY"]],
    ["Makefile +=", "Makefile", ["TOKEN += CANARY"]],
    ["Ruby ENV ||=", "src/a.rb", ["ENV['DB_PASSWORD'] ||= 'CANARY'"]],
    ["Ruby ivar ||=", "src/a.rb", ["@token ||= 'CANARY'"]],
    ["JS ??=", "src/a.ts", ["cfg.token ??= 'CANARY'"]],
    ["Go :=", "src/a.go", ['token := "CANARY"']],
    ["PHP heredoc", "src/a.php", ["$password = <<<EOT", "CANARY", "EOT;", "$x = 1;"]],
    ["PHP open quote", "src/a.php", ['$password = "abc', "CANARY", '";']],
    ["Ruby squiggly heredoc", "src/a.rb", ["@password = <<~EOS", "  CANARY", "EOS"]],
    ["Python subscript triple quote", "src/a.py", ["cfg['password'] = '''", "CANARY", "'''"]],
    ["PHP define", "src/a.php", ["define('DB_PASSWORD', 'CANARY');"]],
    ["Go setenv", "src/a.go", ['os.Setenv("DB_PASSWORD", "CANARY")']],
    ["Dockerfile ENV space form", "Dockerfile", ["ENV DB_PASSWORD CANARY"]],
    ["Dockerfile ENV secret_key_base", "Dockerfile", ["ENV SECRET_KEY_BASE CANARY"]],
    ["Dockerfile ARG", "Dockerfile", ["ARG NPM_TOKEN=CANARY"]],
    ["C #define", "src/a.c", ['#define API_KEY "CANARY"']],
    ["SQL WITH PASSWORD", "db/m.sql", ["CREATE USER app WITH PASSWORD 'CANARY';"]],
    ["SQL IDENTIFIED BY", "db/m.sql", ["CREATE USER 'app'@'%' IDENTIFIED BY 'CANARY';"]],
    [
      "SQL INSERT password column",
      "db/m.sql",
      ["INSERT INTO users (name, password) VALUES ('a','CANARY');"],
    ],
    ["SQL INSERT secret table", "db/m.sql", ["INSERT INTO api_keys VALUES (1, 'CANARY');"]],
    ["secret-named call", "src/a.go", ['req.SetBasicAuth("u", "CANARY")']],
    ["C# property initializer", "src/A.cs", ['public string Password { get; set; } = "CANARY";']],
    ["markdown bold key", "README.md", ["- **password**: CANARY"]],
    [
      "here-string",
      ".github/workflows/ci.yml",
      ["jobs:", "  b:", "    steps:", "      - run: gh auth login --with-token <<< CANARY"],
    ],
    ["string concatenation", "src/a.ts", ["const password = 'abc' +", "  'CANARY';"]],
    ["ternary over lines", "src/a.ts", ["const password = isProd ?", "  'CANARY' : 'x';"]],
    [
      "comment before the value",
      "src/a.ts",
      ["const password =", "  // from vault", "  'CANARY';"],
    ],
    ["zero-width char in the key", "src/a.py", ['pass​word = """', "CANARY", '"""']],
    ["fullwidth equals", "src/a.py", ['password＝"""', "CANARY", '"""']],
  ];
  for (const [label, path, lines] of cases)
    it(label, () => {
      const t = sent(path, [lines]);
      expect(t).not.toContain("CANARY");
      expect(t).toContain(`file ${path}`);
    });

  it("the key and what follows the value stay readable", () => {
    expect(sent("src/a.php", [["$password = <<<EOT", "CANARY", "EOT;", "$x = 1;"]])).toContain(
      "$x = 1;",
    );
    expect(sent("src/a.ts", [["  private readonly apiKey: string = 'CANARY';"]])).toContain(
      "private readonly apiKey: <redacted>",
    );
    // A parameter's type is not a value (the client's generic redactor may still mask it).
    expect(
      redactDiff(diffOf("src/a.ts", [["function login(token: string, user: User) {"]]), {
        maxChars: 4000,
      }).text,
    ).toContain("token: string");
    expect(sent("conf/app.json", [['  "token":', '    "CANARY_1",', '  "name": "x"']])).toContain(
      '"name": "x"',
    );
  });
});

describe("#346 plural names, Kubernetes Secrets, TOML secret tables", () => {
  it("isSecretName: plurals are secret, counts are not", () => {
    for (const n of [
      "tokens",
      "passwords",
      "api_keys",
      "apiKeys",
      "keys",
      "secret_keys",
      "DB_PASSWORDS",
    ])
      expect(isSecretName(n), n).toBe(true);
    for (const n of [
      "max_tokens",
      "prompt_tokens",
      "num_keys",
      "total_tokens",
      "monkeys",
      "keyboards",
    ])
      expect(isSecretName(n), n).toBe(false);
  });

  const lists: Array<[string, string, string[]]> = [
    ["YAML list", "conf/a.yaml", ["api_keys:", "  - CANARY"]],
    ["YAML passwords list", "conf/a.yaml", ["passwords:", "  - CANARY"]],
    ["YAML inline list", "conf/a.yaml", ["tokens: [CANARY, CANARY2]"]],
    ["JSON array", "conf/a.json", ['  "tokens": [', '    "CANARY",', "  ]"]],
    ["TOML inline array", "conf/a.toml", ["tokens = [", '  "CANARY",', "]"]],
  ];
  for (const [label, path, lines] of lists)
    it(label, () => expect(sent(path, [lines])).not.toContain("CANARY"));

  it("a Kubernetes Secret manifest is dropped whole, whatever the file is called", () => {
    for (const lines of [
      [
        "apiVersion: v1",
        "kind: Secret",
        "metadata:",
        "  name: db",
        "data:",
        "  user: Q0FOQVJZX0s4U19VU0VS",
      ],
      ["apiVersion: v1", "kind: Secret", "stringData:", "  user: CANARY_PLAIN"],
    ]) {
      const r = redactDiff(diffOf("deploy/postgres.yaml", [lines]), { maxChars: 8000 });
      expect(r.text).toBe("");
      expect(r.skipped).toBe(1);
    }
    // The kind line in a removed or earlier hunk line counts too.
    const d = `diff --git a/deploy/pg.yaml b/deploy/pg.yaml\n--- a/deploy/pg.yaml\n+++ b/deploy/pg.yaml\n@@ -1 +1 @@\n-kind: Secret\n+kind: Secret \n@@ -9 +9 @@\n+  user: CANARY\n`;
    expect(redactDiff(d, { maxChars: 8000 }).text).not.toContain("CANARY");
  });

  it("data: / stringData: children are masked in any YAML (the kind line may be outside the hunk)", () => {
    const t = sent(
      "deploy/postgres.yaml",
      [["data:", "  user: Q0FOQVJZX0s4U19VU0VS", "  host: CANARY"]],
      1,
    );
    expect(t).not.toContain("Q0FO");
    expect(t).not.toContain("CANARY");
    // Entries of a data: block above the hunk are indented: dropped as orphans.
    expect(sent("deploy/postgres.yaml", [["  user: CANARY"]], 8)).not.toContain("CANARY");
  });

  it("TOML tables named for secrets mask every value until the next table", () => {
    for (const header of [
      "[secrets]",
      "[tokens]",
      "[credentials]",
      "[auth.basic]",
      "[database.credentials]",
    ]) {
      const t = sent("conf/app.toml", [
        [header, "prod = 'CANARY'", "dev = 'CANARY2'", "[server]", "port = 8080"],
      ]);
      expect(t, header).not.toContain("CANARY");
      expect(t, header).toContain("prod = <redacted>");
      expect(t, header).toContain("port = 8080");
    }
  });

  it("TOML keys of a table above the hunk keep their names and lose their values", () => {
    const t = sent("conf/app.toml", [["prod = 'CANARY'", "port = 1", 'version = "1.2.3"']], 30);
    expect(t).not.toContain("CANARY");
    expect(t).toContain("prod = <redacted>");
    expect(t).toContain("port = 1");
    expect(t).toContain('version = "1.2.3"');
  });

  it("JSON keys of an object above the hunk keep their names and lose their values", () => {
    const t = sent("conf/app.json", [['    "prod": "CANARY",', '    "port": 8080']], 30);
    expect(t).not.toContain("CANARY");
    expect(t).toContain('"prod": <redacted>');
    expect(t).toContain('"port": 8080');
  });
});

describe("#347 deny floor: secret stores, compound secret dirs, renames", () => {
  const denied = [
    "wp-config.php",
    "configuration.php",
    "LocalSettings.php",
    "settings.local.php",
    "app/etc/env.php",
    "local_settings.py",
    "mysite/settings_local.py",
    "config/database.yml",
    "src/main/resources/application-prod.yml",
    "appsettings.Production.json",
    "local.settings.json",
    "serviceAccountKey.json",
    "serviceAccountKey-prod.json",
    "sa.json",
    "gcp.json",
    "keyfile.json",
    "privatekey.json",
    "accesskey.json",
    "oauth-client.json",
    "client_secret_123.json",
    "docker/config.json",
    ".azure/azureProfile.json",
    ".config/gcloud/configurations/config_default.txt",
    "helm/repositories.yaml",
    "prod-kubeconfig.yaml",
    "passphrase.txt",
    "passphrase",
    "pw.txt",
    "pwd.txt",
    "otp.txt",
    "recovery-codes.txt",
    "backup-codes.txt",
    "seed-phrase.txt",
    "jwtkey.txt",
    "secrets-prod/db.yaml",
    "config/secrets-prod/db.yaml",
    "my-secrets/x.yaml",
    "sealed-secrets/x.yaml",
    "secret-manager/x.yaml",
    "prod_credentials/x.ts",
    "api-keys/a.txt",
    "hashicorp-vault/policy.hcl.txt",
  ];
  for (const p of denied) it(`denies ${p}`, () => expect(diffFileAllowed(p), p).toBe(false));

  it("still allows ordinary source, docs and data", () => {
    for (const p of [
      "src/token-bucket.ts",
      "docs/secrets-policy.md",
      "src/keyboard/layout.ts",
      "package.json",
      "src/passport.ts",
      "docker/compose.yaml",
    ])
      expect(diffFileAllowed(p), p).toBe(true);
  });

  it("the default commit.exclude names the new stores and stays under the 64-glob user cap", () => {
    for (const p of [
      "wp-config.php",
      "appsettings.Production.json",
      "local.settings.json",
      "serviceAccountKey.json",
      "docker/config.json",
      "my-secrets/x.yaml",
      "secrets-prod/db.yaml",
    ])
      expect(matchesGlob(p, COMMIT_EXCLUDE), p).toBe(true);
    expect(COMMIT_EXCLUDE.length).toBeLessThanOrEqual(64);
  });

  const rename = (from: string, to: string, kind: "rename" | "copy" = "rename") =>
    `diff --git a/${from} b/${to}\nsimilarity index 80%\n${kind} from ${from}\n${kind} to ${to}\nindex 1..2 100644\n--- a/${from}\n+++ b/${to}\n@@ -2 +2 @@\n-OLD=1\n+SOMETHING_ELSE=CANARY_REN\n`;

  it("a rename or copy from a denied file sends nothing", () => {
    const pairs: Array<[string, string]> = [
      [".env", "notes/env.txt"],
      ["secrets.json", "data/x.json"],
      ["config/credentials.yml", "config/x.yml"],
    ];
    for (const [from, to] of pairs) {
      for (const kind of ["rename", "copy"] as const) {
        const r = redactDiff(rename(from, to, kind), { maxChars: 4000 });
        expect(r.text, `${kind} ${from}`).toBe("");
        expect(r.skipped).toBe(1);
      }
    }
    // A pure rename (no hunks) names both sides in the rename lines only.
    const pure =
      "diff --git a/.env b/env.txt\nsimilarity index 100%\nrename from .env\nrename to env.txt\n";
    expect(redactDiff(pure, { maxChars: 4000 }).skipped).toBe(1);
  });

  it("a rename into a denied file sends nothing; an allowed rename still sends", () => {
    expect(redactDiff(rename("notes/a.txt", ".env"), { maxChars: 4000 }).text).toBe("");
    expect(redactDiff(rename("src/a.ts", "src/b.ts"), { maxChars: 4000 }).text).toContain(
      "file src/b.ts",
    );
  });

  it("quoted and space-holding paths are checked on every reading", () => {
    const q = (head: string) =>
      `diff --git ${head}\nindex 1..2 100644\n@@ -0,0 +1 @@\n+x=CANARY_QUOTED\n`;
    for (const head of [
      '"a/s\\303\\251crets/x.yaml" "b/s\\303\\251crets/x.yaml"',
      '"a/secrets/x\\"y.yaml" "b/secrets/x\\"y.yaml"',
      "a/my secrets/x.yaml b/my secrets/x.yaml",
      "a/x b/secrets/y.yaml",
      "a/dir b/.env b/dir b/.env",
      '"a/bad\\q" "b/bad\\q"',
    ])
      expect(redactDiff(q(head), { maxChars: 4000 }).text, head).not.toContain("CANARY");
  });
});
