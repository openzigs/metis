-- Issue #2593 — rows the databaseConnected rollback must leave untouched
-- (scripts/ci/postgres-rollback-roundtrip.sh, postgres-migrate-deploy job).
INSERT INTO "users" ("id", "username", "displayName", "email", "updatedAt")
VALUES ('u-2593', 'u-2593', 'Rollback', 'u-2593@example.test', now());
INSERT INTO "projects" ("id", "name", "slug", "createdById", "updatedAt")
VALUES ('p-2593-a', 'Connected', 'p-2593-a', 'u-2593', now()),
       ('p-2593-b', 'Unconnected', 'p-2593-b', 'u-2593', now());
INSERT INTO "impact_analyses" ("id", "status", "startedById", "updatedAt")
VALUES ('ia-2593', 'completed', 'u-2593', now());
INSERT INTO "impact_analysis_projects" ("analysisId", "projectId", "outcome", "databaseConnected")
VALUES ('ia-2593', 'p-2593-a', 'affected', true),
       ('ia-2593', 'p-2593-b', 'checked-none-affected', false);
