/**
 * #1059 — the module doubles the job-runner rule suites share. A test file
 * declares the `vi.mock`s (they are hoisted per file) and takes the doubles
 * from here, so the file and `spec-kit-job-rules.ts` see the same spies:
 *
 *   vi.mock("../src/lib/socket/job-events.js", async () =>
 *     (await import("./helpers/spec-kit-job-rules-mocks.js")).jobEventsModule);
 */
import { vi, type Mock } from "vitest";
import type { SpecKitJobStoreApi } from "./spec-kit-job-table.js";

type Spy = Mock<(...args: unknown[]) => unknown>;
type JobEventName = "started" | "progress" | "completed" | "failed" | "lifecycle" | "docSection";

export const jobEvents: Record<JobEventName, Spy> = {
  started: vi.fn(),
  progress: vi.fn(),
  completed: vi.fn(),
  failed: vi.fn(),
  lifecycle: vi.fn(),
  docSection: vi.fn(),
};
export const jobEventsModule: {
  jobEvents: Record<JobEventName, Spy>;
  genericFailureMessage: (kind: string) => string;
} = {
  jobEvents,
  genericFailureMessage: (kind: string): string => `GENERIC:${kind}`,
};

export const recordJobScope: Mock<(...args: unknown[]) => Promise<void>> = vi.fn(
  async (): Promise<void> => undefined,
);
export const jobScopeStoreModule = { recordJobScope };

export const auditSpy: Spy = vi.fn();
export const auditModule: { audit: Spy } = { audit: auditSpy };

export const configValues = new Map<string, number>();
export const configModule = {
  getConfigService: () => ({
    getNumber: (key: string, fallback: number): number => configValues.get(key) ?? fallback,
  }),
};

/**
 * The REAL store's functions copied onto a plain object, for the suite that
 * runs the rules on a real database: it is what `jobs.ts` then calls, so a test
 * can `vi.spyOn(realSpecKitJobStore, "finishJob")` to make one write fail.
 */
export const realSpecKitJobStore = {} as SpecKitJobStoreApi;
