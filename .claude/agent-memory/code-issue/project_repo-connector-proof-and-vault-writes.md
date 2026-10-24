---
name: repo-connector-proof-and-vault-writes
description: What a repo connector's status and repoPermission actually prove, every path that writes them, and why a guard keyed on secretId or ciphertext does not prove the credential is unchanged (rotate, undo/ABA) (#1480, #1494, #1499, #1510).
metadata:
  type: project
---

From #1480, #1494, #1499, #1510 and their reviews (2026-10-24).

**`status` is not proof of ownership.**
- A new repo connector is saved `"pending"` with no proof the user can reach the repo. Any
  rule that routes or denies by "who connects owner/name" can be triggered by any tenant
  typing a repo name; count only `"connected"` connectors of the right provider (#1480 review).
- `"connected"` proves only that `repos.get` succeeded, which needs no credential for a
  public repo (`acquireOctokit` allows `token` undefined), and the scheduled refresh flips
  status to `error` on a 403 rate limit. Never treat `"connected"` as proof of ownership.
  Every rebind must also clear the per-connector webhook secret (#1480 review 2).
- In `testRepoConnector` the first DNS lookup (`assertHostFromBaseUrl`) runs before the `try`,
  and Octokit reports fetch failures as status 500, so "a network failure marks the connector
  error" is mostly untrue (#1499).

**Proof fields have several writers.** `status` and `repoPermission` are written by
`testRepoConnector`, `fetchRepoMetadata` and others with unconditional `where: { id }` updates
that race the binding PATCH. A new gate on `repo_connections` needs every status-writing path
to set or clear it, and a write conditioned on the binding the check read (#1494 review).

**"This credential was checked" needs more than the secret id.**
- A binding guard keyed on `secretId` does not cover the credential: `POST /vault/:id/rotate`
  rewrites the value in place. Use the secret's version/`updatedAt`, or reset the proof in the
  rotate path (#1494 cycle 2; #1499 made a vault value write clear the recorded permission in
  the same transaction).
- `undoRotation` restores the previous ciphertext byte for byte, so a "ciphertext as version"
  CAS can be fooled by ABA when a rotate and its undo land inside the guarded operation,
  especially if the guarded code re-reads the secret separately (#1510 review).

Transactions and test seams for these writes: [[prisma-sqlite-interactive-transactions]].
Related: [[github-webhook-dedup-and-routing]], [[secret-binding-fire-time-checks]],
[[product-repo-access-traps]].
