import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getContext, type ProjectContext, resetContextCache } from "../../src/context.js";
import { impact } from "../../src/graph/query.js";
import { parseMemoryFile, serializeMemoryFile } from "../../src/memory/frontmatter.js";
import {
  autoName,
  edit,
  isValidName,
  list,
  memoryLinks,
  read,
  reconcile,
  relatedTarget,
  remove,
  rename,
  write,
} from "../../src/memory/store.js";
import { search } from "../../src/search/pipeline.js";
import type { StorageAdapter } from "../../src/storage/adapter.js";
import { closeAllStorage, getStorage } from "../../src/storage/index.js";
import { emMemory } from "../../src/tools/em_memory.js";
import { emPurge } from "../../src/tools/em_purge.js";
import { emRecall } from "../../src/tools/em_recall.js";
import { emRemember } from "../../src/tools/em_remember.js";

let root: string;
let ctx: ProjectContext;
let db: StorageAdapter;
const file = (name: string) => join(root, ".eminiar", "memories", `${name}.md`);
const textOf = (r: { content: Array<{ text: string }>; isError?: boolean }) =>
  r.content.map((c) => c.text).join("\n");

beforeAll(() => {
  process.env.EMINIAR_HOME = mkdtempSync(join(tmpdir(), "em-home-"));
  process.env.EMINIAR_EMBEDDINGS = "0";
  root = mkdtempSync(join(tmpdir(), "em-mem-"));
  writeFileSync(join(root, "package.json"), "{}");
  resetContextCache();
  ctx = getContext(root);
  db = getStorage(ctx);
});
afterAll(() => {
  closeAllStorage();
  delete process.env.EMINIAR_HOME;
  delete process.env.EMINIAR_EMBEDDINGS;
});

describe("frontmatter", () => {
  it("parses scalars, lists, comments and unknown keys, and round-trips", () => {
    const text = `---
name: auth/session-tokens
kind: decision   # why not
tags: [auth, "security"]
related: []
owner: ryan
created: 2026-10-13T15:00:00Z
updated: 2026-10-13T15:04:11Z
---

Body line one.
`;
    const p = parseMemoryFile(text);
    expect(p.hadFrontmatter).toBe(true);
    expect(p.meta.name).toBe("auth/session-tokens");
    expect(p.meta.kind).toBe("decision");
    expect(p.meta.tags).toEqual(["auth", "security"]);
    expect(p.meta.related).toEqual([]);
    expect(p.meta.owner).toBe("ryan");
    expect(p.body.trim()).toBe("Body line one.");
    const out = serializeMemoryFile(p.meta, p.body);
    expect(out).toContain("name: auth/session-tokens\nkind: decision\ntags: [auth, security]");
    expect(out).toContain("owner: ryan");
    expect(parseMemoryFile(out).body).toBe(p.body);
    expect(parseMemoryFile("no header here").hadFrontmatter).toBe(false);
  });
});

describe("memory store", () => {
  it("validates and derives names", () => {
    expect(isValidName("auth/session-tokens")).toBe(true);
    expect(isValidName("note")).toBe(true);
    expect(isValidName("Bad Name")).toBe(false);
    expect(isValidName("a/b/c")).toBe(false);
    expect(autoName(db, "decision", "We use Vitest, not Jest!")).toBe(
      "decision/we-use-vitest-not-jest",
    );
    expect(() => write(ctx, db, { name: "Bad Name", kind: "note", content: "x" })).toThrow(
      /invalid memory name/,
    );
  });

  it("writes a file and mirrors it into the index and the graph", () => {
    const r = write(ctx, db, {
      name: "auth/session-tokens",
      kind: "decision",
      content: "Tokens rotate every fifteen minutes because refresh is cheap.",
      tags: ["auth"],
      related: ["file:./src/auth.ts", "sym:src/auth.ts#issueToken"],
    });
    expect(r.created).toBe(true);
    expect(r.path).toBe(".eminiar/memories/auth/session-tokens.md");
    const text = readFileSync(file("auth/session-tokens"), "utf8");
    expect(text).toMatch(/^---\nname: auth\/session-tokens\nkind: decision\ntags: \[auth\]\n/);
    expect(text).toContain("related: [file:src/auth.ts, sym:src/auth.ts#issueToken]");
    expect(text.trim().endsWith("refresh is cheap.")).toBe(true);
    const row = db.memoryGetByName("auth/session-tokens")!;
    expect(row.kind).toBe("decision");
    expect(row.path).toBe(r.path);
    expect(db.findDocumentByUri("memory:auth/session-tokens")).toBeDefined();
    expect(db.graphGetNode("memory:auth/session-tokens")?.kind).toBe("memory");
    const edges = db.graphEdgesFrom(["memory:auth/session-tokens"], ["mentions"]);
    expect(edges.map((e) => e.dst).sort()).toEqual([
      "file:src/auth.ts",
      "sym:src/auth.ts#issueToken",
    ]);
  });

  it("is searchable and refuses to overwrite unless asked", async () => {
    const hits = await search(db, "tokens rotate", {
      mode: "lexical",
      filters: { source: "memory" },
    });
    expect(hits.hits[0]?.chunk.document.uri).toBe("memory:auth/session-tokens");
    expect(() =>
      write(ctx, db, { name: "auth/session-tokens", kind: "decision", content: "other" }),
    ).toThrow(/already exists/);
    const created = parseMemoryFile(readFileSync(file("auth/session-tokens"), "utf8")).meta.created;
    const r = write(ctx, db, {
      name: "auth/session-tokens",
      kind: "decision",
      content: "Tokens rotate every fifteen minutes because refresh is cheap. Rotation is logged.",
      tags: ["auth"],
      related: ["file:src/auth.ts", "sym:src/auth.ts#issueToken"],
      replace: true,
    });
    expect(r.created).toBe(false);
    expect(parseMemoryFile(readFileSync(file("auth/session-tokens"), "utf8")).meta.created).toBe(
      created,
    );
  });

  it("re-imports files edited by hand", async () => {
    const f = file("auth/session-tokens");
    writeFileSync(f, `${readFileSync(f, "utf8")}\nHand-edited: the zebra clause.\n`);
    const s = reconcile(ctx, db);
    expect(s.synced).toBe(1);
    expect(read(ctx, db, "auth/session-tokens")?.body).toContain("zebra clause");
    expect(db.memoryGetByName("auth/session-tokens")?.content).toContain("zebra clause");
    const hits = await search(db, "zebra", { mode: "lexical", filters: { source: "memory" } });
    expect(hits.hits.length).toBe(1);
    expect(reconcile(ctx, db).synced).toBe(0);
  });

  it("repairs a missing header and lets the path win over the header's name", () => {
    mkdirSync(join(root, ".eminiar", "memories", "notes"), { recursive: true });
    writeFileSync(file("notes/raw"), "Just a note without a header.\n");
    writeFileSync(
      file("notes/moved"),
      "---\nname: notes/old-name\nkind: fact\ncreated: 2026-01-01T00:00:00Z\nupdated: 2026-01-01T00:00:00Z\n---\n\nMoved by mv.\n",
    );
    const s = reconcile(ctx, db);
    expect(s.synced).toBe(2);
    const raw = parseMemoryFile(readFileSync(file("notes/raw"), "utf8"));
    expect(raw.meta.name).toBe("notes/raw");
    expect(raw.meta.kind).toBe("note");
    expect(raw.body.trim()).toBe("Just a note without a header.");
    expect(parseMemoryFile(readFileSync(file("notes/moved"), "utf8")).meta.name).toBe(
      "notes/moved",
    );
    expect(db.memoryGetByName("notes/moved")?.kind).toBe("fact");
    expect(db.memoryGetByName("notes/old-name")).toBeUndefined();
  });

  it("forgets memories whose file was deleted", () => {
    unlinkSync(file("notes/raw"));
    const s = reconcile(ctx, db);
    expect(s.removed).toBe(1);
    expect(db.memoryGetByName("notes/raw")).toBeUndefined();
    expect(db.findDocumentByUri("memory:notes/raw")).toBeUndefined();
    expect(db.graphGetNode("memory:notes/raw")).toBeUndefined();
  });

  it("edits the body only and renames with mem: references following", () => {
    write(ctx, db, { name: "a/one", kind: "note", content: "See mem:a/two for the follow-up." });
    write(ctx, db, { name: "a/two", kind: "todo", content: "Follow-up item alpha." });
    expect(edit(ctx, db, "a/two", { find: "alpha", replace: "beta" })).toBe(1);
    expect(edit(ctx, db, "a/two", { find: "nothing-here", replace: "x" })).toBe(0);
    expect(read(ctx, db, "a/two")?.body).toBe("Follow-up item beta.");
    expect(parseMemoryFile(readFileSync(file("a/two"), "utf8")).meta.kind).toBe("todo");

    const r = rename(ctx, db, "a/two", "b/two");
    expect(r.refsUpdated).toBe(1);
    expect(existsSync(file("a/two"))).toBe(false);
    expect(read(ctx, db, "a/one")?.body).toContain("mem:b/two");
    expect(db.memoryGetByName("a/two")).toBeUndefined();
    expect(db.graphGetNode("memory:a/two")).toBeUndefined();
    expect(db.graphGetNode("memory:b/two")).toBeDefined();
    expect(parseMemoryFile(readFileSync(file("b/two"), "utf8")).meta.name).toBe("b/two");
  });

  it("migrates legacy database-only rows into files once", () => {
    const id = db.memoryInsert({ kind: "fact", content: "Legacy row content", tags: ["x"] });
    const s = reconcile(ctx, db);
    expect(s.migrated).toBe(1);
    expect(existsSync(file("fact/legacy-row-content"))).toBe(true);
    expect(db.memoryLegacyRows()).toEqual([]);
    expect(db.memoryGetByName("fact/legacy-row-content")?.tags).toBe('["x"]');
    expect(reconcile(ctx, db).migrated).toBe(0);
    // a second legacy row with the same text gets the row id as a suffix
    const id2 = db.memoryInsert({ kind: "fact", content: "Legacy row content" });
    expect(reconcile(ctx, db).migrated).toBe(1);
    expect(existsSync(file(`fact/legacy-row-content-${id2}`))).toBe(true);
    void id;
  });

  it("surfaces memories in impact analysis via mentions edges", () => {
    db.graphUpsertNodes([
      {
        id: "file:src/auth.ts",
        kind: "file",
        name: "src/auth.ts",
        path: "src/auth.ts",
        source: "curated",
      },
    ]);
    const r = impact(db, "src/auth.ts")!;
    const hit = r.hits.find((h) => h.id === "memory:auth/session-tokens");
    expect(hit).toBeDefined();
    expect(hit!.reasons[0]).toMatch(/^memory mentions/);
  });

  it("lists onboarding memories first and removes files on delete", () => {
    write(ctx, db, { name: "onboarding/commands", kind: "onboarding", content: "npm test" });
    expect(list(ctx, db)[0]?.name).toBe("onboarding/commands");
    expect(list(ctx, db, { topic: "a" }).map((m) => m.name)).toEqual(["a/one"]);
    expect(remove(ctx, db, "onboarding/commands")).toBe(true);
    expect(existsSync(file("onboarding/commands"))).toBe(false);
    expect(remove(ctx, db, "onboarding/commands")).toBe(false);
  });
});

describe("memory tools", () => {
  it("em_remember auto-names, em_recall finds, em_memory manages", async () => {
    const r1 = textOf(
      await emRemember.handler({ content: "We use vitest for tests", kind: "decision" }, ctx),
    );
    expect(r1).toContain(
      "remembered decision/we-use-vitest-for-tests (decision) → .eminiar/memories/decision/we-use-vitest-for-tests.md",
    );
    const r2 = textOf(
      await emRemember.handler({ content: "We use vitest for tests", kind: "decision" }, ctx),
    );
    expect(r2).toContain("decision/we-use-vitest-for-tests-2");
    const dup = await emRemember.handler(
      { content: "x".repeat(10), kind: "note", name: "decision/we-use-vitest-for-tests" },
      ctx,
    );
    expect(dup.isError).toBe(true);

    const recall = textOf(await emRecall.handler({ query: "vitest" }, ctx));
    expect(recall).toContain("decision/we-use-vitest-for-tests [decision]");
    const listed = textOf(await emRecall.handler({}, ctx));
    expect(listed).toContain("decision/we-use-vitest-for-tests");

    const readOut = textOf(
      await emMemory.handler({ action: "read", name: "decision/we-use-vitest-for-tests" }, ctx),
    );
    expect(readOut).toContain("[decision]");
    expect(readOut).toContain("We use vitest for tests");
    const refused = await emMemory.handler(
      { action: "delete", name: "decision/we-use-vitest-for-tests-2" },
      ctx,
    );
    expect(refused.isError).toBe(true);
    const deleted = textOf(
      await emMemory.handler(
        { action: "delete", name: "decision/we-use-vitest-for-tests-2", confirm: true },
        ctx,
      ),
    );
    expect(deleted).toContain("deleted");
    expect(existsSync(file("decision/we-use-vitest-for-tests-2"))).toBe(false);
    const edited = textOf(
      await emMemory.handler(
        {
          action: "edit",
          name: "decision/we-use-vitest-for-tests",
          find: "vitest",
          replace: "Vitest",
        },
        ctx,
      ),
    );
    expect(edited).toContain("replaced 1");
    const listOut = textOf(await emMemory.handler({ action: "list", topic: "decision" }, ctx));
    expect(listOut).toContain("decision/we-use-vitest-for-tests [decision]");
    expect(listOut).toContain("We use Vitest for tests");
  });

  it("em_purge memories keeps the files, which reconcile re-imports", async () => {
    const before = db.memoryCount();
    expect(before).toBeGreaterThan(0);
    const out = textOf(await emPurge.handler({ scope: "memories", confirm: true }, ctx));
    expect(out).toContain("left in place");
    expect(db.memoryCount()).toBe(0);
    expect(db.countDocuments("memory")).toBe(0);
    expect(db.graphGetNode("memory:auth/session-tokens")).toBeUndefined();
    reconcile(ctx, db);
    expect(db.memoryCount()).toBe(before);
    expect(db.graphGetNode("memory:auth/session-tokens")).toBeDefined();
  });
});

describe("memory links in the graph", () => {
  it("maps related mem: ids to memory: nodes", () => {
    expect(relatedTarget("mem:auth/tokens")).toBe("memory:auth/tokens");
    expect(relatedTarget("file:src/a.ts")).toBe("file:src/a.ts");
    expect(relatedTarget("memory:x")).toBe("memory:x");
  });

  it("finds mem: links in a body, bare, in backticks and as link targets", () => {
    const body =
      "See mem:links/target. Also `mem:links/other` and [why](mem:links/third), " +
      "not xmem:links/no or mem:Bad/Name, and mem:links/self again.";
    expect(memoryLinks(body, "links/self")).toEqual(["links/target", "links/other", "links/third"]);
  });

  it("writes mentions edges to memory: nodes and links edges for body references", () => {
    write(ctx, db, { name: "links/target", kind: "fact", content: "The target." });
    write(ctx, db, {
      name: "links/source",
      kind: "decision",
      content: "Builds on mem:links/target and mem:links/missing.",
      related: ["mem:links/target", "file:src/a.ts"],
      tags: ["graph"],
    });
    const out = db.graphEdgesFrom(["memory:links/source"]);
    const by = (kind: string) =>
      out
        .filter((e) => e.kind === kind)
        .map((e) => e.dst)
        .sort();
    expect(by("mentions")).toEqual(["file:src/a.ts", "memory:links/target"]);
    expect(by("links")).toEqual(["memory:links/missing", "memory:links/target"]);
    // the file keeps the reader's mem: spelling
    expect(readFileSync(file("links/source"), "utf8")).toContain("mem:links/target");
    expect(db.graphDanglingEdges("memory:").map((e) => e.dst)).toEqual(["memory:links/missing"]);
  });

  it("follows a rename: references are rewritten and the edges point at the new node", () => {
    rename(ctx, db, "links/target", "links/renamed");
    const out = db.graphEdgesFrom(["memory:links/source"]).map((e) => `${e.kind} ${e.dst}`);
    expect(out).toContain("links memory:links/renamed");
    expect(out).toContain("mentions memory:links/renamed");
    expect(out).not.toContain("links memory:links/target");
  });
});

describe("memory frontmatter prototype keys (#62)", () => {
  it("skips __proto__, constructor and prototype keys", () => {
    const { meta } = parseMemoryFile(
      "---\n__proto__: [a, b]\nconstructor: x\nprototype: y\nkind: note\n---\nbody\n",
    );
    expect(Object.getPrototypeOf(meta)).toBe(Object.prototype);
    expect(Object.keys(meta)).toEqual(["kind"]);
    expect((meta as Record<string, unknown>)[0]).toBeUndefined();
  });
});
