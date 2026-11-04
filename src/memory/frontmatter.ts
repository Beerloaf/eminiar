/**
 * The header of a memory file. A deliberately tiny format (no YAML dependency):
 *
 *   ---
 *   name: auth/session-tokens
 *   kind: decision
 *   tags: [auth, security]
 *   related: [file:src/auth.ts, sym:src/auth.ts#issueToken]
 *   status: accepted            # decisions: proposed | accepted | superseded | deprecated
 *   supersedes: auth/old-tokens # the decision this one replaces
 *   created: 2026-10-13T15:00:00Z
 *   updated: 2026-10-13T15:04:11Z
 *   ---
 *
 * One `key: value` per line; `[a, b]` is a list; `# …` after a value is a comment.
 * Unknown keys survive a rewrite so hand-written headers are not flattened.
 */
export type MemoryMeta = Record<string, string | string[]>;

/** Known keys are written first, in this order. */
const ORDER = ["name", "kind", "status", "supersedes", "tags", "related", "created", "updated"];

function unquote(s: string): string {
  const t = s.trim();
  return (t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))
    ? t.slice(1, -1)
    : t;
}

export function parseMemoryFile(text: string): {
  meta: MemoryMeta;
  body: string;
  hadFrontmatter: boolean;
} {
  if (!/^---\r?\n/.test(text)) return { meta: {}, body: text, hadFrontmatter: false };
  const open = text.indexOf("\n") + 1;
  const close = /\n---[ \t]*(?:\r?\n|$)/.exec(text.slice(open - 1));
  if (!close) return { meta: {}, body: text, hadFrontmatter: false };
  const header = text.slice(open, open - 1 + close.index);
  const body = text.slice(open - 1 + close.index + close[0].length);
  const meta: MemoryMeta = {};
  for (const raw of header.split(/\r?\n/)) {
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(raw);
    // `__proto__: [a, b]` would set meta's prototype (a memory file can come with the repo).
    if (!m || m[1] === "__proto__" || m[1] === "constructor" || m[1] === "prototype") continue;
    let value = m[2]!.replace(/\s+#.*$/, "").trim();
    if (value.startsWith("[") && value.endsWith("]")) {
      value = value.slice(1, -1);
      meta[m[1]!] = value
        .split(",")
        .map(unquote)
        .filter((s) => s.length > 0);
    } else {
      meta[m[1]!] = unquote(value);
    }
  }
  return { meta, body, hadFrontmatter: true };
}

export function serializeMemoryFile(meta: MemoryMeta, body: string): string {
  const keys = [
    ...ORDER.filter((k) => k in meta),
    ...Object.keys(meta).filter((k) => !ORDER.includes(k)),
  ];
  const lines = keys.map((k) => {
    const v = meta[k];
    return Array.isArray(v) ? `${k}: [${v.join(", ")}]` : `${k}: ${v ?? ""}`;
  });
  // The body is everything after the closing line, so a leading "\n" is the blank line
  // that separates header from text; callers pass `\n<text>\n` for that layout.
  return `---\n${lines.join("\n")}\n---\n${body.endsWith("\n") ? body : `${body}\n`}`;
}
