/**
 * Pure helpers for the Jev request log (no Preact, no DOM) so the node test suite can load them:
 * the result label and tone of a request, the duration-against-deadline fraction, the segments
 * of the timing bar, how a stored body is shown, and the panel's gating and fixed texts.
 *
 * Types come type-only from the node side (src/adjudicator/types.ts is web-safe) and never from
 * ../api.ts, so this file stays loadable by the node tests.
 */
import type { CapturedBody, ExchangeSummary } from "../../../adjudicator/types.js";
import { ms, type Tone } from "./adjudicator-helpers.js";

/** The fields of a stored request the label, bar and timeline helpers read. */
export type XchgTiming = Pick<
  ExchangeSummary,
  | "outcome"
  | "status"
  | "timedOut"
  | "attempts"
  | "waitMs"
  | "jobWaitMs"
  | "ttfbMs"
  | "durationMs"
  | "retryWaitMs"
  | "deadlineMs"
>;

/** What the list endpoint answered, reduced to the fields the gate reads. */
export type XchgListInput =
  | { active: false }
  | { active: true; capture: false }
  | { active: true; capture: true; rows: readonly unknown[] };

export const CAPTURE_COMMAND = "eminiar adjudicator exchanges on";
export const PURGE_COMMAND = "eminiar adjudicator exchanges purge --yes";
/** The newest this many requests are kept; the server sends the real number as `keep`. */
export const DEFAULT_KEEP = 100;

const DEFAULT_HOST = "api.typesafe.ai";

/** Milliseconds as "—", "840 ms" or "1.2 s". */
export const fmtMs = (x: number | null | undefined): string => ms(x);

/** Bytes as "512 B", "3.4 KiB" or "1.2 MiB". */
export function fmtBytes(n: number | null | undefined): string {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return "—";
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KiB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
}

/**
 * A length in characters, as "512 characters" or "65,536 characters". A captured body's `bytes`
 * field is `text.length` (UTF-16 code units), so it must not be labelled in bytes.
 */
export function fmtChars(n: number | null | undefined): string {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return "—";
  const r = Math.round(n);
  return `${r.toLocaleString("en-US")} ${r === 1 ? "character" : "characters"}`;
}

/** Token counts as "1.2k / 340", "— / —" when neither is known. */
export function tokensLabel(
  tin: number | null | undefined,
  tout: number | null | undefined,
): string {
  const f = (n: number | null | undefined) =>
    typeof n !== "number" || !Number.isFinite(n)
      ? "—"
      : n >= 1000
        ? `${(n / 1000).toFixed(1)}k`
        : String(Math.round(n));
  return `${f(tin)} / ${f(tout)}`;
}

/**
 * How a request ended, for the pill: "200" for an answer, "timeout", "429 rate limited",
 * "http 503", "invalid". An outcome this build does not know is shown with its underscores
 * undone rather than hidden.
 */
export function resultLabel(x: Pick<XchgTiming, "outcome" | "status">): string {
  const st = typeof x.status === "number" && x.status > 0 ? x.status : null;
  switch (x.outcome) {
    case "ok":
      return st !== null ? String(st) : "ok";
    case "timeout":
      return "timeout";
    case "rate_limited":
      return st !== null ? `${st} rate limited` : "rate limited";
    case "http_error":
      return st !== null ? `http ${st}` : "http error";
    case "invalid":
      return "invalid";
    case "no_key":
      return "no key";
    default:
      return String(x.outcome).replace(/_/g, " ") || "unknown";
  }
}

/** ok → ok; timeout and http errors → bad; rate limits and invalid answers → warn. */
export function resultTone(outcome: string): Tone {
  switch (outcome) {
    case "ok":
      return "ok";
    case "timeout":
    case "http_error":
      return "bad";
    case "rate_limited":
    case "invalid":
      return "warn";
    default:
      return "muted";
  }
}

/**
 * Time the request took against its deadline: frac is durationMs / deadlineMs clamped to 0..1
 * (0 when either is unknown), over is true when the request used the whole deadline or timed out.
 */
export function deadlineFraction(x: Pick<XchgTiming, "durationMs" | "deadlineMs" | "timedOut">): {
  frac: number;
  over: boolean;
} {
  const d = x.durationMs;
  const dl = x.deadlineMs;
  if (typeof d !== "number" || !Number.isFinite(d) || typeof dl !== "number" || dl <= 0)
    return { frac: 0, over: x.timedOut };
  const raw = d / dl;
  return { frac: Math.min(1, Math.max(0, raw)), over: x.timedOut || raw >= 1 };
}

/** "12 ms", or "12 ms · job +3.4 s" when the request waited in the background job queue. */
export function waitLabel(x: Pick<XchgTiming, "waitMs" | "jobWaitMs">): string {
  const w = fmtMs(x.waitMs);
  return typeof x.jobWaitMs === "number" && x.jobWaitMs > 0
    ? `${w} · job +${fmtMs(x.jobWaitMs)}`
    : w;
}

/** Attempts, with the pause before the retry when there was one: "2 · ↻ 120 ms". */
export function triesLabel(x: Pick<XchgTiming, "attempts" | "retryWaitMs">): string {
  return x.retryWaitMs > 0 ? `${x.attempts} · ↻ ${fmtMs(x.retryWaitMs)}` : String(x.attempts);
}

/** A relative time for the table ("just now", "5m ago", "2h ago", "3d ago"); the title has the exact one. */
export function relTime(ts: number, now: number = Date.now()): string {
  if (!Number.isFinite(ts) || ts <= 0) return "—";
  const d = Math.max(0, now - ts);
  if (d < 6e4) return "just now";
  if (d < 36e5) return `${Math.round(d / 6e4)}m ago`;
  if (d < 864e5) return `${Math.round(d / 36e5)}h ago`;
  return `${Math.round(d / 864e5)}d ago`;
}

export type XchgSegmentKey = "job" | "wait" | "retry" | "ttfb" | "rest";

export interface XchgSegment {
  key: XchgSegmentKey;
  label: string;
  /** What the segment is, for its tooltip. */
  help: string;
  ms: number;
  /** Where it starts and how wide it is, as fractions (0..1) of the bar. */
  start: number;
  width: number;
}

export interface XchgTimeline {
  segments: XchgSegment[];
  /** Length the bar stands for: the segments' sum or the deadline marker, whichever is later. */
  totalMs: number;
  /** The deadline's position as a fraction of the bar, or null when there is none. */
  deadlineAt: number | null;
}

const num = (n: number | null | undefined): number =>
  typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0;

/**
 * The timing bar: queue wait in the background job (async only) | wait before the request was
 * sent | the pause before a retry | time to the first byte of the answer | the rest (reading the
 * body, and the first attempt when there was a retry). The deadline starts when the request is
 * sent, so its marker sits after the two waits. Fractions only, never pixels; the segments are
 * clamped so they cannot add past the bar.
 */
export function timeline(x: XchgTiming): XchgTimeline {
  const job = num(x.jobWaitMs);
  const wait = num(x.waitMs);
  const duration = num(x.durationMs);
  const retry = Math.min(num(x.retryWaitMs), duration);
  const ttfb = Math.min(num(x.ttfbMs), Math.max(0, duration - retry));
  const rest = Math.max(0, duration - retry - ttfb);
  const raw: Array<Omit<XchgSegment, "start" | "width">> = [
    {
      key: "job",
      label: "job wait",
      help: "queued in the background scoring job before it started",
      ms: job,
    },
    {
      key: "wait",
      label: "wait before send",
      help: "from the start of the call to the moment the request was sent",
      ms: wait,
    },
    {
      key: "retry",
      label: "retry wait",
      help: "pause before the second attempt, after a 429 or 529",
      ms: retry,
    },
    {
      key: "ttfb",
      label: "to first byte",
      help: "from sending the final attempt to the first byte of the answer",
      ms: ttfb,
    },
    {
      key: "rest",
      label: x.attempts > 1 ? "first attempt + body" : "body read",
      help:
        x.attempts > 1
          ? "the superseded first attempt and reading the final answer"
          : "reading the answer after its first byte",
      ms: rest,
    },
  ];
  const sum = raw.reduce((a, s) => a + s.ms, 0);
  const deadlineMs = num(x.deadlineMs);
  const deadlinePos = deadlineMs > 0 ? job + wait + deadlineMs : 0;
  const totalMs = Math.max(sum, deadlinePos);
  let at = 0;
  const segments: XchgSegment[] = raw
    .filter((s) => s.ms > 0)
    .map((s) => {
      const start = totalMs > 0 ? at / totalMs : 0;
      const width = totalMs > 0 ? s.ms / totalMs : 0;
      at += s.ms;
      return { ...s, start, width };
    });
  return {
    segments,
    totalMs,
    deadlineAt: deadlinePos > 0 && totalMs > 0 ? deadlinePos / totalMs : null,
  };
}

export interface PrettyBody {
  /** The text to show, as text (never markup). */
  text: string;
  /** True when it was re-indented JSON. */
  formatted: boolean;
  /** "truncated ... " when the stored body was capped, else null. */
  note: string | null;
}

/**
 * A stored body ready to show: JSON is re-indented only when the capture says it is JSON and it
 * was not cut (a truncated JSON text does not parse); anything else, or JSON that fails to
 * parse, is shown as it was stored. The truncation note carries the size before the cap.
 */
export function prettyBody(b: CapturedBody | null | undefined): PrettyBody {
  if (!b) return { text: "", formatted: false, note: null };
  const note = b.truncated
    ? `truncated: the stored text is cut, the body was ${fmtChars(b.bytes)}`
    : null;
  if (b.json && !b.truncated) {
    try {
      return { text: JSON.stringify(JSON.parse(b.text), null, 2), formatted: true, note };
    } catch {
      // fall through to the stored text
    }
  }
  return { text: b.text, formatted: false, note };
}

/** "api.typesafe.ai" from a stored target such as "api.typesafe.ai/v1/jev"; the default when none. */
export function targetHost(target: string | null | undefined): string {
  const t = (target ?? "").trim();
  if (!t) return DEFAULT_HOST;
  return t.split(/[/?#]/)[0] || DEFAULT_HOST;
}

/** The always-visible notice above the table when capture is on. */
export function captureNotice(target?: string | null, keep: number = DEFAULT_KEEP): string {
  return `Contains your redacted prompt text: each row is the exact request sent to ${targetHost(target)} (redacted, up to privacy.maxChars characters per item) and Jev's answer, stored in this project's local database. Only the newest ${keep} are kept. Delete them: ${PURGE_COMMAND}`;
}

/** The empty state when capture is off. */
export function captureOffText(): { before: string; command: string; after: string } {
  return {
    before:
      "Request capture is off. To see each request eminiar sends to Jev, what it contained, what came back and how long it took, run",
    command: CAPTURE_COMMAND,
    after:
      "It is a personal setting: a project's eminiar.config.json cannot turn it on. Captured requests contain your redacted prompt text.",
  };
}

/** The empty state when capture is on but nothing is stored yet. */
export const CAPTURE_EMPTY_TEXT =
  "Capture is on. No request has gone to Jev since. Prompt scoring runs in the background, so a request appears when that job finishes.";

export type XchgPanelState = "hidden" | "off" | "empty" | "rows";

/**
 * What the section shows for a list answer: nothing for {active:false} (the config changed since
 * the overview loaded), the enable instructions when capture is off, the empty note, or the table.
 */
export function panelState(r: XchgListInput | null | undefined): XchgPanelState | "loading" {
  if (!r) return "loading";
  if (!r.active) return "hidden";
  if (!r.capture) return "off";
  return r.rows.length ? "rows" : "empty";
}

/** The drawer's heading line: "Request #12 · <time> · 200". */
export function drawerTitle(
  x: Pick<ExchangeSummary, "id" | "ts" | "outcome" | "status">,
  absTime: string,
): string {
  return `Request #${x.id} · ${absTime} · ${resultLabel(x)}`;
}
