import type { JSX } from "preact";
import { useMemo, useState } from "preact/hooks";
import { api, post } from "../api.js";
import { ErrorBox, KV, Spinner, toast, useAsync, useSort } from "../components.js";
import {
  Badge,
  Card,
  EmptyState,
  GradientText,
  Hero,
  Skeleton,
  Stat,
  StatRow,
  type Tone,
} from "../ds.js";
import { navigate } from "../router.js";
import { ago, fmt } from "../util.js";

interface CoverageFile {
  path: string;
  status: string;
  reason: string | null;
  language: string | null;
  symbols: number | null;
  size: number | null;
  indexed_at: number;
  errors: string | null;
}
interface Coverage {
  summary: {
    byStatus: Record<string, number>;
    reasons: Array<{ reason: string; n: number }>;
    lastIndexedAt: number | null;
  };
  freshness: {
    head?: string;
    indexedHead?: string;
    headMatches: boolean;
    queued: number;
    dirty: string[];
    lastRun: number | null;
  };
  scan: {
    at?: number;
    scanned?: number;
    durationMs?: number;
    include?: string[];
    exclude?: string[];
  } | null;
  files: CoverageFile[];
}

const STATUS_TONE: Record<string, Tone> = {
  indexed: "ok",
  partial: "warn",
  skipped: "bad",
  unsupported: "muted",
};

export function Coverage(): JSX.Element {
  const q = useAsync(() => api<Coverage>("/api/coverage"), []);
  const [status, setStatus] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const rows = useMemo(() => {
    const f = text.trim().toLowerCase();
    return (q.data?.files ?? []).filter(
      (r) =>
        (!status || r.status === status) &&
        (!f || r.path.toLowerCase().includes(f) || (r.reason ?? "").toLowerCase().includes(f)),
    );
  }, [q.data, status, text]);
  const { sorted, th } = useSort(rows, "path", false);
  const run = async (label: string, body: Record<string, unknown>) => {
    setBusy(label);
    try {
      const r = await post<{ ok: boolean; output: string }>("/api/actions", body);
      toast(r.output.split("\n")[0] ?? "done", !r.ok);
      q.reload();
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(null);
    }
  };
  if (q.error)
    return (
      <div class="page ds-page">
        <ErrorBox error={q.error} onRetry={q.reload} />
      </div>
    );
  const d = q.data;
  if (!d)
    return (
      <div class="page ds-page" role="status" aria-busy="true">
        <Hero title={<Skeleton w="min(320px, 70%)" h={34} />} sub={<Skeleton w={220} h={14} />} />
        <StatRow>
          {[0, 1, 2, 3].map((k) => (
            <div class="ds-stat" key={k}>
              <Skeleton w={80} h={11} />
              <Skeleton w={100} h={28} />
              <Skeleton w={130} h={11} />
            </div>
          ))}
        </StatRow>
        <Skeleton h={120} />
      </div>
    );
  const b = d.summary.byStatus;
  const total = Object.values(b).reduce((a, n) => a + n, 0);
  const fresh = d.freshness.headMatches && !d.freshness.dirty.length && !d.freshness.queued;
  const freshLabel = fresh
    ? "fresh"
    : d.freshness.dirty.length || d.freshness.queued
      ? "stale"
      : "git behind";
  const cards: Array<[string, number, string]> = [
    ["indexed", b.indexed ?? 0, "parsed into the graph and search"],
    ["partial", b.partial ?? 0, "indexed, syntax errors recovered"],
    ["skipped", b.skipped ?? 0, "too large or parser error"],
    ["unsupported", b.unsupported ?? 0, "matched by globs, no parser"],
  ];
  const gaps = (b.partial ?? 0) + (b.skipped ?? 0) + (b.unsupported ?? 0);
  return (
    <div class="page ds-page cv-page">
      <Hero
        eyebrow="Index coverage"
        title={
          total ? (
            <>
              <GradientText>{fmt(b.indexed ?? 0)}</GradientText> of {fmt(total)} files indexed
            </>
          ) : (
            "No files scanned yet"
          )
        }
        sub={
          total
            ? gaps
              ? `${fmt(gaps)} file${gaps === 1 ? "" : "s"} partly or not indexed. Pick a status below to filter the list.`
              : "Every matched file is in the graph and search index."
            : "Run a code reindex and the coverage report shows up here."
        }
        meta={
          <Badge tone={fresh ? "ok" : "warn"} dot>
            {freshLabel}
          </Badge>
        }
        aside={
          <>
            <button
              type="button"
              disabled={!!busy}
              onClick={() => run("code", { action: "reindex", scope: "code" })}
            >
              {busy === "code" ? <Spinner /> : "Reindex code"}
            </button>
            <button
              type="button"
              disabled={!!busy}
              onClick={() => run("full", { action: "reindex", scope: "code", full: true })}
            >
              {busy === "full" ? <Spinner /> : "Full reindex"}
            </button>
          </>
        }
      />
      <StatRow>
        {cards.map(([k, n, sub]) => (
          <Stat
            label={k}
            value={n}
            tone={k === "skipped" && n > 0 ? "bad" : k === "partial" && n > 0 ? "warn" : undefined}
            sub={status === k ? `${sub} · filtering` : sub}
            title={status === k ? `show all files` : `show only ${k} files`}
            onClick={() => setStatus(status === k ? "" : k)}
          />
        ))}
        <Stat
          label="freshness"
          value={freshLabel}
          tone={fresh ? "ok" : "warn"}
          sub={`${d.freshness.dirty.length} changed · ${d.freshness.queued} queued`}
        />
      </StatRow>
      <div class="ds-grid main-side">
        <Card flush title="Files" right={`${sorted.length} of ${total}`}>
          <div class="row cv-filter">
            <input
              type="search"
              class="grow"
              placeholder="filter by path or reason…"
              value={text}
              onInput={(e) => setText((e.target as HTMLInputElement).value)}
            />
            <select
              value={status}
              onChange={(e) => setStatus((e.target as HTMLSelectElement).value)}
            >
              <option value="">any status</option>
              {["indexed", "partial", "skipped", "unsupported"].map((s) => (
                <option value={s}>{s}</option>
              ))}
            </select>
          </div>
          <div class="ds-table-wrap cv-files">
            <table>
              <thead>
                <tr>
                  {th("path", "path")}
                  {th("status", "status")}
                  {th("reason", "reason")}
                  {th("symbols", "symbols", true)}
                  {th("size", "size", true)}
                  {th("indexed_at", "indexed", true)}
                  <th />
                </tr>
              </thead>
              <tbody>
                {sorted.length ? (
                  sorted.slice(0, 500).map((r) => (
                    <tr>
                      <td class="break">
                        <a onClick={() => navigate("explore", { file: r.path })}>{r.path}</a>
                      </td>
                      <td>
                        <Badge tone={STATUS_TONE[r.status] ?? "muted"}>{r.status}</Badge>
                      </td>
                      <td class="muted small">
                        {r.reason ?? ""}
                        {r.errors ? <div class="bad small">{r.errors.slice(0, 160)}</div> : null}
                      </td>
                      <td class="num">{r.symbols ?? ""}</td>
                      <td class="num">{fmt(r.size ?? 0)}</td>
                      <td class="num muted small">{ago(r.indexed_at)}</td>
                      <td>
                        <button
                          type="button"
                          class="sm"
                          disabled={!!busy}
                          onClick={() =>
                            run(r.path, {
                              action: "reindex",
                              scope: "code",
                              paths: [r.path],
                            })
                          }
                        >
                          {busy === r.path ? <Spinner /> : "reindex"}
                        </button>
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={7}>
                      <EmptyState
                        compact
                        icon="∅"
                        title={total ? "No files match" : "No files yet"}
                      >
                        {total
                          ? "Change the filter or status to see more files."
                          : "Nothing has been scanned. Run a code reindex."}
                      </EmptyState>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </Card>
        <div class="cv-side">
          <Card title="Index state">
            <KV
              rows={[
                ["HEAD", d.freshness.head?.slice(0, 10) ?? "no git"],
                [
                  "git signals at",
                  d.freshness.indexedHead
                    ? `${d.freshness.indexedHead.slice(0, 10)}${d.freshness.headMatches ? " (current)" : " (behind)"}`
                    : "never",
                ],
                ["last run", d.freshness.lastRun ? ago(d.freshness.lastRun) : "never"],
                ["queued", String(d.freshness.queued)],
                [
                  "last scan",
                  d.scan?.at
                    ? `${ago(d.scan.at)} · ${d.scan.scanned} files · ${d.scan.durationMs} ms`
                    : "n/a",
                ],
              ]}
            />
          </Card>
          {d.freshness.dirty.length ? (
            <Card title="Changed since indexed" right={d.freshness.dirty.length}>
              <div class="list cv-dirty">
                {d.freshness.dirty.map((p) => (
                  <div class="item" onClick={() => navigate("explore", { file: p })}>
                    <div class="p">{p}</div>
                  </div>
                ))}
              </div>
              <button
                type="button"
                class="sm"
                style={{ marginTop: 6 }}
                disabled={!!busy}
                onClick={() =>
                  run("dirty", {
                    action: "reindex",
                    scope: "code",
                    paths: d.freshness.dirty,
                  })
                }
              >
                {busy === "dirty" ? <Spinner /> : "Reindex changed files"}
              </button>
            </Card>
          ) : null}
          {d.summary.reasons.length ? (
            <Card flush title="Why files are not fully indexed">
              <div class="ds-table-wrap">
                <table>
                  <tbody>
                    {d.summary.reasons.map((r) => (
                      <tr class="click" onClick={() => setText(r.reason)}>
                        <td>{r.reason}</td>
                        <td class="num">{r.n}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          ) : null}
          <Card title="Scope">
            <div class="small">
              <div class="muted">include</div>
              <div class="mono break">{(d.scan?.include ?? []).join("  ") || "(defaults)"}</div>
              <div class="muted" style={{ marginTop: 4 }}>
                exclude
              </div>
              <div class="mono break">{(d.scan?.exclude ?? []).join("  ") || "(defaults)"}</div>
              <div class="muted" style={{ marginTop: 6 }}>
                Change them in eminiar.config.json under graph.include / graph.exclude. A clean
                coverage result means no recorded gap, not proof of completeness.
              </div>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
