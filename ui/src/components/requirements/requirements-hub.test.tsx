/**
 * #999 / #1230 — the run the Requirements hub opens on. The rule is
 * `@metis/shared`'s `defaultRequirementsRunId` (a reader BRD's Approved
 * Requirements section reads the same run); this pins the hub's adapter to it:
 * every review status counts toward a run's total.
 */
import { describe, expect, it } from "vitest";
import type { AnalysisListItem } from "@/lib/analysis-api";
import { defaultHubRunId } from "./requirements-hub";

const run = (
  id: string,
  status: string,
  counts: Partial<AnalysisListItem["requirementCounts"]> = {},
): AnalysisListItem =>
  ({
    id,
    status,
    requirementCounts: { draft: 0, approved: 0, rejected: 0, deferred: 0, ...counts },
  }) as AnalysisListItem;

describe("defaultHubRunId (#999, #1230)", () => {
  it("opens on the newest completed run with any requirements, whatever their status", () => {
    for (const status of ["draft", "approved", "rejected", "deferred"] as const) {
      expect(
        defaultHubRunId([
          run("running", "running", { approved: 4 }),
          run("empty", "completed"),
          run("with-one", "completed", { [status]: 1 }),
          run("older", "completed", { approved: 9 }),
        ]),
      ).toBe("with-one");
    }
  });

  it("falls back to the newest completed run, and to none", () => {
    expect(
      defaultHubRunId([run("a", "failed"), run("b", "completed"), run("c", "completed")]),
    ).toBe("b");
    expect(defaultHubRunId([run("a", "running")])).toBeNull();
    expect(defaultHubRunId([])).toBeNull();
  });

  it("stays on a run being re-run (running again, completed before), as the BRD does (#1252)", () => {
    const reopened = {
      ...run("rerun", "running", { approved: 2 }),
      completedAt: "2026-10-01T00:00:00.000Z",
    };
    expect(defaultHubRunId([reopened, run("older", "completed", { approved: 9 })])).toBe("rerun");
  });
});
