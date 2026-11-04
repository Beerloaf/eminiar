# Adjudicator

[← Docs index](README.md)

The adjudicator is optional and **off by default**. It scores how complex each piece of work is,
on a 0 to 4 scale, and suggests three things for it:

- the eminiar **tool** to start with (`em_symbols`, `em_search`, `em_execute`, …)
- the Claude **model size** (`haiku`, `sonnet`, `opus`, or `fable` if you add it) and an
  effort level
- the swarm **agent role** (`explorer`, `coder`, `architect`, …)

A piece of work is a prompt you type, a subagent dispatch, or a task in an
[agent swarm](swarms.md) plan. The goal is to send small work to small models and to the right
`em_*` tool, so sessions finish sooner and use fewer tokens. Every suggestion comes with its
reasons.

**Contents:** [What it does not do](#what-it-does-not-do) · [Cost when off](#cost-when-off) ·
[Turn it on](#turn-it-on) · [Providers and privacy](#providers-and-privacy) ·
[Keys](#keys) · [Where the advice shows up](#where-the-advice-shows-up) ·
[Advise and apply](#advise-and-apply) · [Swarm plans](#swarm-plans) ·
[em_adjudicate](#em_adjudicate) · [Dashboard](#dashboard) · [Learning](#learning) ·
[Savings](#savings) · [Accuracy](#accuracy) · [Limits](#budgets-breaker-and-limits) ·
[Troubleshooting](#troubleshooting) · [Turn it off](#turn-it-off)

## How it decides

A built-in **heuristic** always runs. It extracts features from the text (verbs such as
`rename` or `refactor`, paths, scope words, risk words, pasted logs, task titles) and scores
each option from them. It runs in under a millisecond and needs no network. It is also the
fallback whenever anything else fails.

You can blend one **provider** onto the heuristic: TypeSafe's Jev, any OpenAI-compatible
endpoint (Groq, Cerebras, Ollama, LM Studio, llama.cpp or your own), or a local
nearest-neighbour search over labelled examples with the embedding model eminiar already ships.
A provider's weight is capped (`weights.providerMax`, `weights.embeddingMax`), so it adjusts the
heuristic but never replaces it.

The heuristic leans up on purpose. A task given a model that is too small usually fails and is
redone, which costs more than a model one size too large. When the final tier is a near tie
(confidence below `weights.lowConfidence`), it moves one tier up.

## What it does not do

- It does not touch API traffic. It uses only Claude Code's own Agent `model` parameter and hook
  text.
- It cannot change the main session's model. Hooks cannot do that, so for the main session it
  only suggests `/model`.
- It never denies or blocks a tool call.
- It never writes free text into your prompts. Its output is one short line.
- It does nothing in Cursor.

## Cost when off

When `adjudicator.enabled` is `false` (the default), the adjudicator costs one boolean check per
hook. Its code sits in separate chunks of the hook bundle that are loaded only when it is on, and
the config loader skips its section while it is untouched. Measured over 60 interleaved runs
(p50, with Node's compile cache), the prompt and Bash hooks are within 1 ms of the build before
the adjudicator existed: 43.2 → 44.2 ms and 43.2 → 43.5 ms for a prompt, 41.7 → 41.7 ms and
41.4 → 41.6 ms for a Bash call.

While it is off, nothing is written to the database or sent anywhere, and the `em_adjudicate`
tool is not registered.

## Turn it on

You can turn it on in any of these ways:

- **During install.** An interactive `eminiar install` asks *"Use the adjudicator for tool,
  model and agent selection?"* (default No). The question is skipped under `--yes`, by
  `eminiar upgrade`, and once `~/.eminiar/config.json` already says on or off.
  `eminiar install --adjudicator[=heuristic|embedding|typesafe|groq|cerebras|ollama|lmstudio|llamacpp]`
  turns it on without asking.
- **During onboarding.** `/em-onboard` asks the same question. It never takes a key in chat. It
  tells you to run `eminiar adjudicator key set` in your own terminal.
- **From the CLI**, at any time:

```sh
eminiar adjudicator enable                      # heuristic only, nothing leaves the machine
eminiar adjudicator enable --provider embedding # local model, still offline
eminiar adjudicator enable --provider ollama    # a local OpenAI-compatible server
eminiar adjudicator enable --provider jev       # TypeSafe Jev: asks for consent and a key
eminiar adjudicator enable --project            # write only adjudicator.enabled to eminiar.config.json
eminiar adjudicator status                      # what is on and what actually runs
```

Hooks pick up the change on the next prompt. The `em_adjudicate` tool is registered when the MCP
server starts, so run **`/mcp reconnect`** (or restart Claude Code) after enabling or disabling.

`enable --project` writes only `adjudicator.enabled: true` to the committed
`eminiar.config.json`. The provider, the keys and the consent stay personal, in
`~/.eminiar/config.json` and `~/.eminiar/adjudicator.key`.

A project file comes with every clone of the repo, so eminiar trusts it only for settings that
cannot send your text or keys anywhere. In `eminiar.config.json` the adjudicator section may set
`enabled`, `mode`, `surfaces`, `promptMode`, `minPromptChars`, `tiers`, `weights`, `apply`,
`advice`, `embedding`, `learning` and `cache`. Everything else is ignored there: `provider`,
`typesafe`, `openai` (preset, base URL, model, price), `keyEnv`, `remoteConsent`,
`remoteConsentOrigins`, `privacy`, `budget`, `timeouts` and `breaker` are read only from
`~/.eminiar/config.json` and the `EMINIAR_ADJUDICATOR*` variables. `eminiar doctor` (check
"adjudicator project config"), `adjudicator status` (a `warning:` line, `projectIgnored` in
`--json`) and the dashboard overview name any key a project file sets that was ignored, even
while the adjudicator is off. A repo that turns the adjudicator on for someone with no personal
setup gets the heuristic, which never leaves the machine. Keys named `__proto__`,
`constructor` or `prototype` are dropped from every config file at any depth, so they cannot
smuggle settings past this list.

The same `.claude/settings.json` `env` block could also move `EMINIAR_HOME` (or `HOME`) into the
repo, so that a `config.json` the repo ships is read as your personal one. eminiar anchors the
personal config to your account: `~/.eminiar/config.json` in the home directory from the
system's user database (not `$HOME`) is always yours. A relative `EMINIAR_HOME` or `HOME` is
never trusted, since the folder a session starts in decides where it points. A `config.json`
anywhere else is honoured only when its real path, after symlinks, is neither inside nor above
the project root, the current directory and every git work tree around them: linked work trees,
and the superproject when you work inside a git submodule. A personal config there gets the same
treatment as `eminiar.config.json`: only the keys listed above apply, and doctor, status and the
dashboard name the ones it ignored. `enable`, `provider` and `key set` refuse to write there (a
key stored inside a repo could be committed). Keep a custom `EMINIAR_HOME` an absolute path
outside your projects; temporary directories, as tests and CI use, are fine. A tree with no git
at all (an unpacked archive) has no work tree to anchor on: don't let its `.claude/settings.json`
set `EMINIAR_HOME` or `HOME` before you have read it.

## Providers and privacy

| Provider | Choose with | Runs where | What leaves this machine | Needs |
|---|---|---|---|---|
| `heuristic` (default) | `--provider heuristic` | in-process, every surface | **nothing** | — |
| `embedding` | `--provider embedding` | MCP server and CLI only; hooks use the heuristic or a verdict the server cached | **nothing**. Uses the local `bge-small` model eminiar already uses for search | the embedding model (downloaded with eminiar's install, or on first use) |
| TypeSafe Jev | `--provider jev` (or `typesafe`) | `api.typesafe.ai` | redacted text, see below | consent and a key |
| Groq | `--provider groq` | `api.groq.com`, model `openai/gpt-oss-20b` | redacted text, see below | consent and a key |
| Cerebras | `--provider cerebras` | `api.cerebras.ai`, model `gpt-oss-120b` | redacted text, see below | consent and a key |
| Ollama | `--provider ollama` | `localhost:11434`, model `qwen2.5:1.5b-instruct` | **nothing** (loopback) | a running Ollama |
| LM Studio | `--provider lmstudio` | `localhost:1234`, the loaded model | **nothing** (loopback) | a running LM Studio server |
| llama.cpp | `--provider llamacpp` | `localhost:8080`, the loaded model | **nothing** (loopback) | a running `llama-server` |
| custom | `provider openai-compatible --preset custom --base-url U --model M` | your URL | nothing if the URL is loopback; otherwise redacted text | `openai.baseUrl` and `openai.model`; consent and a key if remote |

Locality is decided by the URL actually used. A local preset whose `openai.baseUrl` points at
another host counts as remote, and then it needs consent and a key like any hosted provider.
Only `localhost`, `*.localhost`, `127.0.0.0/8` and `::1` count as local.

**What a remote provider receives**, per item:

- The text of the prompt or task after normalising and **redaction**, cut to `privacy.maxChars`
  (default 2000) characters. Redaction masks private keys, credentials in URLs, bearer tokens,
  `sk-…`, GitHub, Slack and AWS keys, JWTs, `key=value` pairs whose name looks secret, email
  addresses, and long hex or base64 runs.
- For a swarm task: the planned role name and the number of files and dependencies.
- The static catalogue: the tier ladder, the tool ids and the role names with their one-line
  descriptions (your swarm's roles and descriptions when scoring a plan).
- A positional item id (`i0`, `i1`, …), never a request key, a path to the project or a
  session id.

The API key goes only in the `Authorization` header. It is scrubbed from every error and log
line.

**Consent.** Before a remote provider is used, eminiar prints exactly what will be sent:

```text
The text of your prompts and subagent tasks (redacted, at most 2000 chars) is sent to https://api.typesafe.ai to score them.
```

Then it asks y/N. Without a terminal, `--accept-remote` is the only way to agree. `--yes` never
grants it. If you decline during install, the heuristic is used instead. If you decline in
`enable` or `provider`, nothing changes.

Consent is bound to the **origin** the notice named: scheme, host and port. Agreeing writes
`remoteConsent: true` and adds that origin to `remoteConsentOrigins` in `~/.eminiar/config.json`
(for example `["https://api.groq.com"]`). Every remote call checks it: a provider whose URL has
another origin falls back to the heuristic with `no_consent`. Switching to another preset, or
`provider … --base-url` with a new host or port, shows the notice and asks again. A project file
cannot set `remoteConsentOrigins`.

No environment variable can grant consent: a project's `.claude/settings.json` can set
environment variables for your session and its hooks, so a cloned repo must not be able to start
sending your prompts anywhere. `EMINIAR_ADJUDICATOR=1` may turn the adjudicator on, and
`EMINIAR_ADJUDICATOR_PROVIDER` may pick a remote provider, but that provider runs only when
`remoteConsentOrigins` in `~/.eminiar/config.json` already lists its origin; otherwise the
heuristic runs with `no_consent`. `EMINIAR_ADJUDICATOR_REMOTE=1` does nothing.
`EMINIAR_ADJUDICATOR_REMOTE=0` withdraws every consent, and `EMINIAR_ADJUDICATOR=0` turns the
adjudicator off.

A config written before consent named origins (`remoteConsent: true` with no list) still covers
the built-in hosts (`https://api.groq.com`, `https://api.cerebras.ai`, `https://api.typesafe.ai`)
for the provider your config names, but not for one `EMINIAR_ADJUDICATOR_PROVIDER` swaps in. The
next `enable` or `provider` writes `remoteConsentOrigins` with only the origin its notice named.
The provider your config named is worked out from `~/.eminiar/config.json` alone, never from an
environment override. If you move to another host, the old one asks again the next time you pick
it.

eminiar never follows an HTTP redirect from a provider: a 3xx answer is an error, so a server
cannot forward your text or key to another host. Set the base URL to the final endpoint.

**What is stored locally**, in the project database: a hash of the input, the scores and
reasons, the provider status, latency and tokens, and at most 80 redacted characters of the
input (`privacy.storeHead: false` stores none). Prompts and keys are never stored.
`eminiar purge adjudicator --yes` deletes the decisions, the verdict cache, the provider state
and the learned bias.

### Setting up each provider

- **Heuristic:** `eminiar adjudicator enable`. Nothing else.
- **Embedding:** `eminiar adjudicator enable --provider embedding`. The first scoring embeds the
  shipped examples once and caches the vectors under `~/.eminiar/models/`. The MCP server warms
  the model in the background at start. `eminiar install --no-model` defers the model download to
  first use.
- **Jev:** `eminiar adjudicator enable --provider jev`, agree to the notice, then paste your
  TypeSafe key at the hidden prompt (or later: `eminiar adjudicator key set typesafe`). The model
  is pinned to `jev-1.14.0`. The moving aliases `jev-latest` and `jev-preview` are replaced by
  it, because the thresholds were tuned against that version. Jev charges $0.042 per million
  input tokens; output is free.
- **Groq / Cerebras:** `eminiar adjudicator enable --provider groq` (or `cerebras`), agree, paste
  the key. Groq is priced at $0.075 / $0.30 per million input / output tokens. Cerebras has no
  price in the table, so its cost shows as unknown unless you set `openai.price`, and
  `budget.dailyCalls` is what limits it.
- **Ollama:** `ollama pull qwen2.5:1.5b-instruct`, then
  `eminiar adjudicator enable --provider ollama`. On session start eminiar sends a keep-alive
  request so the model is loaded before your first prompt.
- **LM Studio / llama.cpp:** start the server with a small instruct model loaded, then
  `eminiar adjudicator enable --provider lmstudio` (or `llamacpp`). The server's loaded model is
  used unless you set `openai.model`.
- **Custom:** `eminiar adjudicator provider openai-compatible --preset custom --base-url https://host/v1 --model my-model`.
  JSON answers use a strict JSON schema; with `openai.json: "auto"` a server that rejects
  `response_format` gets plain JSON mode instead, and the choice is remembered.

`eminiar adjudicator provider --detect` looks for Ollama, LM Studio and llama.cpp on their
default ports and suggests a command. It changes nothing.

## Keys

Keys never go in config files, on the command line, in logs, in the database or in any
dashboard payload. A config section that contains a field named like `apiKey`, `token`,
`secret` or `password` is rejected.

`eminiar adjudicator key set [provider]` reads the key from a hidden prompt, or from stdin when
there is no terminal (`pbpaste | eminiar adjudicator key set typesafe`). It stores the key in
**`~/.eminiar/adjudicator.key`**, a JSON file with mode **0600** written through a temporary file
and a rename. A key file that group or others can read is ignored, and `doctor` tells you to run
`chmod 600`. A key given as an argument is refused, and so is any flag value shaped like one:
`--model`, `--since`, `--fixture` or `--repeat` with a key prefix or a long run of characters
with digits, and a `--base-url` with a user name or password, a fragment, or a query parameter or
path segment that holds a key. The error never repeats the value and nothing is written.

eminiar looks for a key in this order:

1. the environment variable named by `adjudicator.keyEnv`
   (`eminiar adjudicator key set --from-env NAME` stores only the name)
2. the provider's own variable: `TYPESAFE_API_KEY`, `GROQ_API_KEY` or `CEREBRAS_API_KEY`
3. `EMINIAR_ADJUDICATOR_KEY`
4. the key file

`keyEnv` counts only in `~/.eminiar/config.json`. A local provider (one whose URL is
`localhost`, `127.x.x.x` or `::1`) never gets a key from an environment variable, not even
`keyEnv` or `EMINIAR_ADJUDICATOR_KEY`: if your local server needs a token, store it with
`eminiar adjudicator key set` for that preset.

`eminiar adjudicator key status` shows where each key comes from, masked as `****abcd`. It
reports the key that would actually be sent, so a local target shows only its key-file entry
(or none), never an environment variable.
`key clear [provider]` removes one key, or the whole file.

## Where the advice shows up

| Surface | Hook | What you see | Config |
|---|---|---|---|
| Prompt | UserPromptSubmit | One line for Claude, for example `eminiar adjudicator: complexity 1/4 (lookup) · start with em_symbols → em_search · if you delegate: haiku, role explorer` | `surfaces.prompt` |
| Main session | UserPromptSubmit | A note when the session model is at least two tiers above the advice, at most once every `advice.cooldownPrompts` prompts: `… /model haiku would be cheaper than opus` | `advice.mainSession`: `user` (shown to you), `context` (to Claude) or `off` |
| Subagent dispatch | PreToolUse on `Agent` | A note on the call: `adjudicator: model haiku would do (complexity 1, conf 0.82): pass model:'haiku'; pass effort:'low' (Claude Code 2.1.292+), role explorer`. For an agent whose definition pins a model it names the pin instead: `adjudicator: pinned opus (adjudicator would pick haiku; remove the model pin in .claude/agents/x.md to let it choose); …`. See [What the advice tells you to pass](#what-the-advice-tells-you-to-pass) for FORCE and forks. In apply mode it may set the model | `surfaces.agent` |
| Swarm plan | `em_swarm plan` | One line per task, see [Swarm plans](#swarm-plans) | `surfaces.plan` |
| Raw tool | PreToolUse on `Bash`, `Read`, `Grep`, … | A hint when the call contradicts the prompt's advised `em_*` tool, once per prompt, only when routing said nothing | `surfaces.tools` (off by default) |

Prompts shorter than `minPromptChars`, slash commands and plain chat are not scored. On a prompt
the provider runs according to `promptMode`:

- `async` (default): the heuristic answers at once. A detached process asks the provider and
  caches the blended verdict, so a repeat of the same text gets it.
- `blocking`: the provider is asked inline, within `timeouts.promptMs` (local providers:
  `timeouts.localMs`).
- `heuristic`: the provider is never asked on prompts.

## Advise and apply

`mode: "advise"` (default) only suggests. The coordinator, or you, passes `model` on the Agent
call. A dispatch in advise mode never makes a network call; it uses the plan's verdict, a cached
one, or the heuristic.

`mode: "apply"` lets the PreToolUse hook set `model` on the Agent call itself, through Claude
Code's `updatedInput`. It is best effort, because Claude Code does not document whether a model
set by a hook takes effect. eminiar measures it: `eminiar adjudicator status` and the dashboard
show how many applied dispatches ran on the chosen model ("n of m").

These are Claude Code's rules for a subagent's model, and the adjudicator follows them:

1. `model` on the Agent call wins, then the subagent's frontmatter `model` (`inherit` means the
   main model), then `CLAUDE_CODE_SUBAGENT_MODEL`, then the main session's model.
2. `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` overrides all of them. It follows Claude Code's on/off
   rule: `1`, `true`, `yes` or `on`, in any casing, turn it on; anything else (`0`, `false`,
   `no`, `off`, empty, unknown values) leaves it off. While it is on, the adjudicator never
   changes a model, the advice says the model is informational (no pin is named: FORCE ignores
   pins too), and `status` and `doctor` warn in apply mode.
3. The Agent `model` parameter accepts only `haiku`, `sonnet`, `opus` and `fable`.
4. **Effort can be passed per call** from Claude Code 2.1.292: the Agent call takes an `effort`
   parameter (`low`, `medium`, `high`, `xhigh` or `max`; levels a model lacks fall back to the
   highest one below) that overrides the agent file's `effort`, for non-fork subagents.
   `CLAUDE_CODE_EFFORT_LEVEL` outranks both. The adjudicator suggests a level for the
   coordinator to pass (`max` only at the very top of the complexity scale, c ≥ 3.75), and says
   the level is informational while `CLAUDE_CODE_EFFORT_LEVEL` is set. The hook never injects
   `effort`, in apply mode too.

Apply mode changes the model only when all of these hold:

- `apply.scope` is `all`, or the dispatch is a swarm worker (`swarm`, the default)
- the call has no explicit `model`
- the agent's definition has no `model` pin (or `inherit`), or `apply.respectFrontmatter` is
  `false`
- `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` is off
- the tier confidence is at least `apply.minConfidence`

The tier is clamped to `apply.floor` … `apply.ceiling`. The hook keeps every other field of the
call, never turns a deny or ask into an allow, and never adds `effort`. Each dispatch is recorded
as `advised`, `applied` or `respected` (left alone because of an explicit model, a pin or FORCE).

The pin is looked up the way Claude Code finds the agent: managed agents first, then the
project's `.claude/agents` folders from the current directory up to the repo root (closest
first), then `~/.claude/agents`, then plugin agents (`plugin:agent`, from
`installed_plugins.json` and `CLAUDE_CODE_PLUGIN_DIRS`), then the built-in agents. Folders are
searched recursively and matched on the frontmatter `name`, not the file name. When the pin
cannot be known (no definition found, an unreadable or malformed file, copies that disagree, or
an agent defined only for the session with `--agents`), apply mode leaves the model alone and
only advises: the note says "model pin is unknown (… not overridden while the agent's definition
cannot be read)" and the decision's `scores.pin` records why.

Advise mode respects pins the same way (with `apply.respectFrontmatter` on, the default). For a
pinned agent, or one whose pin is unknown, the dispatch note and the plan line name the pin and
what the adjudicator would pick, and never tell the coordinator to pass a different `model`.
Remove the pin (for swarm workers, the role's `model` in `swarm.yaml`) to let the adjudicator
choose. These dispatches get no savings credit, even if a `model` is passed anyway.

### What the advice tells you to pass

One rule decides what the dispatch note, the plan's suggestion lines and the plan's "Next:" line
tell the coordinator to pass on the Agent call. The first matching row decides `model`:

| The dispatch | `model` | `effort` | Savings credit |
|---|---|---|---|
| A fork (`subagent_type: "fork"`) | none: a fork runs on the main session's model | none: per-call `effort` is for non-fork subagents | none |
| `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` on | informational: Claude Code ignores the call's `model` and the agent's pin | by the effort rule | none |
| The agent's pin is respected (pinned, or unknown) | none: the agent keeps its pin | by the effort rule | none |
| Anything else | pass the suggested `model` | by the effort rule | when followed or applied |

The effort rule: pass the suggested `effort` (Claude Code 2.1.292+), unless
`CLAUDE_CODE_EFFORT_LEVEL` is set or the call already passes `effort`; then the level is
informational. The "Next:" line only mentions `model` when at least one task has a model to
pass, and then adds "leave `model` unset for pinned agents" when some agents keep a pin.

A fork's note is only informational:

```text
adjudicator: fork runs on the main session's model; no `model` or `effort` to pass (complexity 3, conf 0.80)
```

Under FORCE the note keeps the effort hint and calls the model informational:

```text
adjudicator: CLAUDE_CODE_SUBAGENT_MODEL_FORCE sets the model (adjudicator would pick haiku; complexity 1, conf 0.82); pass effort:'low' (Claude Code 2.1.292+), role explorer
```

Dispatches without a model to pass are kept out of the comparison between advice and outcome:
reconcile never marks them followed or ignored, the follow rate leaves them out of its
denominator, and the suggested tier × model matrix counts them on their own line ("2 kept their
pin", "1 under CLAUDE_CODE_SUBAGENT_MODEL_FORCE", "1 fork"). A pinned dispatch counts as having
kept its pin when no `model` was passed and it ran on the pinned tier; otherwise it stays in the
matrix.

## Swarm plans

With `surfaces.plan` on, `em_swarm plan` scores all new tasks in one batched call (within
`timeouts.planMs`; the heuristic answers if the provider fails) and appends one line per task:

```text
Planned 3 task(s) in run …; claimable now: #5, #6, #7.
Next: spawn one worker per claimable task with the Agent tool: subagent_type …, and a prompt that names "task #N" (the worker claims it), passing `model` and `effort` as each suggestion below says; leave `model` unset for pinned agents; run_in_background: true runs them in parallel. …
…
Adjudicator suggestions: pass the model as `model` and the effort as `effort` on each Agent call (`effort` needs Claude Code 2.1.292 or later); a pinned agent keeps its model: pass no `model`:
#5 → swarm-feature-coder · model haiku · effort low (complexity 1, conf 0.82)
#6 → swarm-feature-architect · model opus · effort high (complexity 3, conf 0.77); role suggested: architect (planned: coder)
#7 → swarm-feature-reviewer · pinned opus (adjudicator would pick haiku; remove the pin in swarm.yaml to let it choose) · effort low (complexity 1, conf 0.80)
```

A role whose agent pins a model (its `model` in `swarm.yaml`, or any agent definition Claude Code
would find first) keeps it; a definition that cannot be read shows `model pin is unknown`. With
`CLAUDE_CODE_SUBAGENT_MODEL_FORCE` on the model is informational (`model haiku (informational)`,
no pin named), and with `CLAUDE_CODE_EFFORT_LEVEL` set the effort is. The head and the "Next:"
line follow [the same rule](#what-the-advice-tells-you-to-pass), so they never disagree: with
every agent pinned, "Next:" says "passing `effort` as each suggestion below says; leave `model`
unset for pinned agents". If scoring fails outright, the plan still succeeds, the MCP server
logs the error on stderr, and the plan ends with "Adjudicator advice unavailable for this plan
(the tasks are planned)."

The planned role gets a head start in scoring, so "role suggested" appears only on strong
evidence. When the worker is dispatched, the hook reuses the plan's verdict for that task rather
than scoring again, and records whether the coordinator followed it. This is the reliable path:
the coordinator passes `model` (and `effort`) where the suggestion says to, which Claude Code
honours unless `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` (or `CLAUDE_CODE_EFFORT_LEVEL`) is set.

## em_adjudicate

An MCP tool, registered only while the adjudicator is on. See [Tools](tools.md#adjudicator).

```text
em_adjudicate {action: "score", text: "rename parseDate in src/utils/date.ts"}
em_adjudicate {action: "score", tasks: [{key: "a", title: "Add a --json flag to stats", role: "coder"}]}
em_adjudicate {action: "explain", id: 42}
em_adjudicate {action: "stats", since: "7d"}
em_adjudicate {action: "feedback", id: 42, outcome: "too_small", note: "needed opus"}
```

`score` returns one line per item with a decision id. `explain` shows the score tables with
their reasons, the features, the blend weights, the provider status, the cost and the outcome.
`stats` summarises decisions, follow rate and savings. `feedback` (`good`, `too_small` or
`too_big`) closes the decision and teaches the learned bias.

## Dashboard

`eminiar ui` has an **Adjudicator** tab: decisions per day, follow and fallback rates, provider
health, a call log with a detail drawer, savings with their assumptions, a try-it box and the
last eval report. See [Dashboard](dashboard.md#adjudicator).

## Learning

eminiar links each decision to what happened afterwards: the swarm task's status, the subagent
that ran, the tokens it used, a redo, or your feedback. This runs at session end, before stats,
and before every dashboard read. Outcomes feed a small learned bias per bucket (complexity ×
tier, and intent × role) with a Beta(2,2) prior, decay (`learning.halfLife` outcomes), a bound
(`learning.maxBias`) and a small cost term (`learning.costWeight`). A bucket counts only after
`learning.minSamples` outcomes. `eminiar adjudicator stats --reset-learning` clears it, and
`learning.enabled: false` turns it off.

## Savings

The savings figure is an estimate. This is how it is computed.

- **Baseline.** For each dispatch, the model that would have run without the adjudicator: the
  agent file's pinned model, else the main session's model at that moment (from
  [usage](usage.md) data), else `claude-sonnet-5-5`. Under `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` it
  is `CLAUDE_CODE_SUBAGENT_MODEL` (pins are ignored), and for a fork the main session's model.
- **Realised savings.** The tokens the dispatch actually used, repriced at the baseline model,
  minus their actual cost. Only dispatches where the advice was **followed** or **applied** get
  credit. A failed attempt that was redone is charged its full cost. A dispatch whose advice
  named no model gets none: a kept pin (pinned or unknown), `CLAUDE_CODE_SUBAGENT_MODEL_FORCE`,
  or a fork.
- **Net** = realised savings − the adjudicator's own provider spend.
- **Potential savings.** Prompts whose advised tier was below the model that ran, repriced at
  the advised tier. Shown separately and never added to net.

Assumptions, shown next to every figure:

- Token counts would have been the same on the baseline model. Smaller models can need more
  turns, so compare tokens per successful task by tier (the dashboard and `--json` stats show
  it).
- List prices, with cache pricing unchanged (`usage.pricing` overrides apply).
- Credit only for dispatches that were followed or applied; a failed attempt that was redone is
  charged its full cost.
- No credit for a dispatch to an agent whose model pin the advice kept (pinned, or a pin that
  could not be read): the adjudicator chose nothing there.
- No credit while `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` is on, nor for a fork (it runs on the main
  session's model): Claude Code, not the advice, sets the model.
- The adjudicator's own provider spend is subtracted.
- No credit for tool advice: `em_stats` already counts the context kept out by `em_*` tools.
  Only the tool-advice follow rate is reported.
- Main-session advice yields potential savings only and is never added to net: the
  counterfactual cannot be observed.

Without usage ingestion (`usage.enabled: false`, or before the first ingest) there is no actual
or baseline cost, and the report says so.

## Accuracy

`eminiar adjudicator eval` scores a labelled set and compares each provider with the heuristic.
The built-in set has 40 items. Two held-out sets of 60 items each live in the repository's
tests, outside the package. Results on 2026-11-04 (tier = exact Claude tier; complexity ±1 =
within one step on the 0–4 scale):

| Set | Majority class | Heuristic, tier | Heuristic, complexity ±1 | Embedding blended, tier | Embedding blended, complexity ±1 |
|---|---|---|---|---|---|
| Built-in, 40 (the heuristic was tuned on it) | 47.5% | 92.5% (37/40) | 97.5% | 90.0% (36/40) | 100% |
| Held-out, 60 (used to check tuning) | 50.0% | 83.3% (50/60) | 95.0% | 81.7% (49/60) | 100% |
| Held-out 2, 60 (blind) | 45.0% | 78.3% (47/60) | 95.0% | 78.3% (47/60) | 93.3% |

What this says:

- The **heuristic** is the number to trust, and the blind held-out set is the honest one: about
  78% exact tier against 45% for always guessing the most common tier. Its errors lean towards
  a larger model (16.7% over-tier against 5.0% under-tier on the blind set), as designed.
- The **embedding** provider barely adds anything over the heuristic. The blend is equal or one
  item worse on tier, and gains or loses a few points on complexity ±1. The eval verdict was "no"
  on all three sets. Use it if you like, but expect the heuristic's results.
- **Jev and the OpenAI-compatible providers are unmeasured.** The harness supports them, but no
  run with a key has been recorded. Measure them on your own key before relying on them:

```sh
eminiar adjudicator eval --providers typesafe            # or --provider groq, --provider ollama, …
eminiar adjudicator eval --providers typesafe --save     # keep the report for the dashboard
```

Every run ends with one verdict line, for example
`embedding beats heuristic-only on tier+complexity: no (Δ tier -2.5 pp, Δ complexity ±1 +2.5 pp)`.
"Yes" needs neither difference to be negative and one to be positive. Remote providers need
consent and a key here too; a provider without them is listed as skipped. The report also shows
role and tool accuracy, under- and over-tier rates, answer validity, timeouts, p50/p95 latency,
tokens and $ per 1000 items, and accuracy above and below confidence 0.8. It never contains item
text.

To test on your own data, label items as `{text, tier, complexity, role, tool}` in a JSON file:
`eval --fixture my-set.json` adds them to the built-in set, and `--replace` uses them alone.
Hold out about 30% before you tune `weights.features`, and grow the set past 100 items. In a
source checkout, the held-out sets run with
`npx tsx src/cli.ts adjudicator eval --fixture tests/fixtures/adjudicator-heldout-2.ts --replace`.

## Budgets, breaker and limits

Every path has a hard deadline and falls back to the heuristic, so a slow or broken provider
costs at most its timeout.

| Guard | Default | What happens |
|---|---|---|
| Timeouts | prompt 1200 ms, agent 800 ms, plan 3000 ms, local providers 600 ms | The heuristic answers when the provider misses the deadline |
| Circuit breaker | opens after 2 consecutive failures, for 120 s | Timeouts, 5xx, 429/529 and refused connections count; other 4xx and bad answers do not. After the cooldown one trial call goes through; success closes it |
| Slow guard | p95 above the surface budget, over at least 5 calls | The provider is skipped for the breaker cooldown, then the latency history starts over |
| Daily spend cap | `budget.dailyUsd` $0.50 per remote provider per UTC day | The provider is skipped for the rest of the day. Local providers are never capped. A call with an unknown price adds $0 |
| Daily call cap | `budget.dailyCalls` 2000 per remote provider per UTC day (`0` = unlimited) | The provider is skipped for the rest of the day. This is what limits a provider whose price is unknown. Every call that reached the provider counts, failures too; a dashboard try-it call counts as well |
| Auth lockout | 1 hour | A 401 or 403 marks the key as rejected. The provider is skipped with no network call until the key changes or the hour passes. Status shows "API key rejected" |
| Verdict cache | 24 h, 2000 entries | Blended verdicts are reused for the same text; the heuristic is not cached because it is cheaper than a lookup |

The breaker state, spend and calls live in the project database, so every hook process sees them.

## Troubleshooting

Start with `eminiar adjudicator status` (or `eminiar doctor`, which adds the adjudicator checks;
`doctor` also makes a 2-second live probe of the provider). The status names the configured
provider, the one that actually runs, and why they differ.

| Symptom | Cause and fix |
|---|---|
| `em_adjudicate` is missing | The MCP server registered its tools before you enabled it: `/mcp reconnect`. Or it is off: check `status` for which layer decides (`env EMINIAR_ADJUDICATOR`, project file, global file) |
| "the heuristic runs until: no key for typesafe" | `eminiar adjudicator key set typesafe` |
| "… sends redacted prompt text to …: run `eminiar adjudicator enable --accept-remote`" | Consent is missing. Consent in a project file is ignored on purpose |
| "… which you have not agreed to (consent is per origin)" | You agreed to another host. Consent covers only the origins in `remoteConsentOrigins`; no environment variable grants it. Run `enable --accept-remote` to agree to this one |
| "redirect to … refused" | The provider answered with a 3xx. eminiar never follows redirects; set the base URL to the final endpoint |
| "eminiar.config.json sets adjudicator.… : ignored" | The project file set a provider, URL, key, cap or timeout. Those are personal: move them to `~/.eminiar/config.json` (`eminiar adjudicator provider …`) |
| "the key file is readable by others and was ignored" | `chmod 600 ~/.eminiar/adjudicator.key` |
| "API key rejected (HTTP 401)" | The key is wrong or revoked. Store a new one with `key set`; the lockout lifts as soon as the key changes |
| "the custom preset needs openai.baseUrl and openai.model" | Set both: `eminiar adjudicator provider openai-compatible --preset custom --base-url … --model …` |
| embedding shows `hook_context` | Expected: the embedding provider runs in the MCP server and CLI. Hooks use the heuristic, or a verdict the server cached |
| Fallback rate is high, status `breaker_open`, `slow_guard` or `timeout` | The provider is too slow for the budget. Use a smaller local model, raise `timeouts.localMs` / `promptMs`, or use `promptMode: "async"` |
| Status `over_budget` | The daily `budget.dailyUsd` or `budget.dailyCalls` cap was reached; it resets at 00:00 UTC |
| Apply mode shows "0 of n applied dispatches ran the chosen model" | Claude Code did not take the hook's model. Use advise mode and pass `model` on the Agent call |
| Savings stay $0 | Usage ingestion is off or has not run (`eminiar usage ingest`), or no advice was followed |
| "Not enabled: no consent" without a terminal | Pass `--accept-remote`; `--yes` never grants consent |

## Turn it off

- `eminiar adjudicator disable` (or `--project`), then `/mcp reconnect` to drop the tool. Keys
  and consent are kept; `eminiar adjudicator key clear` removes the keys.
- **Kill switch:** `EMINIAR_ADJUDICATOR=0` overrides every config file. Hooks see it on the next
  call; the MCP server needs a restart (`/mcp reconnect`).
- `eminiar purge adjudicator --yes` deletes the recorded decisions, cache, provider state and
  learned bias.

Every key is listed in [Configuration](configuration.md#adjudicator) and every command in
[CLI](cli.md#adjudicator).
