# METIS e2e Fixture — Sample Requirements

This file is consumed by the deterministic full-flow Playwright suite.

## Goals

- Verify document upload through the real Library UI flow
- Exercise the analysis pipeline against the offline-stub AI provider
- Drive a publish dry-run without touching api.github.com
- Schedule and cancel a job to validate the Tasks view

## Functional Requirements

1. The system shall accept Markdown and PDF uploads up to 25MB.
2. The system shall enqueue uploaded documents for RAG ingest.
3. The system shall complete an analysis run within the cost cap.
4. The system shall expose a publish dry-run preview before any API write.
5. The system shall surface scheduled jobs and their tasks in the Tasks view.

## Non-Functional Requirements

- Determinism: every step is reproducible offline.
- Isolation: the spec runs against a dedicated SQLite database and isolated data dirs.
