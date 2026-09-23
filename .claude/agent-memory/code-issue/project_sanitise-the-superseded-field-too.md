# Sanitising the current field is half the surface

METIS has repeatedly migrated a field to a new home while leaving a client-side
legacy parser reading the old one: `errorMessage` → `warnings` at #252, with
`resolveDocWarnings` in `ui/src/app/(authed)/projects/[id]/documentation/page.tsx`
still parsing the superseded column.

So when a "raw exception reaches the user" exposure is closed on the *current*
column (#67 / PR #80), grep the UI for a legacy fallback parse of the field it
replaced — the old rows were written by the old, unsanitised builder and still
render. Filed as #86.

A server-side comment asserting the legacy blob is "METIS-authored, so safe" is
the tell that it was not re-audited after the shape it holds changed: METIS
formatted the blob, but it embedded `String(err)`.
