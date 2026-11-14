---
name: source-redaction-read-path-pitfalls
description: Review lessons for source/code-ACL redaction and access-check PRs: metadata blobs, stored outputs, requirement tools, empty-vs-NULL, admin early return, trial-merge (#2475-#2507).
metadata:
  type: project
---

**Why:** the 2026-11 access-control PRs (#2475-#2507) kept hitting the same few gaps.

**How to apply:**

- **Metadata blob** (#2487): when a redaction filter swaps analysis rows for placeholders, check the run's metadata too. `toSnapshot` returns it almost whole, with per-requirement copies of the text (structuredRequirements, criteria proposals). Seed metadata in fixtures before trusting `not.toContain`.
- **Stored outputs** (#2495): narrowing "hidden" rows by current state (status, deletion, title prefix) reopens fail-closed paths for outputs computed earlier. Test reading a stored check after the source row is rejected, deleted or renamed.
- **Non-code tools** (#2486): `get_requirement` (code links, trace) bypasses the per-document code ACL in chat and MCP. A surface adding code ACLs must check non-code tools that print file paths.
- **Empty vs NULL** (#2481): rows from passes that read the whole run (synthesis, elicitation, completeness, cross-doc) cite nothing yet derive from everything. An empty source set there is fail-open; NULL is not.
- **Admin early return** (#2489): `checkProjectAccess` returns early for admins, so a deletedAt/existence check placed after an access check decides only for admins. Harnesses use developer tokens: add an admin case and mutate that branch.
- **Read-set recording** (#2507): it sits on the per-file `isHidden` check, so callers looping `isHidden` over many files (list_files, fused seed, index-status) record reads in bulk. Starter-run regenerate tests need a synthesis row in the fixture or they pass where production fails closed.
- **Re-ingest** (#2475): once re-ingest keeps old chunks live until commit, any action revoking the in-flight ingest's generation marker must delete live chunks itself.
- **Concurrent PRs** (#2501): a PR green on an older base can break main when another PR rewrites the same security function. Before merging anything touching a source-redaction path, trial-merge onto origin/main and re-run the source-redaction-2447 and 2491 suites.
- **Panel rounds** (#2487): every surface a fix touches widens the panel's next round (6 rounds). Give the fixer the full surface list up front.
