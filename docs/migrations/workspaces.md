# Workspaces Migration Runbook

> Epic #759 — Organization-Level Multi-Tenancy

## Overview

This runbook covers the safe rollout of the Workspaces feature. The migration introduces:
- `Workspace`, `WorkspaceMember`, `WorkspaceInvite` tables
- `WorkspaceUsageDaily` rollup table
- `Project.workspaceId` foreign key
- JWT `workspaces` claim for access scoping

## Prerequisites

- [ ] Database backup taken (see Backup section below)
- [ ] All application pods idle / maintenance window active
- [ ] `VAULT_MASTER_KEY` environment variable set (if vault migration needed)
- [ ] Admin credentials available for backfill verification

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | Prisma connection string |
| `JWT_SECRET` | Yes | Used for token issuance (unchanged) |
| `VAULT_MASTER_KEY` | Yes | Vault encryption key (unchanged) |

No new environment variables are required for this migration.

## Deployment Order

1. **Deploy server** with new schema migration
2. **Run backfill script** to assign existing projects to Default workspace
3. **Deploy UI** with workspace switcher
4. Users log in again to get updated JWT with workspace claims

## Step-by-Step Procedure

### 1. Backup Database

```bash
# SQLite (dev)
cp server/prisma/dev.db server/prisma/dev.db.backup-$(date +%Y%m%d)

# PostgreSQL (prod)
pg_dump -Fc $DATABASE_URL > metis-pre-workspaces-$(date +%Y%m%d).dump
```

### 2. Run Prisma Migration

```bash
cd server
npx prisma migrate deploy
```

Expected output:
```
Applying migration `20260526183211_add_workspaces`
```

### 3. Run Backfill Script

```bash
cd server
npx tsx scripts/backfill-workspaces.ts
```

Expected output:
```
Created Default workspace: <cuid>
Assigned N project(s) to Default workspace
Added admin user <username> as workspace owner
Backfill complete.
```

### 4. Verify Backfill

```sql
-- All projects should have a workspaceId
SELECT COUNT(*) FROM projects WHERE workspace_id IS NULL;
-- Expected: 0

-- Default workspace should exist
SELECT id, name, slug FROM workspaces WHERE slug = 'default';

-- At least one workspace member (the admin)
SELECT COUNT(*) FROM workspace_members;
-- Expected: >= 1
```

### 5. Deploy Updated Server

The server now:
- Issues JWTs with `workspaces[]` claim
- Enforces workspace-scoped project access
- Exposes `/api/workspaces` CRUD + invite endpoints

### 6. Deploy Updated UI

The UI now:
- Shows workspace switcher in header (only visible with 2+ workspaces)
- Workspace settings page at `/admin/workspaces/:id/settings`
- Invite accept page at `/invites/:token`

### 7. User Re-authentication

Users must log out and log back in to receive the updated JWT containing their workspace memberships. Existing sessions continue to work (workspace scoping gracefully allows access when no workspace claim is present, for backward compatibility).

## Rollback Procedure

### Quick Rollback (< 5 minutes)

1. Redeploy previous server version (schema is additive — old code ignores new columns)
2. Redeploy previous UI version

The `workspaceId` column on `Project` is nullable, so the old server code works without modification.

### Full Rollback (if needed)

```bash
# Restore database from backup
# SQLite
cp server/prisma/dev.db.backup-YYYYMMDD server/prisma/dev.db

# PostgreSQL
pg_restore -d $DATABASE_URL metis-pre-workspaces-YYYYMMDD.dump
```

Then redeploy the previous server and UI versions.

## Feature Flags

No feature flags are required. The workspace switcher automatically hides when a user has only one workspace (which is the case after initial migration with the Default workspace).

## Post-Migration Tasks

- [ ] Verify all projects have `workspaceId` set
- [ ] Verify admin user is workspace owner
- [ ] Test workspace CRUD via API
- [ ] Test invitation flow end-to-end
- [ ] Monitor error logs for workspace-related 404s
- [ ] Schedule daily usage rollup job (automatic via scheduler)

## Monitoring

Watch for:
- `workspace.create` / `workspace.delete` audit events
- 404 errors on project routes (may indicate workspace scoping issues)
- JWT decode failures (should not happen — claim is optional)

## Contact

Epic: #759
