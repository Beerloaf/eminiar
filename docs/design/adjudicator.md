# Design: adjudicator (opt-in)

Status: proposed · swarm run `20261104-483f39` · branch `feature/adjudicator` · target v0.13.0 · 2026-11-04

## Constraints from Claude Code

The coordinator checked these against the Claude Code docs (sub-agents "Choose a model", hooks
PreToolUse/UserPromptSubmit, model-config). The design depends on them.

| Fact | Consequence |
|---|---|
| Subagent model precedence: the Agent call's `model` param, then the subagent frontmatter `model` (`inherit` means the main model), then `CLAUDE_CODE_SUBAGENT_MODEL`, then the main model. `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1` overrides all of them. Claude Code substitutes a model when the requested one is outside the org's `availableModels`. | When FORCE is set, the adjudicator never tries to change the model. |
| The Agent call's `model` accepts only `sonnet`, `opus`, `haiku` or `fable`: no `inherit` and no full ids. Frontmatter accepts aliases, full ids and `inherit`. | Tiers are limited to those four aliases. |
| `effort` is not an Agent tool input. Only agent-file frontmatter can set it. | Effort per dispatch is advice only. Never inject an `effort` key into the Agent input. |
| PreToolUse `updatedInput` replaces the whole input, so every unchanged field must be included. Rules are re-evaluated, and in auto mode a changed call without `permissionDecision` may be denied. The docs don't say whether a model set by a hook takes effect. | Rewriting through the hook is best-effort. Advice to the coordinator is the main, reliable path: `em_swarm plan` shows a suggested model per task and the coordinator passes `model` on the Agent call. The optional `apply` mode is opt-in, and a test must check that the merge keeps every field. |
| UserPromptSubmit cannot change the main session's model. It can only add context or block. | Main-session model choice is advice text only. |

**Product decision** (coordinator, from the user's request): choosing model size for dispatched
work is in scope. It does not violate `decision/usage-insights-no-proxy`, because nothing
intercepts API traffic. The adjudicator only gives advice and uses Claude Code's own Agent
`model` parameter. This is recorded as a decision memory at the end of the run.

## 1. What it is and why

The adjudicator is an optional subsystem and is off by default. It scores each piece of work for
complexity on a 0-4 scale: a user prompt, a subagent dispatch or a swarm task. For each one it
recommends:

- (a) the eminiar tool to start with,
- (b) the Claude model tier (haiku/sonnet/opus, plus an effort level),
- (c) the swarm role.

The point is to send small work to small models and to the right `em_*` tool, so sessions run
faster and cost less. Every recommendation comes with its reasons.

How it decides: a deterministic, feature-based heuristic always runs and is always the fallback.
It can be blended with one provider:

- TypeSafe Jev (typed choice/score/noul answers)
- any OpenAI-compatible endpoint (presets: Groq gpt-oss-20b, Cerebras, Ollama, LM Studio,
  llama.cpp, custom)
- local nearest-neighbour search over shipped exemplars, using the bge-small model eminiar
  already ships

### Non-goals

- Intercepting API traffic. `decision/usage-insights-no-proxy` still holds. We use only Claude
  Code's own Agent `model` parameter and hook text. Coordinator ruling: choosing a model this way
  is not "model routing".
- Changing the main session's model. Hooks cannot do it, so this is advice only.
- Denying or blocking any tool call.
- Generating free text.
- Cursor. Every surface returns early when `input.client === "cursor"`.

## 2. Principles

**P1 Off costs nothing.**

- Hooks test `ctx.config.adjudicator.enabled` (config is already loaded) before calling any
  adjudicator code.
- Adjudicator modules have no top-level side effects. They are bundled into `dist/hook.js`
  because tsup uses `splitting: false`, but they stay inert until called.
- When off: the `em_adjudicate` tool is not registered, and nothing is written to the DB or the
  network.
- Kill switch: `EMINIAR_ADJUDICATOR=0`.

**P2 Advice first.**

- The reliable path is advice: `em_swarm plan` lists a suggested role, model and effort for each
  task, and the coordinator passes `model` on the Agent call.
- `apply` mode is opt-in and best-effort: it rewrites the Agent input through PreToolUse
  `updatedInput`. Claude Code does not document whether a hook-set model takes effect, so we
  measure whether it did.

**P3 Fail open and fast.**

- Every path has a hard deadline (AbortController) and falls back to the heuristic.
- Providers sit behind a circuit breaker persisted in SQLite, a p95 latency guard and a daily
  spend cap.

**P4 Private by default.**

- The heuristic, embedding and localhost providers keep all data on the machine.
- Remote providers need explicit consent. `--yes` never implies it, and a committed project file
  cannot grant it.
- Remote providers also need a key, which lives only in `~/.eminiar/adjudicator.key` or an env
  var.
- We store hashes, scores and an 80-char redacted head of the input. We never store prompts or
  keys.

**P5 Explainable.**

- Every score-table entry carries reasons, e.g. `+1.6 verb 'refactor'`.
- Every decision can be inspected (`em_adjudicate explain`, the dashboard detail drawer, CLI
  `test`).

**P6 Measured.**

- Decisions are linked to outcomes (swarm task status, explicit feedback) and to the tokens
  actually spent (`api_calls`).
- Savings are reported net of the adjudicator's own spend, and the method is shown with every
  figure.

## 3. Module layout (new directory `src/adjudicator/`)

- `types.ts`: shared types and constants (`SCORER_VERSION`, `TIERS`, `TOOL_IDS`,
  `DEFAULT_ROLES`, `SURFACES`, `INTENTS`).
- `config.ts`: `resolveAdjudicator(config, env)` returns a `Resolved` object: the effective
  provider after consent, key and locality checks, plus a `degraded` reason. Also holds the
  `PRESETS` table and `isLoopback(url)`.
- `secrets.ts`: reads and writes the key file (0600, temp file + rename). Resolution order,
  `mask()`, permissions check, `resetSecrets()` test seam.
- `redact.ts`: `normalize()`, `inputHash()`, `redact()`, `head(n)`.
- `features.ts`: `extractFeatures(text, hints)` returns `Features`. Pure, under 1 ms.
- `heuristic.ts`: `scoreHeuristic(features, weights, catalogue)` returns a `ScoreSet` with
  reasons.
- `blend.ts`: `blend(heuristic, answer | undefined, bias, weights)` returns a `Verdict`.
  `formatAdvice(v)` builds the one-line hint.
- `prompt.ts`: the rubric and catalogue text, the Jev question builder, the OpenAI strict
  JSON-schema builder.
- `providers/http.ts`: `postJson`/`getJson` using fetch + AbortController, a deadline, error
  classes, and stripping of the key and headers from errors.
- `providers/typesafe.ts`, `providers/openai.ts`, `providers/index.ts`:
  `createProvider(resolved)` plus `registerProvider(id, factory)`, so the server and CLI can
  register `embedding` without the hook bundle ever referencing it.
- `providers/embedding.ts`: MCP server and CLI only. Registered at server start; never imported
  from hook code.
- `breaker.ts`: the breaker, the latency guard and the daily spend cap, all over
  `db.adjudicator`.
- `engine.ts`: `adjudicate(reqs, opts)` runs cache, then heuristic, then the provider gate, then
  the provider, then blend, then persist.
- `async.ts`: `spawnAsyncJob(job)` starts a detached child of the hook process; `runAsyncJob()`
  is the child entry (`em-hook --adjudicate`).
- `hooks.ts`: `onPrompt`, `onPreAgent`, `onPreTool`, `onSessionStart`, `onSessionEnd`. These are
  the only functions `src/hooks/*` call.
- `swarm.ts`: `adjudicatePlan(ctx, runId, tasks)` and `planLines(...)` for `em_swarm`.
- `learn.ts`: `reconcile(db, {limit})` (links outcomes, tokens and savings) and the learned
  per-bucket biases.
- `savings.ts`: baseline resolution, repricing through `src/usage/pricing.ts`, summaries.
- `eval.ts`: the eval harness. `cli.ts`: `eminiar adjudicator ...`.
- `data/evalset.ts`: the 40 labelled items from blackboard `research-local-3`.
- `data/exemplars.ts`: exemplar texts with labels, 15-30 per tier, disjoint from the eval set.

New files elsewhere: `src/storage/sqlite/adjudicator.ts`, `src/tools/em_adjudicate.ts`,
`src/ui/adjudicator-api.ts`, `src/ui/web/views/Adjudicator.tsx`, `docs/adjudicator.md`.

Hot files get thin call-outs only, never logic: `routing.ts` (risk 0.56), `capture.ts`,
`session-start.ts`, `sqlite/adapter.ts`, `adapter.ts`, `cli.ts`, `app.tsx`.

## 4. Public types (`src/adjudicator/types.ts`)

```ts
export const SCORER_VERSION = "1";
export type Surface = "prompt" | "agent" | "plan" | "tool" | "mcp" | "test";
export type Tier = "haiku" | "sonnet" | "opus" | "fable";          // the only Agent `model` values
export type Effort = "low" | "medium" | "high" | "xhigh";            // advice only
export type ProviderId = "heuristic" | "typesafe" | "openai-compatible" | "embedding";
export type Source = "heuristic" | "blend" | "cache" | "fallback";
export type ProviderStatus = "ok" | "timeout" | "http_error" | "rate_limited" | "invalid"
  | "breaker_open" | "slow_guard" | "over_budget" | "no_key" | "no_consent" | "skipped" | "n/a";
export type Intent = "lookup" | "impact" | "history" | "run" | "bigfile" | "docs" | "recall" | "plan"
  | "edit_small" | "implement" | "refactor" | "design" | "review" | "debug" | "research" | "test" | "git" | "ui" | "chat";
export interface Reason { feature: string; weight: number; note: string }
export interface ScoreEntry { option: string; score: number /* 0..1; one table sums to 1 */; reasons: Reason[] }
export interface ScoreTable { dimension: "tool" | "tier" | "role"; entries: ScoreEntry[] /* desc */; choice: string; confidence: number }
export interface Features {
  words: number; chars: number; lines: number; paths: number; symbols: number;
  codeBlock: boolean; stackTrace: boolean; intents: Partial<Record<Intent, number>>;
  scope: number /*0..1*/; risk: number /*0..1*/; chat: boolean; slash: boolean; classify?: string;
  task?: { role?: string; files: number; deps: number };
}
export interface ScoreSet {
  complexity: number /* 0..4 continuous */; complexityReasons: Reason[];
  tool: ScoreTable; tier: ScoreTable; role: ScoreTable; effort: Effort;
}
export interface AdjudicationRequest {
  key: string; surface: Surface; text: string;
  hints?: { role?: string; roles?: Array<{ name: string; description?: string }>; files?: number; deps?: number };
}
export interface Dist { probs: Record<string, number>; confidence: number; calibrated: boolean }
export interface ProviderAnswer {
  key: string; complexity?: { value: number; confidence: number };
  tier?: Dist; role?: Dist; tool?: Dist; risky?: number; needsPlan?: number;
}
export interface ProviderResult { answers: ProviderAnswer[]; usage: { inTok: number; outTok: number; costUsd: number }; latencyMs: number; model: string }
export interface AdjudicatorProvider {
  id: ProviderId; remote: boolean; dims: Array<"complexity" | "tier" | "role" | "tool">;
  adjudicate(reqs: AdjudicationRequest[], o: { signal: AbortSignal; deadlineMs: number }): Promise<ProviderResult>;
  probe(o: { signal: AbortSignal }): Promise<{ ok: boolean; latencyMs: number; detail: string }>;
}
export interface Verdict extends ScoreSet {
  id?: number; key: string; source: Source; provider: ProviderId; providerStatus: ProviderStatus;
  alpha: Partial<Record<"complexity" | "tier" | "role" | "tool", number>>; bias: Record<string, number>;
  latencyMs: number; providerLatencyMs?: number; usage?: ProviderResult["usage"]; version: string;
}
export interface AdjudicationRow { /* mirrors the adjudications table in §12, camelCase */ }
```

Every surface consumes a `Verdict`. `formatAdvice(v, surface)` renders a hint of at most 220
chars.

## 5. Config schema (`src/config.ts`, key `adjudicator`, every object `.prefault({})`)

```
adjudicator: {
  enabled: false,
  provider: "heuristic",          // heuristic | typesafe | openai-compatible | embedding
  mode: "advise",                 // advise | apply (apply may set the Agent `model`)
  surfaces: { prompt: true, agent: true, plan: true, tools: false },
  promptMode: "async",            // heuristic | async | blocking: the provider's role on UserPromptSubmit
  typesafe: { model: "jev-1.14.0", baseUrl: "https://api.typesafe.ai/v1" },
  openai: { preset: "groq", baseUrl?: url, model?: string, json: "auto" /* schema|object|auto */,
            price?: { inPerM: number, outPerM: number } },
  embedding: { k: 5, minSimilarity: 0.55 },
  keyEnv?: string,                // NAME of an env var, never a key
  remoteConsent: false,           // read ONLY from ~/.eminiar/config.json or env
  timeouts: { promptMs: 1200, agentMs: 800, planMs: 3000, localMs: 600, connectMs: 150 },
  minPromptChars: 12,
  tiers: ["haiku", "sonnet", "opus"],   // ordered ladder; "fable" may be inserted by the user
  weights: { providerMax: 0.7, embeddingMax: 0.4, selfReportScale: 0.6, lowConfidence: 0.55,
             tierCenters: { haiku: 0.6, sonnet: 2.0, opus: 3.4 }, features: {} /* per-feature overrides */ },
  apply: { scope: "swarm" /* swarm|all */, minConfidence: 0.7, floor: "haiku", ceiling: "opus", respectFrontmatter: true },
  advice: { mainSession: "user" /* off|user|context */, cooldownPrompts: 8 },
  learning: { enabled: true, maxBias: 0.3, minSamples: 5, halfLife: 50, costWeight: 0.05 },
  cache: { ttlHours: 24, maxEntries: 2000 },
  breaker: { failures: 2, cooldownSec: 120 },
  budget: { dailyUsd: 0.5 },
  privacy: { maxChars: 2000, storeHead: true }
}
```

Rules:

- **(a)** `envOverrides()` adds:
  - `EMINIAR_ADJUDICATOR=0|1` → `enabled`
  - `EMINIAR_ADJUDICATOR_PROVIDER`
  - `EMINIAR_ADJUDICATOR_MODE`
  - `EMINIAR_ADJUDICATOR_REMOTE=1` → `remoteConsent`
- **(b)** `loadConfig` deletes `adjudicator.remoteConsent` from the project layer
  (`<root>/eminiar.config.json`) before merging. Teams commit that file, and consent is personal.
- **(c)** A `superRefine` rejects any key inside `adjudicator` that matches
  `/(api_?key|token|secret|password)/i`, except `keyEnv`. The error tells the user to run
  `eminiar adjudicator key set`.
- **(d)** `install.ts` freezes `ConfigSchema.parse({})` into `~/.eminiar/config.json`, so every
  default above has to be safe to freeze. Optional fields stay undefined.
- **(e)** Run `scripts/gen-schema.ts` and commit the regenerated `eminiar.config.schema.json`.

### PRESETS (`config.ts`)

| preset | baseUrl | default model | key env | price $/Mtok in/out | locality |
|---|---|---|---|---|---|
| groq | `https://api.groq.com/openai/v1` | `openai/gpt-oss-20b` | `GROQ_API_KEY` | 0.075 / 0.30 | remote |
| cerebras | `https://api.cerebras.ai/v1` | `gpt-oss-120b` | `CEREBRAS_API_KEY` | unknown (cost null unless `openai.price` is set) | remote |
| ollama | `http://localhost:11434/v1` | `qwen2.5:1.5b-instruct` | none | 0 | local |
| lmstudio | `http://localhost:1234/v1` | (from `/v1/models`) | none | 0 | local |
| llamacpp | `http://localhost:8080/v1` | (loaded model) | none | 0 | local |
| custom | `openai.baseUrl` (required) | `openai.model` (required) | `keyEnv` | `openai.price` | local only if host is loopback |

The ollama preset adds `keep_alive: "30m"` and options `{temperature: 0, num_predict: 256}`.
Local presets use `timeouts.localMs` in hooks.

typesafe is always remote; its key comes from `TYPESAFE_API_KEY`.

`resolveAdjudicator` picks the effective provider:

- the configured provider, when (remote ⇒ consent && key present) and (embedding ⇒ running in
  the server or CLI);
- otherwise `"heuristic"`, with `degraded` set to `no_key`, `no_consent` or `hook_context`.

## 6. Secrets

File `~/.eminiar/adjudicator.key`: JSON
`{"typesafe": "...", "openai:groq": "...", "openai:cerebras": "...", "openai:custom": "..."}`.

- Written by `eminiar adjudicator key set` only: a temp file created with mode 0600, then
  renamed.
- Cached per process, with a `resetSecrets()` test seam (same pattern as
  `src/swarm/identity.ts`).
- Add `adjudicatorKey` to `paths()` so `EMINIAR_HOME` isolates tests.

Resolution order:

1. the env var named by `keyEnv`
2. the provider's own env var (`TYPESAFE_API_KEY`, `GROQ_API_KEY`, `CEREBRAS_API_KEY`)
3. `EMINIAR_ADJUDICATOR_KEY`
4. the key file

If the file's mode has any `0o077` bits set, we refuse to read it, and doctor fails with a
`chmod 600` hint.

Keys never appear in:

- project config (blocked by the refine)
- argv: the CLI reads hidden TTY input or stdin; `--from-env NAME` stores `keyEnv` instead of a
  key
- `hook.log` or error text: `http.ts` drops the Authorization header and replaces any substring
  equal to the key with `***`
- the DB, the cache, memories, async job JSON (the child process resolves the key itself), or
  dashboard and CLI payloads. These show only `keySource` env|file|none and the last 4 chars,
  masked.

What leaves the machine (remote providers only):

- the normalised input text, cut to `privacy.maxChars` (2000) and passed through `redact()`
- the static tool, tier and role catalogue

Never sent: file contents, code, memories, or the project's paths beyond what the user typed.

## 7. Scoring model

### 7.1 Features (`features.ts`, pure, under 1 ms)

- words, chars and lines
- paths: `/[\w./-]+\.(ts|tsx|js|py|go|rs|md|json|ya?ml|sql|php)\b/`
- symbols: camelCase, PascalCase or snake_case identifiers, and backticked spans
- `codeBlock` and `stackTrace` (`at x (file:line)`, Traceback)
- intents come from an ordered lexicon: multiword phrases first, then stem match; the score is
  0..1 per intent:
  - lookup: what / where / which / show / list / explain
  - impact: what would break / depends / affect / who imports
  - history: blame / history / why was / when did
  - run: run / test suite / lint / typecheck / npm audit
  - bigfile: read the N-line / whole file
  - docs: docs / latest version / fetch
  - recall: should we / is it safe / did we decide
  - plan: split / plan / tasks / assign / rollout
  - edit_small: rename / typo / tidy / format / bump
  - implement: add / implement / write / create
  - refactor: refactor / migrate / rewrite / port
  - design: design / architect / subsystem
  - review: review / audit / security review
  - debug: why / debug / fails / slow / crash / race
  - research: compare / research / providers
  - test: unit tests / regression / verify
  - git: commit / push / rebase / branch
  - ui: dashboard / css / component / view
  - chat: hi / thanks / ok / yes, with no other intent
- scope, 0..1: whole / entire / all / across / every / system / framework / codebase
- risk, 0..1: security / race / migration / data loss / concurrency / production / auth
- the `slash` flag, and the `classifyPrompt()` label from `src/capture/classify.ts`
- task hints for the plan and agent surfaces: role, number of files, number of deps

### 7.2 Complexity

c = clamp(base + Σ wᵢ·fᵢ, 0, 4). Default weights, each overridable in `weights.features`:

- base 0.6; chat −2.0; edit_small −0.6; lookup, history and docs −0.3
- implement +0.9; debug +1.0; review +1.2; plan +1.4; refactor +1.6; design +2.4; research +0.6;
  test +0.6
- scope ×1.2; risk ×0.8; 0.3·log2(1+paths)
- words > 40: +0.3; words > 120: +0.6
- stackTrace +0.4; task.files > 3: +0.4; task.deps > 1: +0.2

`complexityBucket = round(c)`. Every non-zero term becomes a `Reason`.

### 7.3 Tier table

For each tier t in `config.tiers`:

- raw s_t = −|c − center_t|
- risk adds +0.4·risk to tiers ≥ sonnet; chat adds +1 to the lowest tier
- softmax with τ = 0.5, so the scores sum to 1. Reasons cite c and the adjustments.

Effort from c: < 1.5 low, < 2.5 medium, < 3.5 high, otherwise xhigh. This is advice only: the
Agent input has no effort field.

### 7.4 Tool table

Rule weights map intent to tool:

- lookup → em_symbols 0.6 / em_search 0.4
- impact → em_graph_impact; history → em_history
- run and test → em_execute; bigfile → em_execute_file
- docs → em_docs, then em_fetch_and_index; recall → em_recall
- plan → em_swarm; edit_small and implement → Edit; git → Bash; chat → none
- design or refactor with c ≥ 3.5 → Agent
- symbols or paths present add to em_symbols and em_graph_impact

Options are `TOOL_IDS` ∩ registered tools. The heuristic owns this table: provider weight for
tools is 0 unless `weights.features.toolProvider > 0`, and the embedding provider never scores
tools.

### 7.5 Role table

Intent maps to role:

- lookup and impact → explorer; docs and research → researcher
- implement, edit and refactor → coder; test and run → tester
- review → reviewer; design and plan → architect; ui → ui; chat → none

The table adds a token-overlap score against the active swarm's role descriptions
(`swarm.yaml`), so custom roles can score. When a swarm run is active, options are limited to
that swarm's roles.

### 7.6 Blend (`blend.ts`)

- For each dimension d, the provider weight is α_d = min(cap_p, conf_p). The cap is
  `weights.providerMax` for typesafe and openai, and `weights.embeddingMax` for embedding (tier
  and complexity only).
- conf_p is Jev's calibrated confidence, or a self-reported confidence × `selfReportScale`.
- Tables: final = (1−α)·heuristic + α·provider. Add the learned bias, clamp at 0, renormalise.
- Complexity: c = (1−α)·c_h + α·c_p.
- Confidence of a table = 0.5 + (top − second)/2.
- If tier confidence < `weights.lowConfidence`, move up one tier (the safer choice) and add the
  reason "low confidence → rounded up".
- Jev noul answers: risky > 0.7 adds +0.3 to tiers ≥ sonnet; needsPlan > 0.7 adds weight to the
  em_swarm tool and the architect role. Both carry reasons.

### 7.7 Learning (`learn.ts`, bounded and cheap)

Buckets:

- tier: (complexityBucket, tier)
- role: (top intent, role)

Each bucket keeps decayed counts n, s (successes) and f (failures), plus `cost_median`, the
median actual cost per success. On each update, counts are multiplied by 2^(−1/halfLife).

Posterior success ŝ = (s+2)/(n+4), a Beta(2,2) prior.

bias = clamp(1.0·(ŝ − 0.8) − costWeight·log2(cost_t / median cost of the bucket), −maxBias,
+maxBias). It applies only when n ≥ minSamples.

Signals:

- swarm task done = success; failed or blocked = failure. Credit goes to the tier that actually
  ran, taken from `api_calls`.
- explicit feedback: good = success; too_small = failure for that tier; too_big = success, plus
  one success credited to the next-lower tier.
- main-session prompts never teach, because they have no outcome.

`learning.enabled=false` means an empty bias. `eminiar adjudicator stats --reset-learning`
clears the bias table only.

### 7.8 Acceptance bar

With the default weights, heuristic-only must:

- beat the majority class on exact tier and exact complexity accuracy over the 40-item eval set
- reach ≥ 0.8 complexity accuracy within ±1

Document the weights next to the code.

## 8. Providers

Shared rules (`providers/http.ts`):

- plain fetch + AbortController; no SDKs and no new npm dependencies
- deadline = min(surface budget, time remaining)
- error classes: `timeout`, `http_error` (4xx/5xx), `rate_limited` (429/529), `invalid`
- at most 1 retry, only for 429/529, and only if ≥ 300 ms remain
- every answer is validated with zod; an invalid answer falls back to the heuristic

### typesafe (Jev)

Request: `POST {baseUrl}/systemone` with `Authorization: Bearer <key>` and model pinned to
`"jev-1.14.0"` (never `jev-latest`).

- ONE request per batch of up to 10 items. A plan with more than 10 tasks is split into at most
  2 parallel requests.
- `state = {catalogue: {tiers, roles: [{name, description}], tools}, items: [{id, text}]}`.
- Questions for item i (ids namespaced `"i3.complexity"` and so on; each instruction names the
  item):
  - complexity: score, with criteria [trivial chat or lookup, small single-file change,
    multi-step change in one area, cross-cutting change, architectural or multi-subsystem]
  - tier: choice over `config.tiers`, with one-line criteria
  - role: choice over roles
  - risky: noul
  - needs_plan: noul
  - tool: choice; asked only when `weights.features.toolProvider > 0`

Mapping:

- complexity = score × 4; its confidence comes from the answer
- probabilities become a `Dist` with `calibrated = true`
- cost = input_tokens × 0.042/1M (output tokens are free)

### openai-compatible

Request: `POST {baseUrl}/chat/completions` with temperature 0, `max_tokens = 64 + 48 × items`,
the rubric (`prompt.ts`) as the system message and the items as JSON in the user message.

`response_format = json_schema`, `strict: true`, schema:

- `{items: [{id, complexity: integer 0..4, tier: enum, role: enum, tool: enum, risky: boolean, confidence: number}]}`
- every field required, `additionalProperties` false, schema text ≤ 5000 chars (Cerebras limit)

`json: "auto"` handling: on a 400 that mentions `response_format` or `json_schema`, retry once
with `{type: "json_object"}` plus the schema text in the prompt, then parse with zod.

Answers become one-hot Dists × confidence, with `calibrated = false` (§7.6 applies the
`selfReportScale` discount).

Cost = `usage.prompt_tokens`/`completion_tokens` × the preset price, or null when the price is
unknown; 0 for local presets.

### embedding (registered by `src/server.ts` and the CLI; never by the hook bundle)

- Uses Xenova/bge-small through `src/embeddings`; the model is already warm in the MCP server.
- Exemplars from `data/exemplars.ts` are embedded once and cached at
  `~/.eminiar/models/adjudicator-exemplars-<sha of texts + model id>.json`.
- Classification: k-NN with k = config `k`, cosine similarity, similarity-weighted votes,
  ignoring neighbours below `minSimilarity`.
- Output: a tier `Dist` plus the weighted mean complexity, with confidence = top vote share.
  `dims = ["tier", "complexity"]`.
- In hooks the effective provider is the heuristic. The hooks still pick up cached verdicts the
  server wrote for the same input hash.

## 9. Cache, breaker and guards (`breaker.ts`, `engine.ts` over `db.adjudicator`)

**Cache**

- key = sha256(SCORER_VERSION | provider | provider model | surface | normalize(text)[:2000]);
  `normalize` lowercases and collapses whitespace
- value = the `Verdict` JSON only, never the text
- expires after `ttlHours`; every 100 inserts, prune to `maxEntries` by LRU
- a `pending` marker (verdict null, 30 s TTL) dedupes async jobs for the same key

**Breaker** (one per provider, persisted because every hook is a new process)

- closed → open after `failures` consecutive timeouts, 5xx or 429 errors
- open lasts `cooldownSec`; half-open lets one call through
- localhost ECONNREFUSED (about 1 ms) counts as a failure, so a stopped Ollama costs about 1 ms
  per call until the breaker opens

**Latency guard**: if the p95 of the last 50 provider latencies exceeds the surface budget, state
becomes "slow" and the provider is skipped for `cooldownSec`.

**Daily spend**: `spend_usd` accumulates per UTC day. At `budget.dailyUsd` or above, the status
is `over_budget` and the provider is skipped.

Probe and detect results are cached for 60 s and never run in PreToolUse.

## 10. Hook integration and latency budgets

| Point | Cost when disabled | Work when enabled | Added p95 budget |
|---|---|---|---|
| SessionStart: `src/hooks/session-start.ts`, next to the swarm line | 1 bool check | one line (≤ 200 chars) only when enabled but degraded (no_key, no_consent, breaker open, apply ineffective); ollama preset: an async keep-alive warm-up job | ≤ 5 ms, no network inline |
| UserPromptSubmit: `src/hooks/capture.ts`, after recall (L117-133), before `budgetWarnings` | 1 bool check | skip below `minPromptChars`, slash commands and chat-only input; cache → heuristic → insert row (surface prompt) → one advice line. `promptMode` async spawns the provider job; blocking calls the provider with a deadline of `promptMs` (`localMs` for local presets) | ≤ 150 ms inline including the process (heuristic < 5 ms); blocking ≤ 1.2 s |
| PreToolUse, non-Agent tools: `src/hooks/routing.ts` | nothing | only when `surfaces.tools` is on: one indexed SELECT of the session's latest prompt verdict; a hint at most once per prompt, when the raw tool contradicts the advised em_* tool and routing produced no hint | ≤ 2 ms |
| PreToolUse Agent/Task: `routing.ts`, right after `swarmPreAgent` (L710) | nothing | `onPreAgent(ctx, input, spawn)` returns `{model?, note?}`: plan row (run, task) → cache → heuristic. On a miss in apply mode, call the provider with a deadline of `agentMs`. The result is merged into the ONE `updatedInput` routing returns (§11) | ≤ 10 ms advise; ≤ 800 ms on an apply-mode miss |
| SessionEnd: `capture.ts` `sessionEnd` | nothing | `reconcile(db, {limit: 200})` | ≤ 20 ms |
| `em_swarm plan` (MCP server, long-lived) | nothing | `adjudicatePlan`: one batched provider call | ≤ `planMs` (3 s) |
| `em_adjudicate` (MCP) | not registered | score / explain / stats / feedback | ≤ `planMs` |

PostToolUse, Stop and SubagentStop get nothing new: transcript ingestion already runs there and
feeds `reconcile`.

### Async job (`promptMode` async; also the ollama warm-up)

- The hook spawns `process.execPath` with the hook script and `--adjudicate`, using
  `{detached: true, stdio: ["pipe", "ignore", "ignore"]}`.
- It writes the job JSON to stdin and unrefs:
  `{request, rowId, cacheKey, resolved config without the key}`. Spawning costs about 3-5 ms.
- The child (`runAsyncJob`, about 50 ms to boot) resolves the key, calls the provider with a
  deadline of 2 × `promptMs`, writes the cache entry and updates the row (source blend, provider
  fields).
- If the job lands in time, the same turn's PreToolUse(Agent) uses it.
- The prompt text exists only in the pipe and in the provider request; it is never written to
  disk.
- `src/hook.ts` gets an argv switch next to the existing `--gate` check.

### Advice text

- UserPromptSubmit `additionalContext` gets one line of at most 220 chars, for example:
  "eminiar adjudicator: complexity 1/4 (lookup) · start with em_symbols → em_search · if you
  delegate: haiku, role explorer".
- Main-session advice (`advice.mainSession` "user") goes to the user as a `systemMessage`. It
  fires only when the session model (the latest main-thread `api_calls` row) is at least 2 tiers
  above the advice, and at most once per `cooldownPrompts` prompts. Example: "this prompt looks
  small (complexity 0); /model sonnet would be cheaper". With "context", the line goes to Claude
  instead; with "off", nothing is shown.

## 11. Agent dispatch: advise vs apply (`onPreAgent`)

Input text:

- For a swarm worker (`spawn.kind === "worker"`): the swarm task's title + detail from
  `db.swarm`.
- Otherwise: `tool_input.description + "\n" + prompt`.

Each dispatch inserts an `agent` row with:

- `parent_id` = the plan row for (run, task), if there is one
- `model_requested` = `tool_input.model`
- `baseline_model` (§13)
- `action`

Apply happens only when ALL of these hold:

1. `mode` is `"apply"`.
2. `apply.scope` allows it: `"swarm"` means swarm workers only; `"all"` means any
   `subagent_type`.
3. `process.env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE` is unset or `"0"`.
4. `tool_input.model` is absent. An explicit choice always wins, and the row's action becomes
   `"respected"`.
5. With `respectFrontmatter`: the agent's frontmatter model is absent or `"inherit"`. For swarm
   agents it comes from `RoleSpec.model`; for others from `.claude/agents/<type>.md` under the
   project root, read in at most 1 ms. Unknown counts as "not pinned".
6. tier confidence ≥ `apply.minConfidence`.
7. The tier, clamped to [floor, ceiling], is one of sonnet/opus/haiku/fable.

Then:

- `updatedInput = {...tool_input, model: tier}`, with `permissionDecision` `"allow"`, the same
  way routing's enforce path already returns it.
- Routing has three return paths, and the model must survive all of them:
  - enforce + `prefixPrompt`: merge the model into routing's `updatedInput`, which already holds
    the full input plus the prompt prefix. Two `updatedInput`s cannot coexist.
  - the early `return undefined` at L750, when the prompt is already prefixed: return
    `{...tool_input, model}` instead.
  - annotate, mode "off", or no suggestion: return an `updatedInput` with the model and keep
    `additionalContext`.
- Implementation: one helper `withModel(output, input, model)` in `src/adjudicator/hooks.ts`,
  applied at routing's return points. `routing.ts` gets only call-outs.
- Never inject `effort`. Effort and role are advice: one `additionalContext` line, e.g.
  "adjudicator: suggested effort high, role reviewer".
- In advise mode, `onPreAgent` never calls the network. It records the row and, when the
  coordinator passed no model and the advice differs from the baseline, adds one note:
  "adjudicator: model haiku would do (complexity 1, conf 0.8): pass model:'haiku'".

Effectiveness check: `reconcile` compares `model_final` with the model that `api_calls` show for
the agent. Each mismatch counts as `apply_ineffective`. `status` and doctor report "apply did not
take effect on n of m dispatches: use advise".

## 12. Persistence

Migration v8 in `src/storage/sqlite/schema.ts`. Never edit a shipped migration.

Store: `src/storage/sqlite/adjudicator.ts`, `SqliteAdjudicatorStore`, following the
`SqliteSwarmStore` pattern.

- `StorageAdapter` gets `readonly adjudicator: AdjudicatorStore`.
- `SqliteAdapter` constructs it.
- `purge(scope)` gains `"adjudicator"`, which is also included in `"all"`. `em_purge`'s enum gets
  `"adjudicator"`.

```sql
CREATE TABLE IF NOT EXISTS adjudications (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, surface TEXT NOT NULL,
  session_id TEXT, agent_id TEXT, tool_use_id TEXT, run_id TEXT, task_id INTEGER, parent_id INTEGER,
  input_hash TEXT NOT NULL, input_head TEXT, input_chars INTEGER,
  complexity REAL, tier TEXT, effort TEXT, tool TEXT, role TEXT, confidence REAL,
  scores TEXT,                  -- JSON: ScoreSet + features + alpha + bias
  source TEXT, provider TEXT, provider_model TEXT, provider_status TEXT,
  latency_ms INTEGER, provider_latency_ms INTEGER, tokens_in INTEGER, tokens_out INTEGER, cost_usd REAL,
  action TEXT,                  -- advised|applied|followed|respected|ignored|none
  model_requested TEXT, model_final TEXT, baseline_model TEXT,
  actual_model TEXT, actual_tokens INTEGER, actual_cost_usd REAL, baseline_cost_usd REAL, savings_usd REAL,
  outcome TEXT NOT NULL DEFAULT 'pending',   -- pending|success|failure|abandoned|n/a
  outcome_source TEXT, outcome_ts INTEGER, final INTEGER NOT NULL DEFAULT 0, version TEXT);
CREATE INDEX IF NOT EXISTS adjudications_session ON adjudications(session_id, ts);
CREATE INDEX IF NOT EXISTS adjudications_task ON adjudications(run_id, task_id);
CREATE INDEX IF NOT EXISTS adjudications_hash ON adjudications(input_hash);
CREATE INDEX IF NOT EXISTS adjudications_ts ON adjudications(ts);
CREATE INDEX IF NOT EXISTS adjudications_final ON adjudications(final, ts);
CREATE TABLE IF NOT EXISTS adjudicator_cache (key TEXT PRIMARY KEY, verdict TEXT, provider TEXT,
  created_at INTEGER NOT NULL, last_hit_at INTEGER, hits INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS adjudicator_provider_state (provider TEXT PRIMARY KEY, state TEXT NOT NULL,
  failures INTEGER NOT NULL DEFAULT 0, retry_at INTEGER, last_ok_at INTEGER, last_error_at INTEGER,
  last_error_class TEXT, latencies TEXT /* JSON ring of ≤ 50 */, spend_day TEXT, spend_usd REAL NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS adjudicator_bias (dimension TEXT NOT NULL, bucket TEXT NOT NULL, option TEXT NOT NULL,
  n REAL NOT NULL DEFAULT 0, s REAL NOT NULL DEFAULT 0, f REAL NOT NULL DEFAULT 0, cost_median REAL,
  bias REAL NOT NULL DEFAULT 0, updated_at INTEGER, PRIMARY KEY (dimension, bucket, option));
```

Store API (synchronous, better-sqlite3):

- `insert(row)` → id; `update(id, patch)`; `get(id)`
- `list({since, surface, provider, outcome, limit, offset})` → `{rows, total}`
- `latestForSession(sessionId, surface)`; `forTask(runId, taskId)`; `nonFinal(limit)`
- `cacheGet(key, now)`; `cachePut(key, verdict|null, provider)`; `cachePrune(maxEntries, ttlMs)`
- `providerState(p)`; `saveProviderState(p, s)`
- `biasAll()`; `biasUpsert(row)`; `biasReset()`
- `summary(since)`: counts by surface, source and provider_status; p50/p95 of `latency_ms` and
  `provider_latency_ms`; follow, apply and respect rates; Σ`cost_usd`, Σ`savings_usd`;
  `apply_ineffective` count
- `purge()`

Hook writes are single statements (< 1 ms), so they need no deferral.

Meta key `adjudicator:eval:last` holds the last eval report.

Never stored: any text beyond `input_head`, keys, or raw provider responses. `input_head`
(`privacy.storeHead`) is at most 80 chars of `redact()`ed text. `redact()` masks:

- `sk-`, `ghp_`/`gho_`, `xox*`, `AKIA…` tokens and Bearer tokens
- secret-looking `key=value` or `key: value` pairs
- emails
- base64/hex runs of 32+ chars

## 13. Outcomes, tokens and savings (`learn.ts`, `savings.ts`)

`reconcile(db, {limit})` runs:

- in SessionEnd (limit 200)
- in `em_adjudicate stats` and CLI `stats`
- before the dashboard GETs (limit 500)

It is idempotent: rows with `final=1` are skipped. It looks at non-final rows older than 2 min:

| Row kind | Outcome | Agent and tokens |
|---|---|---|
| plan / agent with run_id+task_id | `swarm_tasks.status`: done → success; failed or blocked → failure; run finished in any other state → abandoned; pending or active → wait | `agent_id` from `swarm_tasks.agent_id` / `swarm_agents` |
| agent without a swarm task | n/a, unless feedback arrives | `agent_id` linked best-effort: the first sidechain agent in `api_calls` for the same session whose first call starts within 60 s after ts (`outcome_source` "link") |
| prompt | n/a | tokens = the session's main-thread `api_calls` between this prompt row and the next one |

- `actual_model`, `actual_tokens` and `actual_cost_usd` come from `api_calls`. Usage ingestion
  must be on; otherwise these stay null and the UI says so.
- A row becomes final once its outcome is known, or after 24 h.
- When a row turns final, its bias buckets are updated (§7.7).

Baseline: what would have run without the adjudicator, resolved in this order:

1. the role or agent frontmatter model, if it is pinned (not inherit)
2. otherwise the main-session model at ts: the latest main-thread `api_calls` row before ts
3. otherwise usage's fallback model (`FALLBACK_MODEL` in `src/usage/savings.ts`)

`baseline_cost_usd` = the same token vector (input, output, cache read, cache write 5m/1h)
repriced at the baseline model with `resolvePrice`/`costOfCall` from `src/usage/pricing.ts`,
which honours `config.usage.pricing` overrides.

`savings_usd` = baseline_cost − actual_cost. It is credited only when action is applied, or
followed. "Followed" means the Agent's `input.model` equals our advice and differs from the
baseline.

A failed attempt that is redone (a later row for the same run and task) gets
savings = −actual_cost: the retry is charged to the adjudicator.

Net savings = Σ credited savings − Σ `cost_usd` of the adjudicator's own calls, across all
persisted surfaces (prompt, agent, plan, tool, mcp); test calls are not persisted.

Main-session advice yields "potential" savings only: Σ over prompts where the advised tier was
below the tier that actually ran of (actual cost − the same tokens repriced at the advised tier).
It is never added to net, because we cannot observe the counterfactual.

Every savings figure is shown with its assumptions:

1. The token counts would have been the same on the baseline model. Smaller models can need more
   turns, so the dashboard shows tokens per successful task by tier next to it.
2. List prices, with cache pricing unchanged.
3. Credit only for dispatches that were followed or applied.
4. The adjudicator's own spend is subtracted.
5. No credit for tool advice: eminiar's `em_stats` already counts context kept out by `em_*`
   tools, so crediting it here would double-count. We report only the tool-advice follow rate.

## 14. Failure modes

| Failure | Behaviour |
|---|---|
| provider timeout, 5xx, 429 or 529 | the heuristic verdict stands, `providerStatus` is set, the breaker counts one failure |
| invalid output, or json_schema rejected | one json_object retry if the budget allows; otherwise fallback with status invalid |
| no key or no consent | effective provider is the heuristic; doctor fails; one SessionStart line per session |
| key file permissions too open | not read; doctor fails with a `chmod 600` hint |
| breaker open, slow p95, or over the daily budget | provider skipped; status recorded |
| DB busy or locked, or v8 not migrated | the verdict is still returned but not persisted. `hooks.ts` wraps each surface in try/catch and never throws into the dispatcher |
| `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1` | no apply; action respected; doctor warns when mode is apply |
| explicit Agent model, or pinned frontmatter | no apply; action respected |
| model outside the org's `availableModels` | Claude Code substitutes another; reconcile records `actual_model` and the mismatch |
| Claude Code ignores a hook-set model | detected as `apply_ineffective`; status and doctor recommend advise |
| async child dies or hangs | its own deadline kills it; the pending marker expires after 30 s; the heuristic stands |
| embedding model not cached or not warm | embedding provider unavailable; heuristic; doctor shows "model not downloaded" |
| prompt injection in the scored text | outputs are enums and numbers only; apply is clamped by floor, ceiling and minConfidence; nothing is ever denied |
| Jev alias moves | the version is pinned; re-run eval before bumping `typesafe.model` |
| Cursor client | skipped on every surface |
| many prompts in parallel sessions | the cache plus the pending marker dedupe; the breaker is shared through SQLite |
| a team's config turns the feature on | only heuristic or local providers can run: consent never comes from the project file, and keys live only per user |

## 15. MCP surface: a new tool `em_adjudicate`, registered only when enabled

Why a new tool and not an action on an existing one:

- `em_swarm` is the coordinator and worker protocol, with caller stamping and enforcement.
  Adjudication is not swarm-only: it serves plain prompts and plain Agent calls.
- `em_usage` is read-only transcript analytics. Adjudication needs on-demand scoring and a write
  path (feedback).
- A separate tool can be left out of the tool list when the feature is off, so its schema costs
  nothing in sessions that don't use it.

How: `ToolDef` (`src/tools/types.ts`) gets an optional `available?: (config: Config) => boolean`.
`src/server.ts` filters the tools against the config loaded at start.
`eminiar adjudicator enable` tells the user to run `/mcp` reconnect.

Schema:

```
{ action: "score" | "explain" | "stats" | "feedback",
  text?: string (≤ 8000),
  tasks?: [{ key, title, detail?, role? }] (≤ 20),
  id?: int,
  outcome?: "good" | "too_small" | "too_big",
  note?: string (≤ 200),
  since?: string }
```

Actions:

- **score**: one compact line per item with complexity, tier + effort, tool, role, confidence,
  the top 3 reasons, source/provider and latency. The row is recorded with surface `mcp`. Uses
  the plan budget.
- **explain** `{id}`: the full score tables with reasons, features, α and bias, provider status,
  latency, tokens and cost, outcome, actual model and tokens, savings.
- **stats** `{since}`: the same summary as the CLI, run after reconcile.
- **feedback** `{id, outcome, note}`: sets the outcome (`outcome_source` feedback, final) and
  updates the bias.

Output stays under 1 KB, except explain.

The server also calls `registerProvider("embedding", ...)` at start when the effective provider
is embedding.

## 16. Swarm integration (advice is the primary path)

- `em_swarm plan` (`src/tools/em_swarm.ts`, the handler that calls `planned()`, L274-306): when
  enabled and `surfaces.plan` is on, call `adjudicatePlan(ctx, runId, addedTasks)` after
  `addTasks`.
  - One batched provider call within `planMs`; the heuristic on any failure.
  - Insert plan rows (run_id, task_id).
  - For each task, append e.g.
    "#5 → swarm-feature-coder · model haiku · effort low (complexity 1, conf 0.82)".
  - Add "role suggested: tester (planned: coder)" when the role differs.
- The "Next:" text tells the coordinator to pass `model` on each Agent call.
- No `PlanTask` schema change, no `swarm.yaml` key, no new `TaskRow` columns, no new
  `EVENT_KINDS`. The swarm ledger stays stable, and the suggestions live in `adjudications`.
- `coordinatorBrief` (`src/swarm/brief.ts`, steps block L371-378) gets one line when enabled:
  "Adjudicator on: em_swarm plan shows a suggested model per task; pass it as `model` on the
  Agent call (effort is advice)."
- In apply mode, `onPreAgent` finds the plan row by (run, task) through
  `spawn.kind === "worker"`, so it needs no extra provider call.

## 17. CLI (`src/adjudicator/cli.ts`, loaded lazily from `src/cli.ts` as the `adjudicator` command, plus help text)

- `status [--json]`: enabled; configured vs effective provider and why; mode; surfaces; key
  source (env, file or none, masked); consent; breaker and health; last-24 h summary; apply
  effectiveness.
- `enable [--provider P] [--preset X] [--mode advise|apply] [--project] [--accept-remote]`:
  - writes `~/.eminiar/config.json`; `--project` writes only `adjudicator.enabled: true` into
    `eminiar.config.json`
  - for a remote provider it prints exactly what leaves the machine: "The text of your prompts
    and subagent tasks (redacted, at most 2000 chars) is sent to <host> to score them." Then it
    asks y/N on a TTY. Without a TTY, `--accept-remote` is required. `--yes` never implies
    consent.
  - prints a reminder to `/mcp` reconnect
- `disable [--project]`.
- `provider <heuristic|typesafe|openai-compatible|embedding> [--preset] [--base-url] [--model]`,
  and `provider --detect`, which probes ports 11434, 1234 and 8080 within `connectMs` and
  suggests a provider but never enables one.
- `key set [provider]` (hidden TTY input or stdin; `--from-env NAME` stores `keyEnv` instead),
  `key clear [provider]`, `key show` (source and masked tail).
- `test "<text>" [--provider P] [--json]`: the heuristic, the provider-raw result and the
  blended verdict side by side, with latency, tokens and cost. Not persisted.
- `eval [--providers heuristic,typesafe,...] [--fixture file.json] [--repeat N] [--json]`: see
  §19.
- `stats [--since 7d] [--json] [--reset-learning]`: the summary plus savings with their
  assumptions.

## 18. Install, onboarding, doctor

Install (`src/install/install.ts`):

- new flag `--adjudicator[=heuristic|typesafe|groq|cerebras|ollama|lmstudio|llamacpp]`
- an interactive TTY install asks "Enable the adjudicator? It is off by default, and the
  heuristic runs only on this machine. [y/N]" through a separate `askNo()`. Under `--yes` it is
  skipped and the answer is No, because `confirm()` returns true for `--yes`.
- remote choices go through the same consent text, then point to `eminiar adjudicator key set`
- `writeTeamFiles` never writes the provider, keys or consent

Onboarding: `skills/em-onboard/SKILL.md` gets an optional closing step that explains the
adjudicator, the privacy difference between local and remote providers, and
`eminiar adjudicator enable`. It never auto-enables.

Doctor, cheap checks with no network (`src/doctor.ts` `runDoctor`; also shown in `em_doctor` and
the dashboard System tab via `/api/doctor`):

- config valid
- when enabled: effective provider equals the configured one, or the reason it doesn't
- key present, and the key file is 0600
- consent given for a remote provider
- breaker state
- 24 h fallback rate, and p95 against the budget
- `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` set while mode is apply
- apply effectiveness
- embedding model cached

`fullDoctor` (`src/install/doctor.ts`) adds a live probe with a 2 s timeout: typesafe
`GET /v1/models`, openai `GET {baseUrl}/models`, and local port detection.
`skills/em-doctor/SKILL.md` mentions these checks.

## 19. Eval harness (`src/adjudicator/eval.ts`; `eminiar adjudicator eval`)

Fixture: `src/adjudicator/data/evalset.ts` holds the 40 items from `research-local-3`, each
`{text, tool, tier, role, complexity}`. A test asserts it is disjoint from `data/exemplars.ts`.
`--fixture file.json` adds items or replaces the set (same shape).

Rows always reported:

- majority-class reference
- heuristic-only
- one row per candidate provider, both provider-raw and blended (as shipped)

Providers run batched like a plan (chunks of 10), with the plan budget per chunk. `--repeat N`
gives latency percentiles.

Metrics, per field (tier, complexity, role, tool):

- exact accuracy; for complexity also within-±1 and MAE
- JSON/answer validity rate; timeout and fallback rate
- p50/p95 latencyMs; tokens and $ per 1k items
- calibration: accuracy at confidence ≥ 0.8 vs < 0.8

The run ends with one verdict line: "<provider> beats heuristic-only on tier+complexity: yes/no
(Δ tier +x pp, Δ complexity ±1 +y pp)".

- The report goes to meta `adjudicator:eval:last`, without any item text.
- Remote providers need consent and a key, as everywhere else.
- Offline (heuristic and embedding) runs must work in CI.

Guidance in the docs: grow the set past 100 items from real prompts (store hashes and labels, not
text) and hold out 30% before tuning weights. Several labels are debatable, so agreement between
labellers is part of the test.

## 20. Dashboard

API: `src/ui/adjudicator-api.ts` exports `adjudicatorRoute(ctx, {path, method, query, body})`,
mounted in `src/ui/server.ts` the same way as `swarmRoute`. The loopback-origin guard covers the
POST.

- `GET /api/adjudicator`: sanitised config, enabled, configured vs effective provider with the
  degraded reason, `keySource` (env, file or none; never the key), consent, health per provider
  (breaker state, `last_error_class`, p50/p95, daily spend vs cap), apply effectiveness, and
  `summary(since)`.
- `GET /api/adjudicator/decisions?since&surface&provider&outcome&limit&offset` returns
  `{rows, total}`. Rows carry no scores JSON, only `input_head`.
- `GET /api/adjudicator/decision?id`: the full row, including the parsed scores (features,
  tables, reasons, α, bias).
- `GET /api/adjudicator/savings?since`: realised, potential, adjudicator spend, net,
  `assumptions[]`, tokens per successful task by tier, and the suggested-tier × actual-model
  matrix.
- `GET /api/adjudicator/eval`: the last eval report, or null.
- `POST /api/adjudicator/test {text, useProvider?: boolean}`: uses the heuristic, plus the
  provider only if enabled, consented and keyed. Never persisted.
- The GETs call `reconcile(limit 500)` first. Every input is validated: since, limit ≤ 500,
  enums. Payloads never contain keys or text beyond `input_head`.

Tab "Adjudicator" (`src/ui/web/views/Adjudicator.tsx`; add `"adjudicator"` to `VIEWS` in
`router.ts` and to `TABS` in `app.tsx`; client types appended to `src/ui/web/api.ts`; pure
helpers in `views/adjudicator-helpers.ts`):

0. When disabled: an empty state that explains the feature, its privacy model and
   `eminiar adjudicator enable`, plus the try-it box running the heuristic only.
1. KPI row: decisions; follow and apply rate; fallback rate; provider p50/p95; adjudicator spend;
   net savings, with a "how is this computed" popover listing the assumptions.
2. Provider health card: configured and effective provider, breaker state and retry time, last
   error class, daily spend vs cap, apply effectiveness (n of m), key source.
3. Charts, following the dataviz rules, the existing palette approach (`usage-helpers.ts`) and
   light/dark tokens:
   - decisions per day, stacked by source (heuristic, blend, cache, fallback)
   - complexity histogram (0-4)
   - suggested tier × actual model matrix (heatmap)
4. Call log table with filters (surface, provider, outcome, time) and paging. Clicking a row opens
   a detail drawer: features, the three score tables as bars with their reasons, the complexity
   terms, α and bias, provider status, latency and tokens, outcome, actual model and tokens,
   savings.
5. Savings panel: realised vs potential vs spend vs net, the assumptions list, and tokens per
   successful task by tier.
6. Try-it box (POST test) and the last eval report table.

It must work at phone width with no horizontal page scroll; the call log table may scroll inside
its own container.

## 21. Docs

- `docs/design/adjudicator.md`: this document.
- `docs/adjudicator.md`, the user guide:
  - what it does and what it doesn't
  - privacy: a table per provider of what leaves the machine
  - setup for each preset (Jev key, Groq, Cerebras, Ollama with
    `ollama pull qwen2.5:1.5b-instruct`, LM Studio, llama.cpp)
  - advise vs apply, with the Claude Code precedence facts (Agent model > frontmatter >
    `CLAUDE_CODE_SUBAGENT_MODEL`; FORCE overrides everything; effort is frontmatter-only)
  - latency budgets, breaker and budgets
  - learning, the savings method, eval, troubleshooting
- `docs/configuration.md`: an `adjudicator` table covering every key.
- `docs/cli.md`: the `eminiar adjudicator` subcommands.
- `docs/tools.md`: `em_adjudicate`.
- `docs/dashboard.md`: the Adjudicator tab.
- `docs/README.md` index; a `README.md` feature bullet.
- Version bump to 0.13.0 per the release/pr-version-bump rule.
- At finish, record two decision memories:
  - the scope ruling: model choice through the Agent `model` parameter is in scope and is not
    "routing"
  - the architecture summary

## 22. Task split

17 tasks: T0-T16. Tasks that can run at the same time never share a file.

Order:

1. T0 and T1 start immediately.
2. After T1: T2, T3, T4 and T5 run in parallel; T7 starts once T2 is done.
3. After T2+T3+T4: T6.
4. Then T8, T9, T10 and T12 in parallel; T11 after T10; T13 after T12.
5. T14 and T15 after the integrations; T16 last.

Every task must keep `npm run typecheck`, `npm run lint` and `npm test` green.

Critical path: T1 → T2 → T6 → T8/T9 → T14/T15 → T16. Most parallel work happens after T1
(T2-T5, T7) and after T6 (T8, T9, T10, T12).

### T0 · coder · Write the design doc

Files: `docs/design/adjudicator.md`
Deps: none

Accept: transcribes blackboard design … design-10 faithfully (including the erratum in
design-8), with headings §1-§22.

### T1 · coder · Foundations: shared types, config schema, secrets, redaction

Files: `src/adjudicator/types.ts`, `src/adjudicator/config.ts`, `src/adjudicator/secrets.ts`,
`src/adjudicator/redact.ts`, `src/config.ts`, `src/paths.ts`, `eminiar.config.schema.json`,
`tests/unit/adjudicator-config.test.ts`
Deps: none

Accept:

- the types from §4 and the schema and defaults from §5 (enabled false); `parse({})` round-trips
- env overrides work; the project layer cannot set `remoteConsent`; the refine rejects key-like
  fields
- `PRESETS` and `isLoopback`; `resolveAdjudicator` returns the effective provider plus a degraded
  reason for no_key, no_consent and hook_context
- secrets: written 0600 via temp file + rename; a 0644 file is refused; resolution order as in
  §6; `mask()`; `resetSecrets()`
- `redact()` cases: `sk-`, `ghp_`, `AKIA`, Bearer tokens, key=value pairs, emails, long hex
- schema regenerated

### T2 · coder · Storage: migration v8, AdjudicatorStore, purge

Files: `src/storage/sqlite/schema.ts`, `src/storage/adapter.ts`, `src/storage/sqlite/adapter.ts`,
`src/storage/sqlite/adjudicator.ts`, `src/tools/em_purge.ts`,
`tests/unit/adjudicator-store.test.ts`
Deps: T1

Accept:

- the v8 tables and indexes from §12, applied on top of a v7 DB; shipped migrations untouched
- the full store API from §12
- `purge("adjudicator")` and `purge("all")` clear the 4 tables; `em_purge` accepts
  `"adjudicator"`
- `summary()` verified on fixture rows (rates, p50/p95, spend, savings)
- edits to `adapter.ts` and `sqlite/adapter.ts` stay at about 5 lines each

### T3 · coder · Heuristic scorer, blend, eval fixture

Files: `src/adjudicator/features.ts`, `src/adjudicator/heuristic.ts`, `src/adjudicator/blend.ts`,
`src/adjudicator/data/evalset.ts`, `tests/unit/adjudicator-heuristic.test.ts`
Deps: T1

Accept:

- §7.1-7.6, §7.8; pure functions; every non-zero term yields a Reason; each table sums to 1
- p95 under 2 ms per item over the 40 items
- on the eval set, heuristic-only exact accuracy beats the majority class on tier (0.475) and
  complexity (0.30), and complexity within ±1 is ≥ 0.8
- blend tests: α caps per provider, the `selfReportScale` discount, low-confidence round-up, bias
  renormalisation, Jev noul adjustments
- `formatAdvice()` is ≤ 220 chars

### T4 · coder · HTTP layer, Jev and OpenAI-compatible providers, prompt builders

Files: `src/adjudicator/providers/http.ts`, `src/adjudicator/providers/typesafe.ts`,
`src/adjudicator/providers/openai.ts`, `src/adjudicator/providers/index.ts`,
`src/adjudicator/prompt.ts`, `tests/unit/adjudicator-providers.test.ts`
Deps: T1

Accept (all with mocked fetch):

- Jev request: pinned model, one request per ≤ 10 items, namespaced questions; response mapped to
  `ProviderAnswer` with calibrated Dists; cost from input_tokens
- OpenAI: strict schema ≤ 5000 chars; json_object retry on a 400; presets applied (ollama
  keep_alive/options)
- 429/529 retried at most once and only when ≥ 300 ms remain; the deadline aborts the request;
  error classes correct
- the key never appears in thrown errors or log lines (test with a sentinel key)
- `createProvider`/`registerProvider`; `providers/index.ts` has no static or dynamic import of
  `embedding.ts`

### T5 · coder · Embedding provider and exemplars

Files: `src/adjudicator/providers/embedding.ts`, `src/adjudicator/data/exemplars.ts`,
`tests/unit/adjudicator-embedding.test.ts`
Deps: T1

Accept:

- ≥ 15 exemplars per tier, labelled with tier and complexity; disjoint from the eval set (test,
  once T3 has landed; otherwise compared against the `research-local-3` list)
- the vector cache file is keyed by a sha of the texts + model id and written under
  `paths().models`
- k-NN with an injected stub embedder: similarity-weighted votes, `minSimilarity` respected
- exports a factory for `registerProvider`; imported only by `src/server.ts` and
  `src/adjudicator/cli.ts`/`eval.ts`

### T6 · coder · Engine, breaker, async job

Files: `src/adjudicator/engine.ts`, `src/adjudicator/breaker.ts`, `src/adjudicator/async.ts`,
`src/hook.ts`, `tests/unit/adjudicator-engine.test.ts`
Deps: T2, T3, T4

Accept:

- pipeline: cache → heuristic → gate (consent, key, breaker, slow, budget) → provider → blend →
  persist (§9)
- breaker closed → open → half-open persisted across "processes" (fresh store instances); slow
  guard; daily cap; pending-marker dedupe
- `adjudicate()` never throws, and returns the heuristic within budget + 20 ms when the provider
  hangs
- async: `spawnAsyncJob` writes the job to the child's stdin (spawn mocked); `runAsyncJob`
  updates the row and the cache
- `src/hook.ts` `--adjudicate` branch; the key is not in the job JSON

### T7 · coder · Reconcile, learning, savings

Files: `src/adjudicator/learn.ts`, `src/adjudicator/savings.ts`,
`tests/unit/adjudicator-learn.test.ts`
Deps: T2

Accept:

- §13 on fixture `swarm_tasks`/`api_calls` rows: outcome mapping, agent_id linking (swarm and
  best-effort), prompt token windows, finalisation after 24 h
- baseline resolution order; repricing with `src/usage/pricing.ts`
- credit only for followed/applied; the redo penalty; net = credited savings − spend; potential
  savings kept separate
- bias: Beta(2,2), decay, minSamples, clamp to maxBias, cost term, the feedback mapping;
  `learning.enabled=false` gives an empty bias; idempotent re-runs

### T8 · coder · Hook integration

Bug-prone files: thin call-outs only; read `em_history` for `routing.ts` and `capture.ts` first.

Files: `src/adjudicator/hooks.ts`, `src/hooks/capture.ts`, `src/hooks/routing.ts`,
`src/hooks/session-start.ts`, `tests/unit/adjudicator-hooks.test.ts`
Deps: T6, T7

Accept:

- disabled: no adjudicator function runs and no adjudications/cache rows are written (spy test)
- UserPromptSubmit advice line; skip rules; async vs blocking `promptMode`; main-session
  `systemMessage` with cooldown
- PreToolUse Agent, apply mode: `updatedInput` contains EVERY original field + model on all of
  routing's paths: the enforce prefix, the already-prefixed early return, annotate, mode off
- FORCE env, an explicit model and a frontmatter pin are respected; `effort` is never injected;
  nothing is ever denied
- advise mode makes no network call in `onPreAgent`
- non-Agent PreToolUse: at most one SELECT when `surfaces.tools` is on, none when off
- the Cursor client is skipped; SessionEnd calls reconcile
- the existing hooks, routing and swarm-hooks suites pass unchanged

### T9 · coder · em_adjudicate tool and swarm plan advice

Files: `src/adjudicator/swarm.ts`, `src/tools/em_adjudicate.ts`, `src/tools/index.ts`,
`src/tools/types.ts`, `src/server.ts`, `src/tools/em_swarm.ts`, `src/swarm/brief.ts`,
`tests/unit/adjudicator-swarm.test.ts`
Deps: T5, T6, T7

Accept:

- `ToolDef.available`; `em_adjudicate` is absent from the tool list when disabled and present
  when enabled
- the score, explain, stats and feedback actions (§15)
- `em_swarm plan` makes one batched provider call per plan and prints the per-task lines and
  role-differs notes (§16); plan rows are stored by (run, task)
- one `coordinatorBrief` line when enabled; swarm-tool, swarm-review and swarm-hooks suites pass
  unchanged
- the server registers the embedding provider when it is effective

### T10 · coder · Eval harness

Files: `src/adjudicator/eval.ts`, `tests/unit/adjudicator-eval.test.ts`
Deps: T5, T6

Accept:

- §19: reference rows (majority, heuristic), raw and blended rows per provider, all listed
  metrics including calibration, the verdict line, `--fixture` merge/replace
- the meta report contains no item text
- runs offline with the heuristic and a stubbed embedding provider; a mocked remote provider is
  exercised

### T11 · coder · CLI, install flag, doctor, onboarding

Files: `src/adjudicator/cli.ts`, `src/cli.ts`, `src/install/install.ts`,
`src/install/doctor.ts`, `src/doctor.ts`, `skills/em-onboard/SKILL.md`,
`skills/em-doctor/SKILL.md`, `tests/unit/adjudicator-cli.test.ts`
Deps: T5, T6, T7, T10

Accept:

- every subcommand in §17, with `--json` where listed
- consent flow: y/N on a TTY; without a TTY, `--accept-remote` is required; `--yes` never grants
  it
- the key is never accepted on argv; the key file is 0600; `--project` writes only `enabled`
- `install --adjudicator[=preset]`; the interactive question defaults to No and is skipped under
  `--yes`; `writeTeamFiles` is unchanged
- the doctor checks from §18; existing install, doctor and cli tests pass

### T12 · coder · Dashboard API

Files: `src/ui/adjudicator-api.ts`, `src/ui/server.ts`, `tests/unit/adjudicator-api.test.ts`
Deps: T6, T7

Accept:

- the endpoints in §20, with validation (bad since or limit → 400) and reconcile before the GETs
- a sentinel key and the raw prompt text never appear in any payload
- the POST is behind the loopback guard; test does not persist

### T13 · ui · Dashboard Adjudicator tab

Files: `src/ui/web/views/Adjudicator.tsx`, `src/ui/web/views/adjudicator-helpers.ts`,
`src/ui/web/router.ts`, `src/ui/web/app.tsx`, `src/ui/web/api.ts`,
`tests/unit/adjudicator-view.test.ts`
Deps: T12

Accept:

- the §20 layout (the disabled empty state, KPIs, health card, 3 charts, the call log with its
  detail drawer, the savings panel with assumptions, try-it, the last eval)
- light and dark themes; phone width with no page-level horizontal scroll
- pure helpers unit-tested (formatting, matrix building)
- `npm run build:ui` passes; a screenshot via `scripts/capture-screenshots.mjs` if practical
- append-only edits to `api.ts`

### T14 · coder · User docs and version

Files: `docs/adjudicator.md`, `docs/configuration.md`, `docs/cli.md`, `docs/tools.md`,
`docs/dashboard.md`, `docs/README.md`, `README.md`, `package.json`, `package-lock.json`,
`.claude-plugin/plugin.json`, `.cursor-plugin/plugin.json`
Deps: T8, T9, T11, T13

Accept:

- every config key documented with its default
- a privacy table per provider
- commands match `eminiar adjudicator --help`; the `em_adjudicate` schema matches
- the savings method and its assumptions; Claude Code model precedence facts
- version 0.13.0 via `npm version` (`scripts/sync-plugin-version.mjs`)

### T15 · tester · End-to-end, latency and privacy verification

Files: `tests/integration/adjudicator.test.ts`, `scripts/bench-hotpath.mjs`
Deps: T8, T9, T11, T12

Accept:

- the bench gains hook cases with the feature disabled and enabled; disabled adds ≤ 1 ms p50 over
  the baseline; enabled heuristic UserPromptSubmit stays ≤ 150 ms p95, real process included
- the apply-mode `updatedInput` merge keeps every field, through the real `dispatch()` with
  routing in enforce mode and in annotate mode
- a sentinel key never appears in `hook.log`, a DB dump, dashboard payloads, CLI output or the
  async job stdin
- against a dead localhost port, the breaker opens after 2 failures and later calls add ≤ 5 ms
- `eminiar adjudicator eval --providers heuristic` runs offline and prints the reference rows
- with `EMINIAR_ADJUDICATOR=0` everything is off

### T16 · tester · Final regression sweep and review

Files: none of its own. It reports defects to the coordinator as new tasks and does not edit
files other tasks own.
Deps: T0, T14, T15

Accept:

- typecheck, lint, the full test suite, `npm run build` (the hook bundle does not contain the
  exemplar texts or `embedding.ts` code; grep `dist/hook.js` for a marker string) and `build:ui`
  all pass
- the Cursor client is skipped
- the swarm and routing suites pass
- docs agree with the code
- an adversarial review of apply mode and the privacy paths, with findings listed
