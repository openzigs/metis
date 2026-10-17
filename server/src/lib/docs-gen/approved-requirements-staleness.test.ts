/**
 * #1230 — a requirement write asks the existing auto-update check to look at
 * the project's reader BRDs again: best effort, coalesced per project, never
 * thrown into the request that made the write.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  check: vi.fn(),
  layout: vi.fn(),
  warn: vi.fn(),
}));
vi.mock("../prisma.js", () => ({ prisma: { requirement: { findMany: mocks.findMany } } }));
vi.mock("./incremental.js", () => ({ checkIncrementalRegeneration: mocks.check }));
vi.mock("./brd-layout.js", async (original) => ({
  ...(await original<typeof import("./brd-layout.js")>()),
  readBrdLayoutSetting: mocks.layout,
}));
vi.mock("../logger.js", () => ({ createChildLogger: () => ({ warn: mocks.warn }) }));

import {
  noteProjectRequirementsChanged,
  noteRequirementsChanged,
} from "./approved-requirements-staleness.js";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.layout.mockReturnValue({ layout: "reader" });
  mocks.check.mockResolvedValue(undefined);
});

describe("noteRequirementsChanged (#1230)", () => {
  it("checks each changed requirement's project once, for the documents that list approved requirements", async () => {
    mocks.findMany.mockResolvedValue([
      { projectId: "p1" },
      { projectId: "p1" },
      { projectId: "p2" },
    ]);
    await noteRequirementsChanged(["r1", "r2", "r2", "r3"]);
    expect(mocks.findMany).toHaveBeenCalledWith({
      where: { id: { in: ["r1", "r2", "r3"] } },
      select: { projectId: true },
    });
    expect(mocks.warn.mock.calls).toEqual([]);
    expect(mocks.check.mock.calls).toEqual([
      ["p1", undefined, { approvedRequirementsOnly: true }],
      ["p2", undefined, { approvedRequirementsOnly: true }],
    ]);
  });

  it("does nothing for no requirements or under the catalogue layout", async () => {
    await noteRequirementsChanged([]);
    mocks.layout.mockReturnValue({ layout: "catalogue" });
    await noteRequirementsChanged(["r1"]);
    expect(mocks.findMany).not.toHaveBeenCalled();
    expect(mocks.check).not.toHaveBeenCalled();
  });

  it("coalesces changes that arrive while a check runs into one more check", async () => {
    mocks.findMany.mockResolvedValue([{ projectId: "p1" }]);
    let release!: () => void;
    mocks.check.mockImplementationOnce(() => new Promise<void>((resolve) => (release = resolve)));
    const first = noteRequirementsChanged(["r1"]);
    await vi.waitFor(() => expect(mocks.check).toHaveBeenCalledTimes(1));
    // Fifty approvals while the first check runs.
    const more = Array.from({ length: 50 }, (_, i) => noteRequirementsChanged([`r${i + 2}`]));
    await vi.waitFor(() => expect(mocks.findMany).toHaveBeenCalledTimes(51));
    release();
    await Promise.all([first, ...more]);
    expect(mocks.check).toHaveBeenCalledTimes(2);
    // A later change starts a fresh check.
    await noteRequirementsChanged(["r99"]);
    expect(mocks.check).toHaveBeenCalledTimes(3);
  });

  it("checks a project named directly (a promotion), and not under the catalogue layout", async () => {
    await noteProjectRequirementsChanged("p1");
    expect(mocks.findMany).not.toHaveBeenCalled();
    expect(mocks.check.mock.calls).toEqual([["p1", undefined, { approvedRequirementsOnly: true }]]);
    mocks.layout.mockReturnValue({ layout: "catalogue" });
    await noteProjectRequirementsChanged("p1");
    expect(mocks.check).toHaveBeenCalledTimes(1);
    mocks.layout.mockImplementation(() => {
      throw new Error("config unavailable");
    });
    await expect(noteProjectRequirementsChanged("p1")).resolves.toBeUndefined();
    expect(mocks.warn).toHaveBeenCalledTimes(1);
  });

  it("logs and never rejects when the lookup or the check fails", async () => {
    mocks.findMany.mockRejectedValueOnce(new Error("db down"));
    await expect(noteRequirementsChanged(["r1"])).resolves.toBeUndefined();
    mocks.findMany.mockResolvedValue([{ projectId: "p1" }]);
    mocks.check.mockRejectedValueOnce(new Error("capture failed"));
    await expect(noteRequirementsChanged(["r1"])).resolves.toBeUndefined();
    expect(mocks.warn.mock.calls.map(([, meta]) => (meta as { error: string }).error)).toEqual([
      "db down",
      "capture failed",
    ]);
    // The failed check does not wedge the project.
    await noteRequirementsChanged(["r1"]);
    expect(mocks.check).toHaveBeenCalledTimes(2);
  });
});
