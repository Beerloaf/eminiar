---
name: adjudicator/capture-scrub-order
kind: decision
tags: [adjudicator, jev, privacy, redact, capture]
related: [file:src/adjudicator/providers/capture.ts, file:src/adjudicator/providers/http.ts, file:tests/unit/adjudicator-capture-scrub.test.ts]
created: 2026-11-05T13:28:52.943Z
updated: 2026-11-05T13:28:52.943Z
---

Jev exchange capture scrub rules (task #196, review-xchg R2/R3/R5/R6 + nit, 2026-11-05, branch feature/adjudicator). src/adjudicator/providers/capture.ts owns the key scrub: scrubKey(text, key) replaces the key verbatim, then the cleaned form (Default_Ignorable stripped + NFKC, the same clean redact() does) before AND after redact(), so a zero-width or fullwidth echo of the key never turns into the plain key. http.ts scrub() just calls scrubKey (capture.ts cannot import http.ts: cycle). Never cut raw text and then scrub: scrubHead(text, window, key) scrubs only the first `window` chars and drops a trailing key prefix, and callers cut the scrubbed result (BODY_SNIPPET=500 error snippet, rate_limited body, captureText head). Bounded work: SCRUB_WINDOW = 2*EXCHANGE_BODY_MAX (131072); a body longer than that is neither parsed nor scrubbed whole: head only, json false, truncated, true size in bytes. That covers the 2xx path too (http.ts now calls captureText(text, key, parsedJson), not captureBody(json)). The structural walk masks a non-empty string value (and the strings in an array) under a secret name, judged with redact.ts isSecretName on the cleaned name, plus cookie/set-cookie/proxy-authorization, as "***". Numbers stay numbers. http.ts fail() writes the error column only when there is a live record (`if (x) settle(...)`), so a capture-off failure costs no extra redact(). Tests: tests/unit/adjudicator-capture-scrub.test.ts (mocks redact to count calls).
