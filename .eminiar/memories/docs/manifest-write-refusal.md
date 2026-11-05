---
name: docs/manifest-write-refusal
kind: decision
tags: []
related: [file:src/docs/manifest.ts, file:src/docs/add.ts, file:tests/unit/docs.test.ts]
created: 2026-11-05T09:32:59.134Z
updated: 2026-11-05T09:32:59.134Z
---

Docs manifest writes never overwrite a manifest they could not read (swarm run 20261104-672098, task #134, follow-up to #133, branch feature/adjudicator, 2026-11-05). src/docs/manifest.ts probeManifestAt(file) returns missing | ok{manifest} | refused{reason}. Refused covers: over MANIFEST_MAX_BYTES (1 MiB), not a regular file, dangling symlink, unreadable, invalid JSON (e.g. merge conflict), or not a JSON object. Readers (readManifestAt/readManifest, used on hook paths) still fail open to an empty manifest. Writers must use readManifestForWrite(ctx), which throws ManifestRefusedError(file, reason) with the path and reason in the message. upsertSources and removeSource use it, and writeManifest probes again as a guard. addDocSources (src/docs/add.ts) rethrows ManifestRefusedError rather than retrying per source, so em_docs returns a single error. A new writer must follow the same pattern and never write after a plain readManifest.
