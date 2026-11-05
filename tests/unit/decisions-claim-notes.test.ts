import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decisionDrainNotes } from "../../src/decisions/hooks.js";
import { SqliteAdapter } from "../../src/storage/sqlite/adapter.js";

describe("claimNotes", () => {
  let db: SqliteAdapter;
  beforeEach(() => {
    db = new SqliteAdapter(join(mkdtempSync(join(tmpdir(), "dec-claim-")), "e.db"), {
      vectors: false,
    });
  });
  afterEach(() => db.db.close());

  const base = {
    feature: "commit" as const,
    context: "job" as const,
    subject: "s",
    mode: "live" as const,
    status: "ok" as const,
  };

  it("delivers a note to the first claimer only, scoped to the session", () => {
    const id = db.decisions.insertCall({ ...base, ts: 5000, note: "n1", noteSession: "s1" });
    expect(db.decisions.claimNotes("other", 5001)).toEqual([]);
    expect(db.decisions.claimNotes("s1", 5001)).toEqual([{ id, note: "n1" }]);
    expect(db.decisions.claimNotes("s1", 5002)).toEqual([]);
    expect(decisionDrainNotes(db, "s1", 5003)).toBeUndefined();
  });

  it("expires after 10 minutes and markDelivered does not re-stamp", () => {
    db.decisions.insertCall({ ...base, ts: 1, note: "old", noteSession: "s1" });
    expect(db.decisions.claimNotes("s1", 700_000)).toEqual([]);
    const id = db.decisions.insertCall({ ...base, ts: 5000, note: "n2", noteSession: "s2" });
    db.decisions.claimNotes("s2", 5001);
    db.decisions.markDelivered([id], 9999);
    expect(db.decisions.list({}).find((r) => r.id === id)?.deliveredAt).toBe(5001);
  });

  it("drain returns each note once", () => {
    db.decisions.insertCall({ ...base, ts: 5000, note: "a", noteSession: "s1" });
    expect(decisionDrainNotes(db, "s1", 5001)).toBe("a");
    expect(decisionDrainNotes(db, "s1", 5002)).toBeUndefined();
  });
});
