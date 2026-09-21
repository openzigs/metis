# Security Reviews

Security audits, threat-model documents, and pen-test reports for METIS.

## Index

Audits are kept private until every finding they record is fixed. Report a suspected
vulnerability through [`SECURITY.md`](../../SECURITY.md).

## Conventions

- File naming: `YYYY-qN-<topic>.md` (calendar-quarter audits) or `YYYY-MM-DD-<topic>.md` (ad-hoc).
- Each audit has a section per OWASP Top 10 item, an explicit verdict (PASS / FINDING / N/A), severity for findings, and a follow-up issue link if the severity is Medium or higher.
- Findings labelled `security` in GitHub Issues; High/Critical findings get linked back from the parent epic.
