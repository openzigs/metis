---
name: parallel-prs-semantic-conflicts
description: Parallel PRs on the same guard can merge cleanly yet reopen a race; updateMany bumps @updatedAt; a rebase can shadow a variable.
metadata:
  type: project
---

2026-09-30, vault binding work:
- #585 (#577) split `assertSecretBindingAllowed` into read + judge and added an MCP path that bypassed it; #587 (#552) relied on every binding write going through that guard to stamp `bindingWriteUntil`. A clean textual merge would have silently reopened #552 for MCP. Caught only because the reviewer diffed the two PRs against each other.
- #587's stamp used `prisma.secret.updateMany`, which applies `@updatedAt`, so every binding save showed as "Updated" in the vault UI. Fixed with a raw single-column UPDATE.
- Rebasing #587 onto #589 (#574), a `const created = await svc().create(` shadowed #589's `created: string[]`, so the failure catch would have withdrawn nothing.

**Why:** conflict tools see text, not invariants.

**How to apply:** when two open PRs touch one chokepoint, merge one, then rebase the other with a test that fails if any entry point bypasses the invariant; never use `updateMany` on a model whose `@updatedAt` is user-visible; after a conflict resolution, grep for re-declared names. Links: [[sqlite-tests-skip-on-postgres-adapter]].
