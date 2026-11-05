import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import {
  type AdjExchangeBody,
  type AdjExchangeDetail,
  type AdjExchangeSummary,
  fetchJevExchange,
  fetchJevExchanges,
} from "../api.js";
import { ErrorBox, Spinner, toast, useAsync } from "../components.js";
import { Badge, Card, EmptyState, Skeleton } from "../ds.js";
import { cls } from "../util.js";
import type { Tone } from "./adjudicator-helpers.js";
import {
  CAPTURE_EMPTY_TEXT,
  captureNotice,
  captureOffText,
  DEFAULT_KEEP,
  deadlineFraction,
  drawerTitle,
  fmtChars,
  fmtMs,
  panelState,
  prettyBody,
  relTime,
  resultLabel,
  resultTone,
  timeline,
  tokensLabel,
  triesLabel,
  waitLabel,
} from "./xchg-helpers.js";

const absTime = (ts: number): string => new Date(ts).toLocaleString();
const isoTime = (ts: number): string => new Date(ts).toISOString();

function ResultPill({ x }: { x: Pick<AdjExchangeSummary, "outcome" | "status"> }): JSX.Element {
  const tone: Tone = resultTone(x.outcome);
  return <Badge tone={tone}>{resultLabel(x)}</Badge>;
}

/** A thin bar of how much of the deadline the request used; red when it timed out. */
function DeadlineBar({ x }: { x: AdjExchangeSummary }): JSX.Element {
  const { frac, over } = deadlineFraction(x);
  return (
    <span
      class="xchg-meter"
      title={`${fmtMs(x.durationMs)} of a ${fmtMs(x.deadlineMs)} deadline`}
      role="img"
      aria-label={`${fmtMs(x.durationMs)} of a ${fmtMs(x.deadlineMs)} deadline`}
    >
      <span
        class={cls("xchg-meter-fill", over && "over")}
        style={{ width: `${Math.max(frac > 0 ? 3 : 0, Math.round(frac * 100))}%` }}
      />
    </span>
  );
}

function Rows({
  rows,
  now,
  onRow,
  onOpen,
}: {
  rows: AdjExchangeSummary[];
  now: number;
  onRow: (id: number) => void;
  onOpen: (id: number) => void;
}): JSX.Element {
  return (
    <div class="adj-scroll">
      <table class="adj-tiers xchg-table">
        <thead>
          <tr>
            <th>time</th>
            <th>surface</th>
            <th>result</th>
            <th>duration</th>
            <th class="num">wait</th>
            <th class="num">tries</th>
            <th class="num">items</th>
            <th class="num" title="tokens in / out">
              tokens
            </th>
            <th>decisions</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((x) => (
            <tr class="xchg-row" key={x.id} onClick={() => onRow(x.id)}>
              <td title={isoTime(x.ts)}>
                <button
                  type="button"
                  class="adj-link"
                  onClick={(e) => {
                    e.stopPropagation();
                    onRow(x.id);
                  }}
                  aria-label={`open request ${x.id}`}
                >
                  {relTime(x.ts, now)}
                </button>
              </td>
              <td>{x.surface ?? "—"}</td>
              <td>
                <ResultPill x={x} />
              </td>
              <td>
                <span class="xchg-dur">
                  {fmtMs(x.durationMs)}
                  <DeadlineBar x={x} />
                </span>
              </td>
              <td class="num">{waitLabel(x)}</td>
              <td class="num">{triesLabel(x)}</td>
              <td class="num">{x.items}</td>
              <td class="num">{tokensLabel(x.tokensIn, x.tokensOut)}</td>
              <td>
                {x.rowIds.length ? (
                  <span class="xchg-ids">
                    {x.rowIds.map((id) => (
                      <button
                        type="button"
                        class="adj-link"
                        key={id}
                        onClick={(e) => {
                          e.stopPropagation();
                          onOpen(id);
                        }}
                      >
                        #{id}
                      </button>
                    ))}
                  </span>
                ) : (
                  <span class="muted">—</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The timing bar: segments in the order the time was spent, with a deadline marker. */
function TimingBar({ x }: { x: AdjExchangeDetail }): JSX.Element {
  const t = timeline(x);
  if (!t.segments.length) return <EmptyState compact icon="▁" title="No timing recorded" />;
  return (
    <>
      <div class="xchg-bar" role="img" aria-label="request timing">
        {t.segments.map((s) => (
          <span
            key={s.key}
            class={`xchg-seg xchg-seg-${s.key}`}
            style={{ left: `${s.start * 100}%`, width: `${s.width * 100}%` }}
            title={`${s.label}: ${fmtMs(s.ms)} (${s.help})`}
          />
        ))}
        {t.deadlineAt !== null ? (
          <span
            class="xchg-deadline"
            style={{ left: `${t.deadlineAt * 100}%` }}
            title={`deadline ${fmtMs(x.deadlineMs)} after sending`}
          />
        ) : null}
      </div>
      <ul class="xchg-legend small">
        {t.segments.map((s) => (
          <li key={s.key} title={s.help}>
            <span class={`xchg-dot xchg-seg-${s.key}`} /> {s.label} {fmtMs(s.ms)}
          </li>
        ))}
        {t.deadlineAt !== null ? (
          <li>
            <span class="xchg-dot xchg-dot-deadline" /> deadline {fmtMs(x.deadlineMs)}
          </li>
        ) : null}
      </ul>
    </>
  );
}

/** A request or answer body as formatted text; every character is rendered as a text node. */
function Body({
  title,
  body,
  kind,
}: {
  title: string;
  body: AdjExchangeBody | null;
  kind: string;
}): JSX.Element {
  if (!body) return <div class="muted small">no {kind} was stored</div>;
  const p = prettyBody(body);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(p.text);
      toast(`${title} copied`);
    } catch {
      toast("could not copy", true);
    }
  };
  return (
    <>
      <div class="xchg-body-head small">
        <span class="muted">
          {fmtChars(body.bytes)}
          {p.formatted ? " · formatted JSON" : body.json ? " · JSON" : " · text"}
        </span>
        <button type="button" class="ghost sm" onClick={copy}>
          Copy
        </button>
      </div>
      {p.note ? <div class="warn small xchg-trunc">{p.note}</div> : null}
      <pre class="xchg-json">{p.text}</pre>
    </>
  );
}

function Facts({ x }: { x: AdjExchangeDetail }): JSX.Element {
  const rows: Array<[string, string]> = [
    ["sent at", absTime(x.ts)],
    ["wait before send", fmtMs(x.waitMs)],
    ["job wait", x.jobWaitMs === null ? "— (not a background job)" : fmtMs(x.jobWaitMs)],
    ["to first byte", fmtMs(x.ttfbMs)],
    ["duration", fmtMs(x.durationMs)],
    ["retry wait", x.retryWaitMs > 0 ? fmtMs(x.retryWaitMs) : "—"],
    ["attempts", String(x.attempts)],
    ["deadline", fmtMs(x.deadlineMs)],
    ["engine budget", fmtMs(x.budgetMs)],
    ["timed out", x.timedOut ? "yes" : "no"],
    ["HTTP status", x.status === null ? "—" : String(x.status)],
  ];
  return (
    <dl class="kv xchg-facts">
      {rows.map(([k, v]) => (
        <>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </>
      ))}
    </dl>
  );
}

function ExchangeBody({
  x,
  onOpen,
}: {
  x: AdjExchangeDetail;
  onOpen: (id: number) => void;
}): JSX.Element {
  return (
    <>
      <section>
        <div class="adj-h">Timing</div>
        <TimingBar x={x} />
        <Facts x={x} />
      </section>
      {x.rowIds.length ? (
        <section>
          <div class="adj-h">Decisions this request served</div>
          <span class="xchg-ids">
            {x.rowIds.map((id) => (
              <button type="button" class="adj-link" key={id} onClick={() => onOpen(id)}>
                #{id}
              </button>
            ))}
          </span>
        </section>
      ) : null}
      <section>
        <div class="adj-h">
          Request
          <span class="right muted small">
            {x.target} · {x.model ?? "model unknown"} · {x.items} item{x.items === 1 ? "" : "s"}
          </span>
        </div>
        <Body title="request" body={x.request} kind="request" />
      </section>
      <section>
        <div class="adj-h">
          Response
          <span class="right muted small">
            {tokensLabel(x.tokensIn, x.tokensOut)} tokens
            {x.costUsd !== null ? ` · $${x.costUsd.toFixed(4)}` : ""}
          </span>
        </div>
        {x.error ? <div class="warn small xchg-trunc">error: {x.error}</div> : null}
        <Body title="response" body={x.response} kind="response" />
      </section>
    </>
  );
}

function ExchangeDrawer({
  id,
  onClose,
  onOpen,
}: {
  id: number;
  onClose: () => void;
  onOpen: (id: number) => void;
}): JSX.Element {
  const d = useAsync(() => fetchJevExchange(id), [id]);
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("keydown", key);
      prev?.focus?.();
    };
  }, [id]);
  const x = d.data?.active && d.data.capture ? d.data.exchange : null;
  return (
    <>
      <div class="adj-backdrop" onClick={onClose} />
      <aside
        class="adj-drawer"
        ref={panel}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={`Jev request ${id}`}
      >
        <div class="adj-drawer-head">
          <b>{x ? drawerTitle(x, absTime(x.ts)) : `Request #${id}`}</b>
          {x ? <ResultPill x={x} /> : null}
          <span class="spacer" />
          <button type="button" class="ghost sm" onClick={onClose} aria-label="close">
            ✕ close
          </button>
        </div>
        <div class="adj-drawer-body">
          {d.error ? (
            <ErrorBox error={d.error} />
          ) : !d.data ? (
            <Spinner />
          ) : x ? (
            <ExchangeBody
              x={x}
              onOpen={(n) => {
                onClose();
                onOpen(n);
              }}
            />
          ) : (
            <EmptyState compact icon="○" title="Nothing to show">
              Request capture is off or Jev is not the provider.
            </EmptyState>
          )}
        </div>
      </aside>
    </>
  );
}

/**
 * The Jev request log: the newest stored requests eminiar sent to Jev, with timing, and a
 * drawer with each request and answer. Mounted only inside the Jev panel (which is itself
 * mounted only when Jev is the enabled provider); makes one list call when it appears and
 * renders nothing when the server says Jev is not active. Stored text is rendered as text only.
 */
export function JevExchanges({
  tick,
  onOpen,
}: {
  tick: number;
  onOpen: (id: number) => void;
}): JSX.Element | null {
  const r = useAsync(() => fetchJevExchanges(), [tick]);
  const [open, setOpen] = useState<number | null>(null);
  const state = panelState(r.data);
  if (state === "hidden") return null;
  const list = r.data?.active && r.data.capture ? r.data : null;
  const keep = r.data?.active ? r.data.keep : DEFAULT_KEEP;
  const right = `newest ${keep} kept · capture ${state === "off" ? "off" : state === "loading" ? "…" : "on"}`;
  let body: JSX.Element;
  if (r.error) body = <ErrorBox error={r.error} />;
  else if (state === "loading") body = <Skeleton h={120} />;
  else if (state === "off") {
    const t = captureOffText();
    body = (
      <EmptyState compact icon="○" title="Request capture is off">
        {t.before} <code class="adj-cmd">{t.command}</code>. {t.after}
      </EmptyState>
    );
  } else if (state === "empty")
    body = (
      <EmptyState compact icon="▸" title="No requests captured yet">
        {CAPTURE_EMPTY_TEXT}
      </EmptyState>
    );
  else
    body = (
      <>
        <div class="jev-banner warn small" role="note">
          {captureNotice(list?.rows[0]?.target, keep)}
        </div>
        <Rows
          rows={list?.rows ?? []}
          now={list?.now ?? Date.now()}
          onRow={setOpen}
          onOpen={onOpen}
        />
        {list && list.total > list.rows.length ? (
          <div class="muted small jev-notes">
            showing the newest {list.rows.length} of {list.total}
          </div>
        ) : null}
      </>
    );
  return (
    <Card class="jev-xchg ds-block" title="Jev requests" right={right}>
      {body}
      {open !== null ? (
        <ExchangeDrawer id={open} onClose={() => setOpen(null)} onOpen={onOpen} />
      ) : null}
    </Card>
  );
}
