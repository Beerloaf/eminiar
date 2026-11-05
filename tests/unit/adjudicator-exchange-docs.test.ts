/**
 * The docs promise about Jev request capture (task #186 / X8, T16; wording in blackboard
 * design-xchg-4): the old "never stored" sentences are gone, the new section, settings, routes and
 * commands are documented, and the numbers in the docs are the ones in the code.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ADJUDICATOR_USAGE } from "../../src/adjudicator/cli.js";
import { EXCHANGE_BODY_MAX, SCRUB_WINDOW } from "../../src/adjudicator/providers/capture.js";
import { EXCHANGE_KEEP } from "../../src/storage/sqlite/adjudicator.js";

const ROOT = join(__dirname, "../..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
/** Markdown wraps lines anywhere: compare phrases with the whitespace collapsed. */
const flat = (t: string) => t.replace(/\s+/g, " ");
const adjudicator = read("docs/adjudicator.md");
const configuration = read("docs/configuration.md");
const dashboard = read("docs/dashboard.md");
const cli = read("docs/cli.md");
const design = read("docs/design/adjudicator.md");

const DOCS = [
  "docs/adjudicator.md",
  "docs/configuration.md",
  "docs/dashboard.md",
  "docs/cli.md",
  "docs/design/adjudicator.md",
  "README.md",
];

describe("the old promise is gone", () => {
  it("no document still says prompts are never stored", () => {
    for (const f of DOCS) {
      const t = read(f);
      expect(t, f).not.toContain("Prompts and keys are never stored");
      expect(t, f).not.toContain("We never store prompts or keys");
      expect(t, f).not.toContain("or input text beyond the stored head.");
      expect(t, f).not.toMatch(/never store[sd]? (the )?prompts/i);
    }
  });

  it("the stored-locally paragraph names the exception", () => {
    expect(adjudicator).toContain("Keys are never stored.");
    expect(flat(adjudicator)).toContain(
      "Prompt text beyond those 80 characters is stored only if you turn on Jev request capture (below).",
    );
    expect(flat(adjudicator)).toMatch(
      /`eminiar purge adjudicator --yes` deletes the decisions, the verdict cache, the provider state, the learned bias and any captured Jev requests/,
    );
  });

  it("the design doc keeps 'never keys' and names the opt-in table", () => {
    expect(design).toContain("We never store keys.");
    expect(design).toContain("adjudicator_exchanges");
    expect(design).toContain("privacy.captureExchanges");
    expect(design).toContain(`EXCHANGE_KEEP = ${EXCHANGE_KEEP}`);
    expect(design).toContain("Never stored: keys or request headers.");
  });
});

describe("docs/adjudicator.md: Jev request capture", () => {
  const start = adjudicator.indexOf("### Jev request capture");
  const section = adjudicator.slice(start, adjudicator.indexOf("\n### ", start + 10));

  it("has the section, before the provider setup section", () => {
    expect(start).toBeGreaterThan(-1);
    expect(start).toBeLessThan(adjudicator.indexOf("### Setting up each provider"));
    expect(adjudicator.match(/### Jev request capture/g)).toHaveLength(1);
  });

  it("says what is kept, what is not, the limits, who can turn it on and how to delete it", () => {
    expect(section).toContain("Off by default");
    expect(section).toContain("eminiar adjudicator exchanges on");
    expect(section).toContain("redacted");
    expect(section).toContain("privacy.maxChars");
    expect(section).toContain("65,536 characters");
    expect(section).not.toContain("64 KiB");
    expect(flat(section)).toContain("The key and the `Authorization` header are never stored");
    expect(section).toContain(`Only the newest ${EXCHANGE_KEEP} requests are kept`);
    expect(section).toContain("best effort");
    expect(section).toContain("~/.eminiar/config.json");
    expect(flat(section)).toContain(
      "`eminiar.config.json` in a repository, or an environment variable, cannot",
    );
    expect(section).toContain("EMINIAR_ADJUDICATOR_CAPTURE=0");
    expect(section).toContain("exchanges off");
    expect(section).toContain("exchanges purge --yes");
    expect(section).toContain("adjudicator test");
    expect(section).toContain("adjudicator eval");
    expect(section).toContain("never captured");
  });

  it("the 65,536 characters in the docs is the cap in the code", () => {
    expect(EXCHANGE_BODY_MAX).toBe(65_536);
    expect(SCRUB_WINDOW).toBe(131_072);
    expect(flat(section)).toContain("longer than 131,072 characters");
  });

  it("describes the scrub, the on-disk erase and the in-flight job", () => {
    const s = flat(section);
    expect(s).toContain("zero-width");
    expect(s).toContain("named like a secret");
    expect(s).toContain("truncated");
    expect(s).toContain("write-ahead log");
    expect(s).toContain("secure delete");
    expect(s).toContain("best effort");
    expect(s).toContain("re-reads the setting before it writes");
  });

  it("no doc or tool text claims 64 KiB for a body", () => {
    for (const f of [adjudicator, dashboard, configuration, read("docs/design/adjudicator.md")])
      expect(f).not.toContain("64 KiB");
  });

  it("the purge scope text names the captured requests (tool, docs)", () => {
    expect(read("src/tools/em_purge.ts")).toContain("captured Jev requests");
    expect(read("docs/tools.md")).toContain("learned bias, captured Jev requests");
  });

  it("the turn-it-off list includes the captured requests", () => {
    expect(flat(adjudicator)).toContain(
      "`eminiar purge adjudicator --yes` deletes the recorded decisions, cache, provider state, learned bias and captured Jev requests.",
    );
  });
});

describe("docs/configuration.md", () => {
  it("lists privacy.captureExchanges, off by default, personal only", () => {
    const row =
      configuration.split("\n").find((l) => l.startsWith("| `privacy.captureExchanges`")) ?? "";
    expect(row).toContain("`false`");
    expect(row).toContain(`newest ${EXCHANGE_KEEP}`);
    expect(row).toContain("redacted prompt text");
    expect(row).toContain("`eminiar.config.json` cannot set it");
    expect(row).toContain("adjudicator.md#jev-request-capture");
  });

  it("lists EMINIAR_ADJUDICATOR_CAPTURE=0 and says =1 does nothing", () => {
    const row =
      configuration.split("\n").find((l) => l.includes("`EMINIAR_ADJUDICATOR_CAPTURE=0`")) ?? "";
    expect(row).toContain("`=1` does nothing");
  });

  it("the generated JSON schema has the setting with the default false", () => {
    const schema = JSON.parse(read("eminiar.config.schema.json")) as Record<string, unknown>;
    const text = JSON.stringify(schema);
    expect(text).toContain("captureExchanges");
    // biome-ignore lint/suspicious/noExplicitAny: walking untyped JSON
    const privacy = (schema as any).properties?.adjudicator?.properties?.privacy?.properties;
    expect(privacy?.captureExchanges?.type).toBe("boolean");
    expect(privacy?.captureExchanges?.default).toBe(false);
  });
});

describe("docs/dashboard.md", () => {
  it("lists both routes and where bodies appear", () => {
    expect(dashboard).toContain("GET /api/adjudicator/jev/exchanges?limit=&row=");
    expect(dashboard).toContain("GET /api/adjudicator/jev/exchange?id=");
    expect(flat(dashboard)).toContain("No payload contains a key or a masked key.");
    expect(flat(dashboard)).toContain(
      "appears only in the two Jev request routes, and only when you turned on [Jev request capture]",
    );
    expect(dashboard).toContain(
      "`{capture:false}` when capture is off; neither reads the database",
    );
    expect(dashboard).toContain("(`limit` 1–100, default 100");
  });

  it("describes the Jev requests table", () => {
    expect(dashboard).toContain("**Jev requests**");
    expect(dashboard).toContain(`newest ${EXCHANGE_KEEP} requests`);
  });
});

describe("docs/cli.md and the built-in help agree", () => {
  const lines = [
    "eminiar adjudicator exchanges [status] [--json]",
    "eminiar adjudicator exchanges on [--yes]",
    "eminiar adjudicator exchanges off",
    "eminiar adjudicator exchanges purge [--yes]",
  ];

  it("cli.md lists the four commands", () => {
    for (const l of lines) expect(cli, l).toContain(l);
    expect(cli).toContain("`--project` is refused");
  });

  it("the help text lists the same four", () => {
    for (const l of [
      "exchanges [status] [--json]",
      "exchanges on [--yes]",
      "exchanges off",
      "exchanges purge [--yes]",
    ])
      expect(ADJUDICATOR_USAGE, l).toContain(l);
  });
});
