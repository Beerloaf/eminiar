---
name: adjudicator/redact-rules
kind: decision
tags: []
related: [file:src/adjudicator/redact.ts, file:tests/unit/adjudicator-redact.test.ts]
created: 2026-11-04T11:55:22.686Z
updated: 2026-11-04T11:55:22.686Z
---

Adjudicator redact() design (branch feature/adjudicator, swarm run 20261104-483f39, task #34, 2026-11-04). src/adjudicator/redact.ts must stay linear on 100 KB inputs (tests/unit/adjudicator-redact.test.ts enforces < 20 ms realistic, < 100 ms per pathological input). Rules: (1) Secret `name = value` is two-step: ASSIGN_NAME (/g) finds `name<sep>` at identifier boundaries only; isSecretName() decides in code (split on _ . - and camelCase; the last word must be a secret word such as key/token/secret/pass/password/passphrase/pwd/credentials/auth/pat, or end in password/token/apikey…, optionally followed only by qualifiers like base/hash/v2), so keyEnv, apiKeyName, token_count, max_tokens, pass_through stay; only then the sticky ASSIGN_VALUE reads the value (quoted values with spaces capped at 512, bare values stop at whitespace/quote or a &;, that starts the next name=). Do not put the secret-word alternation back inside one regex with lazy/greedy identifier runs: it is quadratic. Values like ${X}, process.env.X, <placeholder>, true/false, short numbers are kept. (2) YAML block scalars under a secret key are masked line-based by maskYamlBlocks, which head()/forRemote() run BEFORE normalize() because normalize collapses indentation. (3) Every rule starting with \b and an unbounded class must start at the start of its run (lookbehind), e.g. the email rule, or `--a-a-a…` goes quadratic. (4) Rules are idempotent (lookaheads skip `***`). Accepted as inherent: secrets split across lines; prose only masked for "password is/was <word with a digit or symbol>".
