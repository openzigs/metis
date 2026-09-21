-- Issue #422 — enforce sandbox audit log immutability at the DB layer.
--
-- `SandboxAuditEventRepo` already omits update/delete methods at the
-- application layer (Epic #395, #421), but the underlying
-- `prisma.sandboxAuditEvent.{update,delete,deleteMany}` calls are still
-- globally callable. Revoke those privileges from the application role
-- so a future PR (or compromised process) cannot mutate SOC-2 audit
-- evidence even if the application-layer fence is bypassed.
--
-- Convention (from `docker-compose.yml` + `charts/metis/values*.yaml`):
-- the application role is `metis`. If your deployment uses a different
-- role name, adjust the GRANT/REVOKE block below before applying.
--
-- INSERT and SELECT remain allowed so the SandboxAuditEmitter can keep
-- writing rows and operators can keep reading the forensic timeline.
--
-- Idempotent: REVOKE is a no-op if the privilege was never granted, and
-- the DO block tolerates the role being absent (CI ephemeral databases
-- sometimes own the schema directly under a superuser).

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'metis') THEN
    -- Belt-and-suspenders: ensure the row-level operations the app
    -- legitimately needs are explicitly granted before we revoke the
    -- mutating ones. This keeps a fresh database in a known-good state
    -- regardless of whether the role inherited PUBLIC privileges.
    EXECUTE 'GRANT SELECT, INSERT ON TABLE sandbox_audit_events TO metis';
    EXECUTE 'REVOKE UPDATE, DELETE, TRUNCATE ON TABLE sandbox_audit_events FROM metis';
  END IF;

  -- Always revoke the same privileges from PUBLIC so any future role
  -- created by an admin without explicit grants cannot mutate audit
  -- rows by inheritance.
  EXECUTE 'REVOKE UPDATE, DELETE, TRUNCATE ON TABLE sandbox_audit_events FROM PUBLIC';
END;
$$;

COMMENT ON TABLE sandbox_audit_events IS
  'SOC-2 forensic timeline. Append-only at the DB layer (Issue #422): UPDATE/DELETE/TRUNCATE revoked from the metis application role and PUBLIC. Rows are written exclusively by SandboxAuditEmitter via SandboxAuditEventRepo.';
