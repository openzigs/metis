/**
 * Dry-run plan builder — Phase 9 (#70).
 */
import { describe, expect, it } from "vitest";
import { buildDryRunPlan } from "../src/lib/publishing/dry-run.js";
import { computeBodyHash, computeDedupHash } from "../src/lib/publishing/dedup.js";

describe("buildDryRunPlan", () => {
  const target = { owner: "acme", repo: "metis", baseUrl: null, provider: "github" as const };

  it("emits label upserts + issue creates + sub-issue attach", () => {
    const drafts = [
      {
        id: "d_epic",
        title: "[Epic] Apollo",
        body: "epic body",
        labels: ["epic", "metis-generated"],
        parentDraftId: null,
        draftType: "epic",
      },
      {
        id: "d_feat",
        title: "[Feature] Login",
        body: "feature body",
        labels: ["feature"],
        parentDraftId: "d_epic",
        draftType: "feature",
      },
    ];
    const plan = buildDryRunPlan({
      batchId: "b1",
      targetOwner: target.owner,
      targetRepo: target.repo,
      targetBaseUrl: null,
      provider: target.provider,
      drafts,
      additionalLabels: ["custom"],
      existingByHash: new Map(),
      perCallMs: 1000,
    });
    const kinds = plan.actions.map((a) => a.kind);
    expect(kinds).toContain("label.upsert");
    expect(kinds.filter((k) => k === "issue.create").length).toBe(2);
    expect(kinds).toContain("subIssue.attach");
    expect(plan.totalActions).toBe(plan.actions.length);
    expect(plan.estimatedDurationMs).toBeGreaterThan(0);
  });

  it("returns issue.skipDuplicate when bodyHash matches existing", () => {
    const draft = {
      id: "d1",
      title: "Hello",
      body: "x",
      labels: ["feature"],
      parentDraftId: null,
      draftType: "feature",
    };
    const hash = computeDedupHash("acme", "metis", draft.title);
    const bodyHash = computeBodyHash(draft.body);
    const plan = buildDryRunPlan({
      batchId: "b1",
      targetOwner: "acme",
      targetRepo: "metis",
      targetBaseUrl: null,
      provider: "github",
      drafts: [draft],
      additionalLabels: [],
      existingByHash: new Map([[hash, { issueNumber: 42, bodyHash }]]),
      perCallMs: 100,
    });
    const skip = plan.actions.find((a) => a.kind === "issue.skipDuplicate");
    expect(skip).toBeDefined();
    expect(skip).toMatchObject({ existingIssueNumber: 42 });
  });

  it("returns issue.update when bodyHash changed", () => {
    const draft = {
      id: "d1",
      title: "Hello",
      body: "new body",
      labels: ["feature"],
      parentDraftId: null,
      draftType: "feature",
    };
    const hash = computeDedupHash("acme", "metis", draft.title);
    const plan = buildDryRunPlan({
      batchId: "b1",
      targetOwner: "acme",
      targetRepo: "metis",
      targetBaseUrl: null,
      provider: "github",
      drafts: [draft],
      additionalLabels: [],
      existingByHash: new Map([[hash, { issueNumber: 7, bodyHash: "stale" }]]),
      perCallMs: 100,
    });
    const upd = plan.actions.find((a) => a.kind === "issue.update");
    expect(upd).toBeDefined();
    expect(upd).toMatchObject({ existingIssueNumber: 7 });
  });
});

/**
 * #1093 — the plan must state whether the credential resolved.
 *
 * A dry run that reports `completed` for input the live publish rejects with
 * 400 is worse than no dry run: it is the one failure an operator most wants
 * pre-flighted. Malformed refs are now rejected before a batch row exists
 * (#1092), so what the plan has to carry is the supplied-but-unresolvable
 * case.
 */
describe("buildDryRunPlan — credential verdict (#1093)", () => {
  const base = {
    batchId: "b1",
    targetOwner: "acme",
    targetRepo: "metis",
    targetBaseUrl: null,
    provider: "github" as const,
    drafts: [],
    additionalLabels: [],
    existingByHash: new Map(),
    perCallMs: 100,
  };

  it("defaults to an explicit 'missing' verdict rather than silent success", () => {
    const plan = buildDryRunPlan(base);
    expect(plan.credentialResolved).toBe(false);
    expect(plan.credentialCheck).toBe("missing");
  });

  it("records a resolved credential", () => {
    const plan = buildDryRunPlan({
      ...base,
      credential: { check: "resolved", errorCode: null },
    });
    expect(plan.credentialResolved).toBe(true);
    expect(plan.credentialErrorCode).toBeNull();
  });

  it("records an unresolved credential with a bare error code", () => {
    const plan = buildDryRunPlan({
      ...base,
      credential: { check: "unresolved", errorCode: "VAULT_REF_UNRESOLVED" },
    });
    expect(plan.credentialResolved).toBe(false);
    expect(plan.credentialCheck).toBe("unresolved");
    // A code, never vault contents or upstream text.
    expect(plan.credentialErrorCode).toBe("VAULT_REF_UNRESOLVED");
  });
});
