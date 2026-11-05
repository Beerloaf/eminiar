---
name: docs/manifest-write-refusal
kind: decision
tags: []
related: [file:src/docs/manifest.ts, file:src/docs/add.ts, file:src/config.ts, file:tests/unit/docs.test.ts, file:docs/configuration.md]
created: 2026-11-05T09:32:59.134Z
updated: 2026-11-05T10:39:20.613Z
---

Docs manifest writes never overwrite a manifest they could not read, never leave the project and never reduce a manifest (task #134, swarm run 20261104-672098; extended by task #146, swarm run 20261105-f530e8, pre-PR review F1 + F5, branch feature/adjudicator, 2026-11-05).

src/docs/manifest.ts probeManifestAt(file, {root?, write?}) returns missing | ok{manifest} | refused{reason}. Always refused: over MANIFEST_MAX_BYTES (1 MiB), not a regular file, dangling symlink, unreadable, invalid JSON (e.g. merge conflict), not a JSON object. With root: lexically outside root, the nearest existing parent folder realpath outside realpath(root) (a committed .eminiar symlink), or the file a symlink resolving outside root. With write: ANY symlink is refused, even one to a file inside the project (decision: a rename would replace the committed link, writing through edits a file the config does not name). The write probe also refuses a manifest a write would reduce: version !== 1 (or missing), top-level keys other than version/sources, sources present but not an array, or entries normalize() dropped (bad name, duplicate, unknown kind).

Readers (readManifestAt(file, root?) / readManifest(ctx), used on hook paths) fail open to an empty manifest and stay lenient on version/entries. Writers must use readManifestForWrite(ctx), which throws ManifestRefusedError(file, reason). writeManifest probes again, mkdirs, rechecks the location, then writes a temp file in the same folder with flag wx, copies the old file mode, and renameSync's it over the manifest (no write-through). addDocSources (src/docs/add.ts) rethrows ManifestRefusedError so em_docs returns one error.

Config: docs.manifest has a schema pattern PROJECT_RELATIVE_PATH_RE (src/config.ts; no leading / or \, no drive letter, no .. segment, no NUL), in eminiar.config.schema.json too. loadConfig drops an unsafe docs.manifest from the project eminiar.config.json only (withoutUnsafeDocsManifest, stderr note), so the rest of both layers survives; an unsafe personal value is a schema error (whole config to defaults, the pre-existing behaviour). A new writer must follow the same pattern and never write after a plain readManifest. Open follow-up: src/hooks/routing.ts docsSourceFor still calls readManifestAt without root.
