-- Issue #2566 — rows the codeExploration rollback must leave untouched
-- (scripts/ci/postgres-rollback-roundtrip.sh, postgres-migrate-deploy job).
INSERT INTO "users" ("id", "username", "displayName", "email", "updatedAt")
VALUES ('u-2566', 'u-2566', 'Rollback', 'u-2566@example.test', now());
INSERT INTO "projects" ("id", "name", "slug", "createdById", "updatedAt", "codeExploration")
VALUES ('p-2566-a', 'Explore', 'p-2566-a', 'u-2566', now(), 'explore'),
       ('p-2566-b', 'Default', 'p-2566-b', 'u-2566', now(), 'auto');
