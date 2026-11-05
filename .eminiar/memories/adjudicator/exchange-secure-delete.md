---
name: adjudicator/exchange-secure-delete
kind: decision
tags: [adjudicator, privacy, sqlite, exchange-log]
related: [file:src/storage/sqlite/adjudicator.ts, file:tests/unit/adjudicator-store.test.ts, file:src/storage/sqlite/adapter.ts]
created: 2026-11-05T13:28:39.181Z
updated: 2026-11-05T13:28:39.181Z
---

Jev exchange deletes erase the bodies on disk (task #195, review-xchg R1/R9, swarm run 20261105-1d96f4, 2026-11-05, branch feature/adjudicator). SqliteAdjudicatorStore (src/storage/sqlite/adjudicator.ts) runs every exchange write, including exchangeInsert's inserts AND the newest-100 prune, exchangePurge and the exchange DELETE in purge(), with PRAGMA secure_delete=ON. The flag is scoped via secureDelete(fn) and the previous value restored, so other adjudicator writes keep the default. Use ON, not FAST: bodies sit in overflow pages. The inserts need it too: a b-tree split turns the root leaf into an interior page and leaves old cell text in its unused area, which the prune's zeroing never reaches. After exchangePurge, after purge(), and after a prune that deleted rows, checkpoint() runs PRAGMA wal_checkpoint(TRUNCATE) with busy_timeout 0. It never throws and is skipped inside a caller's transaction. Cost on the hook path is ~0.8 ms per pruning insert vs 0.08 ms, with no lock wait. R9: exchangePurge returns 0 and purge() skips the table when adjudicator_exchanges is missing on a v9+ db (hasExchangesTable via sqlite_master). Gap: SqliteAdapter.purge runs store.purge() inside its own transaction and then VACUUMs, so the -wal keeps the text until adapter.ts checkpoints after the VACUUM (follow-up task #199). Tests: tests/unit/adjudicator-store.test.ts, describe 'deleted exchanges leave the disk', grep the db and -wal bytes with a second connection open.
