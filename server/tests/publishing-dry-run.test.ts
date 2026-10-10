/**
 * Dry-run plan builder — Phase 9 (#70).
 */
import { describe, expect, it } from "vitest";
import { buildDryRunPlan, dryRunWarning } from "../src/lib/publishing/dry-run.js";
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

/**
 * #744 — the plan names no internal-id label, upserts only labels a draft
 * carries, and carries the approval gate's verdict.
 */
describe("buildDryRunPlan — labels and approval gate (#744)", () => {
  const drafts = [
    {
      id: "d_epic",
      title: "[Epic] Miniflux",
      body: "epic",
      labels: ["epic", "metis-generated", "priority:high"],
      parentDraftId: null,
      draftType: "epic",
    },
    {
      id: "d_feat",
      title: "[Feature] Feed refresh",
      body: "feat",
      labels: ["feature", "metis-generated", "finding:cmv1tix0d0vyu7d9kr8tbqrgq"],
      parentDraftId: "d_epic",
      draftType: "feature",
    },
  ];
  const base = {
    batchId: "b1",
    targetOwner: "acme",
    targetRepo: "metis",
    targetBaseUrl: null,
    provider: "github" as const,
    drafts,
    additionalLabels: [],
    existingByHash: new Map(),
    perCallMs: 100,
  };
  const upserts = (plan: ReturnType<typeof buildDryRunPlan>) =>
    plan.actions.filter((a) => a.kind === "label.upsert").flatMap((a) => a.labels ?? []);

  it("upserts only the labels the drafts carry and never a finding:<id> label", () => {
    const plan = buildDryRunPlan(base);
    expect(upserts(plan)).toEqual(["epic", "metis-generated", "priority:high", "feature"]);
    const feat = plan.actions.find((a) => a.kind === "issue.create" && a.draftId === "d_feat");
    expect(feat?.labels).toEqual(["feature", "metis-generated"]);
  });

  it("strips finding labels from an issue.update too", () => {
    const hash = computeDedupHash("acme", "metis", drafts[1].title);
    const plan = buildDryRunPlan({
      ...base,
      existingByHash: new Map([[hash, { issueNumber: 9, bodyHash: "stale" }]]),
    });
    const upd = plan.actions.find((a) => a.kind === "issue.update");
    expect(upd?.labels).toEqual(["feature", "metis-generated"]);
  });

  it("carries no gate verdict when the caller supplied none", () => {
    const plan = buildDryRunPlan(base);
    expect(plan.approvalGate).toBeNull();
    expect(plan.actions.some((a) => a.blockedByApprovalGate)).toBe(false);
  });

  it("marks exactly the issue actions the gate would block", () => {
    const hash = computeDedupHash("acme", "metis", drafts[0].title);
    const plan = buildDryRunPlan({
      ...base,
      existingByHash: new Map([[hash, { issueNumber: 3, bodyHash: "stale" }]]),
      approvalGate: { check: "blocked", blockedDraftIds: ["d_epic"] },
    });
    expect(plan.approvalGate).toEqual({ check: "blocked", blockedDraftIds: ["d_epic"] });
    const epic = plan.actions.find((a) => a.kind === "issue.update" && a.draftId === "d_epic");
    const feat = plan.actions.find((a) => a.kind === "issue.create" && a.draftId === "d_feat");
    expect(epic?.blockedByApprovalGate).toBe(true);
    expect(feat?.blockedByApprovalGate).toBeUndefined();
  });

  it("marks a blocked create", () => {
    const plan = buildDryRunPlan({
      ...base,
      approvalGate: { check: "blocked", blockedDraftIds: ["d_feat"] },
    });
    const feat = plan.actions.find((a) => a.kind === "issue.create" && a.draftId === "d_feat");
    expect(feat?.blockedByApprovalGate).toBe(true);
  });
});

describe("dryRunWarning (#744)", () => {
  const plan = (over: Partial<ReturnType<typeof buildDryRunPlan>>) => ({
    ...buildDryRunPlan({
      batchId: "b1",
      targetOwner: "acme",
      targetRepo: "metis",
      targetBaseUrl: null,
      provider: "github",
      drafts: [],
      additionalLabels: [],
      existingByHash: new Map(),
      perCallMs: 1,
      credential: { check: "resolved", errorCode: null },
    }),
    ...over,
  });

  it("is null when the credential resolved and the gate is off, passed or unknown", () => {
    expect(dryRunWarning(plan({}))).toBeNull();
    expect(dryRunWarning(plan({ approvalGate: { check: "off", blockedDraftIds: [] } }))).toBeNull();
    expect(
      dryRunWarning(plan({ approvalGate: { check: "passed", blockedDraftIds: [] } })),
    ).toBeNull();
  });

  it("keeps the #1093 credential wording", () => {
    expect(dryRunWarning(plan({ credentialResolved: false, credentialCheck: "missing" }))).toBe(
      "dry run completed, but the GitHub credential did not resolve (missing) — a live publish would be rejected",
    );
  });

  it("names a blocking gate, and joins it with a credential failure", () => {
    expect(
      dryRunWarning(plan({ approvalGate: { check: "blocked", blockedDraftIds: ["a", "b"] } })),
    ).toBe(
      "dry run completed, but the approval gate would block 2 draft(s) (APPROVAL_REQUIRED) — a live publish would be rejected",
    );
    expect(
      dryRunWarning(
        plan({
          credentialResolved: false,
          credentialCheck: "unresolved",
          approvalGate: { check: "unavailable", blockedDraftIds: [] },
        }),
      ),
    ).toBe(
      "dry run completed, but the GitHub credential did not resolve (unresolved) and the approval gate could not be checked (APPROVAL_GATE_UNAVAILABLE) — a live publish would be rejected",
    );
  });
});
