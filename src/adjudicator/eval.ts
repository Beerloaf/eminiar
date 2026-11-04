/**
 * The adjudicator eval harness (docs/design/adjudicator.md §19; `eminiar adjudicator eval`).
 *
 * Scores a labelled set ({text, tool, tier, role, complexity}) and reports, per row:
 *
 * - `majority`: the majority label of each field, the reference every scorer must beat.
 * - `heuristic (raw)`: the heuristic's own table choices (scoreHeuristic).
 * - `heuristic (shipped)`: what the adjudicator returns with no provider, i.e. after blend()'s
 *   low-confidence round-up. The heuristic leans up on purpose (memory
 *   adjudicator/heuristic-asymmetric-tier), so under- and over-tier rates are reported apart.
 * - per candidate provider, `<id> (raw)` (its own answers, scored over the items it answered)
 *   and `<id> (blended)` (through the engine as shipped, every item, fallbacks included).
 *
 * Providers run through the real engine (adjudicate(), no store: no cache, breaker or spend), in
 * chunks of `chunkSize` (10, like a plan) with the plan budget per chunk. A recording wrapper
 * keeps the raw answers and usage. `repeat` runs every provider pass N times; accuracy counts
 * every pass (n = items × repeat) and latency percentiles come from all chunk calls.
 *
 * The set is the built-in EVAL_SET, optionally merged with or replaced by a fixture
 * (`--fixture`: JSON array / {items}, or a JS/TS module exporting the array). Fixtures are read at
 * run time, never bundled: the held-out sets in tests/fixtures stay out of the package.
 *
 * The report (EvalReport) holds counts, rates and a set hash, never item text; saveEvalReport()
 * writes it to meta `adjudicator:eval:last` for the dashboard. Pure apart from the providers it is
 * handed: consent and keys are checked in resolveEvalCandidates(), as everywhere else.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, extname, resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import type { AdjudicatorConfig } from "../config.js";
import { blend } from "./blend.js";
import { type Resolved, resolveAdjudicator } from "./config.js";
import { EVAL_SET, type EvalItem } from "./data/evalset.js";
import { adjudicate } from "./engine.js";
import { extractFeatures } from "./features.js";
import { complexityBucket, scoreHeuristic } from "./heuristic.js";
import { createProvider, type ProviderDeps } from "./providers/index.js";
import {
  type AdjudicationRequest,
  type AdjudicatorProvider,
  type Dist,
  EVAL_META_KEY,
  type ProviderAnswer,
  type ProviderId,
  type ProviderResult,
  SCORER_VERSION,
  TIERS,
} from "./types.js";

/** Meta key of the last report (read by GET /api/adjudicator/eval); declared in types.ts. */
export { EVAL_META_KEY };
export const EVAL_REPORT_VERSION = 1;
/** Items per provider call, like a plan. */
export const EVAL_CHUNK = 10;
/** Confidence split of the calibration check. */
export const CALIBRATION_AT = 0.8;

export type { EvalItem };

// ---------------------------------------------------------------------------------------------
// Fixtures

const ItemSchema = z.object({
  text: z.string().min(1),
  tool: z.string().min(1),
  tier: z.enum(TIERS),
  role: z.string().min(1),
  complexity: z.number().int().min(0).max(4),
});

export class EvalFixtureError extends Error {
  override name = "EvalFixtureError";
}

/** Validate a fixture: an array of items, or {items: [...]}. Extra fields are dropped. */
export function parseFixture(raw: unknown, source = "fixture"): EvalItem[] {
  const list =
    Array.isArray(raw) || !raw || typeof raw !== "object"
      ? raw
      : (raw as { items?: unknown }).items;
  if (!Array.isArray(list))
    throw new EvalFixtureError(`${source}: expected an array of items or {"items": [...]}`);
  if (!list.length) throw new EvalFixtureError(`${source}: the fixture has no items`);
  return list.map((it, i) => {
    const r = ItemSchema.safeParse(it);
    if (!r.success) {
      const issue = r.error.issues[0];
      const where = issue?.path.length ? issue.path.join(".") : "item";
      throw new EvalFixtureError(`${source}: item ${i} ${where}: ${issue?.message ?? "invalid"}`);
    }
    return r.data;
  });
}

/**
 * Read a fixture file: .json, or a module (.js/.mjs, and .ts under tsx/vitest) whose default
 * export, or first exported array, holds the items.
 */
export async function loadFixture(path: string): Promise<EvalItem[]> {
  const abs = resolvePath(path);
  const ext = extname(abs).toLowerCase();
  let raw: unknown;
  if (ext === ".json") {
    let text: string;
    try {
      text = await readFile(abs, "utf8");
    } catch (err) {
      throw new EvalFixtureError(`${basename(abs)}: ${(err as Error).message}`);
    }
    try {
      raw = JSON.parse(text);
    } catch (err) {
      throw new EvalFixtureError(`${basename(abs)}: not valid JSON (${(err as Error).message})`);
    }
  } else {
    let mod: Record<string, unknown>;
    try {
      mod = (await import(pathToFileURL(abs).href)) as Record<string, unknown>;
    } catch (err) {
      throw new EvalFixtureError(`${basename(abs)}: cannot load (${(err as Error).message})`);
    }
    raw = mod.default ?? Object.values(mod).find((v) => Array.isArray(v));
  }
  return parseFixture(raw, basename(abs));
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/**
 * "replace": the fixture alone. "merge": the base plus the fixture; an item whose normalised
 * text is already in the base replaces that item's labels, in place.
 */
export function mergeEvalItems(
  base: readonly EvalItem[],
  extra: readonly EvalItem[],
  mode: "merge" | "replace",
): EvalItem[] {
  if (mode === "replace") return [...extra];
  const out = [...base];
  const at = new Map(out.map((it, i) => [norm(it.text), i]));
  for (const it of extra) {
    const i = at.get(norm(it.text));
    if (i !== undefined) out[i] = it;
    else {
      at.set(norm(it.text), out.length);
      out.push(it);
    }
  }
  return out;
}

/** Identity of a set (texts + labels): reports of the same set can be compared without the text. */
export function evalSetHash(items: readonly EvalItem[]): string {
  const h = createHash("sha256");
  for (const it of items)
    h.update(`${norm(it.text)}\u0000${it.tier}|${it.complexity}|${it.role}|${it.tool}\n`);
  return h.digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------------------------------------
// Candidates

export interface EvalCandidate {
  id: ProviderId;
  provider: AdjudicatorProvider;
  /** The resolution the engine runs with (default: a resolution of `id` with consent). */
  resolved?: Resolved;
  /** Label in the report (default: the id, plus the model when known). */
  label?: string;
  model?: string;
}

export interface SkippedCandidate {
  provider: ProviderId;
  reason: string;
}

/**
 * Build the candidate providers for `ids` in the "cli" context. A provider that degrades (no
 * consent, no key, misconfigured) or has no registered factory (embedding before
 * registerProvider) is skipped with the reason; "heuristic" is always reported and is ignored here.
 */
export function resolveEvalCandidates(
  config: AdjudicatorConfig,
  ids: readonly ProviderId[],
  o: { env?: NodeJS.ProcessEnv; deps?: ProviderDeps } = {},
): { candidates: EvalCandidate[]; skipped: SkippedCandidate[] } {
  const candidates: EvalCandidate[] = [];
  const skipped: SkippedCandidate[] = [];
  for (const id of new Set(ids)) {
    if (id === "heuristic") continue;
    const cfg: AdjudicatorConfig = { ...config, provider: id };
    const r = resolveAdjudicator(cfg, { context: "cli", ...(o.env ? { env: o.env } : {}) });
    if (r.provider === "heuristic") {
      skipped.push({ provider: id, reason: r.detail ?? r.degraded ?? "not available" });
      continue;
    }
    let provider: AdjudicatorProvider | null = null;
    try {
      provider = createProvider(r, cfg, { ...(o.env ? { env: o.env } : {}), ...o.deps });
    } catch (err) {
      skipped.push({ provider: id, reason: (err as Error).message });
      continue;
    }
    if (!provider) {
      skipped.push({ provider: id, reason: "no provider factory registered" });
      continue;
    }
    const c: EvalCandidate = { id, provider, resolved: r };
    if (r.model) c.model = r.model;
    candidates.push(c);
  }
  return { candidates, skipped };
}

// ---------------------------------------------------------------------------------------------
// Report shape

export interface Rate {
  n: number;
  correct: number;
  /** correct / n; null when n is 0. */
  rate: number | null;
}

export interface Calibration {
  /** Confidence ≥ CALIBRATION_AT. */
  high: Rate;
  low: Rate;
}

export interface TierMetrics extends Rate {
  /** Predicted a smaller tier than the label (a likely redo). */
  under: Rate;
  /** Predicted a larger tier than the label (cost only). */
  over: Rate;
  /** truth → predicted → count. */
  confusion: Record<string, Record<string, number>>;
  calibration?: Calibration;
}

export interface ComplexityMetrics {
  n: number;
  exact: Rate;
  within1: Rate;
  /** Mean absolute error of the continuous score; null when n is 0. */
  mae: number | null;
  calibration?: Calibration;
}

export interface FieldMetrics extends Rate {
  calibration?: Calibration;
}

export interface Percentiles {
  samples: number;
  p50: number | null;
  p95: number | null;
}

export interface EvalOps {
  /** Provider calls (chunks × repeat); for heuristic rows, items scored. */
  calls: number;
  /** Items sent (items × repeat). */
  items: number;
  /** Items the provider returned a valid answer for. */
  answered: number;
  /** answered / items. */
  validity: number | null;
  timeoutRate: number | null;
  /** Items that did not come back blended (any status but ok, or a missing answer). */
  fallbackRate: number | null;
  /** Item count per providerStatus. */
  statuses: Record<string, number>;
  /** Per chunk call for providers, per item for the heuristic. */
  latencyMs: Percentiles;
  tokensPer1k: number | null;
  /** $ per 1k adjudications; null when a call reported an unknown price. */
  usdPer1k: number | null;
}

export type EvalRowKind =
  | "reference"
  | "heuristic-raw"
  | "heuristic"
  | "provider-raw"
  | "provider-blended";

export interface EvalRow {
  name: string;
  kind: EvalRowKind;
  provider?: ProviderId;
  model?: string;
  /** Items scored (items × passes); a raw provider row scores only what it answered, per field. */
  n: number;
  tier: TierMetrics | null;
  complexity: ComplexityMetrics | null;
  role: FieldMetrics | null;
  tool: FieldMetrics | null;
  ops?: EvalOps;
  /** majority: the constant labels it predicts. */
  labels?: { tier: string; complexity: number; role: string; tool: string };
}

export interface EvalVerdict {
  provider: string;
  beats: boolean;
  /** Percentage points, blended provider − heuristic (shipped). */
  deltaTierPp: number;
  deltaComplexityWithin1Pp: number;
  line: string;
}

export interface EvalReport {
  version: typeof EVAL_REPORT_VERSION;
  ts: number;
  scorerVersion: string;
  set: {
    source: "builtin" | "fixture" | "builtin+fixture";
    items: number;
    hash: string;
    /** Basename only. */
    fixture?: string;
    mode?: "merge" | "replace";
    tiers: Record<string, number>;
  };
  repeat: number;
  chunkSize: number;
  budgetMs: number;
  tiers: string[];
  rows: EvalRow[];
  skipped: SkippedCandidate[];
  verdicts: EvalVerdict[];
}

// ---------------------------------------------------------------------------------------------
// Running

export interface EvalOptions {
  config: AdjudicatorConfig;
  /** Default EVAL_SET. */
  items?: readonly EvalItem[];
  fixture?: { items: readonly EvalItem[]; mode: "merge" | "replace"; name?: string };
  candidates?: readonly EvalCandidate[];
  /** Carried into the report (from resolveEvalCandidates). */
  skipped?: readonly SkippedCandidate[];
  /** Provider passes (default 1). */
  repeat?: number;
  /** Default EVAL_CHUNK. */
  chunkSize?: number;
  /** Per chunk (default config.timeouts.planMs). */
  budgetMs?: number;
  env?: NodeJS.ProcessEnv;
  /** Report timestamp (default Date.now). */
  now?: () => number;
  /** High-resolution clock for latencies (default performance.now). */
  clock?: () => number;
  log?: (line: string) => void;
}

const TIER_RANK = new Map<string, number>(TIERS.map((t, i) => [t, i]));

const rate = (correct: number, n: number): Rate => ({ n, correct, rate: n ? correct / n : null });

function percentiles(xs: number[]): Percentiles {
  if (!xs.length) return { samples: 0, p50: null, p95: null };
  const s = [...xs].sort((a, b) => a - b);
  const at = (p: number) => s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))];
  return { samples: s.length, p50: at(0.5) ?? null, p95: at(0.95) ?? null };
}

function majority<T extends string | number>(values: readonly T[]): T {
  const counts = new Map<T, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  // Ties: first seen wins, so the result is stable for a given set order.
  let best = values[0] as T;
  let n = -1;
  for (const [v, c] of counts)
    if (c > n) {
      best = v;
      n = c;
    }
  return best;
}

/** One prediction per item; undefined fields are "not answered" (raw provider rows). */
interface Prediction {
  tier?: { choice: string; confidence?: number };
  complexity?: { value: number; confidence?: number };
  role?: { choice: string; confidence?: number };
  tool?: { choice: string; confidence?: number };
}

class Tally {
  private tier = { n: 0, ok: 0, under: 0, over: 0, confusion: {} as TierMetrics["confusion"] };
  private cx = { n: 0, exact: 0, within1: 0, abs: 0 };
  private role = { n: 0, ok: 0 };
  private tool = { n: 0, ok: 0 };
  private cal = {
    tier: { hi: [0, 0], lo: [0, 0], seen: false },
    complexity: { hi: [0, 0], lo: [0, 0], seen: false },
    role: { hi: [0, 0], lo: [0, 0], seen: false },
    tool: { hi: [0, 0], lo: [0, 0], seen: false },
  };
  n = 0;

  constructor(private readonly dims: ReadonlySet<"tier" | "complexity" | "role" | "tool">) {}

  private calibrate(dim: keyof Tally["cal"], conf: number | undefined, ok: boolean) {
    if (conf === undefined || !Number.isFinite(conf)) return;
    const c = this.cal[dim];
    c.seen = true;
    const slot = conf >= CALIBRATION_AT ? c.hi : c.lo;
    slot[0] = (slot[0] ?? 0) + 1;
    if (ok) slot[1] = (slot[1] ?? 0) + 1;
  }

  add(truth: EvalItem, p: Prediction) {
    this.n++;
    if (p.tier) {
      const t = this.tier;
      t.n++;
      const ok = p.tier.choice === truth.tier;
      if (ok) t.ok++;
      const a = TIER_RANK.get(truth.tier) ?? 0;
      const b = TIER_RANK.get(p.tier.choice) ?? a;
      if (b < a) t.under++;
      if (b > a) t.over++;
      const row = t.confusion[truth.tier] ?? {};
      row[p.tier.choice] = (row[p.tier.choice] ?? 0) + 1;
      t.confusion[truth.tier] = row;
      this.calibrate("tier", p.tier.confidence, ok);
    }
    if (p.complexity) {
      const c = this.cx;
      c.n++;
      const bucket = complexityBucket(p.complexity.value);
      const ok = bucket === truth.complexity;
      if (ok) c.exact++;
      if (Math.abs(bucket - truth.complexity) <= 1) c.within1++;
      c.abs += Math.abs(Math.min(4, Math.max(0, p.complexity.value)) - truth.complexity);
      this.calibrate("complexity", p.complexity.confidence, ok);
    }
    for (const dim of ["role", "tool"] as const) {
      const got = p[dim];
      if (!got) continue;
      const ok = got.choice === truth[dim];
      this[dim].n++;
      if (ok) this[dim].ok++;
      this.calibrate(dim, got.confidence, ok);
    }
  }

  private calibration(dim: keyof Tally["cal"]): Calibration | undefined {
    const c = this.cal[dim];
    if (!c.seen) return undefined;
    return { high: rate(c.hi[1] ?? 0, c.hi[0] ?? 0), low: rate(c.lo[1] ?? 0, c.lo[0] ?? 0) };
  }

  metrics(): Pick<EvalRow, "n" | "tier" | "complexity" | "role" | "tool"> {
    const t = this.tier;
    const c = this.cx;
    const field = (dim: "role" | "tool"): FieldMetrics | null => {
      if (!this.dims.has(dim)) return null;
      const m: FieldMetrics = rate(this[dim].ok, this[dim].n);
      const cal = this.calibration(dim);
      if (cal) m.calibration = cal;
      return m;
    };
    let tier: TierMetrics | null = null;
    if (this.dims.has("tier")) {
      tier = {
        ...rate(t.ok, t.n),
        under: rate(t.under, t.n),
        over: rate(t.over, t.n),
        confusion: t.confusion,
      };
      const cal = this.calibration("tier");
      if (cal) tier.calibration = cal;
    }
    let complexity: ComplexityMetrics | null = null;
    if (this.dims.has("complexity")) {
      complexity = {
        n: c.n,
        exact: rate(c.exact, c.n),
        within1: rate(c.within1, c.n),
        mae: c.n ? c.abs / c.n : null,
      };
      const cal = this.calibration("complexity");
      if (cal) complexity.calibration = cal;
    }
    return { n: this.n, tier, complexity, role: field("role"), tool: field("tool") };
  }
}

const ALL_DIMS = new Set(["tier", "complexity", "role", "tool"] as const);

function argmax(d: Dist | undefined): { choice: string; confidence: number } | undefined {
  if (!d) return undefined;
  let best: string | undefined;
  let p = -Infinity;
  for (const [k, v] of Object.entries(d.probs))
    if (Number.isFinite(v) && v > p) {
      best = k;
      p = v;
    }
  return best === undefined ? undefined : { choice: best, confidence: d.confidence };
}

function rawPrediction(a: ProviderAnswer): Prediction {
  const p: Prediction = {};
  const tier = argmax(a.tier);
  if (tier) p.tier = tier;
  if (a.complexity && Number.isFinite(a.complexity.value))
    p.complexity = { value: a.complexity.value, confidence: a.complexity.confidence };
  const role = argmax(a.role);
  if (role) p.role = role;
  const tool = argmax(a.tool);
  if (tool) p.tool = tool;
  return p;
}

const r4 = (n: number) => Math.round(n * 10_000) / 10_000;

/** Run the eval. Never sends anything a candidate was not already allowed to send. */
export async function runEval(o: EvalOptions): Promise<EvalReport> {
  const cfg = o.config;
  const clock = o.clock ?? (() => performance.now());
  const log = o.log ?? (() => {});
  const repeat = Math.max(1, Math.floor(o.repeat ?? 1));
  const chunkSize = Math.max(1, Math.floor(o.chunkSize ?? EVAL_CHUNK));
  const budgetMs = Math.max(1, o.budgetMs ?? cfg.timeouts.planMs);
  const base = o.items ?? EVAL_SET;
  const items = o.fixture ? mergeEvalItems(base, o.fixture.items, o.fixture.mode) : [...base];
  if (!items.length) throw new EvalFixtureError("the eval set is empty");

  const tierCounts: Record<string, number> = {};
  for (const it of items) tierCounts[it.tier] = (tierCounts[it.tier] ?? 0) + 1;
  const set: EvalReport["set"] = {
    source: !o.fixture ? "builtin" : o.fixture.mode === "replace" ? "fixture" : "builtin+fixture",
    items: items.length,
    hash: evalSetHash(items),
    tiers: tierCounts,
  };
  if (o.fixture) {
    set.mode = o.fixture.mode;
    if (o.fixture.name) set.fixture = basename(o.fixture.name);
  }

  const rows: EvalRow[] = [];

  // Majority-class reference.
  const labels = {
    tier: majority(items.map((i) => i.tier)),
    complexity: majority(items.map((i) => i.complexity)),
    role: majority(items.map((i) => i.role)),
    tool: majority(items.map((i) => i.tool)),
  };
  const ref = new Tally(ALL_DIMS);
  for (const it of items)
    ref.add(it, {
      tier: { choice: labels.tier },
      complexity: { value: labels.complexity },
      role: { choice: labels.role },
      tool: { choice: labels.tool },
    });
  rows.push({ name: "majority", kind: "reference", ...ref.metrics(), labels });

  // Heuristic, raw and as shipped.
  const hRaw = new Tally(ALL_DIMS);
  const hShip = new Tally(ALL_DIMS);
  const hLat: number[] = [];
  const weights = { tierCenters: cfg.weights.tierCenters, features: cfg.weights.features };
  for (const [i, it] of items.entries()) {
    const t0 = clock();
    const h = scoreHeuristic(extractFeatures(it.text), weights, { tiers: cfg.tiers });
    const v = blend(h, undefined, {}, cfg.weights, {
      key: `e${i}`,
      provider: "heuristic",
      tiers: cfg.tiers,
    });
    hLat.push(clock() - t0);
    const pick = (t: { choice: string; confidence: number }) => ({
      choice: t.choice,
      confidence: t.confidence,
    });
    hRaw.add(it, {
      tier: pick(h.tier),
      complexity: { value: h.complexity },
      role: pick(h.role),
      tool: pick(h.tool),
    });
    hShip.add(it, {
      tier: pick(v.tier),
      complexity: { value: v.complexity },
      role: pick(v.role),
      tool: pick(v.tool),
    });
  }
  const hOps: EvalOps = {
    calls: items.length,
    items: items.length,
    answered: items.length,
    validity: null,
    timeoutRate: null,
    fallbackRate: null,
    statuses: {},
    latencyMs: percentiles(hLat),
    tokensPer1k: 0,
    usdPer1k: 0,
  };
  rows.push({ name: "heuristic (raw)", kind: "heuristic-raw", ...hRaw.metrics(), ops: hOps });
  const shipped: EvalRow = {
    name: "heuristic (shipped)",
    kind: "heuristic",
    ...hShip.metrics(),
    ops: hOps,
  };
  rows.push(shipped);

  // Providers.
  const verdicts: EvalVerdict[] = [];
  const reqs: AdjudicationRequest[] = items.map((it, i) => ({
    key: `e${i}`,
    surface: "plan",
    text: it.text,
  }));
  for (const c of o.candidates ?? []) {
    const model = c.model ?? c.resolved?.model;
    const label = c.label ?? (model ? `${c.id}:${model}` : c.id);
    const dims = new Set(c.provider.dims);
    const raw = new Tally(dims);
    const blended = new Tally(ALL_DIMS);
    const latencies: number[] = [];
    const statuses: Record<string, number> = {};
    let calls = 0;
    let sent = 0;
    let answered = 0;
    let timeouts = 0;
    let fallbacks = 0;
    let tokens = 0;
    let usd: number | null = 0;
    let usageCalls = 0;
    let reportedModel: string | undefined;

    // Records the raw answers and usage of every call the engine makes.
    let answers = new Map<string, ProviderAnswer>();
    const inner = c.provider;
    const recorder: AdjudicatorProvider = {
      id: inner.id,
      remote: inner.remote,
      dims: inner.dims,
      probe: (p) => inner.probe(p),
      async adjudicate(rs, opts): Promise<ProviderResult> {
        // A late reply to a chunk the engine already cut off lands in that chunk's map.
        const sink = answers;
        const res = await inner.adjudicate(rs, opts);
        for (const a of res.answers) if (!sink.has(a.key)) sink.set(a.key, a);
        usageCalls++;
        tokens += (res.usage.inTok || 0) + (res.usage.outTok || 0);
        if (usd !== null) usd = res.usage.costUsd === null ? null : usd + res.usage.costUsd;
        if (res.model) reportedModel = res.model;
        return res;
      },
    };
    const resolved: Resolved = c.resolved ?? {
      enabled: true,
      configured: c.id,
      provider: c.id,
      remote: inner.remote,
      configuredRemote: inner.remote,
      keySource: "none",
      keyMasked: "",
      consent: true,
      local: !inner.remote,
      ...(model ? { model } : {}),
    };
    const runCfg: AdjudicatorConfig = { ...cfg, provider: c.id };

    for (let pass = 0; pass < repeat; pass++) {
      for (let at = 0; at < reqs.length; at += chunkSize) {
        const chunk = reqs.slice(at, at + chunkSize);
        answers = new Map();
        const t0 = clock();
        const out = await adjudicate(chunk, {
          config: runCfg,
          resolved,
          context: "cli",
          provider: recorder,
          call: "inline",
          budgetMs,
          persist: false,
          ignoreEnabled: true,
          ...(o.env ? { env: o.env } : {}),
          log,
        });
        latencies.push(clock() - t0);
        calls++;
        for (const [j, a] of out.entries()) {
          const truth = items[at + j] as EvalItem;
          const v = a.verdict;
          sent++;
          statuses[v.providerStatus] = (statuses[v.providerStatus] ?? 0) + 1;
          if (v.providerStatus === "timeout") timeouts++;
          if (v.source !== "blend") fallbacks++;
          blended.add(truth, {
            tier: { choice: v.tier.choice, confidence: v.tier.confidence },
            complexity: { value: v.complexity },
            role: { choice: v.role.choice, confidence: v.role.confidence },
            tool: { choice: v.tool.choice, confidence: v.tool.confidence },
          });
          // A late answer the engine already cut off does not count as raw.
          const ans = v.providerStatus === "ok" ? answers.get(a.request.key) : undefined;
          if (ans) {
            answered++;
            raw.add(truth, rawPrediction(ans));
          }
        }
      }
    }

    const shownModel = model ?? reportedModel;
    const ops: EvalOps = {
      calls,
      items: sent,
      answered,
      validity: sent ? answered / sent : null,
      timeoutRate: sent ? timeouts / sent : null,
      fallbackRate: sent ? fallbacks / sent : null,
      statuses,
      latencyMs: percentiles(latencies),
      tokensPer1k: usageCalls && sent ? r4((tokens / sent) * 1000) : null,
      usdPer1k: usageCalls && sent && usd !== null ? (usd / sent) * 1000 : null,
    };
    const common = { provider: c.id, ...(shownModel ? { model: shownModel } : {}) };
    rows.push({ name: `${label} (raw)`, kind: "provider-raw", ...common, ...raw.metrics(), ops });
    const bRow: EvalRow = {
      name: `${label} (blended)`,
      kind: "provider-blended",
      ...common,
      ...blended.metrics(),
      ops,
    };
    rows.push(bRow);
    verdicts.push(verdictOf(label, bRow, shipped));
  }

  return {
    version: EVAL_REPORT_VERSION,
    ts: (o.now ?? Date.now)(),
    scorerVersion: SCORER_VERSION,
    set,
    repeat,
    chunkSize,
    budgetMs,
    tiers: [...cfg.tiers],
    rows,
    skipped: [...(o.skipped ?? [])],
    verdicts,
  };
}

const pp = (a: number | null | undefined, b: number | null | undefined) =>
  Math.round(((a ?? 0) - (b ?? 0)) * 1000) / 10;
const signed = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(1)}`;

/** Blended provider vs the shipped heuristic: both rows include the low-confidence round-up. */
export function verdictOf(label: string, provider: EvalRow, heuristic: EvalRow): EvalVerdict {
  const dt = pp(provider.tier?.rate, heuristic.tier?.rate);
  const dc = pp(provider.complexity?.within1.rate, heuristic.complexity?.within1.rate);
  const beats = dt >= 0 && dc >= 0 && (dt > 0 || dc > 0);
  return {
    provider: label,
    beats,
    deltaTierPp: dt,
    deltaComplexityWithin1Pp: dc,
    line: `${label} beats heuristic-only on tier+complexity: ${beats ? "yes" : "no"} (Δ tier ${signed(dt)} pp, Δ complexity ±1 ${signed(dc)} pp)`,
  };
}

/** Store the report for the dashboard (it holds no item text). */
export function saveEvalReport(
  db: { metaSet(key: string, value: string): void },
  report: EvalReport,
): void {
  db.metaSet(EVAL_META_KEY, JSON.stringify(report));
}

// ---------------------------------------------------------------------------------------------
// Formatting

const pct = (r: number | null | undefined) =>
  r === null || r === undefined ? "—" : `${(r * 100).toFixed(1)}%`;
const cell = (r: Rate | null | undefined) =>
  !r || r.rate === null ? "—" : `${pct(r.rate)} ${r.correct}/${r.n}`;
const ms = (n: number | null | undefined) =>
  n === null || n === undefined ? "—" : n < 1 ? `${n.toFixed(2)}ms` : `${Math.round(n)}ms`;

function table(head: string[], body: string[][]): string {
  const w = head.map((h, i) => Math.max(h.length, ...body.map((r) => (r[i] ?? "").length)));
  const line = (r: string[]) =>
    r
      .map((c, i) => (i === 0 ? c.padEnd(w[i] ?? 0) : c.padStart(w[i] ?? 0)))
      .join("  ")
      .trimEnd();
  return [line(head), ...body.map(line)].join("\n");
}

function usdCell(o: EvalOps | undefined): string {
  if (!o) return "—";
  if (o.usdPer1k === null) return o.tokensPer1k === null ? "—" : "unknown";
  return o.usdPer1k === 0
    ? "$0"
    : `$${o.usdPer1k < 0.01 ? o.usdPer1k.toFixed(4) : o.usdPer1k.toFixed(2)}`;
}

/** Plain-text report for the CLI: accuracy, operations, calibration, verdict lines. */
export function formatEvalReport(r: EvalReport): string {
  const out: string[] = [];
  const s = r.set;
  const src =
    s.source === "builtin"
      ? "built-in set"
      : `${s.source === "fixture" ? "fixture" : "built-in + fixture"}${s.fixture ? ` ${s.fixture}` : ""}`;
  const mix = Object.entries(s.tiers)
    .map(([t, n]) => `${t} ${n}`)
    .join(", ");
  out.push(
    `Adjudicator eval · ${s.items} items (${src}; ${mix}) · set ${s.hash} · scorer v${r.scorerVersion}`,
  );
  out.push(
    `repeat ${r.repeat} · chunks of ${r.chunkSize} · ${r.budgetMs} ms budget per chunk · tiers ${r.tiers.join(" < ")}`,
  );
  out.push("");
  out.push(
    table(
      ["row", "tier", "under", "over", "cx exact", "cx ±1", "MAE", "role", "tool"],
      r.rows.map((row) => [
        row.name,
        cell(row.tier),
        row.tier ? pct(row.tier.under.rate) : "—",
        row.tier ? pct(row.tier.over.rate) : "—",
        cell(row.complexity?.exact),
        cell(row.complexity?.within1),
        row.complexity?.mae === null || row.complexity?.mae === undefined
          ? "—"
          : row.complexity.mae.toFixed(2),
        cell(row.role),
        cell(row.tool),
      ]),
    ),
  );
  const maj = r.rows.find((x) => x.kind === "reference")?.labels;
  if (maj)
    out.push(
      `majority predicts tier ${maj.tier}, complexity ${maj.complexity}, role ${maj.role}, tool ${maj.tool}. under/over: share of scored items one or more tiers below/above the label.`,
    );

  const opsRows = r.rows.filter((x) => x.ops && x.kind !== "heuristic-raw");
  if (opsRows.length) {
    out.push("");
    out.push(
      table(
        ["row", "valid", "timeout", "fallback", "p50", "p95", "tok/1k", "$/1k"],
        opsRows
          .filter((x) => x.kind !== "provider-raw")
          .map((x) => {
            const o = x.ops as EvalOps;
            return [
              x.kind === "heuristic"
                ? "heuristic (per item)"
                : `${x.name.replace(/ \(blended\)$/, "")} (per call)`,
              pct(o.validity),
              pct(o.timeoutRate),
              pct(o.fallbackRate),
              ms(o.latencyMs.p50),
              ms(o.latencyMs.p95),
              o.tokensPer1k === null ? "—" : String(Math.round(o.tokensPer1k)),
              usdCell(o),
            ];
          }),
      ),
    );
    for (const x of r.rows.filter((y) => y.kind === "provider-blended")) {
      const st = Object.entries(x.ops?.statuses ?? {})
        .map(([k, n]) => `${k} ${n}`)
        .join(", ");
      if (st) out.push(`${x.name.replace(/ \(blended\)$/, "")} statuses: ${st}`);
    }
  }

  const calLines: string[] = [];
  for (const x of r.rows) {
    const parts: string[] = [];
    const add = (dim: string, c: Calibration | undefined) => {
      if (!c) return;
      parts.push(`${dim} ${cell(c.high)} | ${cell(c.low)}`);
    };
    add("tier", x.tier?.calibration);
    add("complexity", x.complexity?.calibration);
    add("role", x.role?.calibration);
    add("tool", x.tool?.calibration);
    if (parts.length) calLines.push(`${x.name}: ${parts.join(" · ")}`);
  }
  if (calLines.length) {
    out.push("");
    out.push(`calibration (accuracy at confidence ≥ ${CALIBRATION_AT} | < ${CALIBRATION_AT})`);
    out.push(...calLines);
  }

  if (r.skipped.length) {
    out.push("");
    for (const k of r.skipped) out.push(`skipped ${k.provider}: ${k.reason}`);
  }
  out.push("");
  if (r.verdicts.length) for (const v of r.verdicts) out.push(v.line);
  else out.push("no candidate provider ran: heuristic only");
  return out.join("\n");
}
