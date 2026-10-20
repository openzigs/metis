---
name: docs-gen-drop-retry-and-ledger
description: Docs-gen mid-stream drop retries (#1174/#1206) and the token ledger they write; which classifier sees which drop, and how to make a stopped-run test reach the ledger path. Links the older ledger entries.
metadata:
  type: project
---

From #1206 (2026-10-16). Checked against `main` at b16dcc30.

- **Two drop detectors, and you need both.** `isConnectionDropped`
  (`docs-gen/generation-failure-message.ts`) reads undici's own error and misses the Anthropic
  adapter's wrapped `anthropic stream failed (TypeError): terminated` (no `cause`, stamped
  502; walkthrough run 9's error). `classifyGroundingError`
  (`docs-gen/grounding/transient-retry.ts`) classes that as `stream-terminated`.
  `isMidStreamDrop` in `holistic-synthesizer.ts` uses both, minus `NEVER_A_DROP`
  (cancelled, config-error, client-error). Any new drop check must do the same.
- **A stopped-run test must wrap its own provider.** `synthesizeFinalDocument` uses the
  provider exactly as passed; only the router builders wrap it in `scopedToGeneration`
  (`generation-control.ts`). A test that passes a bare fixture provider never runs the
  aborted-call ledger path, so wrap the fixture provider itself.
- **Ledger history.** Before #1174 a mid-stream drop wrote no `token_usages` row at all.
- Exclusion tests for the retry: see [[test-falsifiability-traps]] ("X is not retried").

Older ledger entries, folded here (retired from the index 2026-10-16; files unchanged):

- [[usage-row-is-not-always-one-call]] — chat, discussion and failed rows sum several calls;
  pass `requests` so it is priced per call (#1092).
- [[side-column-readers-apply-writer-invariant]] — readers re-pricing from a side column use
  `ledgerRowSummedRequests`, not a shape check (#1092).
- A `section-failed` warning without `detailSafe: true` is rewritten by `publicDocWarnings` into the generic "details are in the server log" text. Text added by a builder never reaches the user unless it sets `detailSafe` (#1275).
- A new `DOCS_GEN_*` key in `config/key-registry.ts` also needs its `key-registry-parse-semantics` snapshot regenerated (`vitest -u` on that file). If the key does not affect output, add it to `RUN_CEILING_KEYS` in `generation-inputs.ts`, or every document's input fingerprint changes (#1274).
- Failure-message remedies must name a setting that exists. Phase 1 has an admin setting that takes `provider-default`, but grounding and local thinking are boolean env vars outside the registry (#1275).
