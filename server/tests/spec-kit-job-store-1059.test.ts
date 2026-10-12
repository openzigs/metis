/**
 * #1059 — the in-memory `spec_kit_jobs` fake, held to the same contract as the
 * real store (`helpers/spec-kit-job-store-contract.ts`). The suites that mock
 * the store with this fake are only as good as its agreement with the real
 * one; the real one is held to the identical assertions on SQLite
 * (`spec-kit-job-store-1059.sqlite.test.ts`) and on Postgres
 * (`spec-kit-job-store-1059-postgres.integration.test.ts`).
 */
import { describe } from "vitest";
import { defineSpecKitJobStoreContract } from "./helpers/spec-kit-job-store-contract.js";
import { fakeSpecKitJobTable } from "./helpers/spec-kit-job-table.js";

describe("#1059 — spec_kit_jobs store contract (in-memory fake)", () => {
  const table = fakeSpecKitJobTable();
  defineSpecKitJobStoreContract(() => table, "c1059");
});
