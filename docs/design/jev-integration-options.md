# Design: further opt-in Jev integrations

Status: implemented · 2026-11-05 · foundation and options A to G are built on branch feature/jev-integrations; user-facing docs are in [Features](adjudicator.md#features)

Jev is TypeSafe's "System One" model. It does not write text. It answers typed questions
(`Choice`, `Score`, `Noul` = yes/no) and returns a calibrated probability per answer, in
about 100 ms, at $0.042 per million input tokens (output is free).

eminiar uses it in one place today: the `typesafe` provider of the [adjudicator](adjudicator.md),
which blends Jev's tier, role, complexity and risk answers onto the heuristic. The options below
were first written for Jev. They are now built provider-generic: each feature asks typed
questions through one decision client and runs on whichever adjudicator provider is configured
(Jev, an OpenAI-compatible server or the offline embedding provider). Jev is one provider, not a
requirement. Where the text says "Jev" in an option, read "the configured provider". This note lists
other places where eminiar has a fuzzy decision that a Jev call could improve, what comparable
projects do, and which ones to build first.

## Ground rules (apply to every option)

These come from the existing adjudicator and are not up for debate per option:

1. **Opt-in twice.** The feature needs `adjudicator.enabled`, a working provider (not the
   heuristic) and, for a remote provider, the existing remote consent plus its own data-class
   consent, and its own flag under `adjudicator.features.<name>` (default `false`). Off costs one
   boolean check. A local provider needs no consent.
2. **The deterministic path stays.** Every feature has a non-Jev behaviour it falls back to on
   timeout, breaker-open, no key or low confidence. Jev adjusts, it never replaces.
3. **Same privacy plumbing.** Text goes through `redact.ts` / `forRemote`, is cut to
   `privacy.maxChars`, is counted by the budget and breaker, and shows up in the opt-in
   exchange log. Project config cannot turn a feature on remotely (same trust split as
   `provider` and `typesafe`).
4. **Advice, not enforcement.** Nothing denies or blocks a tool call (see "What it does not do").
5. **Prove it with an eval.** A feature ships only if an eval on held-out items beats the
   non-Jev path, the way `adjudicator/jev-blend-tuning` was decided.

## What similar projects do

Taken from the [awesome-jev](https://github.com/kraayenjon/awesome-jev/wiki) list. I read the
list entries, not the source of each repo, so treat the details as the authors' own claims.

| Pattern | Projects | What Jev decides |
|---|---|---|
| Context triage | [fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction) (Claude Code plugin), [Jev Logs](https://github.com/reachjalil/jevlogs) | Score each tool call or log line for usefulness and drop the stale ones instead of summarising |
| Retrieval rerank | [jevsearch](https://github.com/kylemclaren/jevsearch), [Milvus Model](https://github.com/milvus-io/milvus-model), [Vector Graph RAG](https://github.com/zilliztech/vector-graph-rag), [JevPDF](https://github.com/kylemclaren/jevpdf) | One `Noul` per query/candidate pair on top of keyword or vector hits; keep the original order if the call fails |
| Skill and tool pick | [SkillRanker](https://github.com/Dicklesworthstone/skillranker) (Claude Code hooks), [ask-jev-skill](https://github.com/shantanugoel/ask-jev-skill) | Rank which skill fits the next step from live session context |
| Commit and diff checks | [jev-commit](https://github.com/valentynkit/jev-commit), [jev-secret-detection](https://github.com/teyhouse/jev-secret-detection), [commit-miner](https://github.com/devanshbatham/commit-miner) | Does the message match the staged diff, are there debug leftovers, is there a credential |
| Loop and completion judges | [ProgressGate](https://github.com/AshutoshVJTI/progressgate), [Foreman](https://github.com/thruwire/foreman), [Bicameral](https://github.com/AbdelStark/bicameral) | Judge the trajectory (continue / warn / replan / halt), judge completeness independently of the model that did the work |
| Harness layers | [jev-harness](https://github.com/AntonioCoppe/jev-harness), [pi-jev](https://github.com/y0usaf/pi-jev), [pi-warden](https://github.com/DevMortimer/pi-warden) | Policy plus a confidence gate plus **shadow mode** (log what Jev would have done before acting on it) |
| Triage with feedback | [typeful-triage](https://github.com/cephalization/jev-triage) | Fixed typed questions per item; human corrections shown back on later runs |
| Option-count limit | [jev-tree](https://github.com/reachjalil/jev-tree) | Recursive `Choice` for taxonomies over Jev's 255-option cap |

Two practices recur and are worth copying: **shadow mode first** and **threshold the
probability in code** rather than trusting the top answer.

## Options

Each option names the eminiar seam it plugs into, the Jev question shape, and the risks.

### A. Recall precision (rerank memories and doc pages)

- **Today:** `recallForText` / `qualifies` in `src/session/recall.ts` pick memories and indexed
  doc pages by shared terms and `requiredMatches`. This is why an unrelated memory sometimes
  rides along, and why a good one with different words is missed.
- **With Jev:** after the term match produces up to ~8 candidates, ask one `Noul` per candidate
  ("does this memory help with this prompt?"). Drop below a threshold, reorder above it. A
  `Choice` over candidates is the cheaper variant (one question, one pass).
- **Comparable:** jevsearch, Milvus Model, Vector Graph RAG.
- **Cost/latency:** one request of ~8 short items per prompt. Runs in the UserPromptSubmit hook,
  which has a tight time budget (see the `fix/hook-time-budget` work), so it must use the
  existing deferred-verdict pattern in `adjudicator/async.ts`: serve the term-matched result now,
  cache the Jev verdict for the next prompt or the MCP `em_recall` path (no hook limit there).
- **Eval:** replay recorded recall traces (`RecallTrace` already stores candidates) and compare
  helpful-memory hit rate against the term-only baseline.
- **Risk:** low. Worst case is the current behaviour.

### B. Memory hygiene on `em_remember`

- **Today:** a new memory is written as given. Supersession is manual (`supersedes`), so
  near-duplicates and stale decisions accumulate.
- **With Jev:** on write, take the top-k nearest existing memories (embedding search already
  exists) and ask one `Choice` per neighbour: `duplicate | supersedes | related | unrelated`.
  Surface the result in the tool reply ("this looks like it supersedes X; pass `supersedes` to
  confirm"). It never edits memories on its own.
- **Comparable:** typeful-triage (fixed typed questions with human correction).
- **Cost:** one call per `em_remember`, off the hot path.
- **Risk:** low, because the output is a suggestion. Needs the stored text to pass redaction,
  and memories are user-authored, so the consent copy must say memory text leaves the machine.

### C. Pre-commit review note (advice only)

- **Today:** a git commit gets `commitContext` (bug-prone files from `em_history`).
- **With Jev:** one call on the staged diff summary and message: does the message match the diff,
  debug leftovers, unmentioned work, possible credential. Added to the existing commit context
  as one line, never as a block.
- **Comparable:** jev-commit, jev-secret-detection. jev-commit blocks only on a credential. We
  would not block at all.
- **Risk:** the diff is the most sensitive text in this list. It needs a stricter default
  (`maxChars`, file allow/deny globs, and redaction that is stricter than the prompt path), and
  the consent text must name diffs. Recommend deferring until A and B have proven the plumbing.

### D. Compaction and output triage

- **Today:** `pre-compact.ts` writes a snapshot within `SNAPSHOT_BUDGET` (2 KB), and
  `em_execute` filters large output by `intent` with keyword search.
- **With Jev:** score session events and output sections for usefulness to the current task and
  keep the highest within the budget, instead of recency/keyword order.
- **Comparable:** fast-jev-compaction (the closest match: it is also a Claude Code plugin),
  Jev Logs.
- **Risk:** medium. `pre-compact` runs at a moment where a slow or failed call is costly, and
  `em_execute` output can hold secrets or customer data, so the redaction bar is high. A
  wrong drop is invisible to the user. Start in shadow mode and record what would have been
  dropped.

### E. Swarm progress and completion judge

- **Today:** the coordinator reads the task board and decides by itself when a worker is stuck or
  done. `reviewer` is an LLM agent.
- **With Jev:** a typed check on a task's trail (blackboard posts, status changes): `stalled`,
  `looping`, `done_claims_match_evidence`, `needs_human`. Surfaces as a flag on the task board
  and in `em_swarm status`.
- **Comparable:** ProgressGate, Foreman, Bicameral.
- **Cost:** per task transition, small.
- **Risk:** medium. A false "stalled" can make a coordinator interrupt good work, so it is a
  badge with its probability, never an automatic action. Fits the existing per-role model
  advice in `swarm/hooks.ts`.

### F. Doc-KB discovery triage

- **Today:** `em_docs discover` lists dependencies and a "recommended" set by rule.
- **With Jev:** `Score` each dependency by how much a coding agent benefits from having its docs
  indexed (framework or API with a large surface versus a tiny util).
- **Comparable:** Notra's classifier routing.
- **Risk:** very low, one call per discover, only package names leave the machine. Also low
  value: discover runs rarely. Listed for completeness.

### G. Error recurrence matching

- **Today:** `recallForError` finds earlier occurrences by normalised text.
- **With Jev:** a `Noul` per candidate: "is this the same underlying failure?". Same mechanism as
  A, scoped to the error path, and a good test bed because errors already carry a fix record.
- **Fold into A** rather than building separately.

### Not proposed

- **Skill ranking (SkillRanker).** The adjudicator already picks the `em_*` tool and the swarm
  role. Extending it to arbitrary skills is the same code with a bigger option list, and the
  255-option cap that jev-tree works around is the limit. Revisit if tool choice grows.
- **Blocking tool-call gates (pi-jev-auto-mode, pi-warden).** They conflict with "never denies
  or blocks a tool call". Shadow-mode logging of what a gate would have done is possible later.

## Comparison

| Option | Value | Hot path? | Data that leaves | Risk | Effort |
|---|---|---|---|---|---|
| A. Recall precision (+G) | High: every prompt | Yes, use deferred verdicts | Prompt + memory snippets | Low | M |
| B. Memory hygiene | Medium | No | Memory text | Low | S |
| C. Pre-commit note | Medium | Commit hook | **Diff text** | Medium | M |
| D. Compaction triage | Medium | Yes (compact) | Session events, tool output | Medium | L |
| E. Swarm judge | Medium | No | Task trail | Medium | M |
| F. Doc-KB triage | Low | No | Package names | Very low | S |

## Recommendation

1. **Foundation first.** `createTypesafeProvider` is shaped around the adjudicator's own
   questions. Extract a small `JevClient.ask(kind, items, schema)` that reuses `http.ts`,
   `redact.ts`, budget, breaker and exchange capture, and add the
   `adjudicator.features.*` flags and a per-feature consent line. The adjudicator provider
   becomes the first caller, with no behaviour change.
2. **Then A (with G), then B.** Highest value for the least data and risk, and both can be
   evaluated offline from data eminiar already records. Ship each behind shadow mode: log
   Jev's verdict next to the baseline for a while, then enable the blend, as the
   `jev-blend-tuning` eval did.
3. **E next**, once the dashboard's Jev impact panel can show per-feature help/hurt counts.
4. **C and D only after** the redaction bar for diffs and tool output has its own review. F
   whenever convenient.

## Decisions taken

- **D1. One object per feature.** `adjudicator.features.<name>` holds `enabled`, `shadow`, the
  thresholds and the deadlines; `true` or `false` is accepted as shorthand for `{enabled}`.
  There is no list form.
- **D2. One consent line per data class.** Prompts are covered by the existing remote consent.
  Memory text, diffs, session guide and tool output, the swarm task trail and package names each
  have their own line, shown by `eminiar adjudicator features on <name>` and stored as
  `<class>@<origin>` in `adjudicator.featureConsent`. A changed `baseUrl` asks again. Local
  providers need none.
- **D3. A new section in the impact panel.** Per-feature calls, spend and help/hurt counts show in
  their own section of the dashboard's impact panel, next to the adjudicator's own figures.
- **D4. Shadow is per feature and on by default.** `eminiar adjudicator features on` starts in
  shadow; `features shadow <name> off` lets the feature act.
- **D5. All options went ahead:** the foundation, A with G, B, C, D, E and F, each behind its own
  flag, all off by default. The ordering in the recommendation above still describes how to
  evaluate them one at a time.

## Verification gaps

- Jev's latency and the 255-option cap come from the awesome-jev list and TypeSafe's public
  material, not from calls made for this note. Measure p50/p95 from this repo's exchange log
  before committing to the hot-path options.
- Project descriptions are from the list. I did not read their code.
