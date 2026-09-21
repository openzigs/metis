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
