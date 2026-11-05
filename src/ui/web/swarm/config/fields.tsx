// Form controls the Configuration Studio shares between the role drawer, the swarm editor and
// the settings panel: the model policy (pin vs a range the adjudicator chooses in), the tier
// range bar, and the context-override editor. Every control is controlled (value + onChange)
// and accepts `disabled` for locked paths.
import type { JSX } from "preact";
import { useState } from "preact/hooks";
import { Segmented, Stepper } from "../../ds.js";
import { cls } from "../../util.js";
import {
  type DocTier,
  modelPolicy,
  type PolicyMode,
  rangeProblem,
  type SwarmDoc,
  type SwarmDocContext,
  type SwarmDocModelRange,
  TIERS,
  tierSpan,
  withPolicy,
} from "./draft.js";

const TIER_HINT: Record<DocTier, string> = {
  haiku: "fast, cheap",
  sonnet: "balanced",
  opus: "deep work",
  fable: "largest",
};

/** The tier scale with the span from floor to ceiling filled and the fallback marked. */
export function RangeBar({
  floor,
  ceiling,
  tier,
  compact,
  onPick,
}: {
  floor: DocTier | undefined;
  ceiling: DocTier | undefined;
  /** The fallback model's tier (marked ★); for a pinned role the one lit tier. */
  tier: DocTier | undefined;
  compact?: boolean | undefined;
  /** Click a tier: the parent decides which bound moves. */
  onPick?: ((t: DocTier) => void) | undefined;
}): JSX.Element {
  const span = floor && ceiling ? tierSpan(floor, ceiling) : tier ? [tier] : [];
  const label = span.length
    ? span.length === 1
      ? `pinned to ${span[0]}`
      : `${floor} to ${ceiling}${tier ? `, falls back to ${tier}` : ""}`
    : "no known tier";
  return (
    <div class={cls("swc-range", compact && "compact")} role="img" aria-label={label} title={label}>
      {TIERS.map((t, i) => {
        const on = span.includes(t);
        const first = on && span[0] === t;
        const last = on && span[span.length - 1] === t;
        const body = (
          <>
            <span class="swc-range-name">
              {t === tier ? <b aria-hidden="true">★ </b> : null}
              {t}
            </span>
            {compact ? null : <span class="swc-range-hint">{TIER_HINT[t]}</span>}
          </>
        );
        const c = cls(
          "swc-range-cell",
          on && "on",
          first && "first",
          last && "last",
          t === tier && "fb",
        );
        return onPick ? (
          <button
            type="button"
            class={c}
            style={{ "--i": String(i) } as JSX.CSSProperties}
            onClick={() => onPick(t)}
          >
            {body}
          </button>
        ) : (
          <span class={c}>{body}</span>
        );
      })}
    </div>
  );
}

/** A select of the model aliases, plus a free Claude model id. `undefined` = inherit the default. */
export function ModelSelect({
  value,
  models,
  inherited,
  disabled,
  id,
  onChange,
}: {
  value: string | undefined;
  models: string[];
  /** The default it falls back on when unset (shown as the first option); none for defaults. */
  inherited?: string | undefined;
  disabled?: boolean | undefined;
  id?: string | undefined;
  onChange: (v: string | undefined) => void;
}): JSX.Element {
  const custom = value !== undefined && !models.includes(value);
  const [typing, setTyping] = useState(custom);
  const sel = value === undefined ? "" : custom || typing ? "__custom" : value;
  return (
    <div class="swc-model">
      <select
        id={id}
        value={sel}
        disabled={disabled}
        onChange={(e) => {
          const v = (e.target as HTMLSelectElement).value;
          if (v === "__custom") {
            setTyping(true);
            onChange(value ?? "claude-");
          } else {
            setTyping(false);
            onChange(v || undefined);
          }
        }}
      >
        <option value="">
          {inherited !== undefined ? `default (${inherited})` : "not set (the main session's)"}
        </option>
        {models.map((m) => (
          <option value={m}>{m}</option>
        ))}
        <option value="__custom">a model id…</option>
      </select>
      {sel === "__custom" ? (
        <input
          type="text"
          class="mono"
          aria-label="Claude model id"
          placeholder="claude-sonnet-4-5"
          value={value ?? ""}
          disabled={disabled}
          spellcheck={false}
          onInput={(e) => onChange((e.target as HTMLInputElement).value.trim() || undefined)}
        />
      ) : null}
    </div>
  );
}

const POLICY_WORD: Record<PolicyMode, string> = {
  pin: "Pin the model",
  range: "Adjudicator picks",
  default: "Use the default",
};

export interface ModelValue {
  model?: string | undefined;
  model_range?: SwarmDocModelRange | undefined;
}

/**
 * Pin a model, or let the adjudicator choose a tier per task within floor..ceiling (the model
 * is then the fallback, which must lie inside the range). `doc` supplies the defaults a role
 * inherits; for the defaults themselves pass a doc without `defaults`.
 */
export function ModelPolicyControl({
  doc,
  value,
  models,
  isDefaults,
  modelDisabled,
  rangeDisabled,
  error,
  onChange,
}: {
  doc: SwarmDoc;
  value: ModelValue;
  models: string[];
  isDefaults?: boolean | undefined;
  modelDisabled?: boolean | undefined;
  rangeDisabled?: boolean | undefined;
  /** A server issue at the model or the range. */
  error?: string | undefined;
  onChange: (v: ModelValue) => void;
}): JSX.Element {
  const ctx: SwarmDoc = isDefaults ? { swarms: {} } : doc;
  const role = { description: "", ...value };
  const p = modelPolicy(ctx, role);
  const defaultRange =
    !isDefaults && !!(doc.defaults?.model_range?.floor || doc.defaults?.model_range?.ceiling);
  const modes: PolicyMode[] = defaultRange ? ["default", "pin", "range"] : ["pin", "range"];
  const problem = rangeProblem(
    p.model,
    p.mode === "pin" ? undefined : (value.model_range ?? doc.defaults?.model_range),
  );
  const setRange = (r: SwarmDocModelRange) => onChange({ ...value, model_range: r });
  const range = value.model_range ?? {};
  return (
    <div class="swc-policy">
      <Segmented<PolicyMode>
        label="model policy"
        value={p.mode}
        onChange={(m) => {
          const next = withPolicy(ctx, role, m);
          onChange({ model: next.model, model_range: next.model_range });
        }}
        options={modes.map((m) => ({
          id: m,
          label: POLICY_WORD[m],
          title:
            m === "pin"
              ? "always run this model"
              : m === "range"
                ? "the adjudicator picks haiku, sonnet, opus or fable per task, within the range"
                : "follow defaults.model_range",
        }))}
      />
      <div class="swc-policy-row">
        <label class="swc-mini-label" for="swc-model">
          {p.mode === "pin" ? "Model" : "Fallback model"}
        </label>
        <ModelSelect
          id="swc-model"
          value={value.model}
          models={models}
          inherited={isDefaults ? undefined : doc.defaults?.model}
          disabled={modelDisabled}
          onChange={(m) => onChange({ ...value, model: m })}
        />
      </div>
      {p.mode === "range" ? (
        <div class="swc-policy-row">
          <span class="swc-mini-label">Range</span>
          <div class="swc-bounds">
            <select
              aria-label="floor"
              value={range.floor ?? ""}
              disabled={rangeDisabled}
              onChange={(e) => {
                const v = (e.target as HTMLSelectElement).value as DocTier | "";
                setRange({ ...range, floor: v || undefined });
              }}
            >
              <option value="">floor: the fallback's tier</option>
              {TIERS.map((t) => (
                <option value={t}>floor: {t}</option>
              ))}
            </select>
            <select
              aria-label="ceiling"
              value={range.ceiling ?? ""}
              disabled={rangeDisabled}
              onChange={(e) => {
                const v = (e.target as HTMLSelectElement).value as DocTier | "";
                setRange({ ...range, ceiling: v || undefined });
              }}
            >
              <option value="">ceiling: the fallback's tier</option>
              {TIERS.map((t) => (
                <option value={t}>ceiling: {t}</option>
              ))}
            </select>
          </div>
        </div>
      ) : null}
      <RangeBar
        floor={p.floor}
        ceiling={p.ceiling}
        tier={p.tier}
        onPick={
          p.mode === "range" && !rangeDisabled
            ? (t) => {
                const lo = p.floor ? TIERS.indexOf(p.floor) : 0;
                const i = TIERS.indexOf(t);
                // Below the span moves the floor, above it the ceiling; inside, the nearer bound.
                const hi = p.ceiling ? TIERS.indexOf(p.ceiling) : TIERS.length - 1;
                if (i <= lo || (i < hi && i - lo <= hi - i)) setRange({ ...range, floor: t });
                else setRange({ ...range, ceiling: t });
              }
            : undefined
        }
      />
      <div class={cls("small", problem || error ? "bad" : "muted")}>
        {problem ??
          error ??
          (p.mode === "pin"
            ? p.model
              ? `Every task runs on ${p.model}${p.modelFrom === "defaults" ? " (the default)" : ""}.`
              : "No model set: the worker runs on the main session's model."
            : `The adjudicator picks ${p.floor} to ${p.ceiling} per task; ${p.model ?? "the fallback"} is pinned in the agent file and used when it does not choose.${p.mode === "default" ? " Follows defaults.model_range." : ""}`)}
      </div>
    </div>
  );
}

// --- context overrides ----------------------------------------------------------------

type CtxKey = keyof SwarmDocContext;
const CTX_FIELDS: Array<{ key: CtxKey; label: string; hint: string; kind: "n" | "b" }> = [
  {
    key: "memories",
    label: "Memories",
    hint: "project memories matching the role and task (0-10)",
    kind: "n",
  },
  { key: "docs", label: "Docs", hint: "documentation pages matching the task (0-10)", kind: "n" },
  {
    key: "history",
    label: "History",
    hint: "bug-prone files, recent fixes and history lessons",
    kind: "b",
  },
  {
    key: "insights",
    label: "Insights",
    hint: "hot files (fan-in × churn) in the work area",
    kind: "b",
  },
  {
    key: "structure",
    label: "Structure",
    hint: "the project brief: overview, decisions, constraints",
    kind: "b",
  },
  { key: "max_chars", label: "Max chars", hint: "size of the brief (500-9000)", kind: "n" },
];
const CTX_LIMITS: Partial<Record<CtxKey, [number, number, number]>> = {
  memories: [0, 10, 1],
  docs: [0, 10, 1],
  max_chars: [500, 9000, 500],
};

/**
 * Per-field overrides of what eminiar tells each worker when it starts. An unset field
 * inherits (`inherited` shows from where); `disabled` for a locked path.
 */
export function ContextEditor({
  value,
  inherited,
  inheritedFrom,
  disabled,
  onChange,
}: {
  value: SwarmDocContext | undefined;
  inherited: SwarmDocContext;
  inheritedFrom: string;
  disabled?: boolean | undefined;
  onChange: (v: SwarmDocContext | undefined) => void;
}): JSX.Element {
  const v = value ?? {};
  const set = (k: CtxKey, x: number | boolean | undefined) => {
    const next: SwarmDocContext = { ...v, [k]: x };
    if (x === undefined) delete next[k];
    onChange(Object.keys(next).length ? next : undefined);
  };
  return (
    <div class="swc-ctx">
      {CTX_FIELDS.map((f) => {
        const own = v[f.key];
        const inh = inherited[f.key];
        const lim = CTX_LIMITS[f.key];
        return (
          <div class={cls("swc-ctx-row", own !== undefined && "set")}>
            <span class="swc-ctx-label" title={f.hint}>
              {f.label}
              <span class="swc-ctx-hint">{f.hint}</span>
            </span>
            {f.kind === "b" ? (
              <Segmented<"inherit" | "on" | "off">
                label={f.label}
                value={own === undefined ? "inherit" : own ? "on" : "off"}
                onChange={(x) => !disabled && set(f.key, x === "inherit" ? undefined : x === "on")}
                options={[
                  {
                    id: "inherit",
                    label: `inherit (${inh === undefined ? "–" : inh ? "on" : "off"})`,
                    title: `use the value from ${inheritedFrom}`,
                  },
                  { id: "on", label: "on" },
                  { id: "off", label: "off" },
                ]}
              />
            ) : (
              <span class="swc-ctx-num">
                {own === undefined ? (
                  <button
                    type="button"
                    class="ghost sm"
                    disabled={disabled}
                    title={`override the value from ${inheritedFrom}`}
                    onClick={() => set(f.key, typeof inh === "number" ? inh : (lim?.[0] ?? 0))}
                  >
                    inherit ({String(inh ?? "–")}) · override
                  </button>
                ) : (
                  <>
                    <Stepper
                      label={f.label}
                      value={own as number}
                      min={lim?.[0]}
                      max={lim?.[1]}
                      onChange={(n) => {
                        if (disabled) return;
                        // Steps of 500 for max_chars, snapped to the range.
                        const step = lim?.[2] ?? 1;
                        const prev = own as number;
                        const dir = n > prev ? 1 : -1;
                        const raw = step === 1 ? n : Math.round((prev + dir * step) / step) * step;
                        set(f.key, Math.max(lim?.[0] ?? 0, Math.min(lim?.[1] ?? 99, raw)));
                      }}
                    />
                    <button
                      type="button"
                      class="ghost sm"
                      disabled={disabled}
                      title="inherit again"
                      onClick={() => set(f.key, undefined)}
                    >
                      ✕
                    </button>
                  </>
                )}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** A role's or swarm's context with the parents filled in (for the "inherit (x)" labels). */
export function mergedContext(
  builtIn: Record<string, unknown>,
  ...layers: Array<SwarmDocContext | undefined>
): SwarmDocContext {
  const out: SwarmDocContext = {
    memories: builtIn.memories as number,
    docs: builtIn.docs as number,
    history: builtIn.history as boolean,
    structure: builtIn.structure as boolean,
    insights: builtIn.insights as boolean,
    max_chars: (builtIn.maxChars ?? builtIn.max_chars) as number,
  };
  for (const l of layers)
    if (l)
      for (const [k, v] of Object.entries(l))
        if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  return out;
}
