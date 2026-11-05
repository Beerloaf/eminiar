import type { JSX } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import { api, del, type MemoryBody, type MemoryList, type MemoryRowUi, post } from "../api.js";
import { ErrorBox, Spinner, toast, useAsync } from "../components.js";
import { Badge, Card, EmptyState, Hero, Segmented, type Tone } from "../ds.js";
import { classifyHref, dashboardHref } from "../markdown/links.js";
import { Markdown } from "../markdown/Markdown.js";
import { navigate } from "../router.js";
import { cls, day, fmt } from "../util.js";
import { KnowledgeGalaxy } from "./KnowledgeGalaxy.js";

const KIND_TONES: Record<string, Tone> = {
  decision: "purple",
  constraint: "bad",
  fact: "accent",
  preference: "ok",
  todo: "warn",
  note: "muted",
  onboarding: "ok",
};
const STATUS_TONES: Record<string, Tone> = { proposed: "warn", rejected: "bad" };

function MemTag({ m }: { m: { kind: string; status?: string | null } }): JSX.Element {
  return (
    <>
      <Badge tone={KIND_TONES[m.kind] ?? "muted"}>{m.kind}</Badge>
      {m.status && m.status !== "accepted" ? (
        <Badge tone={STATUS_TONES[m.status] ?? "muted"}>{m.status}</Badge>
      ) : null}
    </>
  );
}

/** A `related:` entry (`mem:name`, `file:path`, `sym:path#Name`) as a chip that navigates. */
function RelatedRef({ value }: { value: string }): JSX.Element {
  const href = dashboardHref(classifyHref(value));
  return href ? (
    <a class="ref" href={href} title={value}>
      {value}
    </a>
  ) : (
    <span class="tag" title={value}>
      {value}
    </span>
  );
}

/** The first non-empty line, without a heading marker, for list previews. */
function firstLine(content: string): string {
  return (
    content
      .split("\n")
      .find((l) => l.trim())
      ?.replace(/^#+\s*/, "")
      .slice(0, 120) ?? ""
  );
}

interface Form {
  kind: string;
  tags: string;
  related: string;
  body: string;
  name: string;
  status: string;
  supersedes: string;
}

const EMPTY: Form = {
  kind: "fact",
  tags: "",
  related: "",
  body: "",
  name: "",
  status: "",
  supersedes: "",
};

function formOf(m: MemoryBody): Form {
  return {
    kind: m.kind,
    tags: m.tags.join(", "),
    related: m.related.join(", "),
    body: m.body,
    name: m.name,
    status: m.status ?? "",
    supersedes: m.supersedes ?? "",
  };
}

/**
 * The right-hand pane: a memory rendered from its markdown, or (after "edit", or for a
 * new memory) the form whose textarea is the raw markdown body. Saving goes through
 * PUT/POST /api/memories, which rewrites the file; the file is re-read for the view.
 */
function Detail({
  name,
  kinds,
  statuses,
  onSaved,
  onDeleted,
}: {
  name: string | null;
  kinds: string[];
  statuses: string[];
  onSaved: (name: string) => void;
  onDeleted: () => void;
}): JSX.Element {
  const body = useAsync(
    () => (name ? api<MemoryBody>("/api/memories", { name }) : Promise.resolve(undefined)),
    [name],
  );
  const [editing, setEditing] = useState(!name);
  const [preview, setPreview] = useState(false);
  const [f, setF] = useState<Form>(EMPTY);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setEditing(!name);
    setPreview(false);
  }, [name]);
  useEffect(() => {
    const m = body.data;
    if (name && m) setF(formOf(m));
    if (!name) setF(EMPTY);
  }, [name, body.data]);
  const set = (k: keyof Form) => (e: Event) =>
    setF({ ...f, [k]: (e.target as HTMLInputElement).value });
  const stopEditing = () => {
    setEditing(false);
    setPreview(false);
  };
  const save = async () => {
    if (!f.body.trim()) return toast("body required", true);
    setBusy(true);
    try {
      const payload = {
        kind: f.kind,
        content: f.body,
        tags: f.tags,
        related: f.related,
        status: f.status || undefined,
        supersedes: f.supersedes || undefined,
      };
      const r = name
        ? await post<{ name: string; superseded?: string }>("/api/memories", payload, "PUT", {
            name,
          })
        : await post<{ name: string; superseded?: string }>("/api/memories", {
            ...payload,
            name: f.name.trim() || undefined,
          });
      toast(
        `${name ? "saved" : "created"} ${r.name}${r.superseded ? ` · ${r.superseded} marked superseded` : ""}`,
      );
      // Same name: the file changed under us, so re-read it for the rendered view.
      if (name === r.name) body.reload();
      onSaved(r.name);
      stopEditing();
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  const cancel = () => {
    if (body.data) setF(formOf(body.data));
    stopEditing();
  };
  const remove = async () => {
    if (!name || !confirm(`Delete memory "${name}" and its file?`)) return;
    try {
      await del("/api/memories", { name });
      toast(`deleted ${name}`);
      onDeleted();
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  const rename = async () => {
    if (!name) return;
    const to = prompt("New name (topic/slug):", name);
    if (!to || to === name) return;
    try {
      const r = await post<{ name: string; refsUpdated: number }>(
        "/api/memories",
        { to },
        "PATCH",
        { name },
      );
      toast(`renamed → ${r.name}${r.refsUpdated ? ` (${r.refsUpdated} references updated)` : ""}`);
      onSaved(r.name);
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  const onKey = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      void save();
    } else if (e.key === "Escape" && name) {
      e.preventDefault();
      cancel();
    }
  };
  if (name && body.error) return <ErrorBox error={body.error} />;
  if (name && !body.data) return <Spinner />;
  const m = body.data;
  const isDecision = f.kind === "decision";

  if (name && m && !editing)
    return (
      <div>
        <div class="row" style={{ marginBottom: 6 }}>
          <b class="grow break">{name}</b>
          <button type="button" class="sm primary" onClick={() => setEditing(true)}>
            edit
          </button>
          <button type="button" class="sm" onClick={rename}>
            rename
          </button>
          <button
            type="button"
            class="sm"
            title="this memory in the knowledge graph"
            onClick={() => navigate("memory", { tab: "graph", focus: `memory:${name}` })}
          >
            graph
          </button>
          <button type="button" class="sm danger" onClick={remove}>
            delete
          </button>
        </div>
        <div class="muted small" style={{ marginBottom: 8 }}>
          {m.path} · created {m.created.slice(0, 10)} · updated {m.updated.slice(0, 10)}
        </div>
        <div class="row tight mem-refs" style={{ marginBottom: 12 }}>
          <MemTag m={m} />
          {m.tags.map((t) => (
            <span class="tag">#{t}</span>
          ))}
          {m.related.map((r) => (
            <RelatedRef value={r} />
          ))}
          {m.supersedes ? (
            <span class="muted small">
              supersedes <RelatedRef value={`mem:${m.supersedes}`} />
            </span>
          ) : null}
        </div>
        <Markdown source={m.body} />
      </div>
    );

  return (
    <div>
      <div class="row" style={{ marginBottom: 6 }}>
        <b class="grow break">{name ?? "New memory"}</b>
        {name ? (
          <>
            <span class="muted small">editing</span>
            <button type="button" class="sm" onClick={rename}>
              rename
            </button>
            <button type="button" class="sm danger" onClick={remove}>
              delete
            </button>
          </>
        ) : null}
      </div>
      {name && m ? (
        <div class="muted small" style={{ marginBottom: 8 }}>
          {m.path} · created {m.created.slice(0, 10)} · updated {m.updated.slice(0, 10)}
        </div>
      ) : (
        <div class="field">
          <label>name (topic/slug, optional — derived from kind + content)</label>
          <input
            type="text"
            placeholder="auth/session-tokens"
            value={f.name}
            onInput={set("name")}
          />
        </div>
      )}
      <div
        class="grid"
        style={{
          gridTemplateColumns: isDecision ? "1fr 1fr 2fr 2fr" : "1fr 2fr 2fr",
          gap: 8,
          marginBottom: 0,
        }}
      >
        <div class="field">
          <label>kind</label>
          <select value={f.kind} onChange={set("kind")}>
            {kinds.map((k) => (
              <option value={k}>{k}</option>
            ))}
          </select>
        </div>
        {isDecision && (
          <div class="field">
            <label>status</label>
            <select value={f.status} onChange={set("status")}>
              <option value="">accepted (default)</option>
              {statuses.map((s) => (
                <option value={s}>{s}</option>
              ))}
            </select>
          </div>
        )}
        <div class="field">
          <label>tags (comma separated)</label>
          <input type="text" value={f.tags} onInput={set("tags")} />
        </div>
        <div class="field">
          <label>related (file:path, sym:path#Name, mem:name)</label>
          <input type="text" value={f.related} onInput={set("related")} />
        </div>
      </div>
      {isDecision && (
        <div class="field">
          <label>
            supersedes (name of the decision this replaces; it is marked superseded on save)
          </label>
          <input
            type="text"
            placeholder="decision/old-approach"
            value={f.supersedes}
            onInput={set("supersedes")}
          />
        </div>
      )}
      <div class="field">
        <div class="row tight">
          <label class="grow">body (raw markdown)</label>
          <a class="small" onClick={() => setPreview(!preview)}>
            {preview ? "back to markdown" : "preview"}
          </a>
        </div>
        {preview ? (
          <Markdown class="preview" source={f.body.trim() ? f.body : "_Nothing to preview yet._"} />
        ) : (
          <textarea value={f.body} onInput={set("body")} onKeyDown={onKey} spellcheck={false} />
        )}
      </div>
      <div class="row">
        <button type="button" class="primary" disabled={busy} onClick={save}>
          {busy ? <Spinner /> : name ? "Save" : "Create"}
        </button>
        {name ? (
          <button type="button" disabled={busy} onClick={cancel}>
            Cancel
          </button>
        ) : null}
        <span class="muted small">⌘S / Ctrl+S saves{name ? ", Esc cancels" : ""}</span>
      </div>
    </div>
  );
}

function DecisionRecord({ rows }: { rows: MemoryRowUi[] }): JSX.Element {
  const groups = new Map<string, MemoryRowUi[]>();
  for (const r of rows)
    (
      groups.get(r.topic || "(no topic)") ??
      groups.set(r.topic || "(no topic)", []).get(r.topic || "(no topic)")!
    ).push(r);
  if (!rows.length)
    return (
      <EmptyState compact icon="◇" title="No accepted decisions yet">
        Record one with kind "decision", or ask Claude to em_remember it.
      </EmptyState>
    );
  return (
    <div class="stack">
      {[...groups.entries()].sort().map(([topic, list]) => (
        <Card title={topic}>
          {list.map((r) => (
            <div style={{ padding: "8px 0", borderBottom: "1px solid var(--line)" }}>
              <div class="row tight">
                <b>{r.name}</b>
                <MemTag m={r} />
                <span class="muted small">{day(r.updated_at)}</span>
                <span class="spacer" />
                <a class="small" onClick={() => navigate("memory", { name: r.name })}>
                  open
                </a>
              </div>
              {r.supersedes ? <div class="muted small">supersedes {r.supersedes}</div> : null}
              <div style={{ marginTop: 6, fontSize: 13 }}>
                <Markdown source={r.content} />
              </div>
            </div>
          ))}
        </Card>
      ))}
    </div>
  );
}

export function Memory({ params }: { params: Record<string, string> }): JSX.Element {
  const [tab, setTab] = useState<string>(
    params.name?.startsWith("decision/") ? "decision" : (params.tab ?? "all"),
  );
  const [sel, setSel] = useState<string | null>(params.name ?? null);
  const [creating, setCreating] = useState(false);
  const [filter, setFilter] = useState("");
  const [status, setStatus] = useState("");
  const q = useAsync(() => api<MemoryList>("/api/memories"), []);
  useEffect(() => {
    if (params.name) {
      setSel(params.name);
      setCreating(false);
      // "Open memory" from the graph lands on the list that shows it.
      setTab((t) =>
        t === "graph" || t === "record"
          ? params.name!.startsWith("decision/")
            ? "decision"
            : "all"
          : t,
      );
    }
  }, [params.name]);
  // A hash-only change (#/memory?tab=graph&focus=…) does not remount the view.
  useEffect(() => {
    if (params.tab) setTab(params.tab);
  }, [params.tab]);
  useEffect(() => {
    if (q.data?.gitignored)
      toast(`.gitignore keeps ${q.data.dir} out of git; memories stay local`, true);
    if (q.data?.skipped.length)
      toast(`skipped invalid memory files: ${q.data.skipped.join(", ")}`, true);
  }, [q.data]);
  const rows = useMemo(() => {
    const all = q.data?.memories ?? [];
    const f = filter.trim().toLowerCase();
    return all.filter(
      (m) =>
        (tab === "all" || tab === "record" || m.kind === tab) &&
        (!status || (m.status ?? "accepted") === status) &&
        (!f ||
          m.name.includes(f) ||
          m.tags.some((t) => t.includes(f)) ||
          m.content.toLowerCase().includes(f)),
    );
  }, [q.data, tab, filter, status]);
  if (q.error)
    return (
      <div class="page">
        <ErrorBox error={q.error} />
      </div>
    );
  const d = q.data;
  const tabs: Array<[string, string]> = [
    ["all", "All"],
    ...(d?.kinds ?? []).map((k) => [k, k] as [string, string]),
    ["record", "Decision record"],
    ["graph", "Graph"],
  ];
  return (
    <div class="page ds-page mem-page">
      <Hero
        eyebrow="Memory"
        title="Project memory"
        sub="Decisions, constraints and facts Claude recalls across sessions."
        meta={
          d ? (
            <>
              <Badge tone="accent">{d.memories.length} memories</Badge>
              <Badge tone="purple">
                {d.memories.filter((m) => m.kind === "decision").length} decisions
              </Badge>
            </>
          ) : null
        }
      />
      <Segmented
        label="Memory views"
        options={tabs.map(([id, label]) => ({ id, label }))}
        value={tab}
        onChange={(t) => {
          setTab(t);
          if (t !== "decision") setStatus("");
          if (t === "graph" || params.tab) navigate("memory", { tab: t });
        }}
      />
      {tab === "graph" ? (
        <KnowledgeGalaxy scope="memory" focus={params.focus} />
      ) : tab === "record" ? (
        <DecisionRecord
          rows={(d?.memories ?? []).filter(
            (m) => m.kind === "decision" && (m.status ?? "accepted") === "accepted",
          )}
        />
      ) : (
        <>
          <div class="row mem-toolbar" style={{ marginBottom: 12 }}>
            <button
              type="button"
              class="primary"
              onClick={() => {
                setCreating(true);
                setSel(null);
              }}
            >
              + New memory
            </button>
            <input
              type="search"
              class="grow mem-filter"
              placeholder="filter by name, tag or text…"
              value={filter}
              onInput={(e) => setFilter((e.target as HTMLInputElement).value)}
            />
            {tab === "decision" && (
              <select
                value={status}
                onChange={(e) => setStatus((e.target as HTMLSelectElement).value)}
              >
                <option value="">any status</option>
                {(d?.statuses ?? []).map((s) => (
                  <option value={s}>{s}</option>
                ))}
              </select>
            )}
            <button
              type="button"
              title="re-import files edited by hand"
              onClick={async () => {
                const r = await post<{ ok: boolean; output: string }>("/api/actions", {
                  action: "reconcile",
                });
                toast(r.output, !r.ok);
                q.reload();
              }}
            >
              ↻ Reconcile
            </button>
            <span class="muted small">
              {rows.length} of {d?.memories.length ?? 0}
            </span>
          </div>
          <div
            class="grid wide"
            style={{ gridTemplateColumns: "minmax(280px,1fr) minmax(0,2fr)", alignItems: "start" }}
          >
            <Card flush>
              <div class="list">
                {!d ? (
                  <EmptyState compact icon="…" title="Loading memories">
                    <Spinner />
                  </EmptyState>
                ) : rows.length ? (
                  rows.map((m) => (
                    <div
                      class={cls("item", sel === m.name && "sel")}
                      onClick={() => {
                        setSel(m.name);
                        setCreating(false);
                      }}
                    >
                      <div class="n">{m.name}</div>
                      <div class="p">
                        <MemTag m={m} />
                        <span class="muted">
                          {day(m.updated_at)} · {fmt(m.size ?? 0)}B
                        </span>
                      </div>
                      <div class="p">{firstLine(m.content)}</div>
                    </div>
                  ))
                ) : (
                  <EmptyState compact icon="○" title="No memories match" />
                )}
              </div>
            </Card>
            <Card>
              {creating || sel ? (
                <Detail
                  name={creating ? null : sel}
                  kinds={d?.kinds ?? []}
                  statuses={d?.statuses ?? []}
                  onSaved={(n) => {
                    setCreating(false);
                    setSel(n);
                    q.reload();
                  }}
                  onDeleted={() => {
                    setSel(null);
                    q.reload();
                  }}
                />
              ) : (
                <EmptyState compact icon="◇" title="Select a memory">
                  or create a new one.
                </EmptyState>
              )}
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
