import type { JSX } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import { api, type HistoryGraphNodeUi, type HistoryKnowledgeUi } from "../api.js";
import { KindTag, Spinner, Tag, toast } from "../components.js";
import { EmptyState, Skeleton } from "../ds.js";
import { EdgeList } from "../graph/EdgeList.js";
import { EdgeGlyph, Glyph } from "../graph/Glyph.js";
import { GraphCanvas } from "../graph/GraphCanvas.js";
import { applyKnowledgeFilter, countBy } from "../graph/knowledge.js";
import { BUCKET_ORDER, bucketColor } from "../history/colors.js";
import {
  historyColorOf,
  historyEdgeStyleOf,
  historyLabelOf,
  historyShapeOf,
} from "../history/graph-style.js";
import { navigate } from "../router.js";
import { ago, cls } from "../util.js";

const KIND_ORDER = ["branch", "commit", "file", "memory", "doc"];
const EDGE_ORDER = [
  "contains",
  "merged_into",
  "touches",
  "fixes",
  "records",
  "mentions",
  "documents",
];
const EDGE_HINT: Record<string, string> = {
  contains: "a commit made on this branch",
  merged_into: "the branch was merged into the default branch",
  touches: "the commit changed this file",
  fixes: "a fix whose removed lines trace back to this commit",
  records: "the commit wrote or edited this memory",
  mentions: "a memory's related: header names this file",
  documents: "a doc source covers this file",
};
const BRANCH_COUNTS = [5, 8, 15, 30];

const ordered = (keys: string[], order: string[]) =>
  [...keys].sort((a, b) => {
    const ia = order.indexOf(a);
    const ib = order.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a.localeCompare(b);
  });

function toggle(set: Set<string>, k: string): Set<string> {
  const next = new Set(set);
  if (next.has(k)) next.delete(k);
  else next.add(k);
  return next;
}

/**
 * The History tab's graph: branches and their commits, the files each commit touched,
 * and the memories and doc sources about those files. Chips filter the fetched payload
 * (no refetch); `?focus=` re-centres on a branch, commit, file, memory or doc.
 */
export function HistoryGraph({ focus }: { focus?: string | undefined }): JSX.Element {
  const [data, setData] = useState<HistoryKnowledgeUi | null>(null);
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);
  const [branches, setBranches] = useState(8);
  const [hiddenKinds, setHiddenKinds] = useState<Set<string>>(new Set());
  const [hiddenEdges, setHiddenEdges] = useState<Set<string>>(new Set());
  const [bucket, setBucket] = useState("");
  const [legend, setLegend] = useState(false);
  const [selected, setSelected] = useState<string | null>(focus ?? null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api<HistoryKnowledgeUi>("/api/history/knowledge", { focus, branches, limit: 400 })
      .then((d) => {
        if (!alive) return;
        setData(d);
        setSelected(d.focus ?? null);
      })
      .catch((e: Error) => alive && toast(e.message, true))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [focus, branches, tick]);

  const shown = useMemo(() => {
    if (!data?.git) return null;
    // The commit-kind filter drops commits first; the shared filter then removes
    // whatever only those commits linked.
    const nodes = bucket
      ? data.nodes.filter((n) => n.kind !== "commit" || n.root || n.bucket === bucket)
      : data.nodes;
    return applyKnowledgeFilter(
      { nodes, edges: data.edges },
      { hiddenKinds, hiddenEdges, status: "", category: "", hideSuperseded: false },
    );
  }, [data, hiddenKinds, hiddenEdges, bucket]);

  const nodes = data?.git ? data.nodes : [];
  const nodeCounts = useMemo(() => countBy(nodes, (n) => n.kind), [data]);
  const edgeCounts = useMemo(() => countBy(data?.edges ?? [], (e) => e.kind), [data]);
  const buckets = useMemo(
    () =>
      countBy(
        nodes.filter((n) => n.kind === "commit"),
        (n) => n.bucket ?? "other",
      ),
    [data],
  );
  const sample = (kind: string) => nodes.find((n) => n.kind === kind && !n.missing);

  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [data]);
  const sel = selected ? byId.get(selected) : undefined;
  const visibleEdges = shown?.edges ?? [];
  const ins = sel ? visibleEdges.filter((e) => e.dst === sel.id) : [];
  const outs = sel ? visibleEdges.filter((e) => e.src === sel.id) : [];
  const label = (id: string) => {
    const n = byId.get(id);
    return n ? (n.kind === "commit" ? `${n.short} ${n.label}` : n.label) : id;
  };
  const focusOn = (id: string) => navigate("history", { tab: "graph", focus: id });
  const focused = data?.focus ? byId.get(data.focus) : undefined;

  if (data && !data.git)
    return (
      <EmptyState icon="⎇" title="No git history">
        {data.error ?? "Not a git repository."}
      </EmptyState>
    );

  return (
    <div class="kgalaxy hgraph ds-card flush">
      <div class="gtoolbar">
        {focus ? (
          <span class="row tight">
            <span class="muted small">focused on</span>
            <b class="break">{focused ? label(focused.id) : focus}</b>
            <button type="button" class="sm" onClick={() => navigate("history", { tab: "graph" })}>
              Show all
            </button>
          </span>
        ) : (
          <>
            <span class="muted small">newest</span>
            <select
              value={String(branches)}
              title="feature branches drawn"
              onChange={(e) => setBranches(Number((e.target as HTMLSelectElement).value))}
            >
              {BRANCH_COUNTS.map((n) => (
                <option value={String(n)}>{n}</option>
              ))}
            </select>
            <span class="muted small">branches, their commits and what they touched</span>
          </>
        )}
        <select
          value=""
          title="focus a branch"
          onChange={(e) => {
            const v = (e.target as HTMLSelectElement).value;
            if (v) focusOn(`branch:${v}`);
          }}
        >
          <option value="">focus a branch…</option>
          {(data?.branches ?? []).map((b) => (
            <option value={b.name}>
              {b.name} ({b.commits}){b.isDefault ? " · default" : b.merged ? " · merged" : ""}
              {b.live ? "" : " · deleted"}
            </option>
          ))}
        </select>
        {buckets.size > 1 ? (
          <select
            value={bucket}
            title="commit kind"
            onChange={(e) => setBucket((e.target as HTMLSelectElement).value)}
          >
            <option value="">any commit kind</option>
            {BUCKET_ORDER.filter((b) => buckets.has(b)).map((b) => (
              <option value={b}>
                {b} ({buckets.get(b)})
              </option>
            ))}
          </select>
        ) : null}
        <button
          type="button"
          class={cls("chip", legend && "on")}
          onClick={() => setLegend(!legend)}
        >
          legend
        </button>
        <button type="button" class="sm" title="reload" onClick={() => setTick((t) => t + 1)}>
          ↻
        </button>
        <span class="count">
          {loading ? (
            <Spinner />
          ) : shown && data ? (
            `${shown.nodes.length} of ${nodes.length} nodes · ${shown.edges.length} edges${data.truncated ? ` · first ${nodes.length} of ${data.total}` : ""}`
          ) : (
            ""
          )}
        </span>
      </div>
      <div class="gtoolbar" style={{ paddingTop: 4, paddingBottom: 6 }}>
        <span class="muted small">nodes:</span>
        {ordered([...nodeCounts.keys()], KIND_ORDER).map((k) => {
          const s = sample(k);
          return (
            <button
              type="button"
              class={cls("chip", !hiddenKinds.has(k) && "on")}
              onClick={() => setHiddenKinds(toggle(hiddenKinds, k))}
            >
              {s ? <Glyph shape={historyShapeOf(s)} color={historyColorOf(s)} /> : null}
              {k} {nodeCounts.get(k)}
            </button>
          );
        })}
        <span class="muted small" style={{ marginLeft: 8 }}>
          edges:
        </span>
        {ordered([...edgeCounts.keys()], EDGE_ORDER).map((k) => {
          const st = historyEdgeStyleOf(k);
          return (
            <button
              type="button"
              title={EDGE_HINT[k]}
              class={cls("chip", !hiddenEdges.has(k) && "on")}
              onClick={() => setHiddenEdges(toggle(hiddenEdges, k))}
            >
              <EdgeGlyph color={st.color} dash={st.dash} />
              {k} {edgeCounts.get(k)}
            </button>
          );
        })}
      </div>
      <div
        class="kbody"
        style={{ gridTemplateColumns: sel ? "minmax(0,1fr) 320px" : "minmax(0,1fr)" }}
      >
        <div style={{ minWidth: 0, minHeight: 0 }}>
          {!shown ? (
            <div class="hist-graph-loading" role="status" aria-busy="true">
              <Skeleton h={14} />
              <Skeleton w="70%" h={14} />
              <Skeleton h={120} />
            </div>
          ) : shown.nodes.length ? (
            <GraphCanvas
              nodes={shown.nodes}
              edges={shown.edges}
              selected={selected}
              onSelect={setSelected}
              onActivate={focusOn}
              legend={legend}
              colorOf={historyColorOf}
              shapeOf={historyShapeOf}
              edgeStyleOf={historyEdgeStyleOf}
              labelOf={historyLabelOf}
            />
          ) : nodes.length ? (
            <EmptyState compact title="Nothing left after these filters." />
          ) : (
            <EmptyState compact title="No commits to draw." />
          )}
        </div>
        {sel && (
          <div class="panel right">
            <div class="head">
              selection <span class="spacer" />
              <a onClick={() => setSelected(null)}>close</a>
            </div>
            <div class="body">
              <Selection node={sel} focus={data?.focus ?? undefined} onFocus={focusOn} />
              <EdgeList
                title="incoming"
                rows={ins.map((e) => ({ kind: e.kind, id: e.src }))}
                label={label}
                onPick={setSelected}
              />
              <EdgeList
                title="outgoing"
                rows={outs.map((e) => ({ kind: e.kind, id: e.dst }))}
                label={label}
                onPick={setSelected}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Selection({
  node,
  focus,
  onFocus,
}: {
  node: HistoryGraphNodeUi;
  focus?: string | undefined;
  onFocus: (id: string) => void;
}): JSX.Element {
  return (
    <div class="section">
      <div class="row tight">
        <Glyph shape={historyShapeOf(node)} color={historyColorOf(node)} />
        <KindTag kind={node.kind} />
        <b class="break">{node.kind === "commit" ? node.short : node.label}</b>
      </div>
      {node.kind === "commit" ? <div style={{ marginTop: 4 }}>{node.label}</div> : null}
      <div class="row tight wrap" style={{ marginTop: 4 }}>
        {node.kind === "commit" && node.sub ? (
          <span class="tag" style={{ borderColor: bucketColor(node.bucket ?? "other") }}>
            {node.sub}
          </span>
        ) : null}
        {node.group === "memory" && node.sub ? <Tag>{node.sub}</Tag> : null}
        {node.status ? <span class={`tag s-${node.status}`}>{node.status}</span> : null}
        {node.group === "doc" && node.detail ? <Tag>{node.detail}</Tag> : null}
        {node.kind === "branch" ? (
          <>
            <Tag>{node.commits} own commits</Tag>
            {node.isDefault ? (
              <Tag>default</Tag>
            ) : node.merged ? (
              <Tag>merged</Tag>
            ) : (
              <Tag>open</Tag>
            )}
            {node.live ? null : <Tag>ref deleted</Tag>}
            {(node.prs ?? []).map((pr) => (
              <Tag>#{pr}</Tag>
            ))}
          </>
        ) : null}
        {node.kind === "file" && node.fixes ? <Tag>{node.fixes} fixes</Tag> : null}
        {node.risk ? <Tag>risk {Math.round(node.risk * 100)}%</Tag> : null}
      </div>
      {node.at ? (
        <div class="muted small" style={{ marginTop: 4 }}>
          {node.author ? `${node.author} · ` : ""}
          {ago(node.at)}
        </div>
      ) : null}
      {node.missing ? (
        <div class="muted small" style={{ marginTop: 4 }}>
          {node.kind === "file"
            ? "No longer in the working tree (deleted or renamed since)."
            : "Nothing defines it any more (deleted or renamed)."}
        </div>
      ) : null}
      <div class="row wrap" style={{ marginTop: 8 }}>
        {node.id !== focus ? (
          <button type="button" class="sm primary" onClick={() => onFocus(node.id)}>
            Focus here
          </button>
        ) : null}
        {node.kind === "commit" && node.short ? (
          <button
            type="button"
            class="sm"
            onClick={() => navigate("history", { tab: "timeline", sha: node.id.slice(7) })}
          >
            Open commit
          </button>
        ) : null}
        {node.kind === "branch" && node.live && !node.isDefault ? (
          <button
            type="button"
            class="sm"
            onClick={() => navigate("history", { tab: "branches", branch: node.label })}
          >
            Branch detail
          </button>
        ) : null}
        {node.kind === "file" && node.path ? (
          <button
            type="button"
            class="sm"
            onClick={() => navigate("history", { tab: "files", file: node.path! })}
          >
            File history
          </button>
        ) : null}
        {node.kind === "file" && node.path && !node.missing ? (
          <button
            type="button"
            class="sm"
            onClick={() => navigate("explore", { file: node.path! })}
          >
            Open source
          </button>
        ) : null}
        {node.group === "memory" && !node.missing ? (
          <button type="button" class="sm" onClick={() => navigate("memory", { name: node.label })}>
            Open memory
          </button>
        ) : null}
        {node.group === "doc" && !node.missing ? (
          <button
            type="button"
            class="sm"
            onClick={() => navigate("docs", { tab: "sources", name: node.label })}
          >
            Open doc source
          </button>
        ) : null}
      </div>
    </div>
  );
}
