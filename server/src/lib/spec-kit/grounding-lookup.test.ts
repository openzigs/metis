/**
 * #20 — the production code-graph path lookup behind `verifyPlanPaths`. Both
 * queries must be scoped to the project: one project's files must never
 * satisfy another project's plan.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const codeSymbol = vi.hoisted(() => ({
  findFirst: vi.fn(),
  findMany: vi.fn(),
}));
vi.mock("../prisma.js", () => ({ prisma: { codeSymbol } }));

import { createDefaultPlanPathLookup, verifyPlanPaths } from "./grounding.js";

beforeEach(() => {
  codeSymbol.findFirst.mockReset();
  codeSymbol.findMany.mockReset();
});

describe("createDefaultPlanPathLookup", () => {
  it("scopes the code-graph presence check to the project", async () => {
    codeSymbol.findFirst.mockResolvedValue({ id: "s1" });
    await expect(createDefaultPlanPathLookup().hasCodeGraph("p1")).resolves.toBe(true);
    expect(codeSymbol.findFirst).toHaveBeenCalledWith({
      where: { projectId: "p1" },
      select: { id: true },
    });
  });

  it("reports no code graph when the project has no symbols", async () => {
    codeSymbol.findFirst.mockResolvedValue(null);
    await expect(createDefaultPlanPathLookup().hasCodeGraph("p1")).resolves.toBe(false);
  });

  it("queries candidate files by basename within the project only", async () => {
    codeSymbol.findMany.mockResolvedValue([{ filePath: "server/src/a/b.ts" }]);
    const found = await createDefaultPlanPathLookup().findExisting("p1", [
      "server/src/a/b.ts",
      "ui/src/b.ts",
      "c.ts/d/page.tsx",
    ]);
    expect(found).toEqual(["server/src/a/b.ts"]);
    expect(codeSymbol.findMany).toHaveBeenCalledWith({
      where: {
        projectId: "p1",
        OR: [{ filePath: { endsWith: "b.ts" } }, { filePath: { endsWith: "page.tsx" } }],
      },
      select: { filePath: true },
      distinct: ["filePath"],
    });
  });

  it("is the default lookup of verifyPlanPaths", async () => {
    codeSymbol.findFirst.mockResolvedValue({ id: "s1" });
    codeSymbol.findMany.mockResolvedValue([{ filePath: "server/src/a/b.ts" }]);
    const r = await verifyPlanPaths("p1", "`server/src/a/b.ts` and `server/src/new/x.ts`");
    expect(r.unverified).toEqual(["server/src/new/x.ts"]);
  });
});
