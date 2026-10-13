---
name: decided-verdicts-need-positive-evidence
description: A resolver verdict that downstream code treats as DECIDED (Go `external`) may only be issued on positive evidence; "could not determine" must stay undecided so the fallback still runs.
metadata:
  type: project
---

A resolver verdict that downstream code treats as DECIDED must only be issued on positive evidence. "Could not determine" must stay undecided, so the fallback still runs.

In `server/src/lib/code-graph/go-type-resolution.ts` the verdict `external` means "no project callee": ingest binds nothing for it, and both fallback loaders, `search_code_graph` and the Spec Kit caller list skip the edge for good (`GO_DECIDED_UNBOUND`). The first version of #1071 returned it whenever a lookup came back empty, and four different "empty" cases were not evidence at all:

- a directory holding a second package clause (the standard `//go:build ignore` + `package main` generator beside `package storage`): the package could not be named, so every call into it was "external". Miniflux has no such directory, so no measurement showed it; `golang.org/x/*`, Prometheus and Kubernetes do.
- a non-test file under `tests/`, hidden by the code-graph's test-path convention where Go's own rule is `_test.go` only;
- a name declared in a file that failed to parse;
- a tree with no `go.mod`, where `errors` and `net/http` matched project directories of the same name (the opposite error, same cause: spelling taken for evidence).

**Why:** an undecided verdict costs a name-based guess; a wrongly decided one removes a true edge from every reader, labelled as proven. The two errors are not symmetric, and only the first is recoverable later.

**How to apply:**

- For each decided verdict, write down what counts as positive evidence, in the module header, and test both sides of each line with a case where the careless answer is the decided one.
- Make "not found" a distinct value from "known absent" inside the resolver (`undeclared` with a `decided` flag, `ImportTarget` with `project` / `external` / `unknown`), so a new code path cannot fall into the decided branch by default.
- Completeness is evidence: "the package does not declare it" decides only when every file of that directory was read (`incompleteDirs`).
- Measure on a tree that HAS the awkward layout. A clean sample project hides the whole class.
- A test that the decided verdict is not issued must put a name-bindable candidate where the fallback would find it (the caller's own file), or it passes whatever the code does.
- Where the evidence is weaker than the label, change the LABEL, not the reader: a member or result of an external value whose type was never examined is `external-assumed`, still decided, and the breakdown says how many of each there are. "11,276 proven external" in the first PR body was about 6,000 proven.
- A hand-kept "known interfaces" list is not positive evidence for "everything else is concrete". Generate the complete list (`scripts/gen-go-stdlib-snapshot.mjs`) and test that it cannot drift.
- A directory with files the resolver did not read is incomplete whatever the reason: unparseable, unreadable, hidden by `.metisignore`, or a build-ignored sibling.
