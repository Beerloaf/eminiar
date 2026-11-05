---
name: adjudicator/features-linear-regexes
kind: constraint
tags: [adjudicator, performance, regex, redos]
related: [file:src/adjudicator/features.ts]
created: 2026-11-05T07:48:50.398Z
updated: 2026-11-05T07:48:50.398Z
---

Adjudicator features.ts regexes must stay linear (swarm run 20261104-672098, task #114, branch feature/adjudicator, 2026-11-05). extractFeatures runs on the UserPromptSubmit hook path (2 ms p95 budget), and PATH_RE, SYMBOL_RE and STACK_RE scan the whole untruncated prompt. Three patterns were quadratic and got rewritten, with no change to any match result:
- PATH_RE gets a (?<![\w./-]) lookbehind, so a match starts only at a token boundary. Before the fix, a 32 KB dot-free token took 1.6 s and 128 KB took 28 s. The matches are identical because a mid-token match is also found from the token start, and a token holds at most one match.
- ENUM3 and LIST3 use (?<![\w.-])[.-]*\b instead of \b. "a.b.a.b" has a \b at every letter, so the old form cost 16 ms at 4000 chars. Counts and UI_PART item tests are identical, and only a leading ./- can now prefix the first item.
- STACK_RE: `.+\(?[^\s()]+:` became `.+[^\s()]:` (the same language), and the leading/trailing \s* became [^\S\n\r]* (the same boolean). The old form took 530 ms on a 32 KB "at xxx" line and 445 ms on 32 K blank lines.
Proof: 205,882 inputs (5,882 corpus strings plus 200 K fuzz) gave 0 extractFeatures diffs, and the eval dump is byte-identical. The worst case is now about 0.5 ms at 32 KB and about 3 ms at 128 KB. paths and symbols are deliberately NOT capped to SCAN_CHARS: a cap would change counts for long prompts and is no longer needed for speed. Rule for new regexes: never start an unanchored greedy class run (\b[\w.-]+ or [\w./-]+) that can fail at the run's end; anchor it with a lookbehind at the run start. Avoid \s* next to ^ or $ under /m. Never write a raw U+2028 in a regex literal (tools can turn the   escape into the raw character); [^\S\n\r] is enough.
