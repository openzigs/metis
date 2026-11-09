/**
 * #1364 — vitest `globalSetup`: migrate the SQLite head schema ONCE, with the real
 * `prisma migrate deploy`, before any worker starts, and hand workers the file to copy.
 * `createMigratedSqlite` (tests/helpers/sqlite-migrated-db.ts) copies it per suite
 * instead of spawning one Prisma CLI per suite under the fan-out.
 */
import type { TestProject } from "vitest/node";
import {
  buildMigratedSqliteTemplate,
  MIGRATED_SQLITE_TEMPLATE_KEY,
} from "./helpers/sqlite-migrated-db.js";

export default function setup(project: Pick<TestProject, "provide">): () => void {
  const template = buildMigratedSqliteTemplate();
  project.provide(MIGRATED_SQLITE_TEMPLATE_KEY, template.dbFile);
  return () => template.cleanup();
}
