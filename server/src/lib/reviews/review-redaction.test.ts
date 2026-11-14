/**
 * #2491 — a review as its reader may see it. Which requirements are hidden is
 * decided by `restrictedRequirementIds` (pinned over a real database in
 * `tests/source-redaction-2491.sqlite.test.ts`); here, what each shape becomes.
 */
import { describe, expect, it, vi } from "vitest";
import { RESTRICTED_SOURCE_TITLE } from "@metis/shared";

const hiddenSpy = vi.hoisted(() =>
  vi.fn(async (_reader: unknown, _ids: string[]) => new Set<string>()),
);
vi.mock("../analysis/source-redaction.js", () => ({ restrictedRequirementIds: hiddenSpy }));

const { redactReviewFor, redactReviewsFor } = await import("./review-redaction.js");

const READER = { userId: "bob", role: "analyst" };
const sharedWith = (requirementId: string | null, title: string) => ({
  structuredId: "S",
  title,
  requirementId,
  approved: true,
});
const review = () => ({
  id: "rev",
  items: [
    {
      requirementId: "open",
      requirement: { id: "open", title: "Open" },
      sharedCriteria: {
        record: { sharedWith: [sharedWith("secret", "Secret"), sharedWith(null, "Gone")] },
      },
    },
    {
      requirementId: "secret",
      requirement: { id: "secret", title: "Secret" },
      sharedCriteria: { record: { sharedWith: [sharedWith("open", "Open")] } },
    },
    { requirementId: null, generatedDocumentId: "doc", requirement: null },
  ],
});

describe("redactReviewsFor (#2491)", () => {
  it("asks once about every item and named sibling, and returns the reviews as they were when none is hidden", async () => {
    hiddenSpy.mockResolvedValueOnce(new Set());
    const input = [review()];
    const out = await redactReviewsFor(READER, input);
    expect(out).toEqual(input);
    expect(hiddenSpy).toHaveBeenCalledWith(READER, ["open", "secret", "secret", "open"]);
  });

  it("shows a hidden item as the placeholder with no shared-criteria note, and a hidden sibling by the placeholder", async () => {
    hiddenSpy.mockResolvedValueOnce(new Set(["secret"]));
    const [out] = (await redactReviewsFor(READER, [review()])) as Array<ReturnType<typeof review>>;
    const [open, secret, doc] = out!.items as Array<Record<string, unknown>>;
    expect(secret).toMatchObject({
      requirementId: "secret",
      requirement: { id: "secret", title: RESTRICTED_SOURCE_TITLE },
      sharedCriteria: null,
      restricted: true,
    });
    expect(JSON.stringify(secret)).not.toContain("Secret");
    expect(open).toMatchObject({
      requirement: { title: "Open" },
      sharedCriteria: {
        record: {
          sharedWith: [
            { requirementId: "secret", title: RESTRICTED_SOURCE_TITLE },
            { requirementId: null, title: "Gone" },
          ],
        },
      },
    });
    expect(doc).toEqual({ requirementId: null, generatedDocumentId: "doc", requirement: null });
  });

  it("leaves a review read without a list of items as it is", async () => {
    hiddenSpy.mockResolvedValueOnce(new Set(["secret"]));
    const odd = { id: "rev", items: { create: [] } };
    expect(await redactReviewsFor(READER, [odd])).toEqual([odd]);
  });

  it("redactReviewFor passes null through and redacts one review", async () => {
    expect(await redactReviewFor(READER, null)).toBeNull();
    hiddenSpy.mockResolvedValueOnce(new Set(["secret"]));
    const out = (await redactReviewFor(READER, review())) as ReturnType<typeof review>;
    expect(out.items[1]!.requirement!.title).toBe(RESTRICTED_SOURCE_TITLE);
  });

  it("keeps a hidden item's absent fields absent", async () => {
    hiddenSpy.mockResolvedValueOnce(new Set(["secret"]));
    const [out] = (await redactReviewsFor(READER, [
      { items: [{ requirementId: "secret" }] },
    ])) as Array<{ items: Array<Record<string, unknown>> }>;
    expect(out!.items[0]).toEqual({ requirementId: "secret", restricted: true });
  });
});
