---
name: project_go-call-resolver-binds-by-bare-name
description: go-call-resolution.ts binds Go calls by bare callee name; safe for impact analysis, false positives where a bound edge is a positive claim
metadata:
  type: project
---

`impact-analysis/go-call-resolution.ts` binds Go calls by bare callee name (the parser stores only the field name for every selector call, stdlib included), which is safe for impact analysis but produces false positives for any consumer where a bound edge is a positive claim such as "tested by" — check that when the resolver gains a new caller.

**Why:** `parsers-tree-sitter.ts` records `resp.Body.Close()`, `errors.New()` and `t.Run()` as unresolved `Close` / `New` / `Run` edges; the receiver is used at ingest and not persisted on `CodeEdge`. The resolver binds whenever exactly one project function of that name is visible from the caller's package. On PR #1086 that made "Tested by" (#1034) read `proxyURL.String()` as testing `configOptions.String`, `time.Now()` as `timezone.Now`, and `runtime.Version()` in `TestVersionHandler` as `client.Version` (all found by reading Miniflux v2.3.3 source against the bound links).

**How to apply:** a new caller of `loadResolvedGoCalls` / `resolveGoCalls` must say whether a false bind is harmless (a wider blast radius) or a claim (coverage, ownership, "implemented by"). For a claim, narrow in the CONSUMER, not the resolver: `traceability/go-inferred-call-names.ts` (two-word names, stdlib compound denylist, or a same-package test named for the callee; unexported names same-package only), give the result its own lower-confidence label, and keep it out of any guard that can hide ingest-resolved results. Measure on a real graph before and after: a first rule that looked right dropped 92 true `Validate` links.
