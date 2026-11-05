import type { ComponentChildren, JSX } from "preact";
import { useState } from "preact/hooks";
import { type AdjJevImpact, type AdjOverview, fetchJevImpact } from "../api.js";
import { Empty, ErrorBox, Spinner, useAsync } from "../components.js";
import { cls } from "../util.js";
import { DEGRADED_HELP, heat, type Tone } from "./adjudicator-helpers.js";
import { JevExchanges } from "./JevExchanges.js";
import {
  complexityLine,
  dimLine,
  evidenceLabel,
  evidenceTone,
  excludedLine,
  footerFacts,
  jevActive,
  kpiRows,
  outcomeRows,
  surfaceRows,
  transitionGrid,
  verdictLine,
  verdictTone,
} from "./jev-helpers.js";

const Pill = ({
  tone,
  children,
  title,
}: {
  tone: Tone;
  children: ComponentChildren;
  title?: string;
}): JSX.Element => (
  <span class={cls("tag", `adj-t-${tone}`)} title={title}>
    {children}
  </span>
);

/** heuristic tier (rows) × tier with Jev (columns); outlined cells are agreement. */
function TierGrid({ t }: { t: AdjJevImpact["influence"]["tier"] }): JSX.Element {
  const g = transitionGrid(t.transitions);
  if (!g.total) return <Empty>no compared decisions yet</Empty>;
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
        <Empty>no compared decisions yet</Empty>
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
      <Empty>
        no labelled outcomes on decisions Jev changed yet: feedback through em_adjudicate and
        finished swarm tasks add them
      </Empty>
    );
  return (
    <>
      <div class="sub">
        help {e.help} · hurt {e.hurt} · neutral {e.neutral} (newest {e.rows.length} listed)
      </div>
      <ul class="jev-evidence">
        {e.rows.map((row) => (
          <li>
            <Pill tone={evidenceTone(row.kind)}>{row.kind}</Pill>
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

function Panel({
  range,
  tick,
  onOpen,
}: {
  range: string;
  tick: number;
  onOpen: (id: number) => void;
}): JSX.Element | null {
  const [how, setHow] = useState(false);
  const j = useAsync(() => fetchJevImpact(range), [range, tick]);
  // The server answered {active:false}: the config changed since the overview loaded.
  if (j.data && !j.data.active) return null;
  const r = j.data?.active ? j.data : undefined;
  const head = (
    <h3>
      Jev impact
      <span class="right muted small">TypeSafe Jev blended onto the heuristic · {range}</span>
    </h3>
  );
  if (j.error)
    return (
      <section class="card jev-impact">
        {head}
        <ErrorBox error={j.error} />
      </section>
    );
  if (!r)
    return (
      <section class="card jev-impact">
        {head}
        <Spinner />
      </section>
    );
  if (!r.sample.rows)
    return (
      <section class="card jev-impact">
        {head}
        {r.provider.degraded ? <Degraded why={r.provider.degraded} /> : null}
        <Empty>no Jev decisions in this range yet</Empty>
      </section>
    );

  const v = r.verdict;
  const tone = verdictTone(v.label);
  // The degraded banner already says it; drop the duplicate warning line.
  const warnings = r.provider.degraded
    ? v.warnings.filter((w) => !w.startsWith("Jev is configured but degraded"))
    : v.warnings;
  return (
    <section class="card jev-impact">
      {head}
      {r.provider.degraded ? <Degraded why={r.provider.degraded} /> : null}
      <div class="jev-verdict">
        <Pill tone={tone}>{v.label}</Pill>
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

      <div class="grid adj-kpis">
        {kpiRows(r, r.provider.health?.state).map((k) => (
          <div class="card" title={k.help}>
            <h3>{k.title}</h3>
            <div class="big">{k.value}</div>
            <div class="sub">{k.sub}</div>
          </div>
        ))}
      </div>

      <div class="grid two">
        <div class="card">
          <h3>heuristic → final tier</h3>
          <TierGrid t={r.influence.tier} />
        </div>
        <div class="card">
          <h3>agreement</h3>
          <Agreement r={r} />
        </div>
      </div>
      <div class="grid two">
        <div class="card">
          <h3>outcomes: changed vs unchanged</h3>
          <Outcomes r={r} />
        </div>
        <div class="card">
          <h3>evidence</h3>
          <Evidence r={r} onOpen={onOpen} />
        </div>
      </div>
      <div class="muted small jev-foot">{footerFacts(r).join(" · ")}</div>
    </section>
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
      <Panel range={range} tick={tick} onOpen={onOpen} />
      <JevExchanges tick={tick} onOpen={onOpen} />
    </>
  );
}
