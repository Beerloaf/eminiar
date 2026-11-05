// The Configuration Studio (#/swarm/config?swarm=<name>&role=<role>&tab=settings): a visual
// editor for .eminiar/swarm.yaml. The draft is the structured SwarmDoc of the file (or its raw
// text); every change is re-validated on the server after 350 ms (POST /api/swarm/config/
// validate renders it onto the file as it is, keeping comments, and runs the real validator),
// and Save writes it atomically against the hash it was loaded with (409 on a conflict).
// Mounted by Swarm.tsx under the shared SwarmNav; reads GET /api/swarm/config and /templates.
import type { JSX } from "preact";
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import {
  ApiError,
  fetchSwarmConfig,
  fetchSwarmTemplates,
  type SwarmConfigDoc,
  type SwarmConfigDraft,
  type SwarmConfigValidation,
  type SwarmIssue,
  type SwarmOverview,
  type SwarmTemplateUi,
  saveSwarmConfig,
  validateSwarmConfig,
} from "../api.js";
import { ErrorBox, toast } from "../components.js";
import { Badge, Card, Drawer, EmptyState, Skeleton } from "../ds.js";
import { navigate, setLeaveGuard } from "../router.js";
import {
  addRole,
  addSwarm,
  capacity,
  type Draft,
  deleteRole,
  deleteSwarm,
  docEqual,
  docFromTemplate,
  duplicateRole,
  duplicateSwarm,
  issuesUnder,
  rawEntry,
  renameRole,
  renameSwarm,
  type StaleReason,
  type SwarmDoc,
  setIn,
  studioDirty,
  uniqueName,
} from "../swarm/config/draft.js";
import { RoleDrawer } from "../swarm/config/RoleDrawer.js";
import { SettingsPanel } from "../swarm/config/SettingsPanel.js";
import { SwarmEditor } from "../swarm/config/SwarmEditor.js";
import { TemplateGallery } from "../swarm/config/TemplateGallery.js";
import { IssueList, type YamlMode, YamlPane } from "../swarm/config/YamlPane.js";
import { GLYPH, TOPOLOGY_GLYPH } from "../swarm/style.js";
import { cls } from "../util.js";

const VALIDATE_DEBOUNCE_MS = 350;
const PREF_YAML = "eminiar.swarmcfg.yaml";
const LEAVE_MSG =
  "Leave the Configuration Studio? Your unsaved changes to the swarm file will be lost.";

const RELOAD_MSG =
  "Reload the swarm file from disk? Your unsaved changes in the studio will be lost.";

/** The confirm before Raw YAML opens a render that predates the latest form edits. */
function staleRawMsg(reason: StaleReason): string {
  const why =
    reason === "conflict"
      ? "The swarm file changed on disk, so your latest form edits cannot be rendered as YAML."
      : reason === "render"
        ? "Your latest form edits cannot be written as YAML."
        : "Your latest form edits could not be checked.";
  return `${why} Raw YAML opens the last version that rendered, without those edits: they will not carry over to the text (the form keeps them until you save or revert). Open the raw YAML anyway?`;
}

function pref(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === "1";
  } catch {
    return fallback;
  }
}
function setPref(key: string, v: boolean): void {
  try {
    localStorage.setItem(key, v ? "1" : "0");
  } catch {
    // private mode: the preference just does not stick
  }
}

/** The file on disk the draft is based on. */
interface Base {
  text: string | null;
  hash: string | null;
  doc: SwarmDoc | null;
}

/** Why the last validate or save did not go through. */
type Failure =
  | { kind: "conflict"; message: string; current: { text: string; hash: string } | null }
  | { kind: "render"; message: string; locked: string[] }
  | { kind: "invalid"; message: string; issues: SwarmIssue[] }
  | { kind: "error"; message: string };

function failureOf(e: unknown): Failure {
  const message = (e as Error).message ?? String(e);
  if (e instanceof ApiError) {
    const b = (e.body ?? {}) as {
      current?: { text: string; hash: string } | null;
      issues?: SwarmIssue[];
      locked?: string[];
    };
    if (e.status === 409) return { kind: "conflict", message, current: b.current ?? null };
    if (e.status === 422) return { kind: "render", message, locked: b.locked ?? [] };
    if (e.status === 400) return { kind: "invalid", message, issues: b.issues ?? [] };
  }
  return { kind: "error", message };
}

/** What validate and save send, minus the hash. */
type Body = Omit<SwarmConfigDraft, "baseHash">;

interface Check {
  pending: boolean;
  /** The last good render; after a failure it predates the draft. */
  result?: SwarmConfigValidation;
  failure?: Failure;
  /** The body the last settled check (result or failure) was of. */
  of?: Body;
  /** The visual draft `result` was rendered from: "Undo" after a 422 goes back to it. */
  good?: Draft;
}

/** `swarms.feature.agents.coder.model` → where the form shows it. */
function fieldOf(path: string): { swarm?: string; role?: string; settings?: boolean } {
  const p = path.split(".");
  if (p[0] === "swarms" && p[1])
    return p[2] === "agents" && p[3] ? { swarm: p[1], role: p[3] } : { swarm: p[1] };
  return { settings: true };
}

// --- loading --------------------------------------------------------------------------

function StudioSkeleton(): JSX.Element {
  return (
    <div class="swc" role="status" aria-busy="true" aria-label="loading the swarm file">
      <Skeleton h={52} class="swc-skel-card" />
      <div class="swc-layout">
        <aside class="swc-rail">
          <Skeleton h={64} class="swc-skel-card" />
          <Skeleton h={88} class="swc-skel-card" />
          <Skeleton h={88} class="swc-skel-card" />
        </aside>
        <section class="swc-main">
          <Skeleton h={190} class="swc-skel-card" />
          <Skeleton h={240} class="swc-skel-card" />
          <Skeleton h={320} class="swc-skel-card" />
        </section>
      </div>
    </div>
  );
}

// --- the studio -----------------------------------------------------------------------

export function SwarmConfig({
  o,
  params,
  onChanged,
}: {
  /** GET /api/swarm, for the agent-file sync state. */
  o: SwarmOverview | undefined;
  params: Record<string, string>;
  /** Re-read the overview (the SwarmNav badges, the run dashboard) after a save. */
  onChanged: () => void;
}): JSX.Element {
  const [cfg, setCfg] = useState<SwarmConfigDoc>();
  const [loadError, setLoadError] = useState<string>();
  const [base, setBase] = useState<Base>({ text: null, hash: null, doc: null });
  const [draft, setDraft] = useState<Draft | null>(null);
  /** The raw YAML being edited, or null in the visual editor. */
  const [raw, setRaw] = useState<string | null>(null);
  /** The text raw mode started from: leaving raw mode is free while it is unchanged. */
  const rawFrom = useRef<string | null>(null);
  const [check, setCheck] = useState<Check>({ pending: false });
  const [saving, setSaving] = useState(false);
  /** What had focus when the save started; `inert` takes it away while saving. */
  const focusBack = useRef<HTMLElement | null>(null);
  /** Raw YAML is waiting for a render of the current draft. */
  const [opening, setOpening] = useState(false);
  const [conflict, setConflict] = useState<Failure & { kind: "conflict" }>();
  /** The last save failed in transport or on the server (a 500, the network). It says
   * nothing about the draft, so it never blocks Save or dims the preview the way a 400/422
   * in check.failure does; `sync` is what Retry repeats. */
  const [saveError, setSaveError] = useState<{ message: string; sync: boolean }>();
  /** Bumped by "Check again" after a validate request failed in transport. */
  const [recheck, setRecheck] = useState(0);
  const [templates, setTemplates] = useState<SwarmTemplateUi[]>();
  const [tplError, setTplError] = useState<string>();
  const [gallery, setGallery] = useState(false);
  const [yamlOpen, setYamlOpen] = useState(() => pref(PREF_YAML, true));
  const seq = useRef(0);

  /** Start over from the file as read (discarding the draft). `keepRaw` stays in Raw YAML,
   * on the new text, when the studio is in it. */
  const adopt = useCallback((c: SwarmConfigDoc, keepRaw: boolean) => {
    setCfg(c);
    setLoadError(undefined);
    setBase({ text: c.text, hash: c.hash, doc: c.doc });
    setDraft(c.doc ? { doc: c.doc, renames: [] } : null);
    const rawOnly = c.state !== "absent" && !c.doc;
    const toRaw = rawOnly || (keepRaw && c.text !== null);
    setRaw(toRaw ? (c.text ?? "") : null);
    rawFrom.current = toRaw ? c.text : null;
    setConflict(undefined);
    setSaveError(undefined);
    setCheck({ pending: false });
  }, []);

  /** Read the file and start over from it (discarding the draft). */
  const load = useCallback(async (): Promise<SwarmConfigDoc | undefined> => {
    try {
      const c = await fetchSwarmConfig();
      adopt(c, false);
      return c;
    } catch (e) {
      setLoadError((e as Error).message);
      return undefined;
    }
  }, [adopt]);

  useEffect(() => {
    void load();
    fetchSwarmTemplates().then(
      (r) => setTemplates(r.templates),
      (e: Error) => setTplError(e.message),
    );
  }, []);

  const rawOnly = !!cfg && cfg.state !== "absent" && !base.doc;
  const rawMode = raw !== null;
  /** The visual draft differs from the file; it is kept (and counts) in raw mode too. */
  const visualDirty =
    !!draft && (base.hash === null || draft.renames.length > 0 || !docEqual(draft.doc, base.doc));
  const dirty = studioDirty({ raw, baseText: base.text, visual: visualDirty });

  // --- live validation ---
  const body = useMemo<Body | null>(
    () =>
      raw !== null ? { text: raw } : draft ? { doc: draft.doc, renames: draft.renames } : null,
    [raw, draft],
  );
  useEffect(() => {
    if (!body || conflict) return;
    const my = ++seq.current;
    setCheck((c) => ({ ...c, pending: true }));
    const t = setTimeout(async () => {
      try {
        const r = await validateSwarmConfig({ ...body, baseHash: base.hash });
        if (my === seq.current)
          setCheck({
            pending: false,
            result: r,
            of: body,
            ...(raw === null && draft ? { good: draft } : {}),
          });
      } catch (e) {
        if (my !== seq.current) return;
        const f = failureOf(e);
        if (f.kind === "conflict") setConflict(f);
        // The last good render (and the draft it is of) stays, for the preview and for Undo.
        setCheck((c) => ({ ...c, pending: false, failure: f, of: body }));
      }
    }, VALIDATE_DEBOUNCE_MS);
    return () => clearTimeout(t);
    // raw and draft are what body is made of; listed so the closure reads the matching pair.
  }, [body, base.hash, conflict, raw, draft, recheck]);

  const result = check.result;
  const issues: SwarmIssue[] =
    check.failure?.kind === "invalid"
      ? check.failure.issues
      : (result?.issues ?? cfg?.issues ?? []);
  const warnings = result?.warnings ?? cfg?.warnings ?? [];
  const locked = result?.locked ?? cfg?.locked ?? [];
  const blocked = !!check.failure && check.failure.kind !== "conflict";
  const valid = !!result && result.ok && !check.pending && !blocked;
  const canSave = !!body && dirty && valid && !saving && !conflict;
  // Not gated on o.enabled: with `enabled: false` the sync is what removes the agent files.
  const syncOnly = !dirty && !!o?.syncNeeded && !saving && !conflict && !!body;
  /** The file says `enabled: false`: a sync only removes the generated agent files. Read from
   * the file the studio shows (the overview can be a poll ahead of it until it follows). */
  const disabledOnDisk = base.doc ? base.doc.enabled === false : !!o && !o.enabled;

  // --- save ---
  const save = useCallback(
    async (sync: boolean) => {
      if (!body || (!canSave && !(sync && syncOnly))) return;
      const a = document.activeElement;
      focusBack.current = a instanceof HTMLElement && a !== document.body ? a : null;
      setSaving(true);
      setSaveError(undefined);
      try {
        // A sync with a clean draft acts on the file as the studio shows it: when the file
        // changed on disk since (the overview may already label the button from the new
        // state), show the new file first instead of running into a 409.
        if (!dirty) {
          const c = await fetchSwarmConfig().catch(() => undefined);
          if (c && c.hash !== base.hash) {
            adopt(c, raw !== null);
            onChanged();
            toast(
              "the swarm file changed on disk; the studio now shows it. Check it and press again",
            );
            return;
          }
        }
        const r = await saveSwarmConfig({ ...body, baseHash: base.hash, sync });
        const s = r.sync;
        toast(
          [
            r.saved
              ? r.created
                ? "created the swarm file"
                : `saved ${r.changed.length} changed line(s)`
              : "no changes to save",
            s
              ? `${s.changed} agent file(s) synced${s.conflicts ? `, ${s.conflicts} conflict(s) left alone` : ""}`
              : null,
          ]
            .filter(Boolean)
            .join(" · "),
          !!s?.conflicts,
        );
        await load();
        onChanged();
      } catch (e) {
        const f = failureOf(e);
        if (f.kind === "conflict") setConflict(f);
        // A 500 or a network error is about the request, not the draft: the draft stays
        // valid and saveable (Retry), and the badge and the preview keep the last check.
        else if (f.kind === "error") setSaveError({ message: f.message, sync });
        else setCheck((c) => ({ ...c, failure: f, of: body }));
        toast(`save failed: ${f.message}`, true);
      } finally {
        setSaving(false);
      }
    },
    [body, base.hash, canSave, syncOnly, dirty, raw, adopt, load, onChanged],
  );

  // While saving, the layout and the drawers are `inert`, which drops focus to <body>. When
  // they lift, focus goes back where it was (the field typed in, also inside the role drawer
  // after Cmd-S), unless something else took focus meanwhile.
  useEffect(() => {
    if (saving) return;
    const was = focusBack.current;
    focusBack.current = null;
    if (!was) return;
    const now = document.activeElement;
    if (now && now !== document.body && now !== was) return;
    // A save re-reads the file; a field that was re-mounted is found again by its id.
    const el = was.isConnected ? was : was.id ? document.getElementById(was.id) : null;
    if (!el || el.closest("[inert]") || (el as HTMLButtonElement).disabled) return;
    el.focus({ preventScroll: true });
  }, [saving]);

  // Cmd/Ctrl-S saves.
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void saveRef.current(false);
      }
    };
    document.addEventListener("keydown", on);
    return () => document.removeEventListener("keydown", on);
  }, []);

  // --- unsaved-changes guard: closing the tab, and leaving #/swarm/config ---
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  useEffect(() => {
    const unload = (e: BeforeUnloadEvent) => {
      if (!dirtyRef.current) return;
      e.preventDefault();
      e.returnValue = "";
    };
    // The router asks before it re-renders, so the studio is still mounted when it decides
    // (a hashchange listener of its own would be removed by that re-render first).
    const unguard = setLeaveGuard(
      (to) =>
        !dirtyRef.current ||
        (to.view === "swarm" && to.sub === "config") ||
        window.confirm(LEAVE_MSG),
    );
    window.addEventListener("beforeunload", unload);
    return () => {
      unguard();
      window.removeEventListener("beforeunload", unload);
    };
  }, []);

  // --- conflict ---
  const keepMine = useCallback(async () => {
    try {
      const c = await fetchSwarmConfig();
      setCfg(c);
      setBase({ text: c.text, hash: c.hash, doc: c.doc });
      // Renames named the old file's keys; against the new one the difference is written.
      setDraft((d) => (d ? { doc: d.doc, renames: [] } : d));
      setConflict(undefined);
      setSaveError(undefined);
      setCheck({ pending: false });
      toast(
        c.hash === null
          ? "the file is gone on disk; saving now creates it again from your draft"
          : "rebased your draft on the file on disk; saving now overwrites the other change",
      );
    } catch (e) {
      toast(`could not read the file: ${(e as Error).message}`, true);
    }
  }, []);

  /** "Reload from disk" drops the draft: ask first when there is one. */
  const reload = () => {
    if (dirtyRef.current && !window.confirm(RELOAD_MSG)) return;
    void load();
  };

  // --- selection (from the hash) ---
  const doc = draft?.doc;
  const names = doc ? Object.keys(doc.swarms) : [];
  const tab = params.tab === "settings" ? "settings" : "swarm";
  const selName =
    tab === "swarm"
      ? params.swarm && doc?.swarms[params.swarm]
        ? params.swarm
        : names[0]
      : undefined;
  const sel = selName && doc ? doc.swarms[selName] : undefined;
  const roleName = sel && params.role && sel.agents[params.role] ? params.role : undefined;
  const go = (p: {
    swarm?: string | undefined;
    role?: string | undefined;
    tab?: string | undefined;
  }) => navigate("swarm/config", p);

  const update = (fn: (d: Draft) => Draft) => setDraft((d) => (d ? fn(d) : d));
  const updateDoc = (fn: (d: SwarmDoc) => SwarmDoc) => update((d) => ({ ...d, doc: fn(d.doc) }));

  // Raw YAML opens a render of the current draft, never an older one without asking: result
  // lags the draft while validation is pending, and after a 422, a 409 or an error.
  const live = useRef({ body, draft, base, visualDirty, check, conflict, rawMode, saving });
  live.current = { body, draft, base, visualDirty, check, conflict, rawMode, saving };

  // A clean studio follows the file on disk: on every overview poll (which can already show
  // a new on-disk state, e.g. `enabled: false` relabelling the sync button), re-read the file
  // and take it over when it changed. A draft with edits is never replaced; its save gets the
  // 409 and the conflict banner instead.
  const followSeq = useRef(0);
  useEffect(() => {
    const s = live.current;
    if (!o || !cfg || dirtyRef.current || s.saving || s.conflict || opening) return;
    const my = ++followSeq.current;
    fetchSwarmConfig().then(
      (c) => {
        const n = live.current;
        // Only the newest read counts, and only while nothing moved meanwhile (an edit, a
        // save, a reload: each changes the body or the base).
        if (my !== followSeq.current || dirtyRef.current || n.saving || n.conflict) return;
        if (n.body !== s.body || n.base !== s.base || c.hash === n.base.hash) return;
        adopt(c, n.rawMode);
      },
      () => {
        // the next poll tries again
      },
    );
  }, [o]);

  const openRaw = (t: string) => {
    rawFrom.current = t;
    setRaw(t);
  };
  const toRaw = async () => {
    if (opening) return;
    // A few tries: the draft can change while its render is on the way.
    for (let attempt = 0; attempt < 3; attempt++) {
      const s = live.current;
      if (s.rawMode || s.saving || !s.body) return;
      const current = s.check.of === s.body;
      const entry = rawEntry({
        dirty: s.visualDirty,
        current,
        failure: current ? s.check.failure?.kind : undefined,
        conflict: !!s.conflict,
      });
      const lastGood = s.check.result?.text ?? s.base.text ?? "";
      if (entry.kind === "base") return openRaw(s.base.text ?? "");
      if (entry.kind === "render") return openRaw(s.check.result?.text ?? lastGood);
      if (entry.kind === "stale") {
        if (window.confirm(staleRawMsg(entry.reason))) openRaw(lastGood);
        return;
      }
      setOpening(true);
      try {
        const r = await validateSwarmConfig({ ...s.body, baseHash: s.base.hash });
        if (live.current.body !== s.body) continue;
        setCheck({ pending: false, result: r, of: s.body, ...(s.draft ? { good: s.draft } : {}) });
        return openRaw(r.text);
      } catch (e) {
        if (live.current.body !== s.body) continue;
        const f = failureOf(e);
        if (f.kind === "conflict") setConflict(f);
        setCheck((c) => ({ ...c, pending: false, failure: f, of: s.body! }));
        if (window.confirm(staleRawMsg(f.kind))) openRaw(lastGood);
        return;
      } finally {
        setOpening(false);
      }
    }
    toast("the draft kept changing; open Raw YAML again", true);
  };
  const toVisual = () => {
    if (
      raw !== null &&
      raw !== rawFrom.current &&
      !window.confirm("Discard your raw YAML edits and go back to the visual editor?")
    )
      return;
    setRaw(null);
    rawFrom.current = null;
  };
  const showYaml = (on: boolean) => {
    setYamlOpen(on);
    setPref(PREF_YAML, on);
  };
  const jump = (path: string) => {
    const f = fieldOf(path);
    if (f.settings) go({ tab: "settings" });
    else go({ swarm: f.swarm, role: f.role });
  };

  // --- render ---
  if (!cfg)
    return loadError ? (
      <Card>
        <ErrorBox error={loadError} />
        <button type="button" class="sm" onClick={() => void load()}>
          Retry
        </button>
      </Card>
    ) : (
      <StudioSkeleton />
    );

  // No swarm file and no draft yet: the onboarding.
  if (cfg.state === "absent" && !draft)
    return (
      <div class="swc">
        <section class="ds-hero swc-onboard">
          <div class="ds-hero-main">
            <div class="ds-eyebrow">Configuration Studio · not opted in</div>
            <h1 class="ds-hero-title">Design your first agent swarm</h1>
            <div class="ds-hero-sub">
              Swarms are off for this project: there is no <code>{cfg.file}</code> yet, so no agent
              files are written and no hook does swarm work. Pick a template (or the annotated
              starter), shape the roles, models and topology, and save to opt in.
            </div>
            <div class="ds-hero-meta">
              {cfg.starter ? (
                <button
                  type="button"
                  class="primary"
                  onClick={() => {
                    setDraft({ doc: cfg.starter!, renames: [] });
                    go({});
                  }}
                >
                  Start from the annotated starter
                </button>
              ) : null}
              <span class="small muted">or choose a template below</span>
            </div>
          </div>
          <div class="ds-hero-aside swc-onboard-glyphs" aria-hidden="true">
            {(["hierarchical", "mesh", "pipeline"] as const).map((t) => (
              <span>{TOPOLOGY_GLYPH[t]}</span>
            ))}
          </div>
        </section>
        <Card title="Templates" sub="a ready-made team you can reshape" raised>
          <TemplateGallery
            templates={templates}
            error={tplError}
            taken={[]}
            action="Create"
            onCreate={(name, t) => {
              setDraft({ doc: docFromTemplate(name, t.swarm), renames: [] });
              go({ swarm: name });
            }}
          />
        </Card>
      </div>
    );

  const meta = cfg.meta;
  const activeRuns = cfg.activeRuns;
  const nIssues = issues.length;
  const nWarn = warnings.length;
  const failure = check.failure;
  /** Why the last render no longer describes the draft (validation is paused or failed). */
  const staleWhy = conflict
    ? `not checked: the file was ${conflict.current ? "changed" : "removed"} on disk`
    : blocked
      ? failure?.kind === "render"
        ? "out of date: the latest edit cannot be written; this is the last version that rendered"
        : "out of date: the last check failed"
      : undefined;
  const status = conflict
    ? {
        tone: "bad" as const,
        text: `${GLYPH.failed} ${conflict.current ? "changed" : "removed"} on disk`,
      }
    : check.pending
      ? { tone: "muted" as const, text: "checking…" }
      : blocked
        ? {
            tone: "bad" as const,
            text: `${GLYPH.failed} ${failure?.kind === "error" ? "not checked" : "cannot render"}`,
          }
        : nIssues
          ? {
              tone: "bad" as const,
              text: `${GLYPH.failed} ${nIssues} issue${nIssues === 1 ? "" : "s"}`,
            }
          : nWarn
            ? { tone: "warn" as const, text: `⚠ ${nWarn} warning${nWarn === 1 ? "" : "s"}` }
            : result
              ? { tone: "ok" as const, text: `${GLYPH.done} valid` }
              : { tone: "muted" as const, text: "not checked yet" };

  const yamlPane = (
    <YamlPane
      mode={rawMode ? "raw" : "preview"}
      rawOnly={rawOnly}
      file={cfg.file}
      text={result?.text ?? (rawMode ? undefined : (base.text ?? undefined))}
      changed={result?.changed ?? []}
      removed={result?.removed ?? 0}
      pending={check.pending}
      stale={staleWhy}
      rawText={raw ?? ""}
      issues={issues}
      warnings={warnings}
      onMode={(m: YamlMode) => (m === "raw" ? void toRaw() : toVisual())}
      onRaw={setRaw}
      onClose={rawMode ? undefined : () => showYaml(false)}
      onPath={rawMode ? undefined : jump}
    />
  );

  /** After a 422: the last draft that rendered, which "Undo" restores. */
  const undoTo = failure?.kind === "render" && !rawMode ? check.good : undefined;
  return (
    <div class={cls("swc", rawMode && "is-raw")}>
      <div class="swc-bar" role="toolbar" aria-label="swarm file actions">
        <div class="swc-bar-file">
          <code title={cfg.file}>{cfg.file}</code>
          {base.hash === null ? <Badge tone="accent">new file</Badge> : null}
          <Badge
            tone={status.tone}
            title={nIssues ? issues.map((i) => i.message).join("\n") : undefined}
          >
            {status.text}
          </Badge>
          {dirty ? (
            <span class="swc-dirty" title="the draft differs from the file on disk">
              <i aria-hidden="true" /> unsaved
            </span>
          ) : (
            <span class="small muted">saved</span>
          )}
          {result && !staleWhy && (result.changed.length || result.removed) ? (
            <span class="small muted ds-num">
              +{result.changed.length} −{result.removed} lines
            </span>
          ) : null}
        </div>
        <div class="swc-bar-actions">
          {rawOnly ? null : rawMode ? (
            <button
              type="button"
              class="sm"
              disabled={saving}
              onClick={toVisual}
              title="back to the form"
            >
              ← Visual editor
            </button>
          ) : (
            <button
              type="button"
              class="sm ghost"
              disabled={saving || opening}
              aria-busy={opening || undefined}
              onClick={() => void toRaw()}
              title={opening ? "rendering the draft…" : "edit the YAML text directly"}
            >
              {opening ? "Rendering…" : "Raw YAML"}
            </button>
          )}
          {rawMode ? null : (
            <button
              type="button"
              class={cls("sm ghost", yamlOpen && "on")}
              aria-pressed={yamlOpen}
              onClick={() => showYaml(!yamlOpen)}
            >
              {yamlOpen ? "Hide YAML" : "Show YAML"}
            </button>
          )}
          <button
            type="button"
            class="sm"
            disabled={!dirty || saving}
            onClick={() => {
              // Both the raw text and the visual draft kept under it go back to the file (with
              // no file yet, back to the onboarding).
              setRaw(rawOnly ? (base.text ?? "") : null);
              rawFrom.current = rawOnly ? base.text : null;
              setDraft(base.doc ? { doc: base.doc, renames: [] } : null);
              setSaveError(undefined);
            }}
          >
            Revert
          </button>
          <button
            type="button"
            class="sm"
            disabled={!canSave}
            title={canSave ? "save (⌘S / Ctrl-S)" : !dirty ? "no changes" : "fix the issues first"}
            onClick={() => void save(false)}
          >
            {saving ? "Saving…" : base.hash === null ? "Create" : "Save"}
          </button>
          <button
            type="button"
            class="sm primary"
            disabled={!canSave && !syncOnly}
            title={
              syncOnly && disabledOnDisk
                ? "swarms are disabled: delete the generated .claude/agents/swarm-*.md files"
                : "save, then write .claude/agents/swarm-*.md"
            }
            onClick={() => void save(true)}
          >
            {syncOnly
              ? disabledOnDisk
                ? "Remove agent files"
                : "Sync agent files"
              : base.hash === null
                ? "Create & sync"
                : "Save & sync"}
          </button>
        </div>
      </div>

      {conflict ? (
        <div class="swc-banner bad" role="alert">
          <span>
            {conflict.current ? (
              <>
                <b>{GLYPH.failed} The swarm file changed on disk</b> since the studio loaded it (
                {conflict.message}). Nothing was overwritten.
              </>
            ) : (
              <>
                <b>{GLYPH.failed} The swarm file was removed on disk</b> since the studio loaded it
                (a branch switch?). Keep your draft to create it again on save, or reload.
              </>
            )}
          </span>
          <span class="row tight">
            <button type="button" class="sm" disabled={saving} onClick={reload}>
              Reload from disk
            </button>
            <button
              type="button"
              class="sm primary"
              disabled={saving}
              title={
                conflict.current
                  ? "rebase your draft on the file on disk; saving overwrites the other change"
                  : "keep your draft; saving creates the file again"
              }
              onClick={() => void keepMine()}
            >
              Keep mine
            </button>
          </span>
        </div>
      ) : null}
      {failure && failure.kind === "render" ? (
        <div class="swc-banner warn" role="alert">
          <span>
            <b>{GLYPH.blocked} This edit cannot be written from the form.</b> {failure.message}
          </span>
          {rawOnly || rawMode ? null : (
            <span class="row tight">
              {undoTo ? (
                <button
                  type="button"
                  class="sm primary"
                  disabled={saving}
                  title="drop the edit that cannot be written (and any form edit after it); earlier edits stay"
                  onClick={() => setDraft(undoTo)}
                >
                  Undo the last change
                </button>
              ) : null}
              <button
                type="button"
                class="sm"
                disabled={saving || opening}
                onClick={() => void toRaw()}
              >
                Edit in raw YAML
              </button>
            </span>
          )}
        </div>
      ) : null}
      {saveError && !conflict ? (
        <div class="swc-banner bad" role="alert">
          <span>
            <b>{GLYPH.failed} The save did not go through</b> ({saveError.message}). Your draft is
            kept; try again.
          </span>
          <span class="row tight">
            <button
              type="button"
              class="sm primary"
              disabled={saving || !(canSave || (saveError.sync && syncOnly))}
              onClick={() => void save(saveError.sync)}
            >
              Retry
            </button>
            <button
              type="button"
              class="sm ghost"
              aria-label="dismiss the save error"
              onClick={() => setSaveError(undefined)}
            >
              Dismiss
            </button>
          </span>
        </div>
      ) : null}
      {failure && failure.kind === "error" ? (
        <div class="swc-banner bad" role="alert">
          <span>
            <b>{GLYPH.failed} The draft could not be checked</b> ({failure.message}).
          </span>
          <button
            type="button"
            class="sm"
            disabled={saving || check.pending}
            onClick={() => setRecheck((n) => n + 1)}
          >
            Check again
          </button>
        </div>
      ) : null}
      {rawOnly ? (
        <div class="swc-banner warn">
          <span>
            <b>{GLYPH.blocked} The file is not valid YAML</b>, so only the raw editor works. Fix it
            and save; the visual editor comes back once it parses.
          </span>
        </div>
      ) : null}
      {doc && doc.enabled === false && !rawMode ? (
        <div class="swc-banner warn">
          <span>
            <b>Swarms are disabled</b> (<code>enabled: false</code>): the hooks ignore every swarm
            below and a sync removes the generated agent files.
          </span>
          <button
            type="button"
            class="sm"
            disabled={saving}
            onClick={() => updateDoc((d) => setIn(d, ["enabled"], true))}
          >
            Turn swarms on
          </button>
        </div>
      ) : null}
      {warnings.filter((w) => w.kind === "active-run").length && !rawMode ? (
        <div class="swc-banner info">
          <span>
            <b>{GLYPH.active} A run is active.</b>{" "}
            {warnings
              .filter((w) => w.kind === "active-run")
              .map((w) => w.message)
              .join(" · ")}
            . Saving is allowed; the run keeps the workers it has.
          </span>
        </div>
      ) : null}

      {rawMode ? (
        <div class="swc-raw-wrap" inert={saving} aria-busy={saving || undefined}>
          {yamlPane}
        </div>
      ) : !doc ? (
        <Card>
          <EmptyState icon="✎" title="Nothing to edit">
            The swarm file has no structured content.
          </EmptyState>
        </Card>
      ) : (
        <div
          class={cls("swc-layout", yamlOpen && "with-yaml")}
          inert={saving}
          aria-busy={saving || undefined}
        >
          <aside class="swc-rail" aria-label="swarms in the file">
            <button
              type="button"
              class={cls("swc-nav-item settings", tab === "settings" && "on")}
              aria-current={tab === "settings" ? "page" : undefined}
              onClick={() => go({ tab: "settings" })}
            >
              <span class="swc-nav-glyph" aria-hidden="true">
                ⚙
              </span>
              <span class="swc-nav-main">
                <b>File settings</b>
                <span class="small muted">
                  {doc.enabled === false ? "disabled" : "enabled"} · sync {doc.sync ?? "auto"}
                  {doc.enforce ? " · enforced" : ""}
                </span>
              </span>
              {(() => {
                const n = issues.filter((i) => fieldOf(i.path).settings).length;
                return n ? <Badge tone="bad">{n}</Badge> : null;
              })()}
            </button>
            <div class="swc-rail-head small muted">
              Swarms <span class="ds-num">{names.length}</span>
            </div>
            {names.map((n) => {
              const s = doc.swarms[n]!;
              const cap = capacity(s);
              const bad = issuesUnder(issues, `swarms.${n}`).length;
              const roles = Object.keys(s.agents);
              const live = activeRuns.some((r) => r.swarm === n);
              return (
                <button
                  type="button"
                  class={cls("swc-nav-item", n === selName && "on")}
                  aria-current={n === selName ? "page" : undefined}
                  onClick={() => go({ swarm: n })}
                >
                  <span class="swc-nav-glyph" aria-hidden="true">
                    {TOPOLOGY_GLYPH[s.topology ?? "hierarchical"]}
                  </span>
                  <span class="swc-nav-main">
                    <b>
                      {n}
                      {live ? (
                        <i class="swc-live-dot" title="a run of this swarm is active" />
                      ) : null}
                    </b>
                    <span class="small muted">
                      {s.topology ?? "hierarchical"} · {roles.length} role
                      {roles.length === 1 ? "" : "s"} ·{" "}
                      <span class={cls("ds-num", cap.over && "warn")}>
                        {cap.total}/{cap.max}
                      </span>
                    </span>
                  </span>
                  {bad ? (
                    <Badge tone="bad">
                      {GLYPH.failed} {bad}
                    </Badge>
                  ) : null}
                </button>
              );
            })}
            <button type="button" class="swc-new" onClick={() => setGallery(true)}>
              ＋ New swarm
            </button>
            {issues.length && tab === "swarm" ? (
              <div class="swc-rail-issues">
                <IssueList issues={issues.slice(0, 6)} warnings={[]} onPath={jump} />
                {issues.length > 6 ? (
                  <div class="small muted">+{issues.length - 6} more in the YAML pane</div>
                ) : null}
              </div>
            ) : null}
          </aside>

          <section class="swc-main">
            {tab === "settings" ? (
              <SettingsPanel
                doc={doc}
                meta={meta}
                issues={issues}
                locked={locked}
                onChange={(d) => update((x) => ({ ...x, doc: d }))}
              />
            ) : sel && selName ? (
              <SwarmEditor
                key={selName}
                name={selName}
                swarm={sel}
                doc={doc}
                meta={meta}
                issues={issues}
                warnings={warnings}
                locked={locked}
                swarmNames={names}
                activeRun={activeRuns.find((r) => r.swarm === selName)?.id}
                selectedRole={roleName}
                onChange={(s) => updateDoc((d) => setIn(d, ["swarms", selName], s))}
                onRename={(to) => {
                  update((d) => renameSwarm(d, base.doc, selName, to));
                  go({ swarm: to });
                }}
                onDuplicate={() => {
                  const to = uniqueName(`${selName}-copy`, names);
                  updateDoc((d) => duplicateSwarm(d, selName, to));
                  go({ swarm: to });
                }}
                onDelete={() => {
                  updateDoc((d) => deleteSwarm(d, selName));
                  go({ swarm: names.find((n) => n !== selName) });
                }}
                onOpenRole={(r) => go({ swarm: selName, role: r })}
                onAddRole={(r, from) => {
                  updateDoc((d) =>
                    from ? duplicateRole(d, selName, from, r) : addRole(d, selName, r),
                  );
                  go({ swarm: selName, role: r });
                }}
              />
            ) : (
              <Card raised>
                <EmptyState
                  icon="＋"
                  title="No swarms in the file yet"
                  action={
                    <button type="button" class="primary" onClick={() => setGallery(true)}>
                      Add a swarm from a template
                    </button>
                  }
                >
                  A swarm is a team of Claude Code subagents: named roles with their prompts, models
                  and tools, and how they coordinate.
                </EmptyState>
              </Card>
            )}
          </section>

          {yamlOpen ? <aside class="swc-side">{yamlPane}</aside> : null}
        </div>
      )}

      {/* The drawers sit on fixed scrims; this box only carries `inert` during a save, and
          display: contents keeps it out of the .swc flex gap. */}
      <div style={{ display: "contents" }} inert={saving}>
        {sel && selName && roleName && !rawMode ? (
          <RoleDrawer
            key={`${selName}/${roleName}`}
            swarm={selName}
            name={roleName}
            role={sel.agents[roleName]!}
            doc={doc!}
            meta={meta}
            issues={issues}
            locked={locked}
            taken={Object.keys(sel.agents).filter((r) => r !== roleName)}
            onChange={(r) => updateDoc((d) => setIn(d, ["swarms", selName, "agents", roleName], r))}
            onRename={(to) => {
              update((d) => renameRole(d, base.doc, selName, roleName, to));
              go({ swarm: selName, role: to });
            }}
            onDuplicate={() => {
              const to = uniqueName(`${roleName}-copy`, Object.keys(sel.agents));
              updateDoc((d) => duplicateRole(d, selName, roleName, to));
              go({ swarm: selName, role: to });
            }}
            onDelete={() => {
              updateDoc((d) => deleteRole(d, selName, roleName));
              go({ swarm: selName });
            }}
            onRaw={() => {
              go({ swarm: selName });
              void toRaw();
            }}
            onClose={() => go({ swarm: selName })}
          />
        ) : null}

        {gallery && doc ? (
          <Drawer title="New swarm from a template" onClose={() => setGallery(false)}>
            <TemplateGallery
              templates={templates}
              error={tplError}
              taken={names}
              onCreate={(name, t) => {
                updateDoc((d) => addSwarm(d, name, t.swarm));
                setGallery(false);
                go({ swarm: name });
              }}
            />
          </Drawer>
        ) : null}
      </div>
    </div>
  );
}
