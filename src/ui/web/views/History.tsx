import type { ComponentChildren, JSX } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import {
  api,
  type BranchDetailUi,
  type Bucket,
  type CommitDetailUi,
  type CommitLinkUi,
  type CommitRowUi,
  type FileHistoryDetailUi,
  type FileHistoryUi,
  type GraphCommitUi,
  type HistoryGraphUi,
  type HistoryOverview,
  type RiskUi,
} from "../api.js";
import { Bar, ErrorBox, Spinner, useAsync, useSort } from "../components.js";
import {
  Badge,
  Card,
  EmptyState,
  Hero,
  Segmented,
  Skeleton,
  Stat,
  StatRow,
  type Tone,
} from "../ds.js";
import {
  ActivityChart,
  bucketColor,
  FileScatter,
  KindLegend,
  LaneGraph,
  riskColor,
  Sparkline,
} from "../history/charts.js";
import { type LaneRow, layoutLanes } from "../history/lanes.js";
import { navigate } from "../router.js";
import { ago, cls, day, fmt } from "../util.js";
import { HistoryGraph } from "./HistoryGraph.js";

type Tab = "timeline" | "branches" | "files" | "graph" | "risk";

// --- small pieces -----------------------------------------------------------------------

function KindTagH({ kind, bucket }: { kind: string; bucket: Bucket }): JSX.Element {
  return (
    <span
      class={cls("ds-badge hist-kind", bucket === "other" && "neutral")}
      style={bucket === "other" ? undefined : { color: bucketColor(bucket) }}
    >
      {kind}
    </span>
  );
}

function PlusMinus({ added, deleted }: { added: number; deleted: number }): JSX.Element {
  const total = added + deleted;
  const n = 5;
  const a = total ? Math.round((added / total) * n) : 0;
  const d = total ? Math.min(n - a, Math.round((deleted / total) * n)) : 0;
  return (
    <span class="pm" title={`+${added} / -${deleted}`}>
      <span class="add">+{fmt(added)}</span>
      <span class="del">-{fmt(deleted)}</span>
      <span class="bars">
        {Array.from({ length: n }, (_, i) => (
          <i class={i < a ? "a" : i < a + d ? "d" : ""} />
        ))}
      </span>
    </span>
  );
}

function Refs({
  refs,
  tags,
  max = 3,
}: {
  refs: string[];
  tags: string[];
  max?: number;
}): JSX.Element | null {
  const branches = refs.filter((r) => !r.startsWith("tag: "));
  if (!branches.length && !tags.length) return null;
  return (
    <>
      {tags.slice(0, 2).map((t) => (
        <span class="ref tag">{t}</span>
      ))}
      {branches.slice(0, max).map((b) => (
        <span class={cls("ref", b.includes("/") && "remote")}>{b}</span>
      ))}
      {branches.length > max ? <span class="ref remote">+{branches.length - max}</span> : null}
    </>
  );
}

function Flags({ c }: { c: CommitRowUi }): JSX.Element {
  return (
    <>
      {c.blamedBy ? (
        <span
          class="flag warn"
          title={`${c.blamedBy} later fix(es) removed lines from this commit`}
        >
          ⚠ {c.blamedBy}
        </span>
      ) : null}
      {c.reverted ? (
        <span class="flag bad" title="reverted">
          ↩
        </span>
      ) : null}
      {c.origins && (c.kind === "fix" || c.kind === "revert") ? (
        <span class="flag ok" title={`traced to ${c.origins} earlier commit(s)`}>
          ⇠ {c.origins}
        </span>
      ) : null}
      {c.breaking ? <span class="flag bad">BREAKING</span> : null}
    </>
  );
}

function RiskBar({ value }: { value: number }): JSX.Element {
  return (
    <span class="riskbar" title={value.toFixed(2)}>
      <i
        style={{ width: `${Math.round(value * 100)}%`, background: riskColor(0.3 + value * 0.7) }}
      />
    </span>
  );
}

const TAG_TONE: Record<string, Tone> = {
  "risk-high": "bad",
  "risk-medium": "warn",
  "risk-low": "ok",
  "s-accepted": "ok",
};

/** A small status/label chip: the history views' `Tag`, drawn with the ds Badge. */
function Tag({ children, class: c }: { children: ComponentChildren; class?: string }): JSX.Element {
  return <Badge tone={c ? TAG_TONE[c] : undefined}>{children}</Badge>;
}

function Empty({ children }: { children: ComponentChildren }): JSX.Element {
  return <EmptyState compact title={children} />;
}

/** Rows of commits; `lanes` adds the DAG column on the left. */
function CommitList({
  commits,
  selected,
  onSelect,
  lanes,
  empty,
}: {
  commits: CommitRowUi[];
  selected: string | null;
  onSelect: (sha: string) => void;
  lanes?: { rows: LaneRow<GraphCommitUi>[]; lanes: number } | undefined;
  empty?: string;
}): JSX.Element {
  if (!commits.length) return <Empty>{empty ?? "No commits match."}</Empty>;
  const ROW = 28;
  return (
    <div class="commits">
      {lanes ? (
        <LaneGraph rows={lanes.rows} lanes={lanes.lanes} rowH={ROW} selected={selected} />
      ) : null}
      <div class="rows">
        {commits.map((c) => (
          <div
            class={cls("crow", selected === c.sha && "sel", !c.onHead && "off")}
            onClick={() => onSelect(c.sha)}
            title={`${c.sha}\n${c.subject}\n${c.author} · ${new Date(c.at).toLocaleString()}${c.riskReasons.length ? `\n${c.riskReasons.join("; ")}` : ""}`}
          >
            <span class="when">{day(c.at)}</span>
            <span class="subj">
              <span class="sha">{c.short}</span>
              <KindTagH kind={c.kind} bucket={c.bucket} />
              {c.subject}
              <Refs refs={c.refs} tags={c.tags} />
            </span>
            <span class="meta">
              <Flags c={c} />
              {c.merge ? <span>merge</span> : <PlusMinus added={c.added} deleted={c.deleted} />}
              <span>{c.author.split(" ")[0]}</span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function LinkRow({
  l,
  onSelect,
}: {
  l: CommitLinkUi;
  onSelect: (sha: string) => void;
}): JSX.Element {
  return (
    <div class="step" onClick={() => onSelect(l.sha)} style={{ cursor: "pointer" }}>
      <span class="sha mono muted">{l.short}</span>{" "}
      {l.kind && l.bucket ? <KindTagH kind={l.kind} bucket={l.bucket} /> : null}
      <a>{l.subject}</a>
      {l.at ? <span class="muted small"> · {day(l.at)}</span> : null}
      {l.paths.length ? <div class="muted small">{l.paths.join(", ")}</div> : null}
    </div>
  );
}

// --- commit detail ----------------------------------------------------------------------

function DiffView({ sha, path }: { sha: string; path?: string | undefined }): JSX.Element {
  const q = useAsync(
    () => api<{ text: string; truncated: boolean }>("/api/history/diff", { sha, path }),
    [sha, path],
  );
  if (q.error) return <ErrorBox error={q.error} />;
  if (!q.data) return <Spinner />;
  const lines = q.data.text.split("\n");
  return (
    <>
      <div class="diff">
        {lines.map((l) => (
          <div
            class={
              l.startsWith("+++") || l.startsWith("---")
                ? "muted"
                : l.startsWith("diff --git")
                  ? "file"
                  : l.startsWith("@@")
                    ? "hunk"
                    : l.startsWith("+")
                      ? "add"
                      : l.startsWith("-")
                        ? "del"
                        : ""
            }
          >
            {l.startsWith("diff --git") ? l.replace(/^diff --git a\/(.*) b\/.*$/, "$1") : l || " "}
          </div>
        ))}
      </div>
      {q.data.truncated ? <div class="muted small">diff truncated</div> : null}
    </>
  );
}

function CommitDetail({
  sha,
  onSelect,
}: {
  sha: string;
  onSelect: (sha: string) => void;
}): JSX.Element {
  const q = useAsync(() => api<CommitDetailUi>("/api/history/commit", { sha }), [sha]);
  const [diff, setDiff] = useState<string | null | false>(false);
  useEffect(() => setDiff(false), [sha]);
  if (q.error) return <ErrorBox error={q.error} />;
  if (!q.data) return <Spinner />;
  if (q.data.error) return <ErrorBox error={q.data.error} />;
  const d = q.data;
  const c = d.commit;
  const maxLines = Math.max(1, ...d.files.map((f) => f.added + f.deleted));
  return (
    <div class="stack">
      <Card>
        <div class="row tight" style={{ flexWrap: "wrap" }}>
          <KindTagH kind={c.kind} bucket={c.bucket} />
          {c.scope ? <Tag>{c.scope}</Tag> : null}
          {c.breaking ? <Tag class="risk-high">breaking</Tag> : null}
          {c.pr ? <Tag>PR #{c.pr}</Tag> : null}
          {c.issues.map((i) => (
            <Tag>{i}</Tag>
          ))}
          <Refs refs={c.refs} tags={c.tags} max={6} />
          <span class="spacer" />
          <span class="mono small muted" title={c.sha}>
            {c.sha.slice(0, 12)}
          </span>
        </div>
        <h3 class="hist-subject">{c.subject}</h3>
        <div class="muted small">
          {c.author} &lt;{c.email}&gt; · {new Date(c.at).toLocaleString()} ({ago(c.at)})
          {c.merge
            ? " · merge"
            : ` · +${c.added}/-${c.deleted} in ${c.files} file${c.files === 1 ? "" : "s"} (${c.size})`}
          {c.onHead ? "" : " · not reachable from HEAD"}
        </div>
        {c.body ? (
          <div class="msg" style={{ marginTop: 8 }}>
            {c.body}
          </div>
        ) : null}
        {c.riskReasons.length ? (
          <div class="row small" style={{ marginTop: 8, alignItems: "baseline" }}>
            <Tag class={c.risk >= 0.5 ? "risk-high" : c.risk >= 0.3 ? "risk-medium" : "risk-low"}>
              hindsight {c.risk.toFixed(2)}
            </Tag>
            <span class="muted">{c.riskReasons.join("; ")}</span>
          </div>
        ) : null}
        <div class="row" style={{ marginTop: 8 }}>
          <button type="button" class="sm" onClick={() => setDiff(diff === false ? null : false)}>
            {diff === false ? "Show diff" : "Hide diff"}
          </button>
          <button
            type="button"
            class="sm"
            onClick={() => navigate("history", { tab: "graph", focus: `commit:${c.sha}` })}
          >
            Graph
          </button>
          {d.branches.length ? (
            <span class="muted small">
              on {d.branches.slice(0, 5).join(", ")}
              {d.branches.length > 5 ? ` +${d.branches.length - 5}` : ""}
            </span>
          ) : null}
        </div>
      </Card>
      {d.blamedBy.length || d.origins.length || d.revertedBy ? (
        <Card title="what history says">
          {d.origins.length ? (
            <>
              <div class="muted small" style={{ marginBottom: 4 }}>
                {c.kind === "revert"
                  ? "reverts"
                  : "removed lines last written by (likely cause of the bug)"}
              </div>
              <div class="chain">
                {d.origins.map((l) => (
                  <div class={cls("step", "origin")}>
                    <LinkRow l={l} onSelect={onSelect} />
                  </div>
                ))}
              </div>
            </>
          ) : null}
          {d.blamedBy.length ? (
            <>
              <div class="muted small" style={{ margin: "6px 0 4px" }}>
                later fixes that removed lines from this commit
              </div>
              <div class="chain">
                {d.blamedBy.map((l) => (
                  <div class={cls("step", "fix")}>
                    <LinkRow l={l} onSelect={onSelect} />
                    {l.at ? (
                      <span class="muted small">
                        {Math.max(0, Math.round((l.at - c.at) / 864e5))}d later
                      </span>
                    ) : null}
                  </div>
                ))}
              </div>
            </>
          ) : null}
          {d.revertedBy ? (
            <>
              <div class="muted small" style={{ margin: "6px 0 4px" }}>
                reverted by
              </div>
              <div class="chain">
                <div class="step fix">
                  <LinkRow l={d.revertedBy} onSelect={onSelect} />
                </div>
              </div>
            </>
          ) : null}
        </Card>
      ) : null}
      {diff !== false ? (
        <Card>
          <div class="row" style={{ marginBottom: 6 }}>
            <h3 class="hist-h3">diff{diff ? ` · ${diff}` : ""}</h3>
            {diff ? (
              <button type="button" class="sm ghost" onClick={() => setDiff(null)}>
                whole commit
              </button>
            ) : null}
          </div>
          <DiffView sha={c.sha} path={diff ?? undefined} />
        </Card>
      ) : null}
      {d.files.length ? (
        <Card
          title={`files · ${d.files.length}`}
          sub="symbols are listed when the file has not changed since this commit"
        >
          <div class="cfiles">
            {d.files.map((f) => (
              <div class="cfile">
                <div class="row tight">
                  <a
                    class="ellipsis grow"
                    title={f.path}
                    onClick={() => navigate("explore", { file: f.path })}
                  >
                    {f.path}
                  </a>
                  <Bar value={f.added + f.deleted} max={maxLines} width={44} />
                  <PlusMinus added={f.added} deleted={f.deleted} />
                </div>
                <div class="row tight small" style={{ flexWrap: "wrap" }}>
                  <a class="muted" onClick={() => setDiff(f.path)}>
                    diff
                  </a>
                  <a
                    class="muted"
                    onClick={() => navigate("history", { tab: "files", file: f.path })}
                  >
                    history
                  </a>
                  {f.renamedFrom ? <span class="muted">← {f.renamedFrom}</span> : null}
                  {f.fileFixes ? (
                    <span class="muted" title={`history risk ${f.fileRisk.toFixed(2)}`}>
                      <RiskBar value={f.fileRisk} /> {f.fileFixes} past fix
                      {f.fileFixes === 1 ? "" : "es"}
                    </span>
                  ) : null}
                  {f.symbols.map((s) => (
                    <a
                      onClick={() =>
                        navigate("explore", {
                          file: f.path,
                          symbol: s.id,
                          line: s.line ? String(s.line) : undefined,
                        })
                      }
                    >
                      <span class="muted">{s.kind}</span> {s.name}
                    </a>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </Card>
      ) : null}
    </div>
  );
}

// --- timeline tab -----------------------------------------------------------------------

function Timeline({
  ov,
  params,
  selected,
  onSelect,
}: {
  ov: HistoryOverview;
  params: Record<string, string>;
  selected: string | null;
  onSelect: (sha: string | null) => void;
}): JSX.Element {
  const [hidden, setHidden] = useState<Set<Bucket>>(new Set());
  const [range, setRange] = useState<[number, number] | null>(null);
  const [q, setQ] = useState(params.q ?? "");
  const [author, setAuthor] = useState("");
  const [path, setPath] = useState(params.path ?? "");
  const [risky, setRisky] = useState(false);
  const [headOnly, setHeadOnly] = useState(false);
  const [limit, setLimit] = useState(150);
  const buckets = ov.buckets.filter((b) => !hidden.has(b));
  const list = useAsync(
    () =>
      api<{ total: number; commits: CommitRowUi[] }>("/api/history/commits", {
        buckets: hidden.size ? buckets.join(",") : undefined,
        q: q.trim() || undefined,
        author: author || undefined,
        path: path.trim() || undefined,
        since: range ? new Date(range[0]).toISOString() : undefined,
        until: range ? new Date(range[1]).toISOString() : undefined,
        risky: risky ? 1 : undefined,
        head: headOnly ? 1 : undefined,
        limit,
      }),
    [hidden, q, author, path, range, risky, headOnly, limit],
  );
  const graph = useAsync(
    () => api<HistoryGraphUi>("/api/history/graph", { limit: 400 }),
    [ov.head],
  );
  const lanes = useMemo(() => {
    if (!graph.data || !list.data) return undefined;
    const shown = new Set(list.data.commits.map((c) => c.sha));
    // The lane layout needs the DAG; only draw it when the list is an unfiltered prefix of it.
    const prefix = graph.data.commits.slice(0, list.data.commits.length);
    if (prefix.length !== shown.size || !prefix.every((c) => shown.has(c.sha))) return undefined;
    return layoutLanes(prefix);
  }, [graph.data, list.data]);
  const bucketCounts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const w of ov.weeks) for (const b of ov.buckets) out[b] = (out[b] ?? 0) + w.byBucket[b];
    return out;
  }, [ov]);
  return (
    <div
      class="grid wide"
      style={{ alignItems: "start", gridTemplateColumns: "minmax(0, 1.4fr) minmax(320px, 1fr)" }}
    >
      <div class="stack">
        <Card>
          <div class="row" style={{ marginBottom: 6, flexWrap: "wrap" }}>
            <KindLegend
              counts={bucketCounts}
              hidden={hidden}
              onToggle={(b) =>
                setHidden((s) => {
                  const n = new Set(s);
                  if (n.has(b)) n.delete(b);
                  else n.add(b);
                  return n;
                })
              }
            />
            <span class="spacer" />
            <span class="muted small">
              {range ? (
                <>
                  {day(range[0])} → {day(range[1])} <a onClick={() => setRange(null)}>clear</a>
                </>
              ) : (
                "drag across the chart to focus a period"
              )}
            </span>
          </div>
          <ActivityChart weeks={ov.weeks} range={range} onRange={setRange} hidden={hidden} />
        </Card>
        <Card>
          <div class="row" style={{ flexWrap: "wrap", marginBottom: 8 }}>
            <input
              type="search"
              placeholder="search message, sha, issue…"
              value={q}
              onInput={(e) => setQ((e.target as HTMLInputElement).value)}
              style={{ width: 240 }}
            />
            <select
              value={author}
              onChange={(e) => setAuthor((e.target as HTMLSelectElement).value)}
            >
              <option value="">everyone</option>
              {ov.authors.map((a) => (
                <option value={a.name}>
                  {a.name} ({a.commits})
                </option>
              ))}
            </select>
            <input
              type="text"
              placeholder="path prefix"
              value={path}
              onInput={(e) => setPath((e.target as HTMLInputElement).value)}
              style={{ width: 180 }}
            />
            <button
              type="button"
              class={cls("chip", risky && "on")}
              onClick={() => setRisky(!risky)}
              title="only commits later fixed, reverted, large or touching hotspots"
            >
              ⚠ hindsight flags
            </button>
            <button
              type="button"
              class={cls("chip", headOnly && "on")}
              onClick={() => setHeadOnly(!headOnly)}
            >
              HEAD only
            </button>
            <span class="spacer" />
            <span class="muted small">{list.data ? `${list.data.total} commits` : ""}</span>
          </div>
          {list.error ? (
            <ErrorBox error={list.error} />
          ) : !list.data ? (
            <Spinner />
          ) : (
            <>
              <CommitList
                commits={list.data.commits}
                selected={selected}
                onSelect={onSelect}
                lanes={lanes}
              />
              {list.data.total > list.data.commits.length ? (
                <div class="row" style={{ marginTop: 8 }}>
                  <button type="button" class="sm" onClick={() => setLimit((l) => l + 200)}>
                    show more ({list.data.total - list.data.commits.length} left)
                  </button>
                </div>
              ) : null}
            </>
          )}
        </Card>
      </div>
      <div class="stack">
        {selected ? (
          <CommitDetail sha={selected} onSelect={onSelect} />
        ) : (
          <>
            <Card title="worth knowing">
              {ov.notable.length ? (
                <CommitList commits={ov.notable} selected={null} onSelect={onSelect} />
              ) : (
                <div class="muted small">No commit stands out in hindsight.</div>
              )}
            </Card>
            <Card title="people">
              <table>
                <tbody>
                  {ov.authors.slice(0, 8).map((a) => (
                    <tr class="click" onClick={() => setAuthor(a.name)}>
                      <td>{a.name}</td>
                      <td class="num">
                        <Bar value={a.commits} max={ov.authors[0]?.commits ?? 1} width={70} />{" "}
                        {a.commits}
                      </td>
                      <td class="muted small">
                        {a.fixes} fixes · {a.files} files
                      </td>
                      <td class="muted small">{ago(a.lastAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
            {ov.tags.length ? (
              <Card title="releases">
                <div class="row tight" style={{ flexWrap: "wrap" }}>
                  {ov.tags.slice(0, 20).map((t) => (
                    <a onClick={() => onSelect(t.sha)} title={day(t.at)}>
                      <span class="ref tag">{t.name}</span>
                    </a>
                  ))}
                </div>
              </Card>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

// --- branches tab -----------------------------------------------------------------------

function Branches({
  ov,
  params,
  onSelectCommit,
}: {
  ov: HistoryOverview;
  params: Record<string, string>;
  onSelectCommit: (sha: string) => void;
}): JSX.Element {
  const [sel, setSel] = useState<string | null>(params.branch ?? null);
  const [showRemote, setShowRemote] = useState(false);
  const [showMerged, setShowMerged] = useState(true);
  const graph = useAsync(
    () => api<HistoryGraphUi>("/api/history/graph", { limit: 120 }),
    [ov.head],
  );
  const detail = useAsync(
    () => (sel ? api<BranchDetailUi>("/api/history/branch", { name: sel }) : Promise.resolve(null)),
    [sel],
  );
  const lanes = useMemo(
    () => (graph.data ? layoutLanes(graph.data.commits) : undefined),
    [graph.data],
  );
  const rows = ov.branches.filter(
    (b) => (showRemote || !b.remote) && (showMerged || !b.merged || b.isDefault),
  );
  const maxAB = Math.max(1, ...rows.map((b) => Math.max(b.ahead, b.behind)));
  const [selCommit, setSelCommit] = useState<string | null>(null);
  return (
    <div
      class="grid wide"
      style={{ alignItems: "start", gridTemplateColumns: "minmax(0, 1fr) minmax(360px, 1fr)" }}
    >
      <Card
        title="commit graph"
        sub={`latest ${graph.data?.commits.length ?? ""} across all branches`}
      >
        {graph.error ? (
          <ErrorBox error={graph.error} />
        ) : !graph.data ? (
          <Spinner />
        ) : (
          <CommitList
            commits={graph.data.commits}
            selected={selCommit}
            onSelect={(s) => {
              setSelCommit(s);
              onSelectCommit(s);
            }}
            lanes={lanes}
          />
        )}
      </Card>
      <div class="stack">
        <Card>
          <div class="row" style={{ marginBottom: 6 }}>
            <h3 class="hist-h3">branches · {rows.length}</h3>
            <span class="spacer" />
            <button
              type="button"
              class={cls("chip", showRemote && "on")}
              onClick={() => setShowRemote(!showRemote)}
            >
              remotes
            </button>
            <button
              type="button"
              class={cls("chip", showMerged && "on")}
              onClick={() => setShowMerged(!showMerged)}
            >
              merged
            </button>
          </div>
          <table>
            <thead>
              <tr>
                <th>branch</th>
                <th>vs {ov.base ?? "base"}</th>
                <th>last</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((b) => (
                <tr class={cls("click", sel === b.name && "sel")} onClick={() => setSel(b.name)}>
                  <td class="break">
                    <span class={cls("ref", b.remote && "remote")}>{b.name}</span>
                    {b.current ? <Tag>current</Tag> : null}
                    {b.isDefault ? <Tag>base</Tag> : null}
                    {!b.merged && !b.isDefault ? <Tag class="risk-medium">unmerged</Tag> : null}
                    {b.lastSubject ? (
                      <div class="muted small ellipsis" style={{ maxWidth: 260 }}>
                        {b.lastSubject}
                      </div>
                    ) : null}
                  </td>
                  <td>
                    {b.isDefault ? (
                      <span class="muted small">—</span>
                    ) : (
                      <span class="ab" title={`${b.ahead} ahead, ${b.behind} behind`}>
                        <span class="ok">+{b.ahead}</span>
                        <Bar value={b.ahead} max={maxAB} width={40} />
                        <Bar value={b.behind} max={maxAB} width={40} />
                        <span class="bad">-{b.behind}</span>
                      </span>
                    )}
                  </td>
                  <td class="muted small nowrap">
                    {ago(b.at)}
                    {b.lastAuthor ? ` · ${b.lastAuthor.split(" ")[0]}` : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
        {sel ? (
          <Card title={<span class="break">{sel}</span>}>
            {detail.error ? (
              <ErrorBox error={detail.error} />
            ) : !detail.data ? (
              <Spinner />
            ) : detail.data.error ? (
              <ErrorBox error={detail.data.error} />
            ) : (
              <BranchDetail
                d={detail.data}
                onSelect={(s) => {
                  setSelCommit(s);
                  onSelectCommit(s);
                }}
              />
            )}
          </Card>
        ) : (
          <Card class="muted small">
            Select a branch to see the commits only it has, the files they touch, and how bug-prone
            those files have been.
          </Card>
        )}
      </div>
    </div>
  );
}

function BranchDetail({
  d,
  onSelect,
}: {
  d: BranchDetailUi;
  onSelect: (sha: string) => void;
}): JSX.Element {
  const b = d.branch;
  const risky = d.files.filter((f) => f.risk >= 0.3);
  return (
    <>
      <div class="row small" style={{ flexWrap: "wrap" }}>
        <Tag>tip {b.sha.slice(0, 7)}</Tag>
        <Tag>{ago(b.at)}</Tag>
        {b.upstream ? <Tag>tracks {b.upstream}</Tag> : null}
        {!b.isDefault ? (
          <Tag class={b.merged ? "s-accepted" : "risk-medium"}>
            {b.merged ? "merged" : `+${b.ahead} / -${b.behind}`}
          </Tag>
        ) : null}
        <span class="spacer" />
        <button
          type="button"
          class="sm"
          onClick={() =>
            navigate("history", {
              tab: "graph",
              focus: `branch:${b.remote ? b.name.replace(/^[^/]+\//, "") : b.name}`,
            })
          }
        >
          Graph
        </button>
      </div>
      {b.isDefault ? (
        <div class="muted small" style={{ marginTop: 6 }}>
          This is the base branch; other branches are compared against it.
        </div>
      ) : (
        <>
          <div class="muted small" style={{ margin: "8px 0 4px" }}>
            {d.commits.length} commit{d.commits.length === 1 ? "" : "s"} only on this branch
          </div>
          <CommitList
            commits={d.commits}
            selected={null}
            onSelect={onSelect}
            empty="Nothing unique: the branch is fully merged or behind."
          />
          {d.files.length ? (
            <>
              <div class="muted small" style={{ margin: "8px 0 4px" }}>
                files touched {risky.length ? `· ${risky.length} with a fix-heavy history` : ""}
              </div>
              <div class="list" style={{ maxHeight: 220 }}>
                {d.files.map((f) => (
                  <div
                    class="item"
                    onClick={() => navigate("history", { tab: "files", file: f.path })}
                  >
                    <div class="p">
                      {f.risk >= 0.3 ? <RiskBar value={f.risk} /> : null} {f.path}
                      <span class="muted">
                        {" "}
                        · {f.commits} commit{f.commits === 1 ? "" : "s"}
                        {f.fixes ? `, ${f.fixes} past fixes` : ""}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </>
          ) : null}
        </>
      )}
    </>
  );
}

// --- files tab --------------------------------------------------------------------------

function Files({
  params,
  onSelectCommit,
}: {
  params: Record<string, string>;
  onSelectCommit: (sha: string) => void;
}): JSX.Element {
  const [prefix, setPrefix] = useState("");
  const [sel, setSel] = useState<string | null>(params.file ?? null);
  useEffect(() => {
    if (params.file) setSel(params.file);
  }, [params.file]);
  const q = useAsync(
    () =>
      api<{ files: FileHistoryUi[]; total: number }>("/api/history/files", {
        path: prefix.trim() || undefined,
        limit: 400,
      }),
    [prefix],
  );
  const { sorted, th } = useSort(q.data?.files, "risk");
  const [selCommit, setSelCommit] = useState<string | null>(null);
  return (
    <div
      class="grid wide"
      style={{ alignItems: "start", gridTemplateColumns: "minmax(0, 1fr) minmax(360px, 1fr)" }}
    >
      <div class="stack">
        <Card>
          <div class="row" style={{ marginBottom: 6 }}>
            <h3 class="hist-h3">churn vs fix share</h3>
            <input
              type="text"
              placeholder="folder prefix, e.g. src/graph/"
              value={prefix}
              onInput={(e) => setPrefix((e.target as HTMLInputElement).value)}
              style={{ width: 220 }}
            />
            <span class="spacer" />
            <span class="muted small">size = lines changed · colour = history risk</span>
          </div>
          {q.data ? (
            <FileScatter files={q.data.files} selected={sel} onSelect={setSel} />
          ) : q.error ? (
            <ErrorBox error={q.error} />
          ) : (
            <Spinner />
          )}
        </Card>
        <Card flush>
          <table>
            <thead>
              <tr>
                {th("path", "file")}
                {th("commits", "commits", true)}
                {th("fixes", "fixes", true)}
                {th("bugOrigins", "caused fixes", true)}
                {th("commits90d", "90d", true)}
                <th>12 months</th>
                {th("risk", "risk", true)}
              </tr>
            </thead>
            <tbody>
              {sorted.slice(0, 150).map((f) => (
                <tr class={cls("click", sel === f.path && "sel")} onClick={() => setSel(f.path)}>
                  <td class="break">{f.path}</td>
                  <td class="num">{f.commits}</td>
                  <td class="num">{f.fixes}</td>
                  <td class="num">{f.bugOrigins}</td>
                  <td class="num">{f.commits90d}</td>
                  <td>
                    <Sparkline values={f.months} />
                  </td>
                  <td class="num">
                    <RiskBar value={f.risk} /> {f.risk.toFixed(2)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </div>
      <div class="stack">
        {sel ? (
          <FileDetail
            path={sel}
            selected={selCommit}
            onSelect={(s) => {
              setSelCommit(s);
              onSelectCommit(s);
            }}
          />
        ) : (
          <Card class="muted small">
            Pick a file to read its story: who changed it, what broke afterwards, and which fixes
            restored behaviour worth a test.
          </Card>
        )}
      </div>
    </div>
  );
}

function FileDetail({
  path,
  selected,
  onSelect,
}: {
  path: string;
  selected: string | null;
  onSelect: (sha: string) => void;
}): JSX.Element {
  const q = useAsync(() => api<FileHistoryDetailUi>("/api/history/file", { path }), [path]);
  if (q.error) return <ErrorBox error={q.error} />;
  if (!q.data) return <Spinner />;
  const d = q.data;
  const f = d.file;
  return (
    <>
      <Card title={<span class="break">{path}</span>}>
        {f ? (
          <>
            <div class="row small" style={{ flexWrap: "wrap" }}>
              <Tag>{f.commits} commits</Tag>
              <Tag>{f.fixes} fixes</Tag>
              <Tag>
                +{fmt(f.added)}/-{fmt(f.deleted)}
              </Tag>
              <Tag>
                {day(f.firstAt)} → {day(f.lastAt)}
              </Tag>
              {f.renamedFrom ? <Tag>from {f.renamedFrom}</Tag> : null}
            </div>
            <div class="row small" style={{ marginTop: 6, alignItems: "center" }}>
              <RiskBar value={f.risk} />
              <span class="muted">
                history risk {f.risk.toFixed(2)}
                {f.reasons.length ? `: ${f.reasons.join("; ")}` : ""}
              </span>
            </div>
            <div class="row small" style={{ marginTop: 6, flexWrap: "wrap" }}>
              <span class="muted">authors:</span>
              {f.authors.map(([a, n]) => (
                <Tag>
                  {a} {n}
                </Tag>
              ))}
              <span class="spacer" />
              <Sparkline values={f.months} width={120} height={22} />
            </div>
            <div class="row" style={{ marginTop: 8 }}>
              <button type="button" class="sm" onClick={() => navigate("explore", { file: path })}>
                Open source
              </button>
              <button
                type="button"
                class="sm"
                onClick={() => navigate("galaxy", { node: `file:${path}` })}
              >
                Galaxy
              </button>
              <button
                type="button"
                class="sm"
                onClick={() => navigate("history", { tab: "graph", focus: `file:${path}` })}
              >
                History graph
              </button>
            </div>
          </>
        ) : (
          <div class="muted small">No commits in the loaded window touch this file.</div>
        )}
      </Card>
      {d.origins.length ? (
        <Card title="changes that later needed fixing">
          <div class="chain">
            {d.origins.map((o) => (
              <div class="step origin">
                <a onClick={() => onSelect(o.sha)}>
                  <span class="mono muted small">{o.short}</span>{" "}
                  <KindTagH kind={o.kind} bucket={o.bucket} /> {o.subject}
                </a>
                <span class="muted small"> · {day(o.at)}</span>
                <div class="chain" style={{ marginTop: 2 }}>
                  {o.fixes.map((x) => (
                    <div class="step fix">
                      <a onClick={() => onSelect(x.sha)}>
                        <span class="mono muted small">{x.short}</span> {x.subject}
                      </a>
                      <span class="muted small"> · {x.daysLater}d later</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </Card>
      ) : null}
      <Card title={`timeline · ${d.commits.length}`}>
        <CommitList commits={d.commits} selected={selected} onSelect={onSelect} />
      </Card>
    </>
  );
}

// --- risk tab ---------------------------------------------------------------------------

function Risk({
  ov,
  onSelectCommit,
}: {
  ov: HistoryOverview;
  onSelectCommit: (sha: string) => void;
}): JSX.Element {
  const q = useAsync(() => api<RiskUi>("/api/history/risk"), [ov.head, ov.stats.workingTree]);
  const [paths, setPaths] = useState("");
  const custom = useAsync(
    () =>
      paths.trim()
        ? api<RiskUi>("/api/history/risk", { paths: paths.trim() })
        : Promise.resolve(null),
    [paths],
  );
  const data = paths.trim() ? custom.data : q.data;
  const flagged = useAsync(
    () =>
      api<{ commits: CommitRowUi[] }>("/api/history/commits", { risky: 1, limit: 40 }).then((r) =>
        r.commits.filter((c) => c.blamedBy || c.reverted),
      ),
    [ov.head],
  );
  return (
    <div class="grid wide" style={{ alignItems: "start" }}>
      <div class="stack">
        <Card>
          <div class="row" style={{ marginBottom: 6 }}>
            <h3 class="hist-h3">
              {paths.trim() ? "history risk for these paths" : "working tree exposure"}
            </h3>
            <input
              type="text"
              placeholder="or paths, comma separated"
              value={paths}
              onInput={(e) => setPaths((e.target as HTMLInputElement).value)}
              style={{ width: 300 }}
            />
          </div>
          <div class="muted small" style={{ marginBottom: 8 }}>
            What the past says about the files you are changing now: fix density, changes here that
            were later fixed, and the last fix to re-read before editing.
          </div>
          {!data ? (
            q.error ? (
              <ErrorBox error={q.error} />
            ) : (
              <Spinner />
            )
          ) : !data.files.length ? (
            <Empty>Working tree is clean.</Empty>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>file</th>
                  <th>risk</th>
                  <th>history</th>
                </tr>
              </thead>
              <tbody>
                {[...data.files]
                  .sort((a, b) => (b.file?.risk ?? -1) - (a.file?.risk ?? -1))
                  .map((r) => (
                    <tr>
                      <td class="break">
                        <a onClick={() => navigate("history", { tab: "files", file: r.path })}>
                          {r.path}
                        </a>
                      </td>
                      <td class="nowrap">
                        {r.file ? (
                          <>
                            <RiskBar value={r.file.risk} /> {r.file.risk.toFixed(2)}
                          </>
                        ) : (
                          <span class="muted small">new</span>
                        )}
                      </td>
                      <td class="small">
                        {r.file ? (
                          <>
                            <div class="muted">
                              {r.file.commits} commits · {r.file.fixes} fixes · last{" "}
                              {ago(r.file.lastAt)}
                              {r.file.reasons.length ? ` · ${r.file.reasons.join("; ")}` : ""}
                            </div>
                            {r.lastFix ? <div>last fix: {r.lastFix}</div> : null}
                            {r.origins.length ? (
                              <div>
                                needed fixing before:{" "}
                                {r.origins.map((o) => (
                                  <a
                                    onClick={() => onSelectCommit(o.sha)}
                                    style={{ marginRight: 6 }}
                                  >
                                    {o.short} {o.subject.slice(0, 40)}
                                  </a>
                                ))}
                              </div>
                            ) : null}
                          </>
                        ) : (
                          <span class="muted">no history yet</span>
                        )}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          )}
        </Card>
        <Card title="bug-prone files">
          {ov.risky.length ? (
            <table>
              <tbody>
                {ov.risky.map((f) => (
                  <tr
                    class="click"
                    onClick={() => navigate("history", { tab: "files", file: f.path })}
                  >
                    <td class="break">{f.path}</td>
                    <td class="nowrap">
                      <RiskBar value={f.risk} /> {f.risk.toFixed(2)}
                    </td>
                    <td class="muted small">{f.reasons.join("; ") || `${f.commits} commits`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div class="muted small">No file shows a fix pattern yet.</div>
          )}
        </Card>
      </div>
      <div class="stack">
        <Card title="lessons from this history">
          {ov.lessons.length ? (
            ov.lessons.map((l) => <Lesson text={l} />)
          ) : (
            <div class="muted small">Not enough history yet.</div>
          )}
          {ov.stats.tracePending ? (
            <div class="muted small" style={{ marginTop: 6 }}>
              {ov.stats.tracePending} fixes still to trace; reload to continue.
            </div>
          ) : null}
        </Card>
        <Card title="changes that later needed fixing">
          <div class="muted small" style={{ marginBottom: 6 }}>
            A fix removed lines these commits wrote. The pattern, not the blame, is the lesson: what
            kind of change tends to break here?
          </div>
          {flagged.data ? (
            <CommitList
              commits={flagged.data}
              selected={null}
              onSelect={onSelectCommit}
              empty="No traced fix origins yet."
            />
          ) : (
            <Spinner />
          )}
        </Card>
      </div>
    </div>
  );
}

function Lesson({ text }: { text: string }): JSX.Element {
  return (
    <div class="lesson">
      <span class="i">◆</span>
      <span>{text}</span>
    </div>
  );
}

// --- view -------------------------------------------------------------------------------

export function History({ params }: { params: Record<string, string> }): JSX.Element {
  const [tab, setTab] = useState<Tab>(
    (params.tab as Tab) || (params.file ? "files" : params.branch ? "branches" : "timeline"),
  );
  const [sel, setSel] = useState<string | null>(params.sha ?? null);
  useEffect(() => {
    if (params.tab) setTab(params.tab as Tab);
    else if (params.file) setTab("files");
    else if (params.branch) setTab("branches");
  }, [params.tab, params.file, params.branch]);
  useEffect(() => {
    if (params.sha) setSel(params.sha);
  }, [params.sha]);
  const ov = useAsync(() => api<HistoryOverview>("/api/history"), []);
  const pick = (sha: string) => {
    setSel(sha);
    setTab("timeline");
  };
  if (ov.error)
    return (
      <div class="page ds-page hist-page">
        <ErrorBox error={ov.error} />
      </div>
    );
  if (!ov.data)
    return (
      <div class="page ds-page hist-page" role="status" aria-busy="true">
        <section class="ds-hero">
          <div class="ds-hero-main">
            <Skeleton w={120} h={12} />
            <Skeleton w="min(360px, 70%)" h={34} />
          </div>
        </section>
        <StatRow>
          {[0, 1, 2, 3].map(() => (
            <div class="ds-stat">
              <Skeleton w={90} h={11} />
              <Skeleton w={80} h={28} />
            </div>
          ))}
        </StatRow>
      </div>
    );
  const d = ov.data;
  if (!d.git)
    return (
      <div class="page ds-page hist-page">
        <EmptyState icon="⎇" title="No git history">
          {d.error ?? "Not a git repository."} The history explorer reads `git log`; initialise a
          repository and commit to use it.
        </EmptyState>
      </div>
    );
  const s = d.stats;
  const trend = s.prior30 ? Math.round(((s.last30 - s.prior30) / s.prior30) * 100) : null;
  return (
    <div class="page ds-page hist-page">
      <Hero
        eyebrow="History"
        title="Project history"
        sub={
          <>
            {d.branch ?? "detached"} @ {d.head.slice(0, 7)} · built {ago(d.builtAt)}
          </>
        }
        meta={
          <>
            <Badge tone="accent">{fmt(s.commits)} commits</Badge>
            <Badge tone={s.unmerged ? "warn" : "ok"}>
              {s.unmerged ? `${s.unmerged} unmerged` : "all merged"}
            </Badge>
            <a
              class="ds-link"
              onClick={() => api("/api/history", { refresh: 1 }).then(() => ov.reload())}
            >
              rebuild
            </a>
          </>
        }
      />
      <StatRow>
        <Stat label="commits" value={s.commits} sub={`${s.onHead} on HEAD`} />
        <Stat
          label="last 30 days"
          value={s.last30}
          sub={
            trend === null
              ? `${s.prior30} in the 30 before`
              : `${trend >= 0 ? "+" : ""}${trend}% vs prior 30`
          }
          tone={trend === null ? undefined : trend >= 0 ? "ok" : "warn"}
        />
        <Stat
          label="fixes"
          value={s.fixes}
          sub={`${Math.round((s.fixes / Math.max(1, s.commits - s.merges)) * 100)}% · ${s.linksTraced} origins traced${s.tracePending ? `, ${s.tracePending} pending` : ""}`}
        />
        <Stat
          label="branches"
          value={s.branches}
          sub={`${s.unmerged ? `${s.unmerged} unmerged` : "all merged"} · ${s.tags} tags`}
        />
        <Stat label="authors" value={s.authors} sub={`${s.files} files`} />
        <Stat label="working tree" value={s.workingTree} sub={d.branch ?? "detached"} />
      </StatRow>
      <div class="hist-nav">
        <Segmented<Tab>
          label="History view"
          options={[
            { id: "timeline", label: "Timeline" },
            { id: "branches", label: "Branches" },
            { id: "files", label: "Files" },
            { id: "graph", label: "Graph" },
            { id: "risk", label: "Risk & lessons" },
          ]}
          value={tab}
          onChange={(t) => {
            setTab(t);
            navigate("history", { tab: t, sha: sel ?? undefined });
          }}
        />
      </div>
      {tab === "timeline" && <Timeline ov={d} params={params} selected={sel} onSelect={setSel} />}
      {tab === "branches" && <Branches ov={d} params={params} onSelectCommit={pick} />}
      {tab === "files" && <Files params={params} onSelectCommit={pick} />}
      {tab === "graph" && <HistoryGraph focus={params.focus} />}
      {tab === "risk" && <Risk ov={d} onSelectCommit={pick} />}
    </div>
  );
}
