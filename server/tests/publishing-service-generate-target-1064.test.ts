/**
 * #1064 / PR #1102 review, cycle 2 — the Generate service hands the target's
 * host to the generator.
 *
 * The generator links code only when the target is the analysed repository on
 * the same HOST (no base URL given is public GitHub). That is only
 * as good as the value reaching it: a service that dropped `targetBaseUrl`
 * would silently turn every draft's links into text (or, before this rule, let
 * a same-named repository on another host get links it is then refused for).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const generateDraftsImpl = vi.fn(async (_opts: Record<string, unknown>) => ({
  total: 1,
  epics: 1,
  features: 0,
  upserted: 1,
  refreshed: 0,
}));

vi.mock("../src/lib/prisma.js", () => ({ prisma: {} }));
vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));
vi.mock("../src/lib/publishing/draft-generator.js", () => ({
  generateDrafts: (opts: Record<string, unknown>) => generateDraftsImpl(opts),
}));

const { generateDrafts } = await import("../src/lib/publishing/publishing-service.js");

const base = {
  projectId: "proj_1",
  analysisId: "analysis_1",
  targetOwner: "acme",
  targetRepo: "app",
  actorId: "user_1",
};

beforeEach(() => vi.clearAllMocks());

describe("generateDrafts (service) — the target's base URL reaches the generator", () => {
  it("forwards an Enterprise base URL, null for public GitHub, and absence as absence", async () => {
    await generateDrafts({ ...base, targetBaseUrl: "https://ghe.example.com/api/v3" });
    expect(generateDraftsImpl.mock.calls.at(-1)![0]).toMatchObject({
      targetOwner: "acme",
      targetRepo: "app",
      targetBaseUrl: "https://ghe.example.com/api/v3",
    });

    await generateDrafts({ ...base, targetBaseUrl: null });
    expect(generateDraftsImpl.mock.calls.at(-1)![0].targetBaseUrl).toBeNull();

    // Left out is passed on as left out; the generator reads it as public GitHub.
    await generateDrafts(base);
    expect(generateDraftsImpl.mock.calls.at(-1)![0].targetBaseUrl).toBeUndefined();
  });
});
