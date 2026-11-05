/**
 * Pure helpers of the Jev request log (src/ui/web/views/xchg-helpers.ts; task #186 / X8, T17), and
 * a source check on the Preact view that renders them: text nodes only, no HTML injection.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CapturedBody } from "../../src/adjudicator/types.js";
import {
  CAPTURE_COMMAND,
  CAPTURE_EMPTY_TEXT,
  captureNotice,
  captureOffText,
  deadlineFraction,
  drawerTitle,
  fmtBytes,
  fmtChars,
  fmtMs,
  PURGE_COMMAND,
  panelState,
  prettyBody,
  relTime,
  resultLabel,
  resultTone,
  targetHost,
  timeline,
  tokensLabel,
  triesLabel,
  waitLabel,
  type XchgTiming,
} from "../../src/ui/web/views/xchg-helpers.js";

const timing = (o: Partial<XchgTiming> = {}): XchgTiming => ({
  outcome: "ok",
  status: 200,
  timedOut: false,
  attempts: 1,
  waitMs: 10,
  jobWaitMs: null,
  ttfbMs: 300,
  durationMs: 400,
  retryWaitMs: 0,
  deadlineMs: 800,
  ...o,
});

describe("resultLabel / resultTone", () => {
  it("labels each outcome", () => {
    expect(resultLabel({ outcome: "ok", status: 200 })).toBe("200");
    expect(resultLabel({ outcome: "ok", status: null })).toBe("ok");
    expect(resultLabel({ outcome: "timeout", status: null })).toBe("timeout");
    expect(resultLabel({ outcome: "timeout", status: 200 })).toBe("timeout");
    expect(resultLabel({ outcome: "rate_limited", status: 429 })).toBe("429 rate limited");
    expect(resultLabel({ outcome: "rate_limited", status: 529 })).toBe("529 rate limited");
    expect(resultLabel({ outcome: "rate_limited", status: null })).toBe("rate limited");
    expect(resultLabel({ outcome: "http_error", status: 503 })).toBe("http 503");
    expect(resultLabel({ outcome: "http_error", status: null })).toBe("http error");
    expect(resultLabel({ outcome: "invalid", status: 200 })).toBe("invalid");
    expect(resultLabel({ outcome: "no_key", status: null })).toBe("no key");
  });

  it("shows an outcome it does not know instead of hiding it", () => {
    expect(resultLabel({ outcome: "some_new_state" as never, status: null })).toBe(
      "some new state",
    );
    expect(resultLabel({ outcome: "" as never, status: null })).toBe("unknown");
    expect(resultLabel({ outcome: "ok", status: 0 })).toBe("ok");
    expect(resultLabel({ outcome: "ok", status: -1 })).toBe("ok");
  });

  it("tones: ok good, timeouts and http errors bad, limits and invalid answers warn", () => {
    expect(resultTone("ok")).toBe("ok");
    expect(resultTone("timeout")).toBe("bad");
    expect(resultTone("http_error")).toBe("bad");
    expect(resultTone("rate_limited")).toBe("warn");
    expect(resultTone("invalid")).toBe("warn");
    expect(resultTone("pending")).toBe("muted");
    expect(resultTone("whatever")).toBe("muted");
  });

  it("the drawer title carries the id, the time and the label", () => {
    expect(
      drawerTitle({ id: 12, ts: 0, outcome: "rate_limited", status: 429 }, "Nov 4, 12:00"),
    ).toBe("Request #12 · Nov 4, 12:00 · 429 rate limited");
  });
});

describe("deadlineFraction", () => {
  it("is duration over deadline, clamped to 0..1", () => {
    expect(deadlineFraction({ durationMs: 400, deadlineMs: 800, timedOut: false })).toEqual({
      frac: 0.5,
      over: false,
    });
    expect(deadlineFraction({ durationMs: 0, deadlineMs: 800, timedOut: false })).toEqual({
      frac: 0,
      over: false,
    });
    expect(deadlineFraction({ durationMs: 800, deadlineMs: 800, timedOut: false })).toEqual({
      frac: 1,
      over: true,
    });
    expect(deadlineFraction({ durationMs: 5000, deadlineMs: 800, timedOut: false })).toEqual({
      frac: 1,
      over: true,
    });
    expect(deadlineFraction({ durationMs: -5, deadlineMs: 800, timedOut: false })).toEqual({
      frac: 0,
      over: false,
    });
  });

  it("a timeout is over whatever the numbers say; unknown or zero values give 0", () => {
    expect(deadlineFraction({ durationMs: 100, deadlineMs: 800, timedOut: true })).toEqual({
      frac: 0.125,
      over: true,
    });
    expect(deadlineFraction({ durationMs: null, deadlineMs: 800, timedOut: true })).toEqual({
      frac: 0,
      over: true,
    });
    expect(deadlineFraction({ durationMs: null, deadlineMs: 800, timedOut: false })).toEqual({
      frac: 0,
      over: false,
    });
    expect(deadlineFraction({ durationMs: 100, deadlineMs: 0, timedOut: false })).toEqual({
      frac: 0,
      over: false,
    });
    expect(deadlineFraction({ durationMs: Number.NaN, deadlineMs: 800, timedOut: false })).toEqual({
      frac: 0,
      over: false,
    });
    expect(
      deadlineFraction({ durationMs: Number.POSITIVE_INFINITY, deadlineMs: 800, timedOut: false })
        .frac,
    ).toBe(0);
  });
});

describe("timeline", () => {
  const sumWidths = (t: ReturnType<typeof timeline>) => t.segments.reduce((s, x) => s + x.width, 0);
  const finite = (t: ReturnType<typeof timeline>) => {
    for (const s of t.segments) {
      expect(Number.isFinite(s.start)).toBe(true);
      expect(Number.isFinite(s.width)).toBe(true);
      expect(s.start).toBeGreaterThanOrEqual(0);
      expect(s.width).toBeGreaterThan(0);
      expect(s.start + s.width).toBeLessThanOrEqual(1 + 1e-9);
    }
    if (t.deadlineAt !== null) {
      expect(t.deadlineAt).toBeGreaterThan(0);
      expect(t.deadlineAt).toBeLessThanOrEqual(1);
    }
  };

  it("lays out wait, first byte and body read in order, with the deadline marker after the waits", () => {
    const t = timeline(timing({ waitMs: 50, ttfbMs: 300, durationMs: 400, deadlineMs: 800 }));
    expect(t.segments.map((s) => s.key)).toEqual(["wait", "ttfb", "rest"]);
    expect(t.segments.map((s) => s.ms)).toEqual([50, 300, 100]);
    expect(t.totalMs).toBe(850); // the deadline marker (50 + 800) is later than the segments (450)
    expect(t.deadlineAt).toBe(1);
    expect(sumWidths(t)).toBeLessThanOrEqual(1);
    expect(sumWidths(t)).toBeCloseTo(450 / 850);
    // Contiguous: each starts where the last ended.
    let at = 0;
    for (const s of t.segments) {
      expect(s.start).toBeCloseTo(at);
      at += s.width;
    }
    finite(t);
  });

  it("a request that ran past its deadline stretches the bar to the segments, the marker inside", () => {
    const t = timeline(timing({ waitMs: 10, ttfbMs: 100, durationMs: 1500, deadlineMs: 800 }));
    expect(t.totalMs).toBe(1510);
    expect(t.deadlineAt).toBeCloseTo(810 / 1510);
    expect(sumWidths(t)).toBeCloseTo(1);
    finite(t);
  });

  it("a background job's queue wait comes first and moves the marker", () => {
    const t = timeline(
      timing({ jobWaitMs: 2000, waitMs: 5, ttfbMs: 200, durationMs: 300, deadlineMs: 3000 }),
    );
    expect(t.segments.map((s) => s.key)).toEqual(["job", "wait", "ttfb", "rest"]);
    expect(t.totalMs).toBe(5005);
    expect(t.deadlineAt).toBe(1);
    finite(t);
  });

  it("a retry: the pause, then the final attempt's first byte; labels the rest as the first attempt too", () => {
    const t = timeline(
      timing({
        attempts: 2,
        retryWaitMs: 120,
        ttfbMs: 200,
        durationMs: 500,
        waitMs: 0,
        deadlineMs: 800,
      }),
    );
    expect(t.segments.map((s) => s.key)).toEqual(["retry", "ttfb", "rest"]);
    expect(t.segments.map((s) => s.ms)).toEqual([120, 200, 180]);
    expect(t.segments.find((s) => s.key === "rest")?.label).toBe("first attempt + body");
    expect(timeline(timing()).segments.find((s) => s.key === "rest")?.label).toBe("body read");
    finite(t);
  });

  it("a retry with a null ttfb puts the whole remainder in the rest segment", () => {
    const t = timeline(
      timing({ attempts: 2, retryWaitMs: 100, ttfbMs: null, durationMs: 400, waitMs: 20 }),
    );
    expect(t.segments.map((s) => [s.key, s.ms])).toEqual([
      ["wait", 20],
      ["retry", 100],
      ["rest", 300],
    ]);
    finite(t);
  });

  it("null and missing durations leave no segment and no NaN", () => {
    const t = timeline(
      timing({
        waitMs: null,
        jobWaitMs: null,
        ttfbMs: null,
        durationMs: null,
        retryWaitMs: 0,
        deadlineMs: 800,
      }),
    );
    expect(t.segments).toEqual([]);
    expect(t.totalMs).toBe(800);
    expect(t.deadlineAt).toBe(1);
    const none = timeline(timing({ waitMs: null, ttfbMs: null, durationMs: null, deadlineMs: 0 }));
    expect(none).toEqual({ segments: [], totalMs: 0, deadlineAt: null });
  });

  it("clamps inconsistent input so the segments never add past the bar", () => {
    // A retry wait longer than the whole duration, a ttfb longer than what is left, negatives, NaN.
    const cases: XchgTiming[] = [
      timing({ retryWaitMs: 900, durationMs: 400, ttfbMs: 300, attempts: 2 }),
      timing({ ttfbMs: 5000, durationMs: 400 }),
      timing({ waitMs: -50, jobWaitMs: -1, ttfbMs: -3, durationMs: 100, retryWaitMs: -9 }),
      timing({ waitMs: Number.NaN, ttfbMs: Number.POSITIVE_INFINITY, durationMs: 200 }),
      timing({ durationMs: 0, ttfbMs: 100, retryWaitMs: 50 }),
      timing({ durationMs: 400, deadlineMs: 0 }),
    ];
    for (const c of cases) {
      const t = timeline(c);
      expect(sumWidths(t)).toBeLessThanOrEqual(1 + 1e-9);
      finite(t);
      for (const s of t.segments) expect(s.ms).toBeGreaterThan(0);
      const durationPart = t.segments
        .filter((s) => ["retry", "ttfb", "rest"].includes(s.key))
        .reduce((a, s) => a + s.ms, 0);
      expect(durationPart).toBeLessThanOrEqual(Math.max(0, c.durationMs ?? 0) + 1e-9);
    }
    // No deadline: no marker.
    expect(timeline(timing({ deadlineMs: 0 })).deadlineAt).toBeNull();
  });

  it("every segment has a label and a help text for its tooltip", () => {
    const t = timeline(
      timing({ jobWaitMs: 5, waitMs: 5, retryWaitMs: 5, attempts: 2, ttfbMs: 5, durationMs: 40 }),
    );
    expect(t.segments).toHaveLength(5);
    for (const s of t.segments) {
      expect(s.label.length).toBeGreaterThan(2);
      expect(s.help.length).toBeGreaterThan(10);
    }
  });
});

describe("prettyBody", () => {
  const body = (o: Partial<CapturedBody> = {}): CapturedBody => ({
    text: '{"a":1,"b":[2]}',
    json: true,
    bytes: 15,
    truncated: false,
    ...o,
  });

  it("re-indents valid JSON", () => {
    expect(prettyBody(body())).toEqual({
      text: '{\n  "a": 1,\n  "b": [\n    2\n  ]\n}',
      formatted: true,
      note: null,
    });
  });

  it("falls back to the stored text for a truncated body, with a note holding the real size", () => {
    const b = body({ text: '{"a":1,"b":[2', truncated: true, bytes: 90_000 });
    const p = prettyBody(b);
    expect(p).toMatchObject({ text: '{"a":1,"b":[2', formatted: false });
    expect(p.note).toContain("truncated");
    expect(p.note).toContain("90,000 characters");
    expect(p.note).not.toContain("bytes");
  });

  it("a truncated body that happens to parse is still shown raw", () => {
    const p = prettyBody(body({ truncated: true, bytes: 70_000 }));
    expect(p.formatted).toBe(false);
    expect(p.text).toBe('{"a":1,"b":[2]}');
  });

  it("falls back to the stored text when json is claimed but the text does not parse", () => {
    const p = prettyBody(body({ text: "{not json", json: true }));
    expect(p).toEqual({ text: "{not json", formatted: false, note: null });
  });

  it("plain text (json false) is shown as stored, even when it would parse", () => {
    expect(prettyBody(body({ text: '{"a":1}', json: false })).formatted).toBe(false);
    expect(prettyBody(body({ text: "<html>x</html>", json: false })).text).toBe("<html>x</html>");
  });

  it("a null or missing body is empty", () => {
    expect(prettyBody(null)).toEqual({ text: "", formatted: false, note: null });
    expect(prettyBody(undefined)).toEqual({ text: "", formatted: false, note: null });
  });

  it("never turns text into markup: it returns the characters as they are", () => {
    const evil = "<img src=x onerror=alert(1)><script>x</script>";
    const p = prettyBody(body({ text: JSON.stringify({ a: evil }) }));
    expect(p.text).toContain(evil);
    expect(p.text).not.toContain("&lt;");
  });
});

describe("captureNotice / captureOffText / panelState", () => {
  it("the notice says the text is redacted prompt text, names the host, 'newest 100' and the purge command", () => {
    const n = captureNotice("api.typesafe.ai/v1/systemone");
    expect(n).toContain("Contains your redacted prompt text");
    expect(n).toContain("api.typesafe.ai");
    expect(n).not.toContain("/v1/systemone");
    expect(n).toContain("privacy.maxChars");
    expect(n).toContain("Only the newest 100 are kept");
    expect(n).toContain("eminiar adjudicator exchanges purge --yes");
    expect(n).toContain(PURGE_COMMAND);
    expect(n).toContain("local database");
  });

  it("the notice follows the server's keep and falls back to the Jev host", () => {
    expect(captureNotice(undefined, 50)).toContain("Only the newest 50 are kept");
    expect(captureNotice(null)).toContain("api.typesafe.ai");
    expect(captureNotice("")).toContain("api.typesafe.ai");
    expect(captureNotice("localhost:8080/v1/systemone")).toContain("sent to localhost:8080 (");
  });

  it("targetHost keeps the host only", () => {
    expect(targetHost("api.typesafe.ai/v1/x")).toBe("api.typesafe.ai");
    expect(targetHost("  host:9/p?q=1#f ")).toBe("host:9");
    expect(targetHost(null)).toBe("api.typesafe.ai");
    expect(targetHost("/only/a/path")).toBe("api.typesafe.ai");
  });

  it("the capture-off text includes the exact enable command and says it is personal", () => {
    const t = captureOffText();
    expect(t.command).toBe("eminiar adjudicator exchanges on");
    expect(t.command).toBe(CAPTURE_COMMAND);
    expect(t.before).toContain("Request capture is off");
    expect(t.before.trimEnd().endsWith("run")).toBe(true);
    expect(t.after).toContain("personal setting");
    expect(t.after).toContain("eminiar.config.json cannot turn it on");
    expect(t.after).toContain("redacted prompt text");
    expect(`${t.before} ${t.command} ${t.after}`).toContain(
      "run eminiar adjudicator exchanges on It is",
    );
  });

  it("the empty text explains the background job", () => {
    expect(CAPTURE_EMPTY_TEXT).toContain("Capture is on");
    expect(CAPTURE_EMPTY_TEXT).toContain("background");
  });

  it("panelState: loading, hidden, off, empty, rows", () => {
    expect(panelState(null)).toBe("loading");
    expect(panelState(undefined)).toBe("loading");
    expect(panelState({ active: false })).toBe("hidden");
    expect(panelState({ active: true, capture: false })).toBe("off");
    expect(panelState({ active: true, capture: true, rows: [] })).toBe("empty");
    expect(panelState({ active: true, capture: true, rows: [{}] })).toBe("rows");
  });
});

describe("small formatters", () => {
  it("fmtMs", () => {
    expect(fmtMs(412)).toBe("412 ms");
    expect(fmtMs(1200)).toBe("1.2 s");
    expect(fmtMs(null)).toBe("—");
    expect(fmtMs(undefined)).toBe("—");
    expect(fmtMs(Number.NaN)).toBe("—");
  });

  it("fmtBytes", () => {
    expect(fmtBytes(0)).toBe("0 B");
    expect(fmtBytes(512)).toBe("512 B");
    expect(fmtBytes(1536)).toBe("1.5 KiB");
    expect(fmtBytes(65_536)).toBe("64 KiB");
    expect(fmtBytes(5 * 1024 * 1024)).toBe("5.0 MiB");
    expect(fmtBytes(-1)).toBe("—");
    expect(fmtBytes(null)).toBe("—");
    expect(fmtBytes(Number.NaN)).toBe("—");
  });

  it("fmtChars labels a length in characters, never bytes", () => {
    expect(fmtChars(0)).toBe("0 characters");
    expect(fmtChars(1)).toBe("1 character");
    expect(fmtChars(65_536)).toBe("65,536 characters");
    expect(fmtChars(-1)).toBe("—");
    expect(fmtChars(null)).toBe("—");
    expect(fmtChars(Number.NaN)).toBe("—");
  });

  it("tokensLabel", () => {
    expect(tokensLabel(1500, 80)).toBe("1.5k / 80");
    expect(tokensLabel(null, null)).toBe("— / —");
    expect(tokensLabel(0, 0)).toBe("0 / 0");
  });

  it("waitLabel and triesLabel", () => {
    expect(waitLabel({ waitMs: 12, jobWaitMs: null })).toBe("12 ms");
    expect(waitLabel({ waitMs: 12, jobWaitMs: 0 })).toBe("12 ms");
    expect(waitLabel({ waitMs: 12, jobWaitMs: 3400 })).toBe("12 ms · job +3.4 s");
    expect(waitLabel({ waitMs: null, jobWaitMs: null })).toBe("—");
    expect(triesLabel({ attempts: 1, retryWaitMs: 0 })).toBe("1");
    expect(triesLabel({ attempts: 2, retryWaitMs: 120 })).toBe("2 · ↻ 120 ms");
  });

  it("relTime", () => {
    const now = Date.UTC(2026, 10, 4, 12);
    expect(relTime(now - 5_000, now)).toBe("just now");
    expect(relTime(now + 5_000, now)).toBe("just now");
    expect(relTime(now - 5 * 60_000, now)).toBe("5m ago");
    expect(relTime(now - 3 * 3_600_000, now)).toBe("3h ago");
    expect(relTime(now - 2 * 86_400_000, now)).toBe("2d ago");
    expect(relTime(0, now)).toBe("—");
    expect(relTime(Number.NaN, now)).toBe("—");
  });
});

describe("JevExchanges.tsx renders text nodes only", () => {
  const dir = join(__dirname, "../../src/ui/web/views");
  const files = ["JevExchanges.tsx", "xchg-helpers.ts"];

  for (const f of files) {
    it(`${f} has no dangerouslySetInnerHTML, innerHTML, outerHTML or insertAdjacentHTML`, () => {
      const src = readFileSync(join(dir, f), "utf8");
      expect(src).not.toMatch(/dangerouslySetInnerHTML/);
      expect(src).not.toMatch(/\.innerHTML|\bouterHTML|insertAdjacentHTML|document\.write/);
      expect(src).not.toMatch(/\beval\s*\(|new Function\s*\(/);
    });
  }

  it("the view shows a captured body as a child of <pre>, never as markup", () => {
    const src = readFileSync(join(dir, "JevExchanges.tsx"), "utf8");
    expect(src).toMatch(/<pre[^>]*>\s*\{/);
    expect(src).toContain("prettyBody(");
  });

  it("the helpers stay loadable in node: no Preact, no DOM, no ../api.js value import", () => {
    const src = readFileSync(join(dir, "xchg-helpers.ts"), "utf8");
    expect(src).not.toMatch(/from\s+["']preact/);
    expect(src).not.toMatch(/\bdocument\.|\bwindow\./);
    expect(src).not.toMatch(/import\s+(?!type\b)[^;]*from\s+["']\.\.\/api\.js["']/);
  });
});
