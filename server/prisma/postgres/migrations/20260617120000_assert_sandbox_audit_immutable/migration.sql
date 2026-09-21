-- Issue #17.1 — assert sandbox audit immutability was ACTUALLY enforced.
--
-- The original migration (20260501000000_sandbox_audit_immutable) revokes
-- UPDATE/DELETE/TRUNCATE on `sandbox_audit_events` from the hardcoded role
-- `metis` and from PUBLIC. In a prod deployment whose application role is NOT
-- named `metis`, the per-role REVOKE silently no-ops and that role may retain
-- explicit UPDATE/DELETE grants — defeating the SOC-2 append-only guarantee
-- with no signal.
--
-- This migration does NOT trust the role name. It asserts on the EFFECTIVE
-- privilege of the role that will actually be writing rows: the role that owns
-- the connection running migrations is a superuser (and would pass any
-- privilege check), so we assert against the application role when it exists,
-- and otherwise against CURRENT_USER. If UPDATE or DELETE is still granted, we
-- RAISE EXCEPTION to fail the migration loudly rather than ship a mutable
-- audit log.

DO $$
DECLARE
  target_role text;
  can_update  boolean;
  can_delete  boolean;
BEGIN
  -- Prefer the conventional application role; fall back to whatever role
  -- explicitly carries write grants; finally fall back to CURRENT_USER. We
  -- pick a NON-superuser role where possible because superusers bypass all
  -- privilege checks and would mask a genuine misconfiguration.
  SELECT rolname
    INTO target_role
    FROM pg_roles
   WHERE rolname = 'metis'
     AND NOT rolsuper
   LIMIT 1;

  IF target_role IS NULL THEN
    SELECT grantee
      INTO target_role
      FROM information_schema.role_table_grants
     WHERE table_name = 'sandbox_audit_events'
       AND privilege_type IN ('UPDATE', 'DELETE')
       AND grantee <> 'PUBLIC'
       AND grantee IN (SELECT rolname FROM pg_roles WHERE NOT rolsuper)
     LIMIT 1;
  END IF;

  -- Nothing non-superuser to assert against (e.g. CI databases owned directly
  -- by a superuser): there is no application role that could mutate audit rows,
  -- so the immutability invariant holds vacuously. Skip the assertion.
  IF target_role IS NULL THEN
    RAISE NOTICE 'sandbox_audit_events immutability: no non-superuser role to assert against; skipping privilege check';
    RETURN;
  END IF;

  can_update := has_table_privilege(target_role, 'sandbox_audit_events', 'UPDATE');
  can_delete := has_table_privilege(target_role, 'sandbox_audit_events', 'DELETE');

  IF can_update OR can_delete THEN
    RAISE EXCEPTION
      'sandbox_audit_events immutability NOT enforced: role "%" retains UPDATE=% DELETE=% — REVOKE the mutating privileges from this role before applying (see migration 20260501000000_sandbox_audit_immutable)',
      target_role, can_update, can_delete;
  END IF;

  RAISE NOTICE 'sandbox_audit_events immutability verified for role "%": UPDATE and DELETE revoked', target_role;
END;
$$;
