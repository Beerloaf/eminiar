// Design-system primitives (ds-*): the shared building blocks of Overview and the Swarms
// pages. Styles live in the "design system (ds-*)" section of public/styles.css. Nothing
// here fetches data or knows a view; every component is a thin, accessible wrapper around
// a ds-* class. Tone is a class (`ds-t-ok`...) that sets --t / --ts for the component.
import type { ComponentChildren, JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { cls } from "./util.js";

export type Tone = "ok" | "bad" | "warn" | "accent" | "purple" | "muted";
const toneClass = (t: Tone | undefined): string | false => !!t && `ds-t-${t}`;

// Pause decorative motion while the tab is hidden (CSS reads the attribute on <html>).
if (typeof document !== "undefined") {
  const sync = () => {
    if (document.hidden) document.documentElement.setAttribute("data-tab-hidden", "");
    else document.documentElement.removeAttribute("data-tab-hidden");
  };
  document.addEventListener("visibilitychange", sync);
  sync();
}

// --- text -----------------------------------------------------------------------------

export const GradientText = ({ children }: { children: ComponentChildren }): JSX.Element => (
  <span class="ds-gradient-text">{children}</span>
);

// --- hero -----------------------------------------------------------------------------

export function Hero({
  eyebrow,
  title,
  sub,
  meta,
  aside,
}: {
  eyebrow?: ComponentChildren | undefined;
  title: ComponentChildren;
  sub?: ComponentChildren | undefined;
  /** A row of badges, pills or actions under the sub line. */
  meta?: ComponentChildren | undefined;
  /** Right-hand side: gauges, key figures, actions. */
  aside?: ComponentChildren | undefined;
}): JSX.Element {
  return (
    <section class="ds-hero">
      <div class="ds-hero-main">
        {eyebrow ? <div class="ds-eyebrow">{eyebrow}</div> : null}
        <h1 class="ds-hero-title">{title}</h1>
        {sub ? <div class="ds-hero-sub">{sub}</div> : null}
        {meta ? <div class="ds-hero-meta">{meta}</div> : null}
      </div>
      {aside ? <div class="ds-hero-aside">{aside}</div> : null}
    </section>
  );
}

// --- stats ----------------------------------------------------------------------------

export const StatRow = ({ children }: { children: ComponentChildren }): JSX.Element => (
  <div class="ds-stats">{children}</div>
);

export function Stat({
  label,
  value,
  sub,
  tone,
  onClick,
  title,
  children,
}: {
  label: string;
  value: ComponentChildren;
  sub?: ComponentChildren | undefined;
  tone?: Tone | undefined;
  onClick?: (() => void) | undefined;
  title?: string | undefined;
  /** A bar, sparkline or gauge shown under the figure. */
  children?: ComponentChildren | undefined;
}): JSX.Element {
  const body = (
    <>
      <span class="ds-stat-label">{label}</span>
      <span class="ds-stat-value">{value}</span>
      {sub ? <span class="ds-stat-sub">{sub}</span> : null}
      {children ? <div class="ds-stat-extra">{children}</div> : null}
    </>
  );
  const c = cls("ds-stat", toneClass(tone), onClick && "is-link");
  return onClick ? (
    <button type="button" class={c} title={title} onClick={onClick}>
      {body}
    </button>
  ) : (
    <div class={c} title={title}>
      {body}
    </div>
  );
}

// --- badge / pill ---------------------------------------------------------------------

export function Badge({
  tone,
  dot,
  title,
  children,
}: {
  tone?: Tone | undefined;
  dot?: boolean | undefined;
  title?: string | undefined;
  children: ComponentChildren;
}): JSX.Element {
  return (
    <span class={cls("ds-badge", toneClass(tone))} title={title}>
      {dot ? <i class="ds-dot" /> : null}
      {children}
    </span>
  );
}

/** A larger state pill; `pulse` adds a ring around the dot while something is live. */
export function Pill({
  tone,
  pulse,
  title,
  children,
}: {
  tone?: Tone | undefined;
  pulse?: boolean | undefined;
  title?: string | undefined;
  children: ComponentChildren;
}): JSX.Element {
  return (
    <span class={cls("ds-badge ds-pill", toneClass(tone), pulse && "pulse")} title={title}>
      <i class="ds-dot" />
      {children}
    </span>
  );
}

// --- card -----------------------------------------------------------------------------

export function Card({
  title,
  sub,
  right,
  raised,
  selected,
  flush,
  onClick,
  class: c,
  children,
}: {
  title?: ComponentChildren | undefined;
  sub?: ComponentChildren | undefined;
  right?: ComponentChildren | undefined;
  raised?: boolean | undefined;
  selected?: boolean | undefined;
  /** No padding: for tables and lists that run edge to edge (the head keeps its own). */
  flush?: boolean | undefined;
  onClick?: (() => void) | undefined;
  class?: string | undefined;
  children?: ComponentChildren | undefined;
}): JSX.Element {
  const interactive = !!onClick;
  return (
    <div
      class={cls(
        "ds-card",
        raised && "raised",
        selected && "selected",
        flush && "flush",
        interactive && "interactive",
        c,
      )}
      tabIndex={interactive ? 0 : undefined}
      onClick={onClick}
      onKeyDown={
        onClick
          ? (e) => {
              if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
                e.preventDefault();
                onClick();
              }
            }
          : undefined
      }
    >
      {title || right ? (
        <div class="ds-card-head">
          {title ? <h3>{title}</h3> : null}
          {sub ? <span class="ds-card-sub">{sub}</span> : null}
          {right ? <span class="right">{right}</span> : null}
        </div>
      ) : null}
      {children}
    </div>
  );
}

// --- gauge ----------------------------------------------------------------------------

/** A conic ring, 0..1. `label` is the centre text, `caption` a small line under it. */
export function Gauge({
  value,
  size = 72,
  thickness,
  tone = "accent",
  label,
  caption,
  title,
  class: c,
}: {
  value: number;
  size?: number | undefined;
  thickness?: number | undefined;
  tone?: Tone | undefined;
  label?: ComponentChildren | undefined;
  caption?: ComponentChildren | undefined;
  title?: string | undefined;
  class?: string | undefined;
}): JSX.Element {
  const v = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
  const style = {
    "--size": `${size}px`,
    "--th": `${thickness ?? Math.max(5, Math.round(size / 9))}px`,
    "--p": String(Math.round(v * 1000) / 10),
  } as JSX.CSSProperties;
  return (
    <div
      class={cls("ds-gauge", toneClass(tone), c)}
      style={style}
      title={title}
      role="img"
      aria-label={title ?? `${Math.round(v * 100)}%`}
    >
      <div class="ds-gauge-ring" />
      <div class="ds-gauge-label">
        {label ?? `${Math.round(v * 100)}%`}
        {caption ? <small>{caption}</small> : null}
      </div>
    </div>
  );
}

// --- sparkline ------------------------------------------------------------------------

/** Inline-SVG line with a soft area and an end dot. No dependencies; scales to its box. */
export function Sparkline({
  values,
  height = 32,
  tone = "accent",
  title,
}: {
  values: number[];
  height?: number | undefined;
  tone?: Tone | undefined;
  title?: string | undefined;
}): JSX.Element {
  const w = 100;
  const h = 100;
  const n = values.length;
  const max = Math.max(1, ...values);
  const pts = values.map((v, i): [number, number] => [
    n > 1 ? (i / (n - 1)) * w : w / 2,
    h - 6 - (Math.max(0, v) / max) * (h - 12),
  ]);
  const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(2)} ${y.toFixed(2)}`).join(" ");
  const last = pts[pts.length - 1];
  return (
    <svg
      class={cls("ds-spark", toneClass(tone))}
      style={{ "--h": `${height}px` } as JSX.CSSProperties}
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={title ?? "trend"}
    >
      {title ? <title>{title}</title> : null}
      {n > 1 ? (
        <>
          <path class="ds-spark-fill" d={`${line} L${w} ${h} L0 ${h} Z`} />
          <path class="ds-spark-line" d={line} />
        </>
      ) : null}
      {last && n === 1 ? <circle class="ds-spark-end" cx={last[0]} cy={last[1]} r="3" /> : null}
    </svg>
  );
}

// --- segmented bar & meters -----------------------------------------------------------

export interface Seg {
  value: number;
  tone: Tone;
  label?: string | undefined;
}

/** Proportional stacked bar (tasks done / active / failed, a single progress, ...). */
export function SegBar({
  segments,
  total,
  title,
}: {
  segments: Seg[];
  /** Denominator; defaults to the sum, so partial progress leaves the track visible. */
  total?: number | undefined;
  title?: string | undefined;
}): JSX.Element {
  const sum = total ?? segments.reduce((a, s) => a + s.value, 0);
  return (
    <div class="ds-segbar" title={title} role="img" aria-label={title ?? "progress"}>
      {sum > 0
        ? segments
            .filter((s) => s.value > 0)
            .map((s) => (
              <i
                class={toneClass(s.tone) || undefined}
                title={s.label}
                style={{ flex: `0 0 ${(100 * s.value) / sum}%` }}
              />
            ))
        : null}
    </div>
  );
}

/** Label | bar | value rows, scaled to the largest value. */
export function Meters({
  rows,
  tone = "accent",
  empty = "no data yet",
}: {
  rows: Array<{ label: string; value: number; text?: string }>;
  tone?: Tone | undefined;
  empty?: string | undefined;
}): JSX.Element {
  if (!rows.length) return <div class="muted small">{empty}</div>;
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <div class={cls("ds-meters", toneClass(tone))}>
      {rows.map((r) => (
        <div class="ds-meter">
          <span class="ds-meter-label" title={r.label}>
            {r.label}
          </span>
          <span class="ds-meter-track">
            <i style={{ width: `${Math.max(2, (100 * r.value) / max)}%` }} />
          </span>
          <span class="ds-meter-value">{r.text ?? r.value}</span>
        </div>
      ))}
    </div>
  );
}

// --- column chart ---------------------------------------------------------------------

export function ColumnChart({
  data,
  startLabel,
  endLabel,
}: {
  data: Array<{ value: number; tip: string }>;
  startLabel?: string | undefined;
  endLabel?: string | undefined;
}): JSX.Element {
  const max = Math.max(1, ...data.map((d) => d.value));
  return (
    <div class="ds-chart">
      <div class="ds-chart-plot">
        {data.map((d, i) => (
          <div class={cls("ds-chart-col", i === data.length - 1 && "is-last")}>
            <i
              style={{
                height: `${Math.max(2, (100 * d.value) / max)}%`,
                animationDelay: `${Math.min(i * 12, 360)}ms`,
              }}
            />
            <span class="ds-chart-tip">{d.tip}</span>
          </div>
        ))}
      </div>
      {startLabel || endLabel ? (
        <div class="ds-chart-axis">
          <span>{startLabel}</span>
          <span>{endLabel}</span>
        </div>
      ) : null}
    </div>
  );
}

// --- skeleton -------------------------------------------------------------------------

export function Skeleton({
  w,
  h,
  class: c,
}: {
  w?: string | number | undefined;
  h?: string | number | undefined;
  class?: string | undefined;
}): JSX.Element {
  const px = (v: string | number) => (typeof v === "number" ? `${v}px` : v);
  const style: Record<string, string> = {};
  if (w !== undefined) style["--w"] = px(w);
  if (h !== undefined) style["--h"] = px(h);
  return (
    <span class={cls("ds-skeleton", c)} style={style as JSX.CSSProperties} aria-hidden="true" />
  );
}

// --- segmented control ----------------------------------------------------------------

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: Array<{ id: T; label: ComponentChildren; title?: string }>;
  value: T;
  onChange: (id: T) => void;
  label?: string | undefined;
}): JSX.Element {
  return (
    <div class="ds-segmented" role="tablist" aria-label={label}>
      {options.map((o) => (
        <button
          type="button"
          role="tab"
          aria-selected={o.id === value}
          title={o.title}
          class={cls(o.id === value && "active")}
          onClick={() => onChange(o.id)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// --- drawer ---------------------------------------------------------------------------

let drawerSeq = 0;
const FOCUSABLE =
  'a[href],button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex]:not([tabindex="-1"])';

/**
 * A right-hand sheet. Esc and a click on the scrim close it, Tab stays inside it, and focus
 * returns to the opener. Full width on a phone. Render it only while open (or pass `open`).
 */
export function Drawer({
  open = true,
  onClose,
  title,
  actions,
  footer,
  children,
}: {
  open?: boolean | undefined;
  onClose: () => void;
  title: ComponentChildren;
  actions?: ComponentChildren | undefined;
  footer?: ComponentChildren | undefined;
  children: ComponentChildren;
}): JSX.Element | null {
  const panel = useRef<HTMLDivElement>(null);
  const downOnScrim = useRef(false);
  const upOnScrim = useRef(false);
  const titleId = useRef(`ds-drawer-t${++drawerSeq}`).current;
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== "Tab" || !panel.current) return;
      const items = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) {
        e.preventDefault();
        return;
      }
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === panel.current)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      opener?.focus?.();
    };
  }, [open]);
  if (!open) return null;
  return (
    <div
      class="ds-drawer-scrim"
      onMouseDown={(e) => {
        downOnScrim.current = e.target === e.currentTarget;
      }}
      onMouseUp={(e) => {
        upOnScrim.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        // Close on the click, not the press: closing on mousedown removed the scrim under the
        // pointer and let the same click land on the page behind it. A press that began on the
        // scrim and was released inside the drawer still clicks the scrim, so require both ends.
        const hit = downOnScrim.current && upOnScrim.current && e.target === e.currentTarget;
        downOnScrim.current = false;
        upOnScrim.current = false;
        if (hit) {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <aside
        class="ds-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        ref={panel}
      >
        <header class="ds-drawer-head">
          <h2 id={titleId}>{title}</h2>
          {actions}
          <button
            type="button"
            class="ghost sm ds-drawer-close"
            aria-label="close"
            onClick={onClose}
          >
            ✕
          </button>
        </header>
        <div class="ds-drawer-body">{children}</div>
        {footer ? <footer class="ds-drawer-foot">{footer}</footer> : null}
      </aside>
    </div>
  );
}

// --- form bits ------------------------------------------------------------------------

export function Field({
  label,
  hint,
  error,
  htmlFor,
  class: c,
  children,
}: {
  label: ComponentChildren;
  hint?: ComponentChildren | undefined;
  error?: ComponentChildren | undefined;
  htmlFor?: string | undefined;
  class?: string | undefined;
  children: ComponentChildren;
}): JSX.Element {
  return (
    <div class={cls("ds-field", !!error && "has-error", c)}>
      <label for={htmlFor}>{label}</label>
      {children}
      {error ? <div class="ds-field-error">{error}</div> : null}
      {hint && !error ? <div class="ds-field-hint">{hint}</div> : null}
    </div>
  );
}

export function Stepper({
  value,
  min = 0,
  max = 99,
  onChange,
  label,
}: {
  value: number;
  min?: number | undefined;
  max?: number | undefined;
  onChange: (v: number) => void;
  label?: string | undefined;
}): JSX.Element {
  return (
    <span class="ds-stepper" role="group" aria-label={label}>
      <button
        type="button"
        aria-label="decrease"
        disabled={value <= min}
        onClick={() => onChange(Math.max(min, value - 1))}
      >
        −
      </button>
      <output>{value}</output>
      <button
        type="button"
        aria-label="increase"
        disabled={value >= max}
        onClick={() => onChange(Math.min(max, value + 1))}
      >
        +
      </button>
    </span>
  );
}

/** Enter or comma adds, Backspace on an empty input removes the last chip, paste splits. */
export function ChipInput({
  value,
  onChange,
  placeholder,
  disabled,
  label,
}: {
  value: string[];
  onChange: (v: string[]) => void;
  placeholder?: string | undefined;
  disabled?: boolean | undefined;
  label?: string | undefined;
}): JSX.Element {
  const [text, setText] = useState("");
  const add = (raw: string) => {
    const items = raw
      .split(/[,\n]/)
      .map((x) => x.trim())
      .filter((x) => x && !value.includes(x));
    if (items.length) onChange([...value, ...new Set(items)]);
    setText("");
  };
  return (
    <div class="ds-chips">
      {value.map((chip) => (
        <span class="ds-chip">
          {chip}
          {disabled ? null : (
            <button
              type="button"
              aria-label={`remove ${chip}`}
              onClick={() => onChange(value.filter((x) => x !== chip))}
            >
              ×
            </button>
          )}
        </span>
      ))}
      <input
        type="text"
        aria-label={label}
        value={text}
        disabled={disabled}
        placeholder={value.length ? "" : placeholder}
        onInput={(e) => setText((e.target as HTMLInputElement).value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            add(text);
          } else if (e.key === "Backspace" && !text && value.length) {
            onChange(value.slice(0, -1));
          }
        }}
        onBlur={() => text.trim() && add(text)}
        onPaste={(e) => {
          const pasted = e.clipboardData?.getData("text") ?? "";
          if (/[,\n]/.test(pasted)) {
            e.preventDefault();
            add(text + pasted);
          }
        }}
      />
    </div>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: ComponentChildren | undefined;
  disabled?: boolean | undefined;
}): JSX.Element {
  const btn = (
    <button
      type="button"
      role="switch"
      class="ds-switch"
      aria-checked={checked}
      aria-label={typeof label === "string" ? label : undefined}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    />
  );
  return label ? (
    <span class="ds-switch-row">
      {btn}
      <span>{label}</span>
    </span>
  ) : (
    btn
  );
}

// --- empty state ----------------------------------------------------------------------

export function EmptyState({
  icon = "○",
  title,
  tone,
  compact,
  children,
  action,
}: {
  icon?: string | undefined;
  title: ComponentChildren;
  tone?: "bad" | undefined;
  compact?: boolean | undefined;
  children?: ComponentChildren | undefined;
  action?: ComponentChildren | undefined;
}): JSX.Element {
  return (
    <div class={cls("ds-empty", compact && "compact", tone)}>
      <div class="ds-empty-icon" aria-hidden="true">
        {icon}
      </div>
      <div class="ds-empty-title">{title}</div>
      {children ? <div class="ds-empty-text">{children}</div> : null}
      {action}
    </div>
  );
}
