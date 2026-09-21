# AI Bug Scanner

> Epic #708 — connected-repository
> bug discovery using a hybrid rule + LLM scanner. This document is the canonical operator
> guide for the feature.

## Overview

The AI bug scanner inspects every code symbol that survives Metis' static gates and
asks a two-tier LLM whether the symbol matches any project-scoped natural-language rule
or any built-in heuristic bug category. Candidate findings flow through a triage queue
and only become first-class `Finding` rows when a human approves them.

```
                ┌──────────────────────┐
                │  user authors rule   │ rule-compiler → keywords + exemplars
                └──────────┬───────────┘
                           ▼
       ┌────────────────────────────────────────┐
       │  user grades ≥5 exemplars → rule active │
       └───────────────────────┬────────────────┘
                               ▼
   POST /repositories/:id/scans  →  enqueue scheduler task
                               ▼
                ┌──────────────────────────┐
                │      orchestrator         │  fresh-commit gate
                │   (per-symbol scanner)    │  prompt-fenced calls
                │      ▼                    │  budget cap (2M tokens)
                │   fp-filter (3-vote)      │  Haiku → Sonnet
                └──────────┬───────────────┘
                           ▼
                ┌──────────────────────────┐
                │       ScanFinding         │  pending triage
                └──────────┬───────────────┘
                           ▼
        triage approve → materialise Finding → publish
```

## Data model

See [docs/data-model.md](./data-model.md) for full schemas. The scanner adds:

| Model         | Purpose                                                                  |
| ------------- | ------------------------------------------------------------------------ |
| `RuleSet`     | Project-scoped collection of rules.                                       |
| `Rule`        | Natural-language rule with compiled keyword/exemplar metadata.            |
| `Scan`        | One scanner run against a repo commit; tracks status + token budget.      |
| `ScanFinding` | LLM candidate finding pending triage; idempotent on `fingerprint`.        |
| `IssueLink`   | One per published finding/provider; provides idempotency on republish.    |

`ScanFinding.fingerprint` is `sha256(projectId | qualifiedName | category | normalisedTitle)`,
the same fingerprint used in the publish marker `metis-finding:<fingerprint>` so reruns on
the same commit never double-file issues.

## Workflow

1. **Author rules** — `/projects/:id/rule-sets` UI. Each rule starts `draft`.
2. **Compile** — Haiku extracts keywords, symbol kinds, and required exemplars. Rule
   moves to `awaiting_grading` or `failed`.
3. **Grade** — at least **5 exemplars** must be graded with code samples, expected
   verdict, and human label. Rule moves to `active`.
4. **Start scan** — from the repository scanner page. The orchestrator enqueues a
   `scanner.run-scan` task on the existing scheduler.
5. **Triage** — `/projects/:id/scans/:scanId`. Approve, reject, or defer per finding.
   Approving creates a `Finding` row (materialisation).
6. **Publish** — approved findings can be sent to GitHub or Jira. Republish is a no-op
   thanks to `IssueLink` + the fingerprint marker.

## LLM strategy

| Stage         | Model                | Notes                                                      |
| ------------- | -------------------- | ---------------------------------------------------------- |
| Rule compile  | `claude-haiku-4-5`   | Single JSON extraction, deterministic schema.              |
| First pass    | `claude-haiku-4-5`   | Per-symbol, prompt-fenced, ≤8K token context cap.          |
| FP filter     | `claude-sonnet-4-6`  | 3-vote self-consistency, drops findings below 0.5 conf.    |

All prompts pass through `lib/scanner/prompt-fence.ts`, which strips ANSI escapes,
control characters, and prompt-injection markers (`SYSTEM:`, `</human>`, etc).

## Budget + freshness gates

- **Per-scan token cap** — default `2_000_000`, configurable per scan via `budgetCapTokens`.
- **Per-symbol context cap** — `8000` tokens of retrieved context.
- **Fresh-commit gate** — orchestrator aborts with `ERR_STALE_COMMIT` if the repo HEAD
  drifts away from `Scan.commitSha` while it is running.

## API

All routes are mounted under `/projects/:projectId/…`:

| Route                                                          | Permission       |
| -------------------------------------------------------------- | ---------------- |
| `GET    /rule-sets`                                            | `project.read`   |
| `POST   /rule-sets`                                            | `project.update` |
| `POST   /rule-sets/:setId/rules`                               | `project.update` |
| `POST   /rule-sets/:setId/rules/:ruleId/compile`               | `project.update` |
| `POST   /rule-sets/:setId/rules/:ruleId/grade`                 | `project.update` |
| `POST   /repositories/:repoId/scans`                           | `analysis.run`   |
| `GET    /repositories/:repoId/scans`                           | `analysis.read`  |
| `GET    /scans/:scanId`                                        | `analysis.read`  |
| `GET    /scans/:scanId/findings`                               | `analysis.read`  |
| `POST   /scans/:scanId/findings/:findingId/triage`             | `analysis.run`   |
| `POST   /scans/:scanId/findings/:findingId/publish`            | `issue.publish`  |

## Permissions

All scanner actions are scoped to project membership. Cross-project leakage is impossible
because:

- `RuleSet`, `Scan`, and `ScanFinding` are filtered by `projectId` in every query.
- Per-project RAG isolation is inherited from the existing code-graph services
  (`projectId` is a partition key on every vector and BM25 index).
- Publish uses project-scoped vault credentials.

## Audit

Every mutation emits a structured audit event:

| Action                            | Trigger                                              |
| --------------------------------- | ---------------------------------------------------- |
| `rule_set.created`                | `POST /rule-sets`                                    |
| `rule.created`                    | `POST /rule-sets/:setId/rules`                       |
| `rule.compiled` / `rule.compile_failed` | compile endpoint outcome                       |
| `rule.activated`                  | grade endpoint when activation succeeds              |
| `scan.started`                    | `POST /repositories/:repoId/scans`                   |
| `scan_finding.triaged`            | triage endpoint                                      |
| `scan_finding.published`          | publish endpoint                                     |

## Operational runbook

See [docs/OPERATIONS.md](./OPERATIONS.md#ai-bug-scanner) for failure modes and recovery.
