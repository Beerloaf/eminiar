---
name: adjudicator/fetch-and-written-docs
kind: decision
tags: []
related: [file:src/adjudicator/features.ts, file:tests/unit/adjudicator-sim-regression.test.ts]
created: 2026-11-05T08:09:21.297Z
updated: 2026-11-05T08:09:21.297Z
---

Adjudicator fetch/docs triggers are object-based (swarm run 20261104-672098, task #120, review #98 F5-F8, branch feature/adjudicator, 2026-11-05).

Rules in src/adjudicator/features.ts:
- fetch|download|crawl|scrape count only with documentation as the object (FETCH_OBJECT). That object is one of:
  - a URL;
  - a docs noun heading the noun phrase (DOC_HEAD, ended by end, punctuation or a closed-class word; never a page of results);
  - a package as the whole object;
  - "the latest".
  This applies both to the lead phrase (docs 0.7) and to the FETCH flag's verb. "download button does nothing" and "crawl depth should be configurable" are code.
- A doc that is the object of a write verb (WRITTEN_DOC) is writing:
  - edit verbs → edit_small;
  - add/write/draft/create → implement;
  - rewrite/restructure → refactor.
  These phrases run before the docs phrases. The FETCH flag is tested with those matches blanked, so "update the changelog" is not a fetch.
- The format lead takes code as its object (a determiner, a file or dir/, code but not "code blocks", src, files, changed, staged, modified) or "with <formatter>".
- "At once" means batch only after an enumeration ("lint and typecheck at once", "both at once"). Bare "at once" means "now".
