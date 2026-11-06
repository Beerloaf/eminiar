import { describe, expect, it } from "vitest";
import { formatStatus, type StatusReport } from "../../src/adjudicator/cli.js";
import { redact } from "../../src/adjudicator/redact.js";
import { readablePaths } from "../../src/decisions/features/compaction.js";

const ROOT = "/Users/me/proj";

describe("readablePaths shortens only path-looking tokens (#351)", () => {
  it("leaves a bare slash-containing base64 secret to the redactor", () => {
    for (const t of [
      "the key is wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY ok",
      "base64 dGhpc2lzYXZlcnlsb25nc2VjcmV0cGFzc3dvcmQ/c29tZXRoaW5nZWxzZQ+more/andmore1234 end",
    ]) {
      expect(readablePaths(t, ROOT)).toBe(redact(t));
    }
    const out = readablePaths("the key is wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY ok", ROOT);
    expect(out).toContain("[b64]");
    expect(out).not.toContain("EXAMPLEKEY");
  });

  it("still shortens real paths", () => {
    expect(readablePaths(`${ROOT}/src/a.ts failed`, ROOT)).toBe("src/a.ts failed");
    expect(readablePaths("see /opt/very/long/dir/name/that/goes/on/file.ts", ROOT)).toContain(
      "on/file.ts",
    );
    expect(readablePaths("see /opt/very/long/dir/name/that/goes/on/file.ts", ROOT)).not.toContain(
      "/opt/",
    );
  });

  it("is linear on a long slash-less token", () => {
    const big = `${"a".repeat(200_000)} tail`;
    const t0 = Date.now();
    readablePaths(big, ROOT);
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});

describe("adjudicator status explains the provider pin", () => {
  it("says an env provider other than the personal one cannot run, with a working remedy", () => {
    const base = {
      enabled: true,
      enabledBy: "personal",
      configured: "openai-compatible",
      configuredLabel: "openai-compatible",
      effective: "heuristic",
      degraded: "no_consent",
      detail: "no consent",
      mode: "advise",
      surfaces: [],
      remote: true,
      host: "api.openai.com",
      origin: "https://api.openai.com",
      consent: false,
      consentVia: null,
      consentedOrigins: ["https://api.groq.com", "https://api.typesafe.ai"],
      projectIgnored: null,
      envProviderPinned: "openai-compatible",
      key: { id: null, source: "n/a", masked: "none", refused: false, file: { exists: false } },
    } as unknown as StatusReport;
    const out = formatStatus(base);
    expect(out).toContain("EMINIAR_ADJUDICATOR_PROVIDER=openai-compatible");
    expect(out).toContain("eminiar adjudicator provider <name>");
  });
});
