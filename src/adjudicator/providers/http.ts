import type { HttpExchange } from "../types.js";
import { captureBody, captureText, scrubHead, scrubKey } from "./capture.js";

/**
 * The shared HTTP layer of the adjudicator providers (docs/design/adjudicator.md §8): plain
 * fetch + AbortController, no SDKs. One deadline covers the whole call including the retry;
 * 429/529 are retried at most once and only when at least RETRY_MIN_REMAINING_MS remain.
 *
 * Keys: the caller passes the key it resolved at send time. It goes into the Authorization
 * header only; thrown errors and log lines never carry headers, and any substring equal to
 * the key is replaced with "***" (plus redact() for anything that looks like a token).
 */

/** The error classes of §8, named like the ProviderStatus values the engine stores. */
export type ProviderErrorKind = "timeout" | "http_error" | "rate_limited" | "invalid" | "no_key";

/** A retry is attempted only when at least this much of the deadline is left. */
export const RETRY_MIN_REMAINING_MS = 300;
/** Wait before the single 429/529 retry when the server sends no usable Retry-After. */
export const RETRY_BACKOFF_MS = 100;
/** Response text kept on an http_error (scrubbed), enough to detect a response_format 400. */
const BODY_SNIPPET = 500;

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  /** HTTP status, when the server answered. */
  readonly status: number | undefined;
  /** Scrubbed start of the response body, for http_error. */
  readonly body: string | undefined;
  constructor(
    kind: ProviderErrorKind,
    message: string,
    o: { status?: number; body?: string } = {},
  ) {
    super(message);
    this.name = "ProviderError";
    this.kind = kind;
    this.status = o.status;
    this.body = o.body;
  }
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface HttpOptions {
  /** Budget for the whole call in ms, from now (min of the surface budget and time remaining). */
  deadlineMs: number;
  /** The caller's signal; aborting it ends the call as a timeout. */
  signal?: AbortSignal | undefined;
  /** Sent as `Authorization: Bearer <key>` and scrubbed from every error and log line. */
  key?: string | undefined;
  headers?: Record<string, string> | undefined;
  /** Test seam; defaults to globalThis.fetch. */
  fetch?: FetchLike | undefined;
  now?: (() => number) | undefined;
  /** Diagnostic lines (retries, failures); already scrubbed. */
  log?: ((line: string) => void) | undefined;
  /** Retry a 429/529 once (default true). */
  retry?: boolean | undefined;
  /**
   * Jev request capture: called once, right after the first fetch starts, with a LIVE record that
   * http.ts keeps filling until the call ends (so a call the caller gives up on stays readable as
   * "pending"). Bodies are scrubbed and capped (capture.ts); headers and the key are never in it.
   * Without it nothing extra runs. A capture failure never changes the HTTP result.
   */
  exchange?: ((x: HttpExchange) => void) | undefined;
}

/** What a provider factory gets besides its config: test seams and the tool list. */
export interface ProviderDeps {
  fetch?: FetchLike | undefined;
  now?: (() => number) | undefined;
  /** Scrubbed diagnostic lines; the hooks pass hookLog. */
  log?: ((line: string) => void) | undefined;
  /** Where resolveKey looks for env keys (default process.env). */
  env?: NodeJS.ProcessEnv | undefined;
  /** The registered tool ids; the tool table is narrowed to these. */
  tools?: readonly string[] | undefined;
}

/** probe() budget when the caller's signal does not end it sooner. */
export const PROBE_TIMEOUT_MS = 2000;

export interface HttpResult<T = unknown> {
  status: number;
  json: T;
  /** Wall time of the whole call, retries included. */
  latencyMs: number;
  /** 1 or 2. */
  attempts: number;
}

/**
 * Remove the key and anything token-shaped from text that may reach a log or error. The key is
 * also found when an echo hid it with a zero-width character or wrote it in fullwidth forms
 * (capture.ts scrubKey, review-xchg R2).
 */
export function scrub(text: string, key?: string): string {
  return scrubKey(text, key);
}

export function postJson<T = unknown>(
  url: string,
  body: unknown,
  o: HttpOptions,
): Promise<HttpResult<T>> {
  return request<T>("POST", url, body, o);
}

export function getJson<T = unknown>(url: string, o: HttpOptions): Promise<HttpResult<T>> {
  return request<T>("GET", url, undefined, o);
}

/** Join a base URL and a path without doubling or dropping the slash. */
export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

async function request<T>(
  method: "GET" | "POST",
  url: string,
  body: unknown,
  o: HttpOptions,
): Promise<HttpResult<T>> {
  const now = o.now ?? Date.now;
  const doFetch: FetchLike = o.fetch ?? ((u, i) => globalThis.fetch(u, i));
  const start = now();
  const end = start + Math.max(0, o.deadlineMs);
  const target = safeTarget(url);
  const payload = method === "POST" ? JSON.stringify(body) : undefined;
  // Capture state: x is the live record (undefined when o.exchange is not set).
  let x: HttpExchange | undefined;
  let lastText: string | undefined;
  let lastStatus: number | undefined;
  const settle = (outcome: HttpExchange["outcome"], status: number | null, error?: string) => {
    if (!x) return;
    try {
      x.durationMs = now() - x.sentAt;
      x.status = status;
      if (x.response === null && lastText !== undefined) x.response = captureText(lastText, o.key);
      if (error !== undefined) x.error = error;
      x.outcome = outcome;
    } catch {
      x.outcome = outcome;
    }
  };
  const fail = (e: ProviderError): never => {
    // Only with a live record: a capture-off failure pays no extra scrub.
    if (x) settle(e.kind, e.status ?? lastStatus ?? null, scrub(e.message, o.key));
    o.log?.(scrub(`adjudicator ${method} ${target}: ${e.kind} ${e.message}`, o.key));
    throw e;
  };

  const headers: Record<string, string> = { accept: "application/json", ...o.headers };
  if (payload !== undefined) headers["content-type"] = "application/json";
  if (o.key) headers.authorization = `Bearer ${o.key}`;

  for (let attempt = 1; ; attempt++) {
    const remaining = end - now();
    if (remaining <= 0 || o.signal?.aborted)
      return fail(new ProviderError("timeout", `deadline of ${o.deadlineMs} ms passed`));

    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), remaining);
    const onAbort = () => ctl.abort();
    o.signal?.addEventListener("abort", onAbort, { once: true });
    let res: Response;
    let text: string;
    const attemptStart = now();
    try {
      // Never follow a redirect: a 3xx would re-send the prompt text and the key to a host the
      // user did not agree to (task #33). It is answered below as an http_error instead.
      const init: RequestInit = { method, headers, signal: ctl.signal, redirect: "manual" };
      if (payload !== undefined) init.body = payload;
      const sent = doFetch(url, init);
      if (o.exchange && !x) {
        // After the fetch started and before its await: scrubbing overlaps the network.
        try {
          const rec: HttpExchange = {
            method,
            target,
            sentAt: attemptStart,
            deadlineMs: o.deadlineMs,
            attempts: 1,
            retryWaitMs: 0,
            ttfbMs: null,
            durationMs: null,
            status: null,
            outcome: "pending",
            request: captureBody(body, o.key),
            response: null,
            error: null,
          };
          o.exchange(rec);
          x = rec;
        } catch {
          x = undefined;
        }
      }
      res = await sent;
      if (x) x.ttfbMs = now() - attemptStart;
      // The deadline also covers reading the body.
      text = await res.text();
      lastText = text;
      lastStatus = res.status;
    } catch (err) {
      if (ctl.signal.aborted || o.signal?.aborted || isAbort(err))
        return fail(new ProviderError("timeout", `no answer within ${o.deadlineMs} ms`));
      // Connection refused, DNS, TLS: the server never answered. Counts as a breaker failure.
      return fail(new ProviderError("http_error", `request failed: ${scrub(errText(err), o.key)}`));
    } finally {
      clearTimeout(timer);
      o.signal?.removeEventListener("abort", onAbort);
    }

    if ((res.status >= 300 && res.status < 400) || res.type === "opaqueredirect") {
      const to = res.headers.get("location");
      return fail(
        new ProviderError(
          "http_error",
          `HTTP ${res.status || "redirect"}: redirect${to ? ` to ${redirectTarget(to, url)}` : ""} refused; set the provider's base URL to the final endpoint`,
          { status: res.status },
        ),
      );
    }
    if (res.status === 429 || res.status === 529) {
      const wait = retryWait(res.headers.get("retry-after"));
      const left = end - now() - wait;
      if (o.retry !== false && attempt === 1 && left >= RETRY_MIN_REMAINING_MS) {
        o.log?.(`adjudicator ${method} ${target}: ${res.status}, retrying in ${wait} ms`);
        if (x) {
          x.attempts = 2;
          x.retryWaitMs = wait;
          x.ttfbMs = null;
        }
        // The first answer is superseded: the record keeps the final attempt's.
        lastText = undefined;
        lastStatus = undefined;
        if (!(await sleep(wait, o.signal)))
          return fail(new ProviderError("timeout", "aborted while waiting to retry"));
        continue;
      }
      return fail(
        new ProviderError("rate_limited", `HTTP ${res.status}`, {
          status: res.status,
          body: scrubHead(text, BODY_SNIPPET, o.key),
        }),
      );
    }
    if (res.status < 200 || res.status >= 300) {
      // Scrubbed before it is cut, so a key straddling the cut leaves no prefix (review-xchg R3).
      const snippet = scrubHead(text, BODY_SNIPPET, o.key);
      return fail(
        new ProviderError("http_error", `HTTP ${res.status}: ${snippet.slice(0, 160)}`, {
          status: res.status,
          body: snippet,
        }),
      );
    }
    let json: T;
    try {
      json = JSON.parse(text) as T;
    } catch {
      return fail(new ProviderError("invalid", "the response is not JSON", { status: res.status }));
    }
    if (x) {
      try {
        // A body over capture.ts SCRUB_WINDOW is not scrubbed whole: only its head is stored.
        x.response = captureText(text, o.key, json);
      } catch {
        x.response = null;
      }
      lastText = undefined;
    }
    settle("ok", res.status);
    return { status: res.status, json, latencyMs: now() - start, attempts: attempt };
  }
}

/** Retry-After in seconds (or an HTTP date); anything missing or odd uses the default backoff. */
function retryWait(header: string | null): number {
  if (!header) return RETRY_BACKOFF_MS;
  const s = Number(header);
  if (Number.isFinite(s) && s >= 0) return Math.round(s * 1000);
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : RETRY_BACKOFF_MS;
}

function sleep(ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(false);
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      resolve(false);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function isAbort(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
}

function errText(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = (err as { cause?: unknown }).cause;
  const code = cause && typeof cause === "object" ? (cause as { code?: unknown }).code : undefined;
  return typeof code === "string" ? `${err.message} (${code})` : err.message;
}

/** Host and path only: no query string or userinfo in log lines. */
function safeTarget(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return "(bad url)";
  }
}

/** A Location header resolved against the request URL, as host and path only. */
function redirectTarget(location: string, base: string): string {
  try {
    return safeTarget(new URL(location, base).href);
  } catch {
    return "(bad url)";
  }
}

/** One line for probe() results: the error class and a scrubbed message. */
export function probeDetail(err: unknown): string {
  if (err instanceof ProviderError) return `${err.kind}: ${err.message}`;
  return scrub(err instanceof Error ? err.message : String(err));
}
