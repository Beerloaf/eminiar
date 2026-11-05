// The YAML side of the studio: a preview of the text the draft renders to (changed lines
// marked, from POST /api/swarm/config/validate), the raw editor, and the issue and warning
// lists with links to their lines.
import type { JSX } from "preact";
import { useRef } from "preact/hooks";
import type { SwarmDocWarning, SwarmIssue } from "../../api.js";
import { Badge, Card, Segmented, Skeleton } from "../../ds.js";
import { cls } from "../../util.js";
import { GLYPH } from "../style.js";
import { Yaml } from "../Yaml.js";

export type YamlMode = "preview" | "raw";

export function IssueList({
  issues,
  warnings,
  onLine,
  onPath,
}: {
  issues: SwarmIssue[];
  warnings: SwarmDocWarning[];
  onLine?: ((line: number) => void) | undefined;
  /** Jump to the form field of an issue path. */
  onPath?: ((path: string) => void) | undefined;
}): JSX.Element | null {
  if (!issues.length && !warnings.length) return null;
  return (
    <ul class="swc-issues">
      {issues.map((i) => (
        <li class="bad-row">
          <span class="g" aria-hidden="true">
            {GLYPH.failed}
          </span>
          <span class="swc-issue-body">
            {i.path ? (
              onPath ? (
                <button
                  type="button"
                  class="swc-path"
                  title="show the field"
                  onClick={() => onPath(i.path)}
                >
                  {i.path}
                </button>
              ) : (
                <code>{i.path}</code>
              )
            ) : null}{" "}
            {i.message}
          </span>
          {i.line && onLine ? (
            <button type="button" class="ghost sm swc-ln" onClick={() => onLine(i.line!)}>
              line {i.line}
            </button>
          ) : null}
        </li>
      ))}
      {warnings.map((w) => (
        <li class="warn-row">
          <span class="g" aria-hidden="true">
            {GLYPH.blocked}
          </span>
          <span class="swc-issue-body">
            {w.path ? (
              onPath ? (
                <button type="button" class="swc-path" onClick={() => onPath(w.path)}>
                  {w.path}
                </button>
              ) : (
                <code>{w.path}</code>
              )
            ) : null}{" "}
            {w.message}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function YamlPane({
  mode,
  rawOnly,
  file,
  text,
  changed,
  removed,
  pending,
  stale,
  rawText,
  rawDisabled,
  issues,
  warnings,
  onMode,
  onRaw,
  onClose,
  onPath,
}: {
  mode: YamlMode;
  /** Only the raw editor works (the YAML does not parse, or there is no structured draft). */
  rawOnly: boolean;
  file: string;
  /** What the draft renders to; undefined until the first validation. */
  text: string | undefined;
  changed: number[];
  removed: number;
  /** A validation is in flight. */
  pending: boolean;
  /** Why the preview predates the draft (a 409, a 422 or an error), or undefined. The
   * preview is dimmed and the diff count hidden: it no longer describes the draft. */
  stale?: string | undefined;
  rawText: string;
  rawDisabled?: boolean | undefined;
  issues: SwarmIssue[];
  warnings: SwarmDocWarning[];
  onMode: (m: YamlMode) => void;
  onRaw: (t: string) => void;
  onClose?: (() => void) | undefined;
  onPath?: ((path: string) => void) | undefined;
}): JSX.Element {
  const box = useRef<HTMLDivElement>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const marks = new Set(changed);
  const goLine = (n: number) => {
    if (mode === "raw" && area.current) {
      const lines = rawText.split("\n");
      const start = lines.slice(0, n - 1).reduce((a, l) => a + l.length + 1, 0);
      area.current.focus();
      area.current.setSelectionRange(start, start + (lines[n - 1]?.length ?? 0));
      const lh = Number.parseFloat(getComputedStyle(area.current).lineHeight) || 18;
      area.current.scrollTop = Math.max(0, (n - 4) * lh);
      return;
    }
    const el = box.current?.querySelectorAll<HTMLElement>(".sw-yaml .l")[n - 1];
    if (!el) return;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    el.classList.remove("flash");
    void el.offsetWidth;
    el.classList.add("flash");
  };
  const firstChanged = changed[0];
  return (
    <Card
      class="swc-yaml"
      flush
      title={
        <span class="swc-yaml-title">
          YAML <code class="small">{file}</code>
        </span>
      }
      right={
        <span class="row tight">
          {rawOnly ? (
            <Badge tone="warn">raw only</Badge>
          ) : (
            <Segmented<YamlMode>
              label="YAML mode"
              value={mode}
              onChange={onMode}
              options={[
                { id: "preview", label: "Preview", title: "the text the visual draft writes" },
                { id: "raw", label: "Raw", title: "edit the YAML text directly" },
              ]}
            />
          )}
          {onClose ? (
            <button type="button" class="ghost sm" aria-label="hide the YAML" onClick={onClose}>
              ✕
            </button>
          ) : null}
        </span>
      }
    >
      <div class="swc-yaml-sum small">
        {pending ? <span class="muted">checking…</span> : null}
        {stale && mode !== "raw" ? (
          <span class="warn" role="status">
            {GLYPH.blocked} {stale}
          </span>
        ) : changed.length || removed ? (
          <button
            type="button"
            class="ghost sm"
            disabled={!firstChanged || mode === "raw"}
            title="jump to the first change"
            onClick={() => firstChanged && goLine(firstChanged)}
          >
            <span class="swc-diff-add">+{changed.length}</span> line
            {changed.length === 1 ? "" : "s"} changed · <span class="swc-diff-del">−{removed}</span>{" "}
            removed
          </button>
        ) : text !== undefined ? (
          <span class="muted">no changes against the file on disk</span>
        ) : null}
        {mode === "raw" ? (
          <span class="muted">validated as you type; saved as written</span>
        ) : (
          <span class="muted">comments and layout of untouched lines are kept</span>
        )}
      </div>
      <div class="swc-yaml-body" ref={box}>
        {mode === "raw" || rawOnly ? (
          <textarea
            ref={area}
            class="swc-raw"
            value={rawText}
            disabled={rawDisabled}
            spellcheck={false}
            aria-label={`${file} as YAML`}
            onInput={(e) => onRaw((e.target as HTMLTextAreaElement).value)}
            onKeyDown={(e) => {
              // Tab indents with two spaces instead of leaving the editor.
              if (e.key !== "Tab" || e.shiftKey) return;
              e.preventDefault();
              const t = e.target as HTMLTextAreaElement;
              const { selectionStart: s, selectionEnd: en, value } = t;
              onRaw(`${value.slice(0, s)}  ${value.slice(en)}`);
              requestAnimationFrame(() => t.setSelectionRange(s + 2, s + 2));
            }}
          />
        ) : text === undefined ? (
          <div class="swc-pad ds-skel-stack">
            {[80, 60, 72, 40, 66, 54].map((w) => (
              <Skeleton w={`${w}%`} h={12} />
            ))}
          </div>
        ) : (
          <div class={cls(stale && "is-stale")} style={stale ? { opacity: 0.5 } : undefined}>
            <Yaml text={text} marks={marks} />
          </div>
        )}
      </div>
      <div class={cls("swc-yaml-issues", !issues.length && !warnings.length && "empty")}>
        <IssueList issues={issues} warnings={warnings} onLine={goLine} onPath={onPath} />
      </div>
    </Card>
  );
}
