import { describe, expect, it } from "vitest";
import {
  createIssueDraftSchema,
  createPublishBatchSchema,
  createPublishedIssueSchema,
  issueDraftSchema,
  publishBatchSchema,
  publishedIssueSchema,
} from "../src/publishing.js";
import { MAX_BATCH_ISSUES } from "../src/constants.js";

const validId = "clxxxxxxxx0000abcd1234efgh";
const now = new Date();

describe("publishing domain", () => {
  describe("issueDraft", () => {
    it("createIssueDraftSchema applies defaults", () => {
      const parsed = createIssueDraftSchema.parse({
        projectId: validId,
        title: "Bug: thing",
        body: "Repro steps...",
      });
      expect(parsed.labels).toEqual([]);
      expect(parsed.assignees).toEqual([]);
    });

    it("rejects empty title", () => {
      expect(() =>
        createIssueDraftSchema.parse({ projectId: validId, title: "", body: "x" }),
      ).toThrow();
    });

    it("issueDraftSchema validates a hydrated row", () => {
      expect(
        issueDraftSchema.parse({
          id: validId,
          projectId: validId,
          requirementId: null,
          parentDraftId: null,
          draftType: "feature",
          title: "x",
          body: "y",
          labels: "[]",
          assignees: "[]",
          storyPoints: null,
          status: "draft",
          dedupHash: null,
          metadata: null,
          deletedAt: null,
          createdAt: now,
          updatedAt: now,
        }),
      ).toMatchObject({ status: "draft" });
    });
  });

  describe("publishBatch", () => {
    it("happy path", () => {
      expect(
        createPublishBatchSchema.parse({
          projectId: validId,
          targetOwner: "acme",
          targetRepo: "core",
          draftIds: [validId],
        }),
      ).toMatchObject({ targetRepo: "core" });
    });

    it("rejects empty draftIds", () => {
      expect(() =>
        createPublishBatchSchema.parse({
          projectId: validId,
          targetOwner: "acme",
          targetRepo: "core",
          draftIds: [],
        }),
      ).toThrow();
    });

    it("rejects draftIds exceeding MAX_BATCH_ISSUES", () => {
      expect(() =>
        createPublishBatchSchema.parse({
          projectId: validId,
          targetOwner: "acme",
          targetRepo: "core",
          draftIds: Array.from({ length: MAX_BATCH_ISSUES + 1 }, () => validId),
        }),
      ).toThrow();
    });

    describe("#1049 review — additionalLabels", () => {
      const parse = (additionalLabels: unknown) =>
        createPublishBatchSchema.safeParse({
          projectId: validId,
          targetOwner: "acme",
          targetRepo: "core",
          draftIds: [validId],
          additionalLabels,
        });

      it("accepts a 50-character label (GitHub's limit), counted in characters", () => {
        expect(parse(["a".repeat(50), "é".repeat(50), "good first issue"]).success).toBe(true);
      });

      it("refuses a label over 50 characters, saying why", () => {
        const r = parse(["a".repeat(51)]);
        expect(r.success).toBe(false);
        expect(JSON.stringify(r.error?.issues)).toContain("50 characters");
      });

      it.each([
        ["a control character", "sprint\u000742"],
        ["a newline", "sprint\n42"],
        ["a bidi override", `sprint${String.fromCodePoint(0x202e)}24`],
        // #1311 — every invisible format character (Unicode Cf), not only bidi ones.
        ["a zero-width space", `sprint${String.fromCodePoint(0x200b)}42`],
        ["a word joiner", `sprint${String.fromCodePoint(0x2060)}42`],
        ["a zero-width no-break space", `sprint${String.fromCodePoint(0xfeff)}42`],
      ])("refuses a label holding %s", (_what, label) => {
        const r = parse([label]);
        expect(r.success).toBe(false);
        expect(JSON.stringify(r.error?.issues)).toContain("control");
      });

      it("accepts a label with an emoji and accented letters", () => {
        expect(parse(["🐛 bug", "priorité"]).success).toBe(true);
      });

      it("trims the labels it accepts, and refuses a blank one", () => {
        const r = parse(["  sprint-42  "]);
        expect(r.success && r.data.additionalLabels).toEqual(["sprint-42"]);
        expect(parse(["   "]).success).toBe(false);
      });
    });

    it("publishBatchSchema validates a hydrated row", () => {
      expect(
        publishBatchSchema.parse({
          id: validId,
          projectId: validId,
          status: "completed",
          targetOwner: "acme",
          targetRepo: "core",
          targetBaseUrl: null,
          provider: "github",
          dryRun: false,
          totalDrafts: 0,
          publishedCount: 0,
          failedCount: 0,
          dedupSkipped: 0,
          archived: false,
          archivedAt: null,
          archiveReason: null,
          archivedById: null,
          dryRunPlan: null,
          startedById: validId,
          startedAt: now,
          completedAt: now,
          errorMessage: null,
          metadata: null,
          createdAt: now,
          updatedAt: now,
        }),
      ).toMatchObject({ status: "completed" });
    });
  });

  describe("publishedIssue", () => {
    it("happy path", () => {
      expect(
        createPublishedIssueSchema.parse({
          batchId: validId,
          draftId: validId,
          issueNumber: 42,
          issueId: "I_kwDO",
          htmlUrl: "https://github.com/acme/core/issues/42",
          status: "created",
        }),
      ).toMatchObject({ issueNumber: 42 });
    });

    it("rejects non-url htmlUrl", () => {
      expect(() =>
        createPublishedIssueSchema.parse({
          batchId: validId,
          draftId: validId,
          issueNumber: 1,
          issueId: "x",
          htmlUrl: "not a url",
          status: "created",
        }),
      ).toThrow();
    });

    it("rejects issueNumber < 0", () => {
      expect(() =>
        createPublishedIssueSchema.parse({
          batchId: validId,
          draftId: validId,
          issueNumber: -1,
          issueId: "x",
          htmlUrl: "https://example.com",
          status: "created",
        }),
      ).toThrow();
    });

    it("publishedIssueSchema validates a hydrated row", () => {
      expect(
        publishedIssueSchema.parse({
          id: validId,
          batchId: validId,
          draftId: validId,
          issueNumber: 1,
          issueId: "x",
          htmlUrl: "https://example.com",
          status: "created",
          parentIssueNumber: null,
          dedupHash: null,
          bodyHash: null,
          errorMessage: null,
          publishedAt: now,
        }),
      ).toMatchObject({ issueNumber: 1 });
    });
  });
});
