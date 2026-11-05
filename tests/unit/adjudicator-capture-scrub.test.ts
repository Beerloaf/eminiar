/**
 * Jev exchange log, scrub order and cut boundaries (task #196, review-xchg R2, R3, R5, R6 and the
 * fail() nit): providers/capture.ts and providers/http.ts. A stubbed fetch only: no network.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// Counts redact() calls (the nit: a capture-off failure must not scrub one more time).
vi.mock("../../src/adjudicator/redact.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/adjudicator/redact.js")>();
  return { ...actual, redact: vi.fn(actual.redact) };
});

import {
  captureBody,
  captureText,
  EXCHANGE_BODY_MAX,
  SCRUB_WINDOW,
} from "../../src/adjudicator/providers/capture.js";
import { type FetchLike, postJson, scrub } from "../../src/adjudicator/providers/http.js";
import { redact } from "../../src/adjudicator/redact.js";
import type { HttpExchange } from "../../src/adjudicator/types.js";

/** An opaque vendor key in no specific-rule format (not sk-/ghp_/…), 30 characters. */
const KEY = "tsk9Qw7Er5Ty3Ui1Op8As6Df4Gh2Jk";
/** Any 8 leading characters of the key in stored text count as a leak. */
const PREFIX = KEY.slice(0, 8);
const ZW = `${KEY.slice(0, 10)}​${KEY.slice(10)}`;
const FW = [...KEY]
  .map((c) => String.fromCodePoint((c.codePointAt(0) as number) + 0xfee0))
  .join("");

const redactMock = vi.mocked(redact);

beforeEach(() => {
  redactMock.mockClear();
});

interface Run {
  x: HttpExchange | undefined;
  err: unknown;
  logs: string[];
  ms: number;
}

async function call(status: number, body: string, o: { exchange?: boolean } = {}): Promise<Run> {
  const r: Run = { x: undefined, err: undefined, logs: [], ms: 0 };
  const fetch: FetchLike = async () => new Response(body, { status });
  const t0 = performance.now();
  try {
    await postJson(
      "https://api.typesafe.ai/v1/systemone",
      { q: "hello" },
      {
        deadlineMs: 5000,
        key: KEY,
        fetch,
        retry: false,
        log: (l) => r.logs.push(l),
        ...(o.exchange === false ? {} : { exchange: (x: HttpExchange) => (r.x = x) }),
      },
    );
  } catch (e) {
    r.err = e;
  }
  r.ms = performance.now() - t0;
  return r;
}

/** Everything a failed call can leave behind: the record, the thrown error and the log lines. */
function stored(r: Run): string {
  const e = r.err as { message?: string; body?: string } | undefined;
  return JSON.stringify([r.x?.response?.text, r.x?.error, e?.message, e?.body, r.logs]);
}

describe("R2: an echoed key hidden by a zero-width character or fullwidth forms", () => {
  for (const [label, echoed] of [
    ["zero-width", ZW],
    ["fullwidth", FW],
  ] as const) {
    it(`${label}: never becomes the plain key in a capture or in scrub()`, () => {
      expect(echoed).not.toContain(KEY);
      const json = captureText(JSON.stringify({ error: "unauthorized", received: echoed }), KEY);
      expect(json.json).toBe(true);
      expect(json.text).not.toContain(KEY);
      expect(json.text).not.toContain(PREFIX);
      expect(JSON.parse(json.text)).toEqual({ error: "unauthorized", received: "***" });
      const text = captureText(`upstream said: received ${echoed} (bad)`, KEY);
      expect(text.json).toBe(false);
      expect(text.text).toBe("upstream said: received *** (bad)");
      expect(scrub(`got ${echoed}`, KEY)).toBe("got ***");
      // An object key that is the hidden key is scrubbed too.
      expect(captureBody({ [echoed]: 1 }, KEY).text).toBe('{"***":1}');
    });

    it(`${label}: an error response leaves it out of the record, the error and the log`, async () => {
      const r = await call(401, JSON.stringify({ error: { message: `invalid key ${echoed}` } }));
      expect(r.x?.outcome).toBe("http_error");
      expect(stored(r)).toContain("invalid key ***");
      expect(stored(r)).not.toContain(KEY);
      expect(stored(r)).not.toContain(PREFIX);
    });
  }
});

describe("R3: no key prefix at a cut", () => {
  it("a huge text body: the key straddling the scrub window leaves nothing, even when the head shrinks", () => {
    // An inline base64 image collapses to "[b64]", so the window's tail lands inside the kept cap.
    const blob = `data:image/png;base64,${"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg".repeat(800)}`;
    let pre = `<html><img src="${blob}"><p>request debug: {"api_key": "`;
    pre += " ".repeat(SCRUB_WINDOW - 22 - pre.length); // 22 of the key's 30 chars are in the window
    const body = `${pre}${KEY}"}</p>${"x".repeat(1_100_000)}`;
    const c = captureText(body, KEY);
    expect(c.truncated).toBe(true);
    expect(c.json).toBe(false);
    expect(c.bytes).toBe(body.length);
    expect(c.text.length).toBeLessThan(EXCHANGE_BODY_MAX); // the head did shrink
    expect(c.text).toContain("request debug");
    expect(c.text).not.toContain(KEY.slice(0, 4));
  });

  it("a key hidden by a zero-width character and cut by the window leaves nothing either", () => {
    const pre = "z ".repeat(SCRUB_WINDOW / 2 - 6);
    const c = captureText(`${pre}${ZW}${"y".repeat(SCRUB_WINDOW)}`, KEY);
    expect(c.text).not.toContain(KEY.slice(0, 4));
  });

  it("the error snippet: scrubbed before it is cut, so shrinking echoes cannot pull a prefix in", async () => {
    let pre = `{"echo":"${`${KEY} `.repeat(15)}`; // 15 echoes, each 30 → 3 characters after the scrub
    pre += "y".repeat(500 - 22 - pre.length); // the 16th straddles the 500-char snippet
    const r = await call(400, `${pre}${KEY}"}`);
    expect(r.x?.outcome).toBe("http_error");
    expect(stored(r)).not.toContain(KEY);
    expect(stored(r)).not.toContain(PREFIX);
    expect(r.x?.error).toMatch(/^HTTP 400: \{"echo":"\*\*\* \*\*\* /);
  });

  it("a 429 body is cut the same way", async () => {
    // Words, not one run: a 500-char run would collapse to "[b64]" and hide the prefix by luck.
    const r = await call(429, `${"busy ".repeat(100).slice(0, 500 - 22)}${KEY}`);
    expect(r.x?.outcome).toBe("rate_limited");
    expect(stored(r)).not.toContain(PREFIX);
  });
});

describe("R5: secret-named JSON fields are masked by name", () => {
  it("client_secret, cookie, set-cookie, authorization, api_key and secret arrays; the rest intact", () => {
    const c = captureText(
      JSON.stringify({
        error: "denied",
        client_secret: "Zx81qL0wP",
        clientSecret: "Zx81qL0wQ",
        api_key: "short1",
        password: "",
        headers: {
          cookie: "session=AbC123xyz",
          "Set-Cookie": "sid=Qq9; Path=/",
          authorization: "Basic dXNlcjpwYXNz",
          "x-api-key": "k1k2k3",
        },
        tokens: ["t0kA", "t0kB"],
        access_tokens: ["t0kC"],
        nested: { db_password: ["p4ssA", { note: "plain words stay" }] },
        usage: { input_tokens: 9, output_tokens: 2 },
        max_tokens: 64,
        token_count: "12",
        keyEnv: "TYPESAFE_API_KEY",
      }),
      KEY,
    );
    expect(c.json).toBe(true);
    const v = JSON.parse(c.text) as Record<string, unknown>;
    expect(v).toMatchObject({
      error: "denied",
      client_secret: "***",
      clientSecret: "***",
      api_key: "***",
      password: "",
      headers: {
        cookie: "***",
        "Set-Cookie": "***",
        authorization: "***",
        "x-api-key": "***",
      },
      nested: { db_password: ["***", { note: "plain words stay" }] },
      usage: { input_tokens: 9, output_tokens: 2 },
      max_tokens: 64,
      token_count: "12",
      keyEnv: "TYPESAFE_API_KEY",
    });
    for (const secret of [
      "Zx81qL0w",
      "AbC123xyz",
      "Qq9",
      "dXNlcjpwYXNz",
      "k1k2k3",
      "short1",
      "p4ssA",
    ])
      expect(c.text).not.toContain(secret);
  });

  it("a secret name hidden by a zero-width character is still a secret name", () => {
    const c = captureBody({ "client​_secret": "Zx81qL0wP" }, KEY);
    expect(c.text).toBe('{"client_secret":"***"}');
  });
});

describe("R6: bounded work on a huge 2xx body", () => {
  it("a 7 MB JSON answer is not scrubbed whole: its head is stored, the call stays fast", async () => {
    const big = JSON.stringify({
      answers: {},
      junk: Array.from({ length: 50_000 }, (_, i) => ({
        k: `item ${i} password=abc${i} https://u:p@h/x ${KEY}`,
        v: "z".repeat(80),
      })),
    });
    expect(big.length).toBeGreaterThan(7_000_000);
    const r = await call(200, big);
    expect(r.err).toBeUndefined();
    expect(r.x?.outcome).toBe("ok");
    const res = r.x?.response;
    expect(res?.json).toBe(false);
    expect(res?.truncated).toBe(true);
    expect(res?.bytes).toBe(big.length);
    expect(res?.text.length).toBeLessThanOrEqual(EXCHANGE_BODY_MAX);
    expect(res?.text).not.toContain(PREFIX);
    expect(res?.text).not.toContain("password=abc1 ");
    // The whole-body structural scrub took ~500 ms; the head-only one takes a few. JSON.parse of
    // the 7 MB answer (the provider needs it) is most of what is left.
    expect(r.ms).toBeLessThan(300);
  });

  it("a body up to the window is still scrubbed structurally and stays JSON", async () => {
    const r = await call(200, JSON.stringify({ answers: {}, pad: "w ".repeat(40_000) }));
    expect(r.x?.response?.json).toBe(true);
    expect(r.x?.response?.truncated).toBe(true);
  });
});

describe("nit: a capture-off failure does no extra scrub", () => {
  it("a timeout with no exchange sink and no log runs redact() zero times", async () => {
    const fetch: FetchLike = async () => new Response("{}");
    await expect(
      postJson(
        "https://api.typesafe.ai/v1/systemone",
        { q: 1 },
        { deadlineMs: 0, key: KEY, fetch },
      ),
    ).rejects.toMatchObject({ kind: "timeout" });
    expect(redactMock).not.toHaveBeenCalled();
  });

  it("with a sink the error column is still written, scrubbed", async () => {
    let x: HttpExchange | undefined;
    const fetch: FetchLike = async () => new Response(`bad ${KEY}`, { status: 500 });
    await expect(
      postJson(
        "https://api.typesafe.ai/v1/systemone",
        { q: 1 },
        { deadlineMs: 2000, key: KEY, fetch, exchange: (r) => (x = r) },
      ),
    ).rejects.toMatchObject({ kind: "http_error" });
    expect(x?.error).toBe("HTTP 500: bad ***");
    expect(redactMock).toHaveBeenCalled();
  });
});
