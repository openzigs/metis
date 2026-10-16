# ADR 0021 — A reader-sized BRD: a main document plus an appendix

- **Status:** Accepted. Ships behind `DOCS_GEN_BRD_LAYOUT=reader`, off by default, until a
  model run has measured it (#1074)
- **Date:** 2026-10-16
- **Issue:** GitHub #1175 (epic #1189)
- **Related:** #1070 (the topic plan this builds on), #995 (topics left out for length),
  #1041 (the walkthrough's answer key), #706 (the walkthrough)

## Context

METIS is mainly for business analysts, and the BRD is what an analyst gives to stakeholders.
In walkthrough run 9 the full-scope Miniflux BRD scored 15/15 on coverage and 15/15 on
accuracy against the answer key. It was also **247,171 characters**, about 60–70 printed
pages: the 250,000-character document cap (`DOCS_GEN_DOCUMENT_MAX_CHARS`) was spread over
the catalogue sections, one topic per module, so its length grew with the repository rather
than with what a reader needs. Only the Executive Summary was written for a business reader.
Even at that length, 65 topics were left out (#995).

## Decision

The owner's decision (issue comment, 2026-10-16): **one document, a main part plus an
appendix**.

- **Main document, about 40–60k characters (12–18 pages):** Executive Summary, Scope and
  the business domain; Core Business Capabilities; Key Business Rules; Requirements with
  their acceptance criteria. It is written for someone who does not know the code.
- **The requirements are reconstructed from the code, and say so.** This path reads the
  Phase-1 code facts, not the project's stored, approved requirements. So the section is
  titled **Requirements Reconstructed from the Code**, its items are numbered `RC-n` (not an
  id scheme a stored requirement uses), and METIS, not the model, puts a fixed lead-in under
  its heading: inferred from the code, not the approved requirements, which are in METIS
  under Requirements or in a requirements-scoped BRD, and the numbers are local to the
  document. Filling this section from the approved requirements when a project has them is
  a follow-up.
- **The rules a reader signs off get the catalogue's bar.** Key Business Rules states literal
  limits, defaults and periods, so it is gated at the default code-fidelity faithfulness bar
  and reads the same inputs (the rules slice and the mined-rule inventory with `file:line`)
  as the appendix's Business Rules & Policies.
- **Appendix in the same document:** the module-by-module detail (the Business Rules &
  Policies catalogue, Key Workflows, Calculations & Formulas, Data & Domain Model,
  Integrations & Glossary), so nothing is lost and the reader can stop after the main part.
- **Not chosen:** a separate companion document (two documents to keep in sync), and a short
  summary only (it loses the per-module coverage that the answer key checks).

### How it is built (`server/src/lib/docs-gen/brd-layout.ts`)

1. **The main part's budget comes from per-section targets in the plan.** Each main section
   is a single-call section of the #1070 topic plan asking for its own target: Executive
   Summary, Scope & Domain 8k, Capabilities 12k, Key Business Rules 12k, Requirements
   Reconstructed from the Code 16k, **48k together**. The main part is planned *first*, within
   `min(48k, 40% of the document budget)`. Every main prompt states its target as a length
   limit. The layout turns the plan on for the BRD whatever `DOCS_GEN_TOPIC_PLAN` says,
   because the targets are what hold the main part to its length.
2. **A cap holds it at assembly.** A model does not always keep to a stated length. The main
   sections are fitted to `min(60k, 50% of the body limit)`, so whatever the model wrote, the
   main part is at most 60k under the default caps. Not every main section is a summary of
   the appendix: Capabilities and Key Business Rules are, but the opening and the
   reconstructed requirements have nothing behind them there. So the summaries give up text
   **first**, down to a floor of 4k each, and only then are the other two cut. Each cut
   section's closing note says which it is: "the detail behind this section is in the
   appendix" for a summary, "what was left out is not elsewhere in this document; provenance
   lists it" for the others. What is cut is listed in provenance, as every other cut is.
3. **The appendix gets the rest of the 250k cap.** At planning it is planned in the document
   budget less the footnote reserve less what the main sections were given. At assembly it
   is fitted to the body limit less the main part *as fitted* and the divider, so room the
   main part does not use goes to the appendix. Its sections are the catalogue layout's own
   sections, unchanged, behind an H1 `# Appendix: Module-by-Module Detail`.

### Why 48k

48k is exactly two single-call asks (2 × `SINGLE_CALL_SECTION_CHARS`), which is what the
Overview and Capabilities sections already asked of the plan. In the catalogue layout three
single-call sections (Overview, Capabilities, Integrations & Glossary) asked 72k. In the
reader layout the four main sections ask 48k and Integrations & Glossary keeps its 24k, so
the appendix's catalogue sections are planned **the same budget, topic for topic**, under the
default cap. `holistic-synthesizer-reader-layout.test.ts` holds this on a project whose
catalogue outgrows the budget. **That equality holds at planning time only.** At assembly the
appendix is fitted to the body limit less the main part as written, and the main part has
two more sections than the catalogue's Overview and Capabilities: when a run-9-sized BRD fills
the cap, the appendix can lose more at assembly than the catalogue layout does. #1074
measures it.

### What this does not do: #995

Moving the catalogue to an appendix **does not by itself bring the topics left out to zero.**
The appendix is the same catalogue under the same 250k cap with the same budget, so it plans
out the same topics, and they are listed in provenance as before. Getting to zero means a
larger cap for the appendix, or asking less of each topic. Both are #995's to decide, with
#1074's run data.

## Consequences

- **Cost (an estimate, not measured).** Two more section calls, Key Business Rules and the
  reconstructed requirements, each with its own fact-check (claim extraction and judge):
  about 4–6 more model calls per BRD, more with hybrid escalation, and roughly 160–260k more
  input and 16–20k more output tokens. That is about **$0.05–0.10 more per BRD on
  `deepseek-flash`** ($0.30/$1.20 per MTok), about $0.30–0.40 on `deepseek-v4-pro`, less with
  cache reads, paid again on a regenerate. Small next to run 4's $1.91 BRD.
- The layout applies to every BRD generated from code (scope full, repository or path
  prefix), not only the full scope.

- With `DOCS_GEN_BRD_LAYOUT` unset or `catalogue`, a BRD is generated exactly as before
  (the #1070 off-path fixture still passes byte for byte).
- With `reader`, a BRD's sections are rewritten once on its next generation, as with any
  change to its prompts.
- The requirements-scoped BRD (`requirements-scope.ts`) is built from stored rows, not by
  this path, and is unchanged.
- The walkthrough scores the BRD on a sign-off rubric as well as on the answer key
  (`docs/walkthroughs/TEST_PLAN.md`, Phase 9 and J1.7).
- Whether the main part reads well, and how often a model overruns its targets, is for a
  model run to say: #1074 runs DeepSeek against Sonnet on this layout.
