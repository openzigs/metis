# Restoring a mutation with `git checkout --` destroys uncommitted work

**What happened (2026-09-22, #72/#73/#77).** A scripted mutation loop applied one
mutation per file, ran the suites, then restored with
`git checkout -- <path>`. On the third mutation the anchor string was "not found".
The mutations were being applied to a tree where the *implementation under test no
longer existed*: `git checkout --` restores the file from **HEAD**, and the
implementation was still uncommitted, so the first restore silently reverted
`judge.ts` to `origin/main` and the second to `suggestion-generator.ts`.

**Why it is easy to miss.** The run does not fail. It reports mutation results that
look plausible — the second mutation showed *more* tests red than the real mutation
would, because it was running against a file with the whole feature missing. Read as
"my tests are strong", when it actually measured nothing about that mutation at all.
A mutation proof made this way is worthless in both directions.

**Do instead.** Keep the pre-mutation text in memory (or a scratch copy) and write it
back, then assert the restore:

```python
backup = open(path).read()
open(path, "w").write(backup.replace(old, new, 1))
try:
    out = run_suites()
finally:
    open(path, "w").write(backup)
assert open(path).read() == backup
```

Committing a checkpoint before mutating also removes the trap, and is worth doing
anyway: the loop is the point in a `code-issue` run where the working tree is most
exposed. `git stash push/pop` is safe (it preserves the working copy); `git checkout
--`, `git restore` and `git reset --hard` are not.

**Symptom to recognise.** A mutation's anchor string suddenly "not found" in a file
you know you edited, or a later mutation reporting failures in a suite it does not
touch. Both mean the tree drifted mid-loop — stop and diff against your own changes
before believing any result from that run.
