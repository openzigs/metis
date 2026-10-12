---
name: requirement-id-guard-and-recording-doubles
description: Only the requirement-grounded code path validated a model-supplied requirementId; id-bearing prompt text needs a non-compliant-model test on agentic and single-shot, new untrusted context goes to the code agent only, and a test double that ignores its arguments cannot prove text is never a query.
metadata:
  type: project
---

In `orchestrator.ts` only the requirement-grounded code path validated a model-supplied `requirementId` against the pass's requirement set; any PR that adds id-bearing text to the code agent's prompt needs a non-compliant-model test on the agentic and single-shot paths. The document agent's extracted requirements feed the code pass, so new untrusted context goes to the code agent only. A test double that ignores its arguments cannot prove "this text is never used as a query" — record the calls and assert.

**Why:** PR #1111 (#1027) put a plan context (task ids such as `T01`, component names, any `- [NR-9] …` line) into the code agent's prompt with a rule never to write one as a `requirementId`. Review reproduced a finding carrying `requirementId: "T01"` persisted as `T01` on the agentic and single-shot paths and as `null` on the grounded one: the guarantee was prompt-only on two of three paths while the user guide stated it as fact. The same PR's pipeline harness passed `retrieve: async () => []` and switched fused retrieval off, so a build that joined the context into every retrieval query passed all 73 tests, and one that fed the stored context to the requirement splitter on regenerate or resume passed too.

**How to apply:**

- The guard is `clearUnknownRequirementIds` in `server/src/lib/analysis/requirement-id-guard.ts`. It runs in `runAgenticPass` at the one point where the loop's answer, the final-answer retry, the transcript salvage and the evidence-only salvage have all converged on `validated`, and in `runOneAgent` for the code agent. A new way for a code pass to produce findings must reach that point or call the guard itself.
- The legitimate id set is the RUN's code requirements (document-extracted `REQ-*` merged with the operator's `NR-*`), not one pass's slice: a split deep/standard pass may name a requirement of the other pass. A single-shot pass has no set (that is what makes it single-shot), so every id it writes is cleared; a regenerate that falls back to single-shot passes the set it reconstructed as `knownRequirementIds`.
- Test with a model that does not comply: `requirement-id-guard-pipeline-1027.test.ts` scripts a provider through each of the four agentic answer paths plus single-shot and grounded.
- To assert "never a retrieval query", drop the `retrieve` seam (it replaces retrieval whole and receives no query), set `ANALYSIS_FUSED_CODE_RETRIEVAL=true`, and inject a recording `knowledge.search` and `fusedCode.searcher`. Assert the recorder saw real queries (a requirement's words) before asserting the context's words are absent, or the test passes on an empty list.
- For regenerate and resume, compare what the rerun derives (requirement set, `computeAffectedCode` / `computeAffectedSchema` / `computeEscalations` arguments) with and without the stored context, and spell the expected ids out so two wrong runs cannot agree.
- The document agent is kept from run context by three layers: the pipeline's sequenced call does not pass it, `runOneAgent` strips it for every agent but `code`, and `buildSpecialistPrompt` returns early into `buildDocumentExtractionPrompt` with an explicit field list. The code-only gate in `buildSpecialistPrompt` protects the database and web agents, not the document agent.
