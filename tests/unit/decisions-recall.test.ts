import { describe, expect, it } from "vitest";
import { decideRecall } from "../../src/decisions/features/recall.js";
import type { Answers } from "../../src/decisions/types.js";

const spec = {
  path: "prompt" as const,
  query: "q",
  items: [
    { id: "memory:a", text: "a" },
    { id: "memory:b", text: "b" },
    { id: "memory:c", text: "c" },
  ],
  baseline: ["memory:a", "memory:b"],
};
const yn = (p: number, calibrated: boolean) => ({ kind: "yes_no" as const, p, calibrated });
const ans = (...a: Array<ReturnType<typeof yn>>): Answers =>
  Object.fromEntries(spec.items.map((it, i) => [it.id, { relevant: a[i]! }]));

describe("decideRecall", () => {
  it("reorders by probability and drops what a calibrated provider rates below dropBelow", () => {
    const d = decideRecall(spec, 0.25)(ans(yn(0.1, true), yn(0.4, true), yn(0.9, true)));
    expect(d.decision).toEqual(["memory:c", "memory:b"]);
    expect(d.changed).toBe(1);
  });
  it("never drops on an uncalibrated answer, only reorders", () => {
    const d = decideRecall(spec, 0.25)(ans(yn(0.1, false), yn(0.2, false), yn(0.3, false)));
    expect(d.decision).toEqual(["memory:c", "memory:b", "memory:a"]);
  });
  it("reports no change when the verdict agrees with the baseline", () => {
    const d = decideRecall(spec, 0.25)(ans(yn(0.9, true), yn(0.8, true), yn(0.1, true)));
    expect(d.changed).toBe(0);
  });
});
