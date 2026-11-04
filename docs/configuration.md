# Configuration

[← Docs index](README.md)

## Where settings come from

eminiar merges four layers. A later layer overrides an earlier one.

| Order | Source | Use for |
|---|---|---|
| 1 | Built-in defaults | — |
| 2 | `~/.eminiar/config.json` | Your personal settings |
| 3 | `<project>/eminiar.config.json` | Team settings. **Commit this file** |
| 4 | `EMINIAR_*` environment variables | One-off overrides |

`eminiar.config.schema.json` is the JSON Schema for every key. The file written by
`eminiar install --team` already points to it, so your editor completes and checks the keys:

```json
{ "$schema": "https://raw.githubusercontent.com/rydn/eminiar/main/eminiar.config.schema.json" }
```

## Example

```json
{
  "routing": { "mode": "enforce" },
  "sandbox": { "timeoutMs": 120000, "envAllow": ["MY_API_TOKEN"] },
  "graph": { "exclude": ["**/generated/**"] },
  "recall": { "maxMemories": 5 },
  "docs": { "crawl": { "maxPages": 20 } }
}
```

## All keys

### `routing`

| Key | Default | Description |
|---|---|---|
| `mode` | `"auto"` | `auto`, `enforce`, `annotate` or `off`. See [Routing](how-it-works.md#routing) |
| `deferToContextMode` | `true` | In `auto`, only annotate while the context-mode plugin is installed |

### `sandbox`

| Key | Default | Description |
|---|---|---|
| `timeoutMs` | `60000` | Time limit for one run |
| `maxOutputBytes` | `2097152` (2 MB) | Output cap per run |
| `indexThreshold` | `5120` (5 KB) | Output larger than this is indexed, and only matching sections return |
| `envAllow` | `[]` | Extra environment variable names to pass to the sandbox |
| `disabledLanguages` | `[]` | Languages to turn off, for example `["php"]` |

### `search`

| Key | Default | Description |
|---|---|---|
| `defaultLimit` | `5` | Results per query |
| `defaultMaxTokens` | `2000` | Size limit of a search answer |

### `embeddings`

| Key | Default | Description |
|---|---|---|
| `enabled` | `true` | Use semantic search. `false` keeps search lexical only |
| `model` | `"Xenova/bge-small-en-v1.5"` | ONNX embedding model |
| `dims` | `384` | Vector dimensions of the model |

### `graph`

| Key | Default | Description |
|---|---|---|
| `include` | `**/*.{ts,tsx,js,jsx,mjs,cjs,py,go,php}` | Files to parse |
| `exclude` | `node_modules`, `dist`, `build`, `.git`, `coverage`, `*.d.ts`, virtualenvs, `__pycache__`, `site-packages`, `vendor`, `*.min.js`, `*.blade.php` | Files to skip |

### `git`

| Key | Default | Description |
|---|---|---|
| `maxCommits` | `3000` | How many commits the history and co-change analysis read |

### `index`

| Key | Default | Description |
|---|---|---|
| `docs` | `["**/*.md", "**/*.mdx"]` | Project markdown to index for search |

### `permissions`

| Key | Default | Description |
|---|---|---|
| `extraDeny` | `[]` | Extra Bash deny rules for the sandbox, in addition to Claude Code's `permissions.deny` |

### `code`

| Key | Default | Description |
|---|---|---|
| `backend` | `"tree-sitter"` | Code parser backend |

### `memories`

| Key | Default | Description |
|---|---|---|
| `dir` | `".eminiar/memories"` | Where memory files live, relative to the project root |

### `recall`

| Key | Default | Description |
|---|---|---|
| `onPrompt` | `true` | Attach matching memories and docs to each prompt |
| `onFile` | `true` | Attach memories and fix history before a file read or edit, fan-in before an edit |
| `onAgent` | `true` | Add the brief and matching knowledge to subagent prompts |
| `onCommit` | `true` | List risky files before `git commit` |
| `onError` | `true` | Attach earlier occurrences of a failed call's error |
| `onWeb` | `true` | Attach indexed doc pages before `WebSearch` / `WebFetch` |
| `maxMemories` | `3` | Memories per prompt |
| `maxDocs` | `2` | Doc pages per prompt |
| `repeatAfter` | `10` | Prompts after which an item already shown in this context window may be attached again (`0` = once per window) |

### `docs`

| Key | Default | Description |
|---|---|---|
| `manifest` | `".eminiar/docs.json"` | The documentation sources manifest |
| `ttlHours` | `168` (7 days) | Page cache lifetime |
| `crawl.depth` | `1` | Link depth for dependency docs |
| `crawl.maxPages` | `8` | Pages per dependency source |
| `crawl.maxPageBytes` | `122880` (120 KB) | Page size cap |
| `crawl.api.depth` | `2` | Link depth for external API docs |
| `crawl.api.maxPages` | `150` | Pages per external API source |
| `embed` | `false` | Also embed documentation for semantic search |
| `discover.includeDev` | `false` | Include dev dependencies in discovery |
| `discover.subprojects` | `true` | Scan one level of sub-projects |
| `catalog` | `[]` | Extra catalogue entries, each with a `tier`: `service`, `infra` or `library` |

### `usage`

| Key | Default | Description |
|---|---|---|
| `enabled` | `true` | Ingest Claude Code transcripts (tokens, cache, cost per model call) and record statusline snapshots |
| `budgets.sessionUsd` | unset | Session cost above which the next prompt gets a one-line warning (once per session). Never blocks |
| `budgets.dailyUsd` | unset | The same for the calendar day |
| `budgets.turnUsd` | `1.00` | A single API call above this is flagged as an expensive turn |
| `pricing` | `{}` | Price overrides, USD per million tokens, keyed by a substring of the model id (first match wins): `input`, `output`, `cacheWrite5m`, `cacheWrite1h`, `cacheRead`. Missing fields fall back to the bundled table |
| `statusline` | `true` | Append `$<cost> · ctx <pct>% · 5h <pct>%` to `eminiar statusline` |

See [Usage insights](usage.md) for the sources, the privacy notes and the savings model.

### `adjudicator`

Optional and off by default. See [Adjudicator](adjudicator.md). Two rules apply to this section
only:

- It must not hold a key. A field named like `apiKey`, `token`, `secret` or `password` makes the
  config invalid. Keys go in `~/.eminiar/adjudicator.key` (`eminiar adjudicator key set`) or an
  environment variable named by `keyEnv`.
- Only `enabled`, `mode`, `surfaces`, `promptMode`, `minPromptChars`, `tiers`, `weights`,
  `apply`, `advice`, `embedding`, `learning` and `cache` may be set in the committed
  `eminiar.config.json`. Everything that decides where text and keys go or how much is spent
  (`provider`, `typesafe`, `openai`, `keyEnv`, `remoteConsent`, `remoteConsentOrigins`,
  `privacy`, `budget`, `timeouts`, `breaker`) comes from `~/.eminiar/config.json` only, and from
  there only while that file is outside the project (see `EMINIAR_HOME` below).

| Key | Default | Description |
|---|---|---|
| `enabled` | `false` | Turn the adjudicator on. `EMINIAR_ADJUDICATOR=0` is the kill switch |
| `provider` | `"heuristic"` | `heuristic`, `embedding`, `typesafe` (Jev) or `openai-compatible` |
| `mode` | `"advise"` | `advise` only suggests; `apply` may set the Agent `model` (best effort) |
| `surfaces.prompt` | `true` | Score prompts (UserPromptSubmit) |
| `surfaces.agent` | `true` | Score subagent dispatches (PreToolUse on `Agent`) |
| `surfaces.plan` | `true` | Add suggestions to `em_swarm plan` |
| `surfaces.tools` | `false` | Hint when a raw tool call contradicts the prompt's advised `em_*` tool |
| `promptMode` | `"async"` | How the provider runs on a prompt: `async` (detached; the heuristic answers now), `blocking` (inline within `timeouts.promptMs`) or `heuristic` (never) |
| `typesafe.model` | `"jev-1.14.0"` | Jev model. `jev-latest` and `jev-preview` are replaced by the pinned version |
| `typesafe.baseUrl` | `"https://api.typesafe.ai/v1"` | Jev endpoint |
| `openai.preset` | `"groq"` | `groq`, `cerebras`, `ollama`, `lmstudio`, `llamacpp` or `custom` |
| `openai.baseUrl` | unset (the preset's) | Overrides the preset's URL; required for `custom`. A non-loopback URL makes any preset remote |
| `openai.model` | unset (the preset's) | Overrides the preset's model; required for `custom` |
| `openai.json` | `"auto"` | `schema` (strict JSON schema), `object` (JSON mode) or `auto` (schema, falling back to JSON mode when the server rejects it) |
| `openai.price.inPerM` | unset (the preset's) | USD per million input tokens. Without a price, a preset with an unknown price reports no cost |
| `openai.price.outPerM` | unset (the preset's) | USD per million output tokens |
| `embedding.k` | `5` | Nearest examples that vote |
| `embedding.minSimilarity` | `0.55` | Cosine similarity below which an example does not count; with none, the heuristic answers |
| `keyEnv` | unset | The NAME of an environment variable holding the key, never the key |
| `remoteConsent` | `false` | Consent to send redacted text to a remote provider. Set by `enable`/`provider` after you agree |
| `timeouts.promptMs` | `1200` | Provider deadline on prompts (remote providers) |
| `timeouts.agentMs` | `800` | Provider deadline on dispatches and tool hints (remote providers) |
| `timeouts.planMs` | `3000` | Deadline for a plan batch, `em_adjudicate score` and each eval chunk |
| `timeouts.localMs` | `600` | Provider deadline on prompts and dispatches for local providers |
| `timeouts.connectMs` | `150` | Port probe timeout for `provider --detect` |
| `minPromptChars` | `12` | Shorter prompts are not scored |
| `tiers` | `["haiku", "sonnet", "opus"]` | The model ladder, smallest first. Add `"fable"` to allow it. Each tier at most once (at most 4 entries), since every provider request carries the whole ladder |
| `weights.providerMax` | `0.7` | Largest weight a Jev or OpenAI-compatible answer gets in the blend |
| `weights.embeddingMax` | `0.4` | Largest weight an embedding answer gets |
| `weights.selfReportScale` | `0.6` | Multiplier on a model's self-reported confidence (Jev's calibrated confidence is used as is) |
| `weights.lowConfidence` | `0.55` | A tier choice below this confidence moves one tier up |
| `weights.tierCenters` | `{"haiku": 0.6, "sonnet": 2.0, "opus": 3.4}` | The complexity each tier fits best (at most 16 entries) |
| `weights.features` | `{}` | Per-feature weight overrides, for example `{"design": 2.0}`. `asymmetry` (default 2) sets how strongly the tier leans up; `toolProvider` above 0 lets a provider vote on the tool. At most 64 entries |
| `apply.scope` | `"swarm"` | In apply mode, set the model on swarm worker dispatches only (`swarm`) or on every dispatch (`all`) |
| `apply.minConfidence` | `0.7` | Apply only at or above this tier confidence |
| `apply.floor` | `"haiku"` | Smallest tier apply mode sets |
| `apply.ceiling` | `"opus"` | Largest tier apply mode sets |
| `apply.respectFrontmatter` | `true` | Leave a dispatch alone when its agent file pins a `model` (`inherit` is not a pin) |
| `advice.mainSession` | `"user"` | Main-session `/model` note: `user` (shown to you), `context` (to Claude) or `off` |
| `advice.cooldownPrompts` | `8` | At most one main-session note per this many prompts |
| `learning.enabled` | `true` | Learn a bias from outcomes and feedback |
| `learning.maxBias` | `0.3` | Bound on the learned bias |
| `learning.minSamples` | `5` | Outcomes a bucket needs before its bias applies |
| `learning.halfLife` | `50` | Outcomes after which an old outcome counts half |
| `learning.costWeight` | `0.05` | How much a bucket's cost pulls its bias down |
| `cache.ttlHours` | `24` | Lifetime of a cached blended verdict |
| `cache.maxEntries` | `2000` | Verdict cache size |
| `breaker.failures` | `2` | Consecutive failures that open the circuit breaker |
| `breaker.cooldownSec` | `120` | How long an open breaker or the slow guard skips the provider |
| `budget.dailyUsd` | `0.5` | Spend cap per remote provider per UTC day |
| `budget.dailyCalls` | `2000` | Call cap per remote provider per UTC day (`0` = unlimited). Limits providers whose price is unknown |
| `privacy.maxChars` | `2000` | Characters of redacted text a remote provider receives per item |
| `privacy.storeHead` | `true` | Keep the first 80 redacted characters of each input in the database |

## Environment variables

| Variable | Effect |
|---|---|
| `EMINIAR_ROUTING_MODE` | Overrides `routing.mode` |
| `EMINIAR_EMBEDDINGS=0` | Turns off embeddings |
| `EMINIAR_HOME` | Moves the data directory (default `~/.eminiar`). A `config.json` there that lies inside or above the project (or any git work tree around it, a submodule's superproject included), or a relative `EMINIAR_HOME`, cannot set the adjudicator's provider, consent, endpoints, `keyEnv`, privacy, budget or timeouts, since a repo's `.claude/settings.json` could set this variable. The same applies when `HOME` is moved into the project |
| `CURSOR_CONFIG_DIR` | Where `install --cursor` writes Cursor's `hooks.json`, `mcp.json` and `skills/` (default `~/.cursor`) |
| `EMINIAR_PROJECT_ROOT` | Sets the project root. Otherwise `CLAUDE_PROJECT_DIR`, then the current directory |
| `EMINIAR_DEBUG` | Prints stack traces from the CLI |
| `EMINIAR_CLAUDE_DIR` | Where Claude Code keeps its transcripts (default `~/.claude`) |
| `EMINIAR_ADJUDICATOR=0` / `=1` | Turns the adjudicator off (the kill switch) or on, over every config file |
| `EMINIAR_ADJUDICATOR_PROVIDER` | Overrides `adjudicator.provider`. A remote provider runs only when `remoteConsentOrigins` in `~/.eminiar/config.json` lists its origin |
| `EMINIAR_ADJUDICATOR_MODE` | Overrides `adjudicator.mode` (`advise` or `apply`) |
| `EMINIAR_ADJUDICATOR_REMOTE=0` | Withdraws remote consent. `=1` does nothing: no environment variable can grant consent, because a project's `.claude/settings.json` can set them |
| `EMINIAR_ADJUDICATOR_KEY` | Adjudicator provider key, checked after `keyEnv` and the provider's own variable (`TYPESAFE_API_KEY`, `GROQ_API_KEY`, `CEREBRAS_API_KEY`) and before `~/.eminiar/adjudicator.key` |
