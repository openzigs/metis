---
name: workspace-delete-is-soft
description: Workspace DELETE only sets deletedAt
metadata:
  type: project
---

Membership-derived scope ignored workspace.deletedAt until #549/#553 (auth.ts workspaceIds, accessible-projects, requireWorkspaceRole, cross-project, token claims). JWT refresh still copies the workspace claim forward (#561, #562).

**Why:** A soft-deleted or left workspace can still grant scope through any reader that trusts the claim.

**How to apply:** When touching workspace lists or scoping, filter deletedAt in the membership query AND check the workspace row at project-access sinks.
