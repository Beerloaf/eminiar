import type { DecisionFeatureModule } from "./feature.js";
import type { DecisionFeature } from "./types.js";

/**
 * The feature modules, loaded lazily so a process pays only for the features that are on.
 * Written once by the foundation; each file in ./features belongs to one feature.
 */
export const FEATURES: Record<DecisionFeature, () => Promise<{ feature: DecisionFeatureModule }>> =
  {
    recall: () => import("./features/recall.js"),
    memory: () => import("./features/memory.js"),
    commit: () => import("./features/commit.js"),
    compaction: () => import("./features/compaction.js"),
    swarm: () => import("./features/swarm.js"),
    docs: () => import("./features/docs.js"),
  };

/** The module of `f`, or undefined when it cannot be loaded (a broken feature never breaks a caller). */
export async function loadFeature(f: DecisionFeature): Promise<DecisionFeatureModule | undefined> {
  try {
    return (await FEATURES[f]()).feature;
  } catch {
    return undefined;
  }
}
