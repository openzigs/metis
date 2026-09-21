/**
 * Unit tests for getLatestWebResearch (Epic #204 / Issue #222).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockAnalysis = {
  findMany: vi.fn(),
};

vi.mock("../prisma.js", () => ({
  prisma: {
    analysis: {
      findMany: (...args: unknown[]) => mockAnalysis.findMany(...args),
    },
  },
}));

import { getLatestWebResearch } from "./analysis-service.js";

function meta(obj: unknown): { metadata: string } {
  return { metadata: JSON.stringify(obj) };
}

describe("getLatestWebResearch", () => {
  beforeEach(() => {
    mockAnalysis.findMany.mockReset();
  });

  it("returns the webResearch of the most recent analysis that has it", async () => {
    const research = { digests: [{ id: "d1" }], totalSources: 1, reviewRequired: 0 };
    mockAnalysis.findMany.mockResolvedValue([meta({ webResearch: research })]);
    const result = await getLatestWebResearch("p1");
    expect(result).toEqual(research);
  });

  it("skips analyses without webResearch and returns the first that has it", async () => {
    const research = { digests: [{ id: "d2" }], totalSources: 1, reviewRequired: 0 };
    mockAnalysis.findMany.mockResolvedValue([
      meta({ structuredRequirements: { requirements: [] } }),
      meta({ webResearch: research }),
    ]);
    const result = await getLatestWebResearch("p1");
    expect(result).toEqual(research);
  });

  it("returns null when no analysis has web research", async () => {
    mockAnalysis.findMany.mockResolvedValue([meta({}), { metadata: null }]);
    expect(await getLatestWebResearch("p1")).toBeNull();
  });

  it("returns null when there are no analyses", async () => {
    mockAnalysis.findMany.mockResolvedValue([]);
    expect(await getLatestWebResearch("p1")).toBeNull();
  });

  it("tolerates unparseable metadata", async () => {
    mockAnalysis.findMany.mockResolvedValue([{ metadata: "{not json" }]);
    expect(await getLatestWebResearch("p1")).toBeNull();
  });

  it("queries the project's analyses ordered by createdAt desc", async () => {
    mockAnalysis.findMany.mockResolvedValue([]);
    await getLatestWebResearch("proj-x");
    expect(mockAnalysis.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { projectId: "proj-x" },
        orderBy: { createdAt: "desc" },
      }),
    );
  });
});
