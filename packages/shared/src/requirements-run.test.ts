import { describe, expect, it } from "vitest";
import { defaultRequirementsRunId } from "./requirements-run.js";

const run = (id: string, status: string, requirementCount = 0) => ({
  id,
  status,
  requirementCount,
});

describe("defaultRequirementsRunId (#999, #1230)", () => {
  it("is null without a completed run", () => {
    expect(defaultRequirementsRunId([])).toBeNull();
    expect(defaultRequirementsRunId([run("a1", "running", 3)])).toBeNull();
  });

  it("is the newest completed run with requirements, skipping running and empty runs", () => {
    expect(
      defaultRequirementsRunId([
        run("a4", "running", 9),
        run("a3", "completed"),
        run("a2", "completed", 16),
        run("a1", "completed", 2),
      ]),
    ).toBe("a2");
  });

  it("keeps a re-opened run (a regenerate or resume: running again, completed before) as the default (#1252)", () => {
    const reopened = { ...run("a2", "running", 16), completedAt: "2026-10-01T00:00:00.000Z" };
    const runs = [run("a3", "completed"), reopened, run("a1", "completed", 2)];
    expect(defaultRequirementsRunId(runs)).toBe("a2");
    // A first run still running has never completed: it is not the default yet.
    const first = { ...run("a4", "running", 9), completedAt: null };
    expect(defaultRequirementsRunId([first, ...runs])).toBe("a2");
  });

  it("falls back to the newest completed run when none has requirements", () => {
    expect(
      defaultRequirementsRunId([
        run("a3", "completed"),
        run("a2", "failed", 4),
        run("a1", "completed"),
      ]),
    ).toBe("a3");
  });
});
