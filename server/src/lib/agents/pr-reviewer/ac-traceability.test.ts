/**
 * Epic #394 (#398) — AC traceability tests.
 */
import type { PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { extractAcceptanceCriteria, resolveAcceptanceCriteriaForPr } from "./ac-traceability.js";

interface PublishedIssueRow {
  issueNumber: number;
  draft: { id: string; body: string } | null;
}

function mkPrisma(rows: PublishedIssueRow[]): PrismaClient {
  return {
    publishedIssue: {
      findMany: async () => rows,
    },
  } as unknown as PrismaClient;
}

const ISSUE_BODY = `
## Description

Implement the thing.

## Acceptance criteria

- [ ] **Given** a user, **When** they sign in, **Then** a session is created.
- [ ] **Given** invalid creds, **When** they sign in, **Then** a 401 is returned.
- [ ] Coverage stays >=80%.

## Definition of done

- [ ] Tests added
`;

describe("extractAcceptanceCriteria", () => {
  it("returns the bullets from the Acceptance criteria section", () => {
    const out = extractAcceptanceCriteria(ISSUE_BODY);
    expect(out).toHaveLength(3);
    expect(out[0]).toContain("Given a user");
    expect(out[2]).toBe("Coverage stays >=80%.");
    // DoD bullets are excluded (different section).
    expect(out.find((t) => t.includes("Tests added"))).toBeUndefined();
  });

  it("falls back to whole-body G/W/T scan when no AC section exists", () => {
    const body = `
- [ ] **Given** a thing, **When** acted on, **Then** outcome.
- [ ] non-matching bullet
`;
    const out = extractAcceptanceCriteria(body);
    expect(out).toEqual(["Given a thing, When acted on, Then outcome."]);
  });

  it("dedupes repeated AC lines", () => {
    const body = `## Acceptance criteria
- [ ] AC one
- [ ] AC one
- [ ] AC two
`;
    const out = extractAcceptanceCriteria(body);
    expect(out).toEqual(["AC one", "AC two"]);
  });

  it("returns [] for empty body", () => {
    expect(extractAcceptanceCriteria("")).toEqual([]);
  });
});

describe("resolveAcceptanceCriteriaForPr", () => {
  it("returns no_linked_issue skip when nothing references an issue", async () => {
    const out = await resolveAcceptanceCriteriaForPr(
      {
        prBody: "Some PR body",
        branchName: "feature/no-numbers-here",
        repoOwner: "acme",
        repoName: "proj",
      },
      mkPrisma([]),
    );
    expect(out.skipReason).toBe("no_linked_issue");
    expect(out.criteria).toEqual([]);
  });

  it("resolves ACs from a PR body Closes keyword", async () => {
    const prisma = mkPrisma([{ issueNumber: 42, draft: { id: "draft-1", body: ISSUE_BODY } }]);
    const out = await resolveAcceptanceCriteriaForPr(
      {
        prBody: "Closes #42",
        branchName: "main",
        repoOwner: "acme",
        repoName: "proj",
      },
      prisma,
    );
    expect(out.skipReason).toBeNull();
    expect(out.criteria).toHaveLength(3);
    expect(out.criteria[0].id).toBe("42-AC1");
    expect(out.criteria[0].sourceIssueNumber).toBe(42);
    expect(out.linkedIssueNumbers).toEqual([42]);
  });

  it("resolves ACs from branch name when body has no closing keyword", async () => {
    const prisma = mkPrisma([{ issueNumber: 100, draft: { id: "d1", body: ISSUE_BODY } }]);
    const out = await resolveAcceptanceCriteriaForPr(
      {
        prBody: "No keywords here",
        branchName: "feature/100-add-stuff",
        repoOwner: "acme",
        repoName: "proj",
      },
      prisma,
    );
    expect(out.skipReason).toBeNull();
    expect(out.criteria.length).toBeGreaterThan(0);
    expect(out.criteria[0].sourceIssueNumber).toBe(100);
  });

  it("merges ACs from multiple linked issues with traceability", async () => {
    const body2 = `## Acceptance criteria
- [ ] **Given** other AC, **When** y, **Then** z.
`;
    const prisma = mkPrisma([
      { issueNumber: 1, draft: { id: "d1", body: ISSUE_BODY } },
      { issueNumber: 2, draft: { id: "d2", body: body2 } },
    ]);
    const out = await resolveAcceptanceCriteriaForPr(
      {
        prBody: "Closes #1\nFixes #2",
        branchName: "main",
        repoOwner: "acme",
        repoName: "proj",
      },
      prisma,
    );
    expect(out.criteria).toHaveLength(4);
    expect(out.criteria.map((c) => c.sourceIssueNumber)).toEqual([1, 1, 1, 2]);
    expect(out.linkedIssueNumbers).toEqual([1, 2]);
  });

  it("returns no_published_issue when links exist but no DB row matches", async () => {
    const out = await resolveAcceptanceCriteriaForPr(
      {
        prBody: "Closes #999",
        branchName: "main",
        repoOwner: "acme",
        repoName: "proj",
      },
      mkPrisma([]),
    );
    expect(out.skipReason).toBe("no_published_issue");
    expect(out.unresolvedIssueNumbers).toEqual([999]);
    expect(out.linkedIssueNumbers).toEqual([]);
  });

  it("returns no_acceptance_criteria when issue has none extractable", async () => {
    const prisma = mkPrisma([
      { issueNumber: 7, draft: { id: "d-empty", body: "Just a description, no ACs." } },
    ]);
    const out = await resolveAcceptanceCriteriaForPr(
      {
        prBody: "Closes #7",
        branchName: "main",
        repoOwner: "acme",
        repoName: "proj",
      },
      prisma,
    );
    expect(out.skipReason).toBe("no_acceptance_criteria");
    expect(out.criteria).toEqual([]);
    expect(out.linkedIssueNumbers).toEqual([7]);
  });

  it("dedupes when both body and branch name reference the same issue", async () => {
    const prisma = mkPrisma([{ issueNumber: 50, draft: { id: "d", body: ISSUE_BODY } }]);
    const out = await resolveAcceptanceCriteriaForPr(
      {
        prBody: "Closes #50",
        branchName: "feature/issue-50-thing",
        repoOwner: "acme",
        repoName: "proj",
      },
      prisma,
    );
    expect(out.linkedIssueNumbers).toEqual([50]);
    expect(out.criteria).toHaveLength(3);
  });
});
