/**
 * #733 — the GitHub publish target: owner/repo validation, the
 * set-together rule on the persisted destination, and the explicit target a
 * finding publish may carry.
 */
import { describe, expect, it } from "vitest";
import {
  createPublishBatchSchema,
  githubOwnerSchema,
  githubPublishTargetSchema,
  publishDestinationConfigSchema,
  publishFindingSchema,
} from "../src/index.js";

const DRAFT = {
  title: "t",
  problemStatement: "p",
  affected: { files: [], requirementIds: [] },
  acceptanceCriteria: [],
  suggestedLabels: [],
};

describe("githubPublishTargetSchema", () => {
  it.each([
    ["openzigs", "flux-v2"],
    ["a", "b"],
    ["my-org", "repo.name_1"],
    ["x".repeat(39), "r".repeat(100)],
  ])("accepts %s/%s", (owner, repo) => {
    expect(githubPublishTargetSchema.safeParse({ owner, repo }).success).toBe(true);
  });

  it("trims surrounding whitespace", () => {
    expect(githubPublishTargetSchema.parse({ owner: " acme ", repo: " app " })).toEqual({
      owner: "acme",
      repo: "app",
    });
  });

  it.each([
    ["", "repo"],
    ["-acme", "repo"],
    ["acme-", "repo"],
    ["ac--me", "repo"],
    ["x".repeat(40), "repo"],
    ["acme/evil", "repo"],
    ["acme", ""],
    ["acme", "."],
    ["acme", ".."],
    ["acme", "a/b"],
    ["acme", "../issues"],
    ["acme", "r".repeat(101)],
    ["acme", "has space"],
  ])("rejects %s/%s", (owner, repo) => {
    expect(githubPublishTargetSchema.safeParse({ owner, repo }).success).toBe(false);
  });
});

describe("publishDestinationConfigSchema — GitHub target (#733)", () => {
  it("accepts a destination with no GitHub target fields (left as stored)", () => {
    expect(publishDestinationConfigSchema.safeParse({ publishDestination: "github" }).success).toBe(
      true,
    );
  });

  it("accepts an owner and repo set together", () => {
    const parsed = publishDestinationConfigSchema.parse({
      publishDestination: "github",
      githubOwner: "openzigs",
      githubRepo: "flux-v2",
    });
    expect(parsed.githubOwner).toBe("openzigs");
    expect(parsed.githubRepo).toBe("flux-v2");
  });

  it("accepts both cleared together", () => {
    expect(
      publishDestinationConfigSchema.safeParse({
        publishDestination: "github",
        githubOwner: null,
        githubRepo: null,
      }).success,
    ).toBe(true);
  });

  it.each([
    [{ githubOwner: "acme" }],
    [{ githubRepo: "app" }],
    [{ githubOwner: "acme", githubRepo: null }],
    [{ githubOwner: null, githubRepo: "app" }],
  ])("rejects a half-set target %j", (fields) => {
    expect(
      publishDestinationConfigSchema.safeParse({ publishDestination: "github", ...fields }).success,
    ).toBe(false);
  });

  it("rejects an invalid owner", () => {
    expect(
      publishDestinationConfigSchema.safeParse({
        publishDestination: "github",
        githubOwner: "a/b",
        githubRepo: "app",
      }).success,
    ).toBe(false);
  });
});

describe("publishFindingSchema — target (#733)", () => {
  it("accepts an explicit target", () => {
    const parsed = publishFindingSchema.parse({
      draft: DRAFT,
      target: { owner: "openzigs", repo: "flux-v2" },
    });
    expect(parsed.target).toEqual({ owner: "openzigs", repo: "flux-v2" });
  });

  it("leaves the target optional", () => {
    expect(publishFindingSchema.parse({ draft: DRAFT }).target).toBeUndefined();
  });

  it("rejects a malformed target", () => {
    expect(
      publishFindingSchema.safeParse({ draft: DRAFT, target: { owner: "acme", repo: "../x" } })
        .success,
    ).toBe(false);
  });
});

describe("githubOwnerSchema — one owner rule for every publish path (#733)", () => {
  const validId = "clxxxxxxxx0000abcd1234efgh";
  const batch = (targetOwner: string) =>
    createPublishBatchSchema.safeParse({
      projectId: validId,
      targetOwner,
      targetRepo: "core",
      draftIds: [validId],
    }).success;
  const deepDive = (owner: string) =>
    publishFindingSchema.safeParse({ draft: DRAFT, target: { owner, repo: "app" } }).success;
  const saveTarget = (githubOwner: string) =>
    publishDestinationConfigSchema.safeParse({
      publishDestination: "github",
      githubOwner,
      githubRepo: "app",
    }).success;

  it.each(["octo_shortcode", "my-handle_acme", "a_b", "x".repeat(30) + "_" + "y".repeat(8)])(
    "accepts the Enterprise Managed User owner %s on every path",
    (owner) => {
      expect(githubOwnerSchema.safeParse(owner).success).toBe(true);
      expect(deepDive(owner)).toBe(true);
      expect(saveTarget(owner)).toBe(true);
      expect(batch(owner)).toBe(true);
    },
  );

  it.each(["", "-bad", "_bad", "bad-", "ba--d", "x".repeat(40), "a/b", "has space"])(
    "rejects %j on every path",
    (owner) => {
      expect(githubOwnerSchema.safeParse(owner).success).toBe(false);
      expect(deepDive(owner)).toBe(false);
      expect(saveTarget(owner)).toBe(false);
      expect(batch(owner)).toBe(false);
    },
  );
});
