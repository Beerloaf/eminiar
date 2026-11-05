import type { ComponentChildren, JSX } from "preact";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { EmptyState } from "./ds.js";
import { cls, color } from "./util.js";

// --- toasts ---------------------------------------------------------------------------

type Listener = (msg: string, bad: boolean) => void;
const listeners = new Set<Listener>();
export function toast(msg: string, bad = false): void {
  for (const l of listeners) l(msg, bad);
}

export function ToastHost(): JSX.Element | null {
  const [t, setT] = useState<{ msg: string; bad: boolean } | null>(null);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const l: Listener = (msg, bad) => {
      setT({ msg, bad });
      clearTimeout(timer);
      timer = setTimeout(() => setT(null), bad ? 6000 : 2500);
    };
    listeners.add(l);
    return () => {
      listeners.delete(l);
      clearTimeout(timer);
    };
  }, []);
  return t ? <div class={cls("toast", t.bad && "bad")}>{t.msg}</div> : null;
}

// --- async data -----------------------------------------------------------------------

export interface Async<T> {
  data: T | undefined;
  error: string | undefined;
  loading: boolean;
  reload: () => void;
}

/** Run `fn` when `deps` change; keeps the last data while reloading. */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): Async<T> {
  const [state, set] = useState<{
    data: T | undefined;
    error: string | undefined;
    loading: boolean;
  }>({
    data: undefined,
    error: undefined,
    loading: true,
  });
  const [tick, setTick] = useState(0);
  const gen = useRef(0);
  useEffect(() => {
    const g = ++gen.current;
    set((s) => ({ ...s, loading: true, error: undefined }));
    fn().then(
      (data) => g === gen.current && set({ data, error: undefined, loading: false }),
      (err: Error) =>
        g === gen.current && set((s) => ({ ...s, error: err.message, loading: false })),
    );
  }, [...deps, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { ...state, reload };
}

// --- small bits -----------------------------------------------------------------------

export const Spinner = (): JSX.Element => <span class="spin" />;
export const Empty = ({ children }: { children: ComponentChildren }): JSX.Element => (
  <div class="empty">{children}</div>
);
export const ErrorBox = ({
  error,
  onRetry,
}: {
  error: string;
  onRetry?: (() => void) | undefined;
}): JSX.Element => (
  <EmptyState
    compact
    tone="bad"
    icon="!"
    title="Could not load this view"
    action={
      onRetry ? (
        <button type="button" class="ds-empty-action" onClick={onRetry}>
          Retry
        </button>
      ) : undefined
    }
  >
    {error}
  </EmptyState>
);

export function KindTag({ kind }: { kind: string }): JSX.Element {
  return (
    <span class="tag kind" style={{ color: color(kind) }}>
      {kind}
    </span>
  );
}

export function Tag({
  children,
  class: c,
}: {
  children: ComponentChildren;
  class?: string;
}): JSX.Element {
  return <span class={cls("tag", c)}>{children}</span>;
}

export function Bar({
  value,
  max,
  width = 80,
}: {
  value: number;
  max: number;
  width?: number;
}): JSX.Element {
  const w = max > 0 ? Math.max(2, (value / max) * width) : 2;
  return <span class="bar" style={{ width: `${w}px` }} title={String(value)} />;
}

export function KV({ rows }: { rows: Array<[string, ComponentChildren]> }): JSX.Element {
  return (
    <dl class="kv">
      {rows.map(([k, v]) => (
        <>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </>
      ))}
    </dl>
  );
}

export function SubTabs<T extends string>({
  tabs,
  value,
  onChange,
}: {
  tabs: Array<[T, string]>;
  value: T;
  onChange: (t: T) => void;
}): JSX.Element {
  return (
    <div class="subtabs">
      {tabs.map(([id, label]) => (
        <button type="button" class={cls(value === id && "active")} onClick={() => onChange(id)}>
          {label}
        </button>
      ))}
    </div>
  );
}

// --- resizable split ------------------------------------------------------------------

/**
 * Two or three panes with draggable gutters. `sizes` are the pixel widths of the side
 * panes; the middle (or right, for two panes) pane takes the rest.
 */
export function Split({
  left,
  center,
  right,
  leftWidth = 280,
  rightWidth = 340,
}: {
  left?: ComponentChildren;
  center: ComponentChildren;
  right?: ComponentChildren;
  leftWidth?: number;
  rightWidth?: number;
}): JSX.Element {
  const [lw, setLw] = useState(leftWidth);
  const [rw, setRw] = useState(rightWidth);
  const drag = useRef<{ side: "l" | "r"; x: number; start: number } | null>(null);
  const [active, setActive] = useState<"l" | "r" | null>(null);
  useEffect(() => {
    const move = (e: MouseEvent) => {
      const d = drag.current;
      if (!d) return;
      const dx = e.clientX - d.x;
      if (d.side === "l") setLw(Math.max(160, Math.min(700, d.start + dx)));
      else setRw(Math.max(200, Math.min(800, d.start - dx)));
    };
    const up = () => {
      drag.current = null;
      setActive(null);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  }, []);
  const cols = [left ? `${lw}px 5px` : "", "minmax(0, 1fr)", right ? `5px ${rw}px` : ""]
    .filter(Boolean)
    .join(" ");
  return (
    <div class="split" style={{ gridTemplateColumns: cols }}>
      {left && (
        <>
          <div class="pane">{left}</div>
          <div
            class={cls("gutter", active === "l" && "on")}
            onMouseDown={(e) => {
              drag.current = { side: "l", x: e.clientX, start: lw };
              setActive("l");
              e.preventDefault();
            }}
          />
        </>
      )}
      <div class="pane">{center}</div>
      {right && (
        <>
          <div
            class={cls("gutter", active === "r" && "on")}
            onMouseDown={(e) => {
              drag.current = { side: "r", x: e.clientX, start: rw };
              setActive("r");
              e.preventDefault();
            }}
          />
          <div class="pane">{right}</div>
        </>
      )}
    </div>
  );
}

// --- sortable table helper ------------------------------------------------------------

export function useSort<T>(rows: T[] | undefined, initial: keyof T, desc = true) {
  const [key, setKey] = useState<keyof T>(initial);
  const [dir, setDir] = useState<1 | -1>(desc ? -1 : 1);
  const sorted = (rows ?? []).slice().sort((a, b) => {
    const x = a[key];
    const y = b[key];
    if (typeof x === "number" && typeof y === "number") return (x - y) * dir;
    return String(x ?? "").localeCompare(String(y ?? "")) * dir;
  });
  const th = (k: keyof T, label: string, numeric = false): JSX.Element => (
    <th
      class={cls("sortable", numeric && "num", key === k && "sorted")}
      onClick={() => {
        if (key === k) setDir((d) => (d === 1 ? -1 : 1));
        else {
          setKey(k);
          setDir(numeric ? -1 : 1);
        }
      }}
    >
      {label}
      {key === k ? (dir === 1 ? " ▲" : " ▼") : ""}
    </th>
  );
  return { sorted, th };
}
