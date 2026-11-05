import type { JSX } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import { categoryInfo } from "../../../docs/category.js";
import { api, type KnowledgeNodeUi, type KnowledgeUi } from "../api.js";
import { KindTag, Spinner, toast } from "../components.js";
import { Badge, EmptyState, Skeleton, type Tone } from "../ds.js";
import { EdgeList } from "../graph/EdgeList.js";
import { EdgeGlyph, Glyph } from "../graph/Glyph.js";
import { GraphCanvas } from "../graph/GraphCanvas.js";
import {
  applyKnowledgeFilter,
  countBy,
  knowledgeColorOf,
  knowledgeEdgeStyleOf,
  knowledgeLabelOf,
  knowledgeShapeOf,
} from "../graph/knowledge.js";
import { navigate } from "../router.js";
import { cls } from "../util.js";

const STATUSES = ["proposed", "accepted", "superseded", "deprecated"];
const STATUS_TONE: Record<string, Tone> = {
  proposed: "warn",
  accepted: "ok",
  superseded: "muted",
  deprecated: "muted",
};

/** Chip order: the view's own kinds first, then hubs, then code. */
const KIND_ORDER = ["memory", "doc", "topic", "tag", "file", "package"];
const EDGE_ORDER = ["mentions", "links", "supersedes", "documents", "about", "tagged", "in_topic"];
const EDGE_HINT: Record<string, string> = {
  mentions: "a memory's related: header names it",
  links: "a mem: link in a memory's body",
  supersedes: "a decision that replaces another",
  documents: "a doc source covers this package or names this file",
  about: "a memory relates to a page of this local doc source",
  tagged: "carries this tag",
  in_topic: "memory topic or doc category",
};

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
 * The knowledge galaxy for one dashboard section: memories (scope `memory`) or
 * documentation sources (scope `docs`) and the files, symbols, packages, tags and
 * topics they connect to. Filters work on the fetched payload, so each chip changes
 * the drawing immediately; `focus` (from `?focus=`) re-centres the picture on a node.
 */
export function KnowledgeGalaxy({
  scope,
  focus,
}: {
  scope: "memory" | "docs";
  focus?: string | undefined;
}): JSX.Element {
  const view = scope === "docs" ? "docs" : "memory";
  const [data, setData] = useState<KnowledgeUi | null>(null);
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);
  const [hiddenKinds, setHiddenKinds] = useState<Set<string>>(new Set());
  const [hiddenEdges, setHiddenEdges] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState("");
  const [category, setCategory] = useState("");
  const [hideSuperseded, setHideSuperseded] = useState(scope === "memory");
  const [legend, setLegend] = useState(false);
  const [selected, setSelected] = useState<string | null>(focus ?? null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api<KnowledgeUi>("/api/knowledge", { scope, focus, limit: 300 })
      .then((d) => {
        if (!alive) return;
        setData(d);
        setSelected(focus ?? null);
      })
      .catch((e: Error) => alive && toast(e.message, true))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [scope, focus, tick]);

  const shown = useMemo(
    () =>
      data
        ? applyKnowledgeFilter(data, {
            hiddenKinds,
            hiddenEdges,
            status,
            category,
            hideSuperseded,
          })
        : null,
    [data, hiddenKinds, hiddenEdges, status, category, hideSuperseded],
  );

  const nodeCounts = useMemo(() => countBy(data?.nodes ?? [], (n) => n.kind), [data]);
  const edgeCounts = useMemo(() => countBy(data?.edges ?? [], (e) => e.kind), [data]);
  const sample = (kind: string) => data?.nodes.find((n) => n.kind === kind && !n.missing);
  const categories = useMemo(
    () => [
      ...new Set((data?.nodes ?? []).filter((n) => n.group === "doc" && n.sub).map((n) => n.sub!)),
    ],
    [data],
  );
  const hasMemories = (data?.nodes ?? []).some((n) => n.group === "memory");

  const byId = useMemo(() => new Map((data?.nodes ?? []).map((n) => [n.id, n])), [data]);
  const sel = selected ? byId.get(selected) : undefined;
  const visibleEdges = shown?.edges ?? [];
  const ins = sel ? visibleEdges.filter((e) => e.dst === sel.id) : [];
  const outs = sel ? visibleEdges.filter((e) => e.src === sel.id) : [];
  const label = (id: string) => byId.get(id)?.label ?? id;
  const focusOn = (id: string) => navigate(view, { tab: "graph", focus: id });
  const focused = focus ? byId.get(focus) : undefined;

  return (
    <div class="kgalaxy ws">
      <div class="gtoolbar">
        {focus ? (
          <span class="row tight">
            <span class="muted small">focused on</span>
            <b class="break">{focused?.label ?? focus}</b>
            <button type="button" class="sm" onClick={() => navigate(view, { tab: "graph" })}>
              Show all
            </button>
          </span>
        ) : (
          <span class="muted small">
            {scope === "docs"
              ? "documentation sources and what they cover"
              : "memories and what they are about"}
          </span>
        )}
        {hasMemories ? (
          <>
            <select
              value={status}
              title="memory status"
              onChange={(e) => setStatus((e.target as HTMLSelectElement).value)}
            >
              <option value="">any status</option>
              {STATUSES.map((s) => (
                <option value={s}>{s}</option>
              ))}
            </select>
            <button
              type="button"
              class={cls("chip", hideSuperseded && "on")}
              onClick={() => setHideSuperseded(!hideSuperseded)}
            >
              hide superseded
            </button>
          </>
        ) : null}
        {categories.length ? (
          <select
            value={category}
            title="doc category"
            onChange={(e) => setCategory((e.target as HTMLSelectElement).value)}
          >
            <option value="">any category</option>
            {categories.map((c) => (
              <option value={c}>{categoryInfo(c).label}</option>
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
            `${shown.nodes.length} of ${data.nodes.length} nodes · ${shown.edges.length} edges${data.truncated ? ` · first ${data.nodes.length} of ${data.total}` : ""}`
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
              {s ? <Glyph shape={knowledgeShapeOf(s)} color={knowledgeColorOf(s)} /> : null}
              {k} {nodeCounts.get(k)}
            </button>
          );
        })}
        <span class="muted small" style={{ marginLeft: 8 }}>
          edges:
        </span>
        {ordered([...edgeCounts.keys()], EDGE_ORDER).map((k) => {
          const st = knowledgeEdgeStyleOf(k);
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
        style={{
          gridTemplateColumns: sel ? "minmax(0,1fr) 320px" : "minmax(0,1fr)",
        }}
      >
        <div style={{ minWidth: 0, minHeight: 0 }}>
          {!shown ? (
            <div class="ws-skel" aria-busy="true">
              <Skeleton h={180} />
            </div>
          ) : shown.nodes.length ? (
            <GraphCanvas
              nodes={shown.nodes}
              edges={shown.edges}
              selected={selected}
              onSelect={setSelected}
              onActivate={focusOn}
              legend={legend}
              colorOf={knowledgeColorOf}
              shapeOf={knowledgeShapeOf}
              edgeStyleOf={knowledgeEdgeStyleOf}
              labelOf={knowledgeLabelOf}
            />
          ) : data?.nodes.length ? (
            <EmptyState compact icon="∅" title="Nothing left after these filters">
              Turn some node or edge kinds back on above.
            </EmptyState>
          ) : scope === "docs" ? (
            <EmptyState icon="❏" title="No documentation sources yet">
              Add some from Discover and they appear here with what they cover.
            </EmptyState>
          ) : (
            <EmptyState icon="❏" title="No memories yet">
              Memories saved with em_remember show up here with what they are about.
            </EmptyState>
          )}
        </div>
        {sel && (
          <div class="panel right">
            <div class="head">
              selection <span class="spacer" />
              <a onClick={() => setSelected(null)}>close</a>
            </div>
            <div class="body">
              <Selection node={sel} focus={focus} onFocus={focusOn} />
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
  node: KnowledgeNodeUi;
  focus?: string | undefined;
  onFocus: (id: string) => void;
}): JSX.Element {
  const isHub = node.group === "hub";
  return (
    <div class="section">
      <div class="row tight">
        <Glyph shape={knowledgeShapeOf(node)} color={knowledgeColorOf(node)} />
        <KindTag kind={node.kind} />
        <b class="break">{node.label}</b>
      </div>
      <div class="row tight wrap" style={{ marginTop: 4 }}>
        {node.sub && node.group === "memory" ? <Badge>{node.sub}</Badge> : null}
        {node.status ? <Badge tone={STATUS_TONE[node.status]}>{node.status}</Badge> : null}
        {node.group === "doc" && node.detail ? <Badge>{node.detail}</Badge> : null}
        {node.provider ? <Badge>{node.provider}</Badge> : null}
        {(node.tags ?? []).map((t) => (
          <Badge>#{t}</Badge>
        ))}
      </div>
      {node.path && node.group === "code" && node.kind !== "file" ? (
        <div class="muted small">
          {node.path}
          {node.line ? `:${node.line}` : ""}
        </div>
      ) : null}
      {node.missing ? (
        <div class="muted small" style={{ marginTop: 4 }}>
          Referenced, but nothing defines it: a deleted or renamed memory, a file outside the index,
          or a package the code does not import.
        </div>
      ) : null}
      <div class="row wrap" style={{ marginTop: 8 }}>
        {node.id !== focus ? (
          <button type="button" class="sm primary" onClick={() => onFocus(node.id)}>
            Focus here
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
        {!isHub && !node.missing ? (
          <button type="button" class="sm" onClick={() => navigate("galaxy", { node: node.id })}>
            Open in code galaxy
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
      </div>
    </div>
  );
}
