import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConfigSchema } from "../../src/config.js";
import type { ProjectContext } from "../../src/context.js";
import { indexContent } from "../../src/index/indexer.js";
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
});
