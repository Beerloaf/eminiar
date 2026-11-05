import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import { api, type EdgeWithNode, type VisNode } from "../../api.js";
import { KindTag, useAsync } from "../../components.js";
import { Badge, Card, EmptyState, Skeleton } from "../../ds.js";
import { navigate } from "../../router.js";
import { cls } from "../../util.js";

interface BehaviorNode {
  root: VisNode & { endLine?: number | null; loc?: number; complexity?: number };
  callees: EdgeWithNode[];
}

function BehaviorTree({
  id,
  depth,
  onSelect,
  selected,
}: {
  id: string;
  depth: number;
  onSelect: (n: BehaviorNode) => void;
  selected: string | null;
}): JSX.Element {
  const q = useAsync(() => api<BehaviorNode>("/api/behavior", { id }), [id]);
  const [open, setOpen] = useState<Set<string>>(new Set());
  if (q.error) return <div class="muted small">{q.error}</div>;
  if (!q.data) return <Skeleton h={24} />;
  const d = q.data;
  return (
    <>
      {depth === 0 && (
        <div class={cls("bnode", selected === d.root.id && "sel")} onClick={() => onSelect(d)}>
          <Badge>start</Badge>
          <KindTag kind={d.root.kind} />
          <b>{d.root.label}</b>
          <span class="muted small">{d.root.path}</span>
        </div>
      )}
      <div class="kids">
        {d.callees.length ? (
          d.callees.map((c) => {
            const isOpen = open.has(c.node.id);
            return (
              <>
                <div
                  class={cls("bnode", selected === c.node.id && "sel")}
                  onClick={() => onSelect({ root: c.node, callees: [] })}
                >
                  <span
                    class="arrow"
                    onClick={(e) => {
                      e.stopPropagation();
                      setOpen((s) => {
                        const n = new Set(s);
                        if (n.has(c.node.id)) n.delete(c.node.id);
                        else n.add(c.node.id);
                        return n;
                      });
                    }}
                  >
                    {c.node.kind === "package" || c.node.kind === "route"
                      ? "·"
                      : isOpen
                        ? "▾"
                        : "▸"}
                  </span>
                  <Badge>{c.kind === "handles" ? "handles" : "possible call"}</Badge>
                  <KindTag kind={c.node.kind} />
                  <span>{c.node.label}</span>
                  <span class="muted small">
                    {c.lines?.length ? `L${c.lines.join(", L")}` : ""}
                    {c.count && c.count > 1 ? ` ×${c.count}` : ""}
                  </span>
                </div>
                {isOpen && depth < 6 ? (
                  <BehaviorTree
                    id={c.node.id}
                    depth={depth + 1}
                    onSelect={onSelect}
                    selected={selected}
                  />
                ) : null}
              </>
            );
          })
        ) : (
          <div class="muted small" style={{ padding: "2px 6px" }}>
            no resolved calls
          </div>
        )}
      </div>
    </>
  );
}

export function Behavior({ params }: { params: Record<string, string> }): JSX.Element {
  const [start, setStart] = useState<string | null>(params.node ?? null);
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<VisNode[]>([]);
  const [sel, setSel] = useState<BehaviorNode | null>(null);
  useEffect(() => {
    if (q.trim().length < 2) return setRows([]);
    const t = setTimeout(() => {
      api<VisNode[]>("/api/nodes/search", { q: q.trim(), limit: 10 })
        .then((r) => setRows(r.filter((n) => n.kind !== "file" && n.kind !== "package")))
        .catch(() => setRows([]));
    }, 180);
    return () => clearTimeout(t);
  }, [q]);
  return (
    <div class="ds-grid main-side" style={{ alignItems: "start" }}>
      <Card title="Behavior" sub="possible calls from one operation">
        <div class="row" style={{ marginBottom: 10, position: "relative" }}>
          <span class="muted small">Start</span>
          <input
            type="text"
            placeholder="function or method…"
            value={q}
            onInput={(e) => setQ((e.target as HTMLInputElement).value)}
            style={{ width: 320 }}
          />
          {rows.length > 0 && (
            <div class="suggest" style={{ top: 36, left: 40 }}>
              {rows.map((r) => (
                <div
                  onMouseDown={() => {
                    setStart(r.id);
                    setQ("");
                    setRows([]);
                    setSel(null);
                  }}
                >
                  <KindTag kind={r.kind} />
                  <span class="ellipsis">{r.label}</span>
                  <span class="path">{r.path}</span>
                </div>
              ))}
            </div>
          )}
          <span class="muted small">
            Branches are possible static calls from the index, not an execution order.
          </span>
        </div>
        <div class="btree">
          {start ? (
            <BehaviorTree id={start} depth={0} onSelect={setSel} selected={sel?.root.id ?? null} />
          ) : (
            <EmptyState compact icon="↳" title="Choose a starting operation">
              Search a function or method above to follow its calls.
            </EmptyState>
          )}
        </div>
      </Card>
      <Card title={sel ? "Selected operation" : "Starting operation"}>
        {sel ? (
          <>
            <div class="row tight">
              <KindTag kind={sel.root.kind} />
              <b class="break">{sel.root.label}</b>
            </div>
            <div class="muted small">
              {sel.root.path}
              {sel.root.line ? `:${sel.root.line}` : ""}
              {sel.root.endLine ? `–${sel.root.endLine}` : ""}
            </div>
            {sel.root.complexity ? (
              <div class="row small" style={{ marginTop: 6 }}>
                <Badge>complexity {sel.root.complexity}</Badge>
                <Badge>{sel.root.loc} loc</Badge>
              </div>
            ) : null}
            <div class="row" style={{ marginTop: 8 }}>
              {sel.root.path ? (
                <button
                  type="button"
                  class="sm"
                  onClick={() =>
                    navigate("explore", {
                      file: sel.root.path!,
                      line: sel.root.line ? String(sel.root.line) : undefined,
                      symbol: sel.root.id,
                    })
                  }
                >
                  Open definition
                </button>
              ) : null}
              <button
                type="button"
                class="sm"
                onClick={() => {
                  setStart(sel.root.id);
                  setSel(null);
                }}
              >
                Start here
              </button>
              <button
                type="button"
                class="sm"
                onClick={() => navigate("galaxy", { node: sel.root.id })}
              >
                Galaxy
              </button>
            </div>
          </>
        ) : (
          <div class="muted small">Click an operation in the tree.</div>
        )}
      </Card>
    </div>
  );
}
