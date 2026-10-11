# Feature Request: Track reading time — add read_at timestamp to entries

## Problem

Miniflux currently does not record when an entry was read. The `changed_at` field updates whenever an entry is modified (including status changes), but there is no dedicated field to know when exactly a user marked an entry as read.

This makes it impossible to:
- Query "articles read today/this week"
- Build reading statistics/history dashboards
- Sort entries by reading time
- Integrate with external tools (e.g., Grafana) for reading analytics

## Proposed Solution

Add a `read_at` TIMESTAMP column to the `entries` table. When an entry transitions from `unread` → `read`, set `read_at = NOW()`. Expose it via the API and support filtering with `read_at_after` / `read_at_before` parameters.

### API changes

`GET /v1/entries?status=read&read_at_after=2026-05-15T00:00:00Z`

Entry JSON response adds:
```json
{
  "id": 123,
  "title": "...",
  "status": "read",
  "read_at": "2026-05-15T10:30:00Z",
  ...
}
```

### Database migration

```sql
ALTER TABLE entries ADD COLUMN read_at TIMESTAMPTZ;
CREATE INDEX entries_read_at_idx ON entries(read_at);
```

Update the `mark_entry_as_read` query to also set `read_at`.

## Why

This is a minimal change (one column, one index, one field in API response) that unlocks a wide range of use cases: personal reading analytics, external dashboard integration, and better reading history UX.

Existing feature requests like #2706 (mark as seen) touch on related UX but dont address the timestamp tracking need.
