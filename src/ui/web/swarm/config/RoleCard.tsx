// One role of the selected swarm, as a card in the roles grid: colour, name, model policy at a
// glance (badge + tier range bar), worker count, tools and scope. Clicking it opens the drawer.
import type { JSX } from "preact";
import { Badge, Card, Stepper } from "../../ds.js";
import { cls } from "../../util.js";
import { GLYPH, roleColor } from "../style.js";
import { modelPolicy, type SwarmDoc, type SwarmDocRole, toolsSummary } from "./draft.js";
import { RangeBar } from "./fields.js";

/** Claude Code's agent colours, drawn in theme-aware ink. */
export const AGENT_COLOR_CSS: Record<string, string> = {
  red: "var(--bad)",
  blue: "var(--accent)",
  green: "var(--ok)",
  yellow: "var(--warn)",
  purple: "var(--accent-2)",
  orange: "#ea7a2b",
  pink: "#e0559a",
  cyan: "#14a8c4",
};

export const roleInk = (name: string, role: SwarmDocRole, names: string[]): string =>
  (role.color && AGENT_COLOR_CSS[role.color]) || roleColor(name, names);

export function RoleCard({
  name,
  role,
  doc,
  names,
  issues,
  selected,
  countLocked,
  maxCount,
  onOpen,
  onCount,
}: {
  name: string;
  role: SwarmDocRole;
  doc: SwarmDoc;
  /** Every role of the swarm, for the fallback palette. */
  names: string[];
  /** Blocking issues inside this role. */
  issues: number;
  selected: boolean;
  countLocked: boolean;
  maxCount: number;
  onOpen: () => void;
  onCount: (n: number) => void;
}): JSX.Element {
  const p = modelPolicy(doc, role);
  const ink = roleInk(name, role, names);
  const tools = toolsSummary(role);
  const count = role.count ?? 1;
  const noPrompt = !role.prompt?.trim();
  return (
    <Card class={cls("swc-role", issues > 0 && "has-issues")} selected={selected} onClick={onOpen}>
      <div class="swc-role-top" style={{ "--rc": ink } as JSX.CSSProperties}>
        <span class="swc-role-dot" aria-hidden="true">
          {(name[0] ?? "?").toUpperCase()}
        </span>
        <span class="swc-role-name">
          <b>{name}</b>
          <span class="muted small swc-role-desc" title={role.description}>
            {role.description}
          </span>
        </span>
        {/* The count stepper edits in place; it must not open the drawer. */}
        <span
          class="swc-role-count"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
          title={countLocked ? "set in the YAML (anchor or merge)" : "workers of this role at once"}
        >
          {countLocked ? (
            <span class="ds-num">×{count}</span>
          ) : (
            <Stepper
              label={`${name} count`}
              value={count}
              min={1}
              max={maxCount}
              onChange={onCount}
            />
          )}
        </span>
      </div>
      <div class="swc-role-model">
        <Badge
          tone={p.mode === "pin" ? "muted" : "purple"}
          title={
            p.mode === "pin"
              ? `pinned to ${p.model ?? "the main session's model"}`
              : `the adjudicator picks ${p.floor}–${p.ceiling}; falls back to ${p.model}`
          }
        >
          {p.mode === "pin" ? "pinned" : "adaptive"} · {p.model ?? "inherit"}
          {p.modelFrom === "defaults" ? <span class="muted"> (default)</span> : null}
        </Badge>
        {role.effort ? <Badge tone="muted">effort {role.effort}</Badge> : null}
        <RangeBar compact floor={p.floor} ceiling={p.ceiling} tier={p.tier} />
      </div>
      <div class="swc-role-foot">
        <Badge tone={tools === "read-only" ? "accent" : "muted"} title="tools and disallowed_tools">
          {tools === "read-only" ? "◇ " : ""}
          {tools}
        </Badge>
        {role.isolation === "worktree" ? <Badge tone="muted">worktree</Badge> : null}
        {role.skills?.length ? (
          <Badge tone="muted" title={role.skills.join("\n")}>
            {role.skills.length} skill{role.skills.length === 1 ? "" : "s"}
          </Badge>
        ) : null}
        {role.hooks ? (
          <Badge tone="muted" title="hooks are edited in the YAML">
            hooks
          </Badge>
        ) : null}
        {(role.scope ?? []).slice(0, 3).map((g) => (
          <code class="swc-glob" title="scope">
            {g}
          </code>
        ))}
        {(role.scope?.length ?? 0) > 3 ? (
          <span class="muted small">+{(role.scope?.length ?? 0) - 3}</span>
        ) : null}
        <span class="spacer" />
        {issues ? (
          <Badge tone="bad">
            {GLYPH.failed} {issues}
          </Badge>
        ) : noPrompt ? (
          <Badge tone="warn" title="no prompt: the worker gets only the description">
            {GLYPH.blocked} no prompt
          </Badge>
        ) : null}
      </div>
    </Card>
  );
}
