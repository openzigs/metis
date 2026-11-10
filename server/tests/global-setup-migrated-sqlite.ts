/**
 * #1364 — vitest `globalSetup`: migrate the SQLite schema ONCE, with the real
 * `prisma migrate deploy`, before any worker starts, and hand workers the files to copy.
 * `createMigratedSqlite` (tests/helpers/sqlite-migrated-db.ts) copies one per suite
 * instead of spawning one Prisma CLI per suite under the fan-out. #2146 — besides the head
 * schema, one template per `STOP_BEFORE_MIGRATIONS` name, snapshotted on the way up.
 */
import type { TestProject } from "vitest/node";
import {
  buildMigratedSqliteTemplates,
  MIGRATED_SQLITE_TEMPLATES_KEY,
} from "./helpers/sqlite-migrated-db.js";

export default function setup(project: Pick<TestProject, "provide">): () => void {
  const { cleanup, ...templates } = buildMigratedSqliteTemplates();
  project.provide(MIGRATED_SQLITE_TEMPLATES_KEY, templates);
  return cleanup;
}
