/**
 * #1230 (PR #1249 review) — the check's pipeline is loaded on first use. A
 * load that fails is logged and NOT kept: the next requirement change loads it
 * again, rather than every check failing for the life of the process.
 */
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  check: vi.fn(async () => undefined),
  warn: vi.fn(),
  loads: 0,
}));
vi.mock("../prisma.js", () => ({ prisma: {} }));
vi.mock("./incremental.js", () => {
  mocks.loads += 1;
  if (mocks.loads === 1) throw new Error("pipeline failed to load");
  return { checkIncrementalRegeneration: mocks.check };
});
vi.mock("./brd-layout.js", () => ({ readBrdLayoutSetting: () => ({ layout: "reader" }) }));
vi.mock("../logger.js", () => ({ createChildLogger: () => ({ warn: mocks.warn }) }));

import { noteProjectRequirementsChanged } from "./approved-requirements-staleness.js";

describe("the check's lazy load (#1230)", () => {
  it("retries a failed load on the next change", async () => {
    await expect(noteProjectRequirementsChanged("p1")).resolves.toBeUndefined();
    expect(mocks.check).not.toHaveBeenCalled();
    expect(mocks.warn).toHaveBeenCalledTimes(1);
    await noteProjectRequirementsChanged("p1");
    expect(mocks.check).toHaveBeenCalledWith("p1", undefined, { approvedRequirementsOnly: true });
  });
});
