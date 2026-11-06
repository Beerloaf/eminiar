import type { JSX } from "preact";
import { useState } from "preact/hooks";
import { type AdjJevImpact, type AdjOverview, fetchJevImpact } from "../api.js";
import { ErrorBox, useAsync } from "../components.js";
import { Badge, Card, EmptyState, Skeleton, Stat, StatRow } from "../ds.js";
import { cls } from "../util.js";
import { DEGRADED_HELP, heat } from "./adjudicator-helpers.js";
import { JevExchanges } from "./JevExchanges.js";
import {
  complexityLine,
  deferredLine,
  dimLine,
  evidenceLabel,
  evidenceTone,
  excludedLine,
  featuresHint,
  footerFacts,
  jevActive,
  keptLine,
  kpiRows,
  outcomeRows,
  surfaceRows,
  transitionGrid,
  verdictLine,
  verdictSteps,
  verdictTone,
} from "./jev-helpers.js";

/** heuristic tier (rows) × tier with Jev (columns); outlined cells are agreement. */
function TierGrid({ t }: { t: AdjJevImpact["influence"]["tier"] }): JSX.Element {
  const g = transitionGrid(t.transitions);
  if (!g.total) return <EmptyState compact icon="▦" title="No compared decisions yet" />;
  return (
    <>
      <div class="adj-scroll">
        <table class="adj-matrix">
          <thead>
            <tr>
              <th class="corner">heuristic ↓ · with Jev →</th>
              {g.cols.map((c) => (
                <th class="num">{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {g.rows.map((r) => (
              <tr>
                <th>{r}</th>
                {g.cols.map((c) => {
                  const n = g.cell(r, c);
                  const a = heat(n, g.max);
                  return (
                    <td
                      class={cls("num", "cell", r === c && "diag", a > 0.55 && "strong")}
                      style={
                        a
                          ? {
                              background: `color-mix(in srgb, var(--accent) ${Math.round(a * 100)}%, transparent)`,
                            }
                          : undefined
                      }
                      title={`${n} decisions: heuristic ${r}, with Jev ${c}`}
                    >
                      {n || ""}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div class="sub">
        {g.agree} of {g.total} kept the heuristic's tier · outlined cells are agreement
      </div>
      <div class="muted small jev-notes">
        Jev overruled by the heuristic {t.jevOverruled} · rounded up for low confidence{" "}
        {t.roundUps.final} (only because of blending: {t.roundUps.blendInduced})
        {t.wouldHaveChanged.compared
          ? ` · deferred (async) ${t.wouldHaveChanged.changed} of ${t.wouldHaveChanged.compared} would have changed`
          : ""}
      </div>
    </>
  );
}

function Agreement({ r }: { r: AdjJevImpact }): JSX.Element {
  const t = r.influence.tier;
  const rows = surfaceRows(t);
  const eff = r.influence.effort;
  return (
    <>
      {rows.length ? (
        <div class="adj-scroll">
          <table class="adj-tiers">
            <thead>
              <tr>
                <th>surface</th>
                <th class="num">compared</th>
                <th class="num">agree</th>
                <th class="num" title="Jev raised the tier">
                  ↑
                </th>
                <th class="num" title="Jev lowered the tier">
                  ↓
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr>
                  <td>{s.label}</td>
                  <td class="num">{s.compared}</td>
                  <td class="num">{s.agree}</td>
                  <td class="num">{s.up}</td>
                  <td class="num">{s.down}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState compact icon="▦" title="No compared decisions yet" />
      )}
      <ul class="jev-lines">
        <li>
          <b>role</b> {dimLine(r.influence.role)}
        </li>
        <li>
          <b>tool</b> {dimLine(r.influence.tool)}{" "}
          <span class="muted">(tools change only through Jev's needs-plan boost)</span>
        </li>
        <li>
          <b>effort</b> ↑{eff.up} ↓{eff.down} of {eff.compared}
        </li>
        <li>
          <b>complexity</b> {complexityLine(r.influence.complexity)}
        </li>
      </ul>
    </>
  );
}

function Outcomes({ r }: { r: AdjJevImpact }): JSX.Element {
  const rows = outcomeRows(r.outcomes.changed, r.outcomes.unchanged);
  const x = r.outcomes.excluded;
  return (
    <>
      <div class="adj-scroll">
        <table class="adj-tiers">
          <thead>
            <tr>
              <th />
              <th class="num">Jev changed it</th>
              <th class="num">same as heuristic</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((o) => (
              <tr>
                <td>{o.label}</td>
                <td class="num">{o.changed}</td>
                <td class="num">{o.unchanged}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div class="muted small jev-notes">left out: {excludedLine(x)}</div>
    </>
  );
}

function Evidence({ r, onOpen }: { r: AdjJevImpact; onOpen: (id: number) => void }): JSX.Element {
  const e = r.outcomes.evidence;
  if (!e.rows.length)
    return (
      <EmptyState compact icon="○" title="No labelled outcomes yet">
        Feedback through em_adjudicate and finished swarm tasks add them to decisions Jev changed.
      </EmptyState>
    );
  return (
    <>
      <div class="sub">
        help {e.help} · hurt {e.hurt} · neutral {e.neutral} (newest {e.rows.length} listed)
      </div>
      <ul class="jev-evidence">
        {e.rows.map((row) => (
          <li>
            <Badge tone={evidenceTone(row.kind)}>{row.kind}</Badge>
            <button type="button" class="adj-link" onClick={() => onOpen(row.id)}>
              #{row.id}
            </button>
            <span class="muted small">{row.surface}</span>
            <span class="jev-move">
              {row.from} → {row.to}
            </span>
            <span class="muted small jev-why">{evidenceLabel(row.code)}</span>
          </li>
        ))}
      </ul>
    </>
  );
}

function Guidance({ r, config }: { r: AdjJevImpact; config: unknown }): JSX.Element | null {
  const x = r.outcomes.excluded;
  const notes = [
    keptLine(x),
    deferredLine(r, (config as { promptMode?: unknown } | null)?.promptMode),
    featuresHint(config),
  ].filter((n): n is string => !!n);
  const steps = verdictSteps(r);
  if (!notes.length && !steps.length) return null;
  return (
    <div class="jev-guide small">
      {notes.length ? (
        <ul class="jev-lines">
          {notes.map((n) => (
            <li>{n}</li>
          ))}
        </ul>
      ) : null}
      {steps.length ? (
        <>
          <b>How to get a verdict</b>
          <ul class="jev-lines">
            {steps.map((n) => (
              <li>{n}</li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}

function Panel({
  range,
  tick,
  config,
  onOpen,
}: {
  range: string;
  tick: number;
  config: unknown;
  onOpen: (id: number) => void;
}): JSX.Element | null {
  const [how, setHow] = useState(false);
  const j = useAsync(() => fetchJevImpact(range), [range, tick]);
  // The server answered {active:false}: the config changed since the overview loaded.
  if (j.data && !j.data.active) return null;
  const r = j.data?.active ? j.data : undefined;
  const cardProps = {
    class: "jev-impact ds-block",
    title: "Jev impact",
    right: `TypeSafe Jev blended onto the heuristic · ${range}`,
  };
  if (j.error)
    return (
      <Card {...cardProps}>
        <ErrorBox error={j.error} />
      </Card>
    );
  if (!r)
    return (
      <Card {...cardProps}>
        <Skeleton h={160} />
      </Card>
    );
  if (!r.sample.rows)
    return (
      <Card {...cardProps}>
        {r.provider.degraded ? <Degraded why={r.provider.degraded} /> : null}
        <EmptyState compact icon="▸" title="No Jev decisions in this range yet">
          Decisions blended with Jev appear here as the adjudicator runs.
        </EmptyState>
      </Card>
    );

  const v = r.verdict;
  const tone = verdictTone(v.label);
  // The degraded banner already says it; drop the duplicate warning line.
  const warnings = r.provider.degraded
    ? v.warnings.filter((w) => !w.startsWith("Jev is configured but degraded"))
    : v.warnings;
  return (
    <Card {...cardProps}>
      {r.provider.degraded ? <Degraded why={r.provider.degraded} /> : null}
      <div class="jev-verdict">
        <Badge tone={tone}>{v.label}</Badge>
        <span class="jev-why-line">{verdictLine(v)}</span>
        <button type="button" class="adj-link" aria-expanded={how} onClick={() => setHow(!how)}>
          how is this decided?
        </button>
      </div>
      {how ? (
        <div class="jev-rule">
          <p class="small">{v.rule}</p>
          <ul class="reasons">
            {r.savings.assumptions.map((a) => (
              <li>{a}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {warnings.length ? (
        <ul class="warn small jev-warn">
          {warnings.map((w) => (
            <li>{w}</li>
          ))}
        </ul>
      ) : null}

      <StatRow>
        {kpiRows(r, r.provider.health?.state).map((k) => (
          <Stat label={k.title} value={k.value} sub={k.sub} title={k.help} />
        ))}
      </StatRow>

      <div class="ds-grid cols-2">
        <Card title="Heuristic → final tier">
          <TierGrid t={r.influence.tier} />
        </Card>
        <Card title="Agreement">
          <Agreement r={r} />
        </Card>
      </div>
      <div class="ds-grid cols-2">
        <Card title="Outcomes: changed vs unchanged">
          <Outcomes r={r} />
        </Card>
        <Card title="Evidence">
          <Evidence r={r} onOpen={onOpen} />
        </Card>
      </div>
      <Guidance r={r} config={config} />
      <div class="muted small jev-foot">{footerFacts(r).join(" · ")}</div>
    </Card>
  );
}

/** The banner for a Jev that is configured but cannot be called. */
function Degraded({ why }: { why: string }): JSX.Element {
  return (
    <div class="jev-banner warn small" role="status">
      Jev is configured but not being called ({why.replace(/_/g, " ")}): every decision falls back
      to the heuristic. {DEGRADED_HELP[why] ?? ""}
    </div>
  );
}

/**
 * The Jev impact section of the Adjudicator tab. Renders nothing, and makes no request, unless
 * Jev is enabled (jevActive on the overview the tab already loaded); the tab mounts it under
 * the same check, and this guard keeps a stray mount from fetching.
 */
export function JevImpact({
  range,
  tick,
  ov,
  onOpen,
}: {
  range: string;
  tick: number;
  ov: AdjOverview;
  onOpen: (id: number) => void;
}): JSX.Element | null {
  if (!jevActive(ov)) return null;
  return (
    <>
      <Panel range={range} tick={tick} config={ov.config} onOpen={onOpen} />
      <JevExchanges tick={tick} onOpen={onOpen} />
    </>
  );
}
