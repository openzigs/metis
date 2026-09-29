---
name: mutation-restore-uncommitted-edits
description: Restoring a mutated file with git checkout reverts to HEAD and silently drops uncommitted edits in that file; commit before mutating.
metadata:
  type: project
---

On PR #404 a mutation test restored `GenerateIssuesAction.tsx` with `git checkout --`, which also discarded the uncommitted fix being tested; only `git status` showed the file was no longer modified. The restore target is HEAD, not "the file before the mutation".

**Why:** `git checkout -- <file>` restores the index/HEAD copy.

**How to apply:** commit the change before any mutation you will undo with `git checkout`, or back the file up with `cp` to a `mktemp` path and restore from that. Links: [[mutation-restore-must-not-use-git-checkout]].
