import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AdjudicatorConfig, AdjudicatorConfigSchema } from "../../src/config.js";
import { getContext, resetContextCache } from "../../src/context.js";
import { createDecisionClient } from "../../src/decisions/client.js";
import { diffFileAllowed, matchesGlob, redactDiff } from "../../src/decisions/diff-redact.js";
import { commitMessage, feature } from "../../src/decisions/features/commit.js";
import type { DecisionProvider } from "../../src/decisions/providers/types.js";
import type { DecisionJob } from "../../src/decisions/types.js";
import type { StorageAdapter } from "../../src/storage/adapter.js";
import { closeAllStorage, getStorage } from "../../src/storage/index.js";

const ORIGIN = "https://api.typesafe.ai";
const ENV = { TYPESAFE_API_KEY: "sk-test-key-0123456789" } as NodeJS.ProcessEnv;
const CMD = 'git commit -m "Rename the helper"';

let root: string;
let db: StorageAdapter;
const sent: string[] = [];

function cfg(shadow: boolean): AdjudicatorConfig {
  return AdjudicatorConfigSchema.parse({
    enabled: true,
    provider: "typesafe",
    remoteConsent: true,
    remoteConsentOrigins: [ORIGIN],
    featureConsent: [`diffs@${ORIGIN}`],
    features: { commit: { enabled: true, shadow } },
  }) as AdjudicatorConfig;
}

const provider = (p: number): DecisionProvider => ({
  id: "typesafe",
  remote: false,
  model: "m",
  maxPairs: 100,
  maxRequests: 1,
  supports: () => true,
  ask: async (batch) => {
    sent.push(JSON.stringify(batch));
    return {
      answers: Object.fromEntries(
        batch.items.map((i) => [
          i.id,
          Object.fromEntries(
            batch.questions.map((q) => [
              q.name,
              {
                kind: "yes_no" as const,
                p: q.name === "debug_leftover" ? p : 0.01,
                calibrated: true,
              },
            ]),
          ),
        ]),
      ),
      tokensIn: 1,
      costUsd: 0,
      latencyMs: 1,
      model: "m",
    };
  },
});

const g = (...a: string[]) => execFileSync("git", a, { cwd: root, stdio: "pipe" });

beforeAll(() => {
  process.env.EMINIAR_HOME = mkdtempSync(join(tmpdir(), "em-home-"));
  process.env.EMINIAR_EMBEDDINGS = "0";
  root = mkdtempSync(join(tmpdir(), "em-dcommit-"));
  writeFileSync(join(root, "package.json"), "{}");
  g("init", "-q");
  writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
  g("add", "-A");
  g("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
  writeFileSync(
    join(root, "a.ts"),
    'export const a = 1;\nconsole.log("here");\nconst apiKey = "abcdEFGH1234";\n',
  );
  writeFileSync(join(root, ".env"), "TOKEN=supersecretvalue\n");
  writeFileSync(join(root, "yarn.lock"), "lock\n");
  g("add", "-A");
  resetContextCache();
  db = getStorage(getContext(root));
});
afterAll(() => {
  closeAllStorage();
  delete process.env.EMINIAR_HOME;
  delete process.env.EMINIAR_EMBEDDINGS;
});

const job = (command = CMD): DecisionJob => ({
  v: 1,
  feature: "commit",
  projectRoot: root,
  sessionId: "s1",
  payload: { command },
});
const run = (c: AdjudicatorConfig, p: DecisionProvider, command?: string) =>
  feature.runJob?.(
    job(command),
    createDecisionClient("commit", { config: c, db, context: "job", env: ENV, provider: p }),
    db,
  );

describe("diff redaction", () => {
  it("globs and file lists", () => {
    expect(matchesGlob("src/.env.local", ["**/.env*"])).toBe(true);
    expect(diffFileAllowed("src/a.ts")).toBe(true);
    expect(diffFileAllowed(".env")).toBe(false);
    expect(diffFileAllowed("yarn.lock")).toBe(false);
    expect(diffFileAllowed("img/logo.png")).toBe(false);
    expect(diffFileAllowed("src/a.ts", ["src/**"])).toBe(false);
  });

  it("keeps added lines only, scrubs secrets and cuts", () => {
    const diff = [
      "diff --git a/s.ts b/s.ts",
      "--- a/s.ts",
      "+++ b/s.ts",
      "@@ -1,2 +1,3 @@",
      " context line",
      "-removed line",
      '+const password = "hunter2hunter2";',
      `+const h = "${"a".repeat(64)}";`,
      "+ok();",
      "diff --git a/.env b/.env",
      "+++ b/.env",
      "+X=1",
    ].join("\n");
    const r = redactDiff(diff, { maxChars: 4000 });
    expect(r.text).toContain("ok();");
    expect(r.text).toContain("password");
    expect(r.text).not.toMatch(/hunter2|removed line|context line|X=1|aaaa/);
    expect(r.files).toBe(1);
    expect(r.skipped).toBe(1);
    expect(redactDiff(diff, { maxChars: 20 }).text.length).toBeLessThanOrEqual(20);
  });

  it("reads the message from -m and heredocs", () => {
    expect(commitMessage('git commit -m "one" -m "two"')).toBe("one\n\ntwo");
    expect(commitMessage("git commit -F- <<'EOF'\nbody here\nEOF")).toBe("body here");
  });
});

describe("commit advice", () => {
  it("queues a job only for git commit", () => {
    const seam = {} as never;
    const bash = (command: string) => ({ tool_name: "Bash", tool_input: { command } }) as never;
    expect(feature.preToolUse?.(seam, bash(CMD))).toEqual({ command: CMD });
    expect(feature.preToolUse?.(seam, bash("git status"))).toBeUndefined();
    expect(
      feature.preToolUse?.(seam, { tool_name: "Read", tool_input: {} } as never),
    ).toBeUndefined();
  });

  it("leaves one note in live mode and sends no denied file", async () => {
    await run(cfg(false), provider(0.95));
    const notes = db.decisions.pendingNotes("s1", Date.now());
    expect(notes).toHaveLength(1);
    expect(notes[0]?.note).toMatch(/^commit advice: the diff may contain debug leftovers/);
    const wire = sent.join("");
    expect(wire).toContain("console.log");
    expect(wire).not.toMatch(/supersecretvalue|abcdEFGH1234|yarn\.lock/);
  });

  it("leaves no note in shadow mode or for a low probability", async () => {
    db.decisions.markDelivered(
      db.decisions.pendingNotes("s1", Date.now()).map((n) => n.id),
      Date.now(),
    );
    await run(cfg(true), provider(0.95));
    await run(cfg(false), provider(0.2), 'git commit -m "Another message"');
    expect(db.decisions.pendingNotes("s1", Date.now())).toHaveLength(0);
  });
});
