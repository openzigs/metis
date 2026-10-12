/**
 * #1059 — the Spec Kit job runner's rules, on the in-memory job table.
 *
 * The rules themselves are in `helpers/spec-kit-job-rules.ts`, and the SAME
 * rules run against the real store on a real SQLite database in
 * `spec-kit-job-rules-1059.sqlite.test.ts`. This file is the fast copy; it
 * proves nothing about the real store's statements, which is why it is not the
 * only one. The in-memory table is itself held to the store contract in
 * `spec-kit-job-store-1059.test.ts`.
 */
import { describe, vi } from "vitest";

vi.mock("../src/lib/socket/job-events.js", async () => {
  return (await import("./helpers/spec-kit-job-rules-mocks.js")).jobEventsModule;
});
vi.mock("../src/lib/socket/job-scope-store.js", async () => {
  return (await import("./helpers/spec-kit-job-rules-mocks.js")).jobScopeStoreModule;
});
vi.mock("../src/lib/audit/audit-service.js", async () => {
  return (await import("./helpers/spec-kit-job-rules-mocks.js")).auditModule;
});
vi.mock("../src/lib/config/config-service.js", async () => {
  return (await import("./helpers/spec-kit-job-rules-mocks.js")).configModule;
});
vi.mock("../src/lib/spec-kit/job-store.js", async () => {
  return (await import("./helpers/spec-kit-job-store-fake.js")).fakeSpecKitJobStore;
});

const { defineSpecKitJobRules } = await import("./helpers/spec-kit-job-rules.js");
const { fakeSpecKitJobTable } = await import("./helpers/spec-kit-job-table.js");

describe("#1059 — Spec Kit job rules (in-memory job table)", () => {
  const table = fakeSpecKitJobTable();
  defineSpecKitJobRules(() => table);
});
