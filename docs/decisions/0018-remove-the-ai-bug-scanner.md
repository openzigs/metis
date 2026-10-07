# 0018 — Remove the AI bug scanner

- **Status**: Accepted
- **Date**: 2026-10-03
- **Issue**: [#799](https://github.com/openzigs/metis/issues/799) (epic), recorded by
  [#805](https://github.com/openzigs/metis/issues/805)
- **Supersedes**: [ADR 0011](0011-scan-finding-materialisation-provenance.md)
- **Updates**: [ADR 0010](0010-finding-provenance-invariant-is-a-ci-ratchet.md) (one
  measured write site is gone)

## Context

METIS shipped an AI bug scanner: per-repository scans that made a model call per
code-graph symbol, a triage workflow that promoted approved findings into `Finding`
rows, natural-language rule sets compiled into scanner rules, a `scanner.run-scan`
scheduler task, and the **Bug Rules** and **Bug Scans** pages under a project's
**Code** tab. It lived in `server/src/lib/scanner/` and its routes.

Two pieces of it served other features and were moved rather than deleted: the
generic finding-publisher engine, now in `server/src/lib/publishing/` (#800) and used
by Deep Dive → Issue and Impact Analysis → Jira; and the JSON model-call helper, now
`server/src/lib/ai/json-llm-client.ts` (#801), used by requirement → data-mapping
suggestions.

## Decision

Remove the scanner: its UI and e2e specs (#803), its server code, routes and scheduler
task (#804), and its documentation (#805). METIS is pre-1.0 (`0.x`), so the UI and API
get no deprecation period.

## Rationale

- **Overlap with SAST.** METIS was turning into a Swiss army knife. Dedicated SAST tools
  find bugs better, and this repository already runs both CodeQL
  (`.github/workflows/codeql.yml`) and Semgrep (`.github/workflows/sast.yml`).
- **Cost and time do not scale.** A scan makes about one model call per symbol, so a
  repository of about 4k symbols takes about 88 hours on DeepSeek. In the #706
  walkthrough (miniflux/v2, 4,252 symbols), 4 symbols took about 15 minutes and about
  276k tokens over 67 calls before the scan failed. #761 measured 42,489 input +
  182,709 output + 50,684 cache-read tokens.
- **Maintenance load.** #718 (scan fails on DeepSeek), #759 (task timeout restarts from
  symbol 0) and #761 (cost under-reported, partly found through the scanner) were
  fixed. #747 (scanner UI cost and repository id) and #764 (bounded per-symbol
  concurrency) were closed as not planned.
- **Coverage remains.** The code agent and Deep Dive analysis still find issues in code.

## Data plan

The tables are **kept for one release**, then dropped in
[#806](https://github.com/openzigs/metis/issues/806):

- `Scan`, `ScanFinding`, `RuleSet` and `Rule`, with their migrations, stay in the schema
  unused for one release, so operators have one upgrade in which the data can still be
  exported before #806's destructive drop (see the export guidance in #806). It also
  means the removal can be reverted without a data migration.
- `Finding.scanFindingId` and `IssueLink.scanFindingId` stay too. Nothing writes either
  any more. `IssueLink` itself stays: it is the idempotency record for Deep Dive and
  Impact Analysis publishes, and #806 drops only its `scanFindingId` column.
- `Finding` rows materialised from approved scan findings (ADR 0011's `scanFindingId`
  provenance branch) remain until #806 decides their fate, because dropping the link
  leaves them with no provenance.
- Leftover `scanner.run-scan` task rows are inert and stay as history: #806 does not
  clear them (the `tasks` table is not a scanner table). See
  `docs/OPERATIONS.md` for what an operator sees in the meantime.

## Consequences

- ADR 0011 is superseded: the writer it fixed (`materializeTriagedFinding`) was deleted
  in #804. ADR 0010's ratchet now measures 6 `Finding` write sites across 4 files, down
  from 7 across 5.
- The `metis-scanner` issue label is no longer applied. It stays on the reserved list,
  so a suggested or added label cannot make a new issue look like scanner output.
- Finding-publish audit entries are now `publish.<github|jira>.<created|reused>` with
  `metadata.source` naming the flow, instead of `scanner.scanner.publish.*`.
- The `TokenUsage.agentStep` value `bug-scan` appears only on rows written before the
  removal.
