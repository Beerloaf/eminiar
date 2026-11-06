import { type Category, GUIDE_ORDER } from "../capture/categories.js";
import type { StorageAdapter } from "../storage/adapter.js";
import type { EventRow } from "../storage/types.js";

type Payload = Record<string, unknown>;

function parse(e: EventRow): Payload {
  try {
    return JSON.parse(e.payload) as Payload;
  } catch {
    return {};
  }
}

/** One line per event, category-specific. Returns undefined to skip. */
function line(cat: Category, p: Payload): string | undefined {
  switch (cat) {
    case "user_prompt":
    case "assistant_summary":
    case "decision":
    case "constraint":
    case "rejected":
    case "blocker":
    case "error_resolution":
    case "intent":
      return typeof p.text === "string" ? p.text : undefined;
    case "files":
    case "plans":
    case "rules":
      return typeof p.path === "string"
        ? p.path
        : typeof p.action === "string"
          ? p.action
          : undefined;
    case "tasks":
      return Array.isArray(p.todos) ? (p.todos as string[]).join("; ") : undefined;
    case "error":
      return `${p.summary ?? p.tool}: ${p.error ?? ""}`;
    case "git":
      return typeof p.command === "string" ? p.command : undefined;
    case "iteration_loop":
      return `${p.summary} ×${p.count}`;
    case "mcp_tool":
      return typeof p.tool === "string" ? p.tool : undefined;
    case "subagent":
      return typeof p.description === "string" ? p.description : undefined;
    case "agent_findings":
      return typeof p.text === "string" ? p.text.slice(0, 200) : undefined;
    case "skill":
      return typeof p.skill === "string" ? p.skill : undefined;
    case "external_ref":
      return typeof p.url === "string" ? p.url : undefined;
    case "latency":
      return `${p.summary} (${Math.round(Number(p.ms) / 1000)}s)`;
    case "environment":
    case "data":
      return typeof p.text === "string" ? p.text : JSON.stringify(p);
    default:
      return undefined;
  }
}

interface Section {
  title: string;
  priority: number;
  items: string[];
}

/** Collect sections from a session's events, newest-last, deduped, errors minus resolved ones. */
export function buildSections(db: StorageAdapter, sessionId: string): Section[] {
  const events = db.eventsBySession(sessionId);
  const byCat = new Map<string, EventRow[]>();
  for (const e of events) {
    const list = byCat.get(e.category) ?? [];
    list.push(e);
    byCat.set(e.category, list);
  }
  const resolved = byCat.has("error_resolution");
  const sections: Section[] = [];
  for (const g of GUIDE_ORDER) {
    const items: string[] = [];
    let priority = 4;
    for (const cat of g.categories) {
      for (const e of byCat.get(cat) ?? []) {
        const l = line(cat, parse(e));
        if (l && !items.includes(l)) items.push(l);
        priority = Math.min(priority, e.priority);
      }
    }
    if (!items.length) continue;
    // Last request / last reply: only the most recent matters.
    if (g.title === "Last Request" || g.title === "Last Reply" || g.title === "Intent")
      items.splice(0, items.length - 1);
    if (g.title === "Unresolved Errors" && resolved) items.splice(0, Math.max(0, items.length - 3));
    sections.push({ title: g.title, priority, items });
  }
  return sections;
}

/**
 * Render sections within a byte budget: drop whole P4 → P3 → P2 sections first,
 * then trim the longest lists, until it fits. P1 sections are always kept (truncated).
 */
export function renderWithin(sections: Section[], budget: number): string {
  let live = sections.map((s) => ({ ...s, items: [...s.items] }));
  const render = () =>
    live
      .map((s) => `**${s.title}**: ${s.items.map((i) => i.replace(/\s+/g, " ")).join(" | ")}`)
      .join("\n");
  let out = render();
  for (const p of [4, 3, 2]) {
    if (Buffer.byteLength(out) <= budget) break;
    live = live.filter((s) => s.priority !== p);
    out = render();
  }
  let guard = 0;
  while (Buffer.byteLength(out) > budget && guard++ < 200) {
    const longest = live.reduce((a, b) =>
      a.items.join("").length >= b.items.join("").length ? a : b,
    );
    if (longest.items.length > 1) longest.items.shift();
    else if (longest.items[0] && longest.items[0].length > 40)
      longest.items[0] = `${longest.items[0].slice(0, Math.floor(longest.items[0].length * 0.7))}…`;
    else live = live.filter((s) => s !== longest);
    out = render();
  }
  return out;
}

/** A guide section as a scoring unit: `text` is its rendered line; the rest lets it be re-rendered. */
export interface GuideSection {
  id: string;
  label: string;
  text: string;
  priority: number;
  items: string[];
}

const sectionText = (s: Section) =>
  `**${s.title}**: ${s.items.map((i) => i.replace(/\s+/g, " ")).join(" | ")}`;

/** The session's guide sections, in render order (the unit the compaction feature scores). */
export function guideSections(db: StorageAdapter, sessionId: string): GuideSection[] {
  return buildSections(db, sessionId).map((s) => ({
    id: s.title,
    label: s.title,
    text: sectionText(s),
    priority: s.priority,
    items: s.items,
  }));
}

/** Render sections within a byte budget; renderGuide is guideSections + renderSections. */
export function renderSections(sections: GuideSection[], budget: number): string {
  if (!sections.length) return "";
  return renderWithin(
    sections.map((s) => ({ title: s.label, priority: s.priority, items: s.items })),
    budget,
  );
}

/**
 * The byte budget of the PreCompact snapshot (src/hooks/pre-compact.ts) and of its Jev rewrite
 * (decisions/features/compaction.ts). Kept here, not in the hook, so server-side code can use it
 * without reaching the hook module and its dynamic import of decisions/hooks (tsup.config.ts).
 */
export const SNAPSHOT_BUDGET = 2048;

export function renderGuide(db: StorageAdapter, sessionId: string, budget = 2048): string {
  return renderSections(guideSections(db, sessionId), budget);
}
