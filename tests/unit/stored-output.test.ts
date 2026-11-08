import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConfigSchema } from "../../src/config.js";
import type { ProjectContext } from "../../src/context.js";
import { indexContent, remaskCapturedOutput } from "../../src/index/indexer.js";
import { processOutput } from "../../src/sandbox/output.js";
import { search } from "../../src/search/pipeline.js";
import { closeAllStorage } from "../../src/storage/index.js";
import { SqliteAdapter } from "../../src/storage/sqlite/adapter.js";
import { emBatchExecute } from "../../src/tools/em_batch_execute.js";

// What em_execute, em_batch_execute and em_fetch_and_index store: the masked copy in the index.

let ctx: ProjectContext;
let db: SqliteAdapter;
beforeAll(() => {
  const home = mkdtempSync(join(tmpdir(), "em-home-"));
  process.env.EMINIAR_HOME = home;
  const root = mkdtempSync(join(tmpdir(), "em-root-"));
  writeFileSync(join(root, "package.json"), "{}");
  ctx = { root, id: "test", dbPath: join(home, "t.db"), config: ConfigSchema.parse({}) };
  db = new SqliteAdapter(ctx.dbPath);
});
afterAll(() => {
  db.close();
  closeAllStorage();
  delete process.env.EMINIAR_HOME;
});

const textOf = (r: { content: Array<{ type: string; text?: string }> }) =>
  r.content.map((c) => c.text ?? "").join("\n");

describe("captured output in the index", () => {
  it("stores every output with its secrets masked and inlines it as printed", async () => {
    const token = "ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
    const r = await emBatchExecute.handler(
      { commands: [{ label: "env", command: `echo GH_TOKEN=${token}; echo PATH=/usr/bin` }] },
      ctx,
    );
    const out = textOf(r);
    expect(out).toContain(`GH_TOKEN=${token}`);
    const docId = Number(/· doc (\d+)/.exec(out)?.[1]);
    expect(db.chunksOfDocument(docId).map((c) => c.body)).toEqual([
      "GH_TOKEN=***\nPATH=/usr/bin\n",
    ]);
  }, 30_000);

  it("indexes large output with its secrets masked, so no search returns them", async () => {
    const secret = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
    const bearer = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.dozjgNryP4J3jVmNHl0w5N";
    const big = Array.from({ length: 400 }, (_, i) =>
      i === 3 ? `AWS_SECRET_ACCESS_KEY=${secret}` : `line ${i} routine output noise`,
    ).join("\n");
    const r = await processOutput(db, ctx, {
      stdout: big,
      title: `shell: curl -H "Authorization: Bearer ${bearer}" https://api.example.com`,
      source: "exec",
    });
    // The head/tail preview is as printed; only the stored copy is masked.
    expect(r.text).toContain(secret);
    const id = r.documentId as number;
    expect(db.getDocument(id)?.title).toBe(
      'shell: curl -H "Authorization: Bearer ***" https://api.example.com',
    );
    const stored = db
      .chunksOfDocument(id)
      .map((c) => `${c.title}\n${c.body}`)
      .join("\n");
    expect(stored).toContain("AWS_SECRET_ACCESS_KEY=***");
    expect(stored).not.toContain(secret);
    expect(stored).not.toContain(bearer);
    const find = async (q: string) =>
      (await search(db, q, { mode: "lexical", filters: { documentIds: [id] } })).hits.length;
    expect(await find("AWS_SECRET_ACCESS_KEY")).toBeGreaterThan(0);
    expect(await find("wJalrXUtnFEMI")).toBe(0);
    expect(await find("dozjgNryP4J3jVmNHl0w5N")).toBe(0);
  });

  it("returns intent sections from the masked copy", async () => {
    const secret = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
    const big = Array.from({ length: 400 }, (_, i) =>
      i === 3 ? `AWS_SECRET_ACCESS_KEY=${secret}` : `line ${i} routine output noise`,
    ).join("\n");
    const r = await processOutput(db, ctx, {
      stdout: big,
      title: "env",
      source: "exec",
      intent: "AWS_SECRET_ACCESS_KEY",
    });
    expect(r.text).toContain("AWS_SECRET_ACCESS_KEY=***");
    expect(r.text).not.toContain(secret);
  });

  it("masks fetched pages too, but never a project file or a memory", () => {
    const content = "# Setup\n\nexport API_TOKEN=tok-9f8e7d6c5b4a\n";
    const body = (source: string) => {
      const { documentId } = indexContent(db, {
        source,
        title: source,
        uri: `t:${source}`,
        content,
      });
      return db.chunksOfDocument(documentId)[0]?.body ?? "";
    };
    expect(body("url")).toContain("API_TOKEN=***");
    for (const source of ["file", "memory", "code"])
      expect(body(source)).toContain("tok-9f8e7d6c5b4a");
  });

  it("masks the intent and pre-cut chunks of captured output too", () => {
    const { documentId } = indexContent(db, {
      source: "exec",
      title: "t",
      content: "x",
      meta: { intent: "why does DB_PASSWORD=hunter2hunter2 fail" },
      chunks: [
        {
          title: "API_TOKEN=tok-9f8e7d6c5b4a",
          body: "export API_TOKEN=tok-9f8e7d6c5b4a",
          startLine: 1,
          endLine: 1,
        },
      ],
    });
    expect(db.getDocument(documentId)?.meta).toBe('{"intent":"why does DB_PASSWORD=*** fail"}');
    const [c] = db.chunksOfDocument(documentId);
    expect([c?.title, c?.body]).toEqual(["API_TOKEN=***", "export API_TOKEN=***"]);
  });

  const secret = "ghp_Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2";
  /** A document as an older version stored it: raw, with its chunk already embedded. */
  const legacy = (source: string, tag: string) => {
    const { id } = db.upsertDocument(
      {
        source,
        title: `echo ${secret}`,
        contentType: "prose",
        contentHash: `old-${source}-${tag}`,
        meta: { intent: `why is GH_TOKEN=${secret} rejected` },
      },
      [{ ord: 0, title: "", body: `GH_TOKEN=${secret}`, contentType: "prose", hash: "h" }],
    );
    db.markEmbedded(db.chunksOfDocument(id).map((c) => c.id));
    return id;
  };

  it("masks output stored before masking once, in place, and leaves other sources", async () => {
    const exec = legacy("exec", "a");
    const file = legacy("file", "a");
    db.metaDelete("captured_mask_version");
    expect(await remaskCapturedOutput(db)).toBeGreaterThan(0);
    expect(db.getDocument(exec)?.title).toBe("echo ghp_***");
    expect(db.getDocument(exec)?.meta).toBe('{"intent":"why is GH_TOKEN=*** rejected"}');
    const [chunk] = db.chunksOfDocument(exec);
    expect(chunk?.body).toBe("GH_TOKEN=***");
    // the old vector was embedded from the raw text: the chunk is queued to be embedded again
    expect(db.unembeddedChunkIds(1000)).toContain(chunk?.id);
    expect(db.chunksOfDocument(file)[0]?.body).toBe(`GH_TOKEN=${secret}`);
    const hits = await search(db, "Z9y8X7w6V5u4T3s2", { mode: "lexical" });
    expect(hits.hits.map((h) => h.chunk.document.id)).toEqual([file]);
    // once per database: a later warm-up does nothing
    legacy("exec", "later");
    expect(await remaskCapturedOutput(db)).toBe(0);
  });

  it("works in slices that yield to the event loop, and resumes where it stopped", async () => {
    db.metaDelete("captured_mask_version");
    const docs = [legacy("exec", "s1"), legacy("batch", "s2"), legacy("url", "s3")];
    // a run stopped after the first document resumes after it
    db.metaSet("captured_mask_resume", `1:${docs[0]}`);
    // one document per slice, as if each took the whole 20 ms
    const sliced = Object.create(db) as SqliteAdapter;
    const order: string[] = [];
    sliced.remaskDocuments = (sources, mask, afterId) => {
      order.push("slice");
      return db.remaskDocuments(sources, mask, afterId, 0);
    };
    setImmediate(() => order.push("tick"));
    await remaskCapturedOutput(sliced);
    expect(order).toEqual(["slice", "tick", "slice", "slice"]);
    expect(db.chunksOfDocument(docs[0] as number)[0]?.body).toBe(`GH_TOKEN=${secret}`);
    for (const id of docs.slice(1)) expect(db.chunksOfDocument(id)[0]?.body).toBe("GH_TOKEN=***");
    expect(db.metaGet("captured_mask_resume")).toBeUndefined();
  });
});
