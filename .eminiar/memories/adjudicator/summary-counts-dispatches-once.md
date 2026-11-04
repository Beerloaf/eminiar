---
name: adjudicator/summary-counts-dispatches-once
kind: decision
tags: []
related: [file:src/storage/dispatch.ts, file:src/storage/sqlite/adjudicator.ts, file:src/adjudicator/savings.ts, file:src/storage/types.ts]
created: 2026-11-04T14:58:00.587Z
updated: 2026-11-04T14:58:00.587Z
---

Adjudicator summary counts dispatches once (task #81, swarm run 20261104-483f39, 2026-11-04, branch feature/adjudicator). src/storage/dispatch.ts is a pure storage-layer module (type-only imports) holding tierOf, KeptModel, KEPT_MODEL_FLAG, keptModel, keptPin, keptDispatch and dispatchFilter. src/adjudicator/savings.ts re-exports them, so existing import sites are unchanged. Storage must not import adjudicator runtime modules, which is why these helpers live in storage.

- dispatchFilter(rows): an agent row counts as itself, whether it is in a swarm, outside one, or a fork. A plan row counts only when no agent row in `rows` has the same (runId, taskId). Prompt, mcp, tool and test rows are not dispatches.
- keptDispatch(row): returns the KeptModel flag when actualModel is set, the row has a flag, and for a pin keptPin(row) holds. Otherwise it returns undefined.
- summary().keptModel = keptDispatch over the counted dispatches. It equals savingsReport().keptModel for the same rows and does not depend on action, so an apply-mode FORCE row that ran also counts.
- summary().rates.follow = followed / counted dispatches whose action is advised, followed or ignored and whose row has no KeptModel flag. Reconcile never follows a flagged row, so flagged rows leave the rate even before they run, and a pin row where a model was passed stays out too.
- apply and respect rates still use byAction over all rows. Plan rows are always 'advised', so they do not inflate those rates.
- Before this change, prompt rows and plan rows sat in the follow denominator: a fully followed swarm run capped at 50%, and the store test pinned 3/24 (now 3/4). The old SQL KEPT_MODEL_SQL was removed.
