import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AdjudicatorConfigSchema } from "../../src/config.js";
import { getContext, resetContextCache } from "../../src/context.js";
import { consentLine } from "../../src/decisions/consent.js";
import { chooseSections } from "../../src/decisions/features/compaction.js";
import { applyDocsScores, isPublicName, scorable } from "../../src/decisions/features/docs.js";
import { createOpenAIDecisionProvider } from "../../src/decisions/providers/openai.js";
import { choiceClears, type DecisionAnswer, scoreActs } from "../../src/decisions/types.js";
import { type Discovery, discoverDocs, type ProviderCandidate } from "../../src/docs/discover.js";

const choice = (calibrated: boolean, probs: Record<string, number>, confidence = 0.5) =>
  ({ kind: "choice", choice: "duplicate", probs, confidence, calibrated }) as DecisionAnswer;
const score = (value: number, calibrated: boolean) =>
  ({ kind: "score", value, confidence: 0.5, calibrated }) as DecisionAnswer;

describe("uncalibrated choice and score answers", () => {
  it("choiceClears: uncalibrated picks never fire, calibrated ones use the probability", () => {
    expect(choiceClears(choice(false, {}), "duplicate", 0.6)).toBe(false);
    expect(choiceClears(choice(false, { duplicate: 1 }, 0.5), "duplicate", 0.6)).toBe(true);
    expect(choiceClears(choice(true, { duplicate: 0.7 }), "duplicate", 0.6)).toBe(true);
    expect(choiceClears(choice(true, { duplicate: 0.5 }), "duplicate", 0.6)).toBe(false);
    expect(choiceClears(choice(true, {}, 0.9), "duplicate", 0.6)).toBe(true);
    expect(choiceClears(choice(true, { duplicate: 0.9 }), "supersedes", 0.6)).toBe(false);
  });

  it("scoreActs: uncalibrated may flag only at the top level and never drop", () => {
    expect(scoreActs(score(0.25, false), "drop")).toBe(false);
    expect(scoreActs(score(1, false), "drop")).toBe(false);
    expect(scoreActs(score(0.5, false), "flag")).toBe(false);
    expect(scoreActs(score(1, false), "flag")).toBe(true);
    expect(scoreActs(score(0.1, true), "drop")).toBe(true);
    expect(scoreActs(undefined, "flag")).toBe(false);
  });

  it("the openai provider gives a choice no synthetic probability", async () => {
    const r = {
      local: true,
      remote: false,
      baseUrl: "http://127.0.0.1:1",
      model: "m",
      extra: {},
    } as never;
    const cfg = AdjudicatorConfigSchema.parse({});
    const p = createOpenAIDecisionProvider(r, cfg, {
      fetch: (async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    answers: [{ id: "a.rel", choice: "duplicate" }],
                  }),
                },
              },
            ],
          }),
          { status: 200 },
        )) as never,
    });
    const out = await p.ask(
      {
        feature: "memory",
        items: [{ id: "a", text: "x" }],
        questions: [
          { name: "rel", kind: "choice", instructions: "{item}", options: { duplicate: "d" } },
        ],
        context: "c",
      } as never,
      { deadlineMs: 1000 } as never,
    );
    const a = out.answers.a?.rel;
    expect(a?.kind === "choice" && a.probs).toEqual({});
    expect(choiceClears(a, "duplicate", 0.1)).toBe(false);
  });

  it("chooseSections keeps a section whose score may not drop it", () => {
    const s = [
      { id: "a", label: "A", priority: 1, text: "aa", items: [] },
      { id: "b", label: "B", priority: 3, text: "bb", items: [] },
      { id: "c", label: "C", priority: 3, text: "cc", items: [] },
    ] as never[];
    const sc = (x: { id: string }) => (x.id === "b" ? 0 : 0.9);
    expect(chooseSections(s, sc, 0.3, 100).map((x: { id: string }) => x.id)).toEqual(["a", "c"]);
    expect(
      chooseSections(s, sc, 0.3, 100, (x) => (x as { id: string }).id !== "b").map(
        (x: { id: string }) => x.id,
      ),
    ).toEqual(["a", "b", "c"]);
  });

  it("applyDocsScores reorders but flags only flaggable providers", () => {
    const mk = (n: string): ProviderCandidate => ({
      name: n,
      provider: `npm:${n}`,
      title: n,
      urls: [],
      confidence: "registry",
      usedBy: ["."],
      evidence: [],
      registered: false,
    });
    const d: Discovery = { root: "/", projects: ["."], local: [], providers: [mk("a"), mk("b")] };
    const scores = new Map([
      ["npm:a", 0.5],
      ["npm:b", 0.75],
    ]);
    const r = applyDocsScores(d, scores, 0.5, (id) => id === "npm:b");
    expect(r.discovery.providers.map((p) => p.name)).toEqual(["b", "a"]);
    expect(r.discovery.providers.map((p) => !!p.recommended)).toEqual([true, false]);
  });
});

describe("docs triage sends public names only", () => {
  it("discovery marks git, URL, path and private-index sources, and scorable drops private names", () => {
    const root = mkdtempSync(join(tmpdir(), "em-pub-"));
    mkdirSync(root, { recursive: true });
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({
        name: "x",
        dependencies: {
          "left-padz": "^1.0.0",
          "@acme/internal": "^1.0.0",
          "gitdep-zz": "git+https://example.com/x.git",
          "shorthand-zz": "acme/shorthand-zz",
        },
      }),
    );
    writeFileSync(join(root, "requirements.txt"), "fastapi-zz==1\nwhl-zz @ https://x/y.whl\n");
    writeFileSync(
      join(root, "go.mod"),
      "module m\nrequire (\n  github.com/acme/pubmod v1.0.0\n  git.corp.internal/team/lib v1.0.0\n)\n",
    );
    resetContextCache();
    const d = discoverDocs(getContext(root));
    const by = Object.fromEntries(d.providers.map((p) => [p.provider, p]));
    expect(by["npm:gitdep-zz"]?.nonRegistry).toBe(true);
    expect(by["npm:shorthand-zz"]?.nonRegistry).toBe(true);
    expect(by["pypi:whl-zz"]?.nonRegistry).toBe(true);
    expect(by["pypi:fastapi-zz"]?.nonRegistry).toBeUndefined();
    const sent = scorable(d).map((p) => p.provider);
    expect(sent).toContain("npm:left-padz");
    expect(sent).toContain("pypi:fastapi-zz");
    expect(sent).toContain("go:github.com/acme/pubmod");
    expect(sent).not.toContain("npm:@acme/internal");
    expect(sent).not.toContain("npm:gitdep-zz");
    expect(sent).not.toContain("pypi:whl-zz");
    expect(sent).not.toContain("go:git.corp.internal/team/lib");
  });

  it("a private pip index makes every name in its requirements file non-public", () => {
    const root = mkdtempSync(join(tmpdir(), "em-idx-"));
    writeFileSync(
      join(root, "requirements.txt"),
      "--extra-index-url https://pypi.corp.internal/simple\nsecret-lib-zz==1\n",
    );
    resetContextCache();
    const d = discoverDocs(getContext(root));
    const p = d.providers.find((x) => x.provider === "pypi:secret-lib-zz");
    expect(p && isPublicName(p)).toBe(false);
  });
});

describe("consent text", () => {
  it("names what is actually sent", () => {
    const o = { origin: "https://x", maxChars: 100 };
    expect(consentLine("session", o)).toMatch(/em_execute command output only/);
    expect(consentLine("session", o)).toMatch(/never em_execute_file or em_batch_execute/);
    expect(consentLine("swarm", o)).toMatch(/worker final messages, spawn prompts/);
    expect(consentLine("packages", o)).toMatch(/public-registry/);
  });
});
