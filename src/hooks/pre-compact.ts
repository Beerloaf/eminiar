import { featuresWanted } from "../config.js";
import { getContext } from "../context.js";
import { renderGuide } from "../session/guide.js";
import { getStorage } from "../storage/index.js";
import type { HookHandler } from "./types.js";

export const SNAPSHOT_BUDGET = 2048;

/**
 * PreCompact cannot inject context; it only has time to persist a snapshot.
 * SessionStart(source=compact) replays it as the Session Guide.
 */
export const preCompact: HookHandler = async (input) => {
  const ctx = getContext(input.cwd);
  const db = getStorage(ctx, { vectors: false });
  const sessionId = input.session_id || "unknown";
  const body = renderGuide(db, sessionId, SNAPSHOT_BUDGET);
  if (!body) return undefined;
  const snapshotId = db.snapshotInsert({ sessionId, trigger: input.trigger ?? "unknown", body });
  // Jev features (off by default): may queue a detached job that rewrites this snapshot.
  if (featuresWanted(ctx.config.adjudicator)) {
    try {
      const { decisionPreCompact } = await import("../decisions/hooks.js");
      await decisionPreCompact(ctx, db, sessionId, snapshotId);
    } catch {
      // Jev is optional
    }
  }
  return undefined;
};
