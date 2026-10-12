/**
 * Dry-run plan panel + vault-ref hint — #1093 / #1094.
 *
 * The publish page itself is excluded from UI coverage, so the logic under
 * test deliberately lives in `src/components/publishing/dry-run-plan-panel.tsx`
 * and `src/lib/vault-ref.ts`.
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { DryRunPlan } from "@metis/shared";
import {
  approvalGateWarning,
  credentialWarning,
  describeHiddenRows,
  DryRunPlanPanel,
  orderDryRunRows,
  estimatedDurationLabel,
  parseDryRunPlan,
  summarizeDryRunPlan,
} from "@/components/publishing/dry-run-plan-panel";
import { isVaultRefShape, vaultRefHint, VAULT_REF_EXAMPLE } from "@/lib/vault-ref";

function makePlan(over: Partial<DryRunPlan> = {}): DryRunPlan {
  return {
    batchId: "batch_0000001",
    targetOwner: "openzigs",
    targetRepo: "example-requirements",
    targetBaseUrl: null,
    provider: "github",
    totalActions: 4,
    estimatedDurationMs: 4000,
    actions: [
      { kind: "label.upsert", labels: ["metis-generated"] },
      { kind: "issue.create", draftId: "draft_000000001", title: "[Epic] Apollo" },
      { kind: "issue.create", draftId: "draft_000000002", title: "[Bug] Cleartext cards" },
      { kind: "subIssue.attach", draftId: "draft_000000002", parentIssueNumber: 1000 },
    ],
    credentialResolved: true,
    credentialCheck: "resolved",
    credentialErrorCode: null,
    approvalGate: null,
    ...over,
  };
}

describe("parseDryRunPlan", () => {
  it("parses the JSON string persisted on PublishBatch.dryRunPlan", () => {
    const plan = parseDryRunPlan(JSON.stringify(makePlan()));
    expect(plan?.totalActions).toBe(4);
  });

  it("degrades to null rather than throwing on absent or malformed input", () => {
    expect(parseDryRunPlan(null)).toBeNull();
    expect(parseDryRunPlan(undefined)).toBeNull();
    expect(parseDryRunPlan("")).toBeNull();
    expect(parseDryRunPlan("{not json")).toBeNull();
    // Valid JSON but not a plan — must not render a broken panel.
    expect(parseDryRunPlan('{"totalActions":3}')).toBeNull();
    expect(parseDryRunPlan("null")).toBeNull();
  });
});

describe("summarizeDryRunPlan", () => {
  it("counts by action kind, most frequent first", () => {
    expect(summarizeDryRunPlan(makePlan())).toEqual([
      { kind: "issue.create", count: 2 },
      { kind: "label.upsert", count: 1 },
      { kind: "subIssue.attach", count: 1 },
    ]);
  });

  it("handles an empty plan", () => {
    expect(summarizeDryRunPlan(makePlan({ actions: [], totalActions: 0 }))).toEqual([]);
  });
});

describe("estimatedDurationLabel", () => {
  it.each([
    [4000, "~4s"],
    [104000, "~1m 44s"],
    [120000, "~2m"],
    [0, "~0s"],
  ])("formats %ims as %s", (ms, expected) => {
    expect(estimatedDurationLabel(makePlan({ estimatedDurationMs: ms }))).toBe(expected);
  });
});

describe("credentialWarning (#1093)", () => {
  it("is silent when the credential resolved", () => {
    expect(credentialWarning(makePlan())).toBeNull();
  });

  it("warns that a live publish will be rejected when no ref was supplied", () => {
    const warning = credentialWarning(
      makePlan({ credentialResolved: false, credentialCheck: "missing" }),
    );
    expect(warning).toMatch(/live publish will be rejected/i);
  });

  it("names the error code when the ref did not resolve", () => {
    const warning = credentialWarning(
      makePlan({
        credentialResolved: false,
        credentialCheck: "unresolved",
        credentialErrorCode: "VAULT_REF_UNRESOLVED",
      }),
    );
    expect(warning).toContain("VAULT_REF_UNRESOLVED");
    expect(warning).toMatch(/would fail before reaching GitHub/i);
  });

  it("treats a plan persisted before #1093 as unknown, not as a failure", () => {
    const legacy = JSON.parse(JSON.stringify(makePlan())) as Record<string, unknown>;
    delete legacy.credentialResolved;
    delete legacy.credentialCheck;
    expect(credentialWarning(legacy as unknown as DryRunPlan)).toBeNull();
  });
});

describe("approvalGateWarning (#744)", () => {
  it("is silent when the plan has no verdict, or the gate is off or passed", () => {
    expect(approvalGateWarning(makePlan())).toBeNull();
    expect(
      approvalGateWarning(makePlan({ approvalGate: { check: "off", blockedDraftIds: [] } })),
    ).toBeNull();
    expect(
      approvalGateWarning(makePlan({ approvalGate: { check: "passed", blockedDraftIds: [] } })),
    ).toBeNull();
    const legacy = { ...makePlan() } as Partial<DryRunPlan>;
    delete legacy.approvalGate;
    expect(approvalGateWarning(legacy as DryRunPlan)).toBeNull();
  });

  it("says a live publish will be refused, with the blocked-draft count", () => {
    expect(
      approvalGateWarning(
        makePlan({ approvalGate: { check: "blocked", blockedDraftIds: ["draft_000000001"] } }),
      ),
    ).toBe(
      "Approval required: 1 draft in this batch has no approved, up-to-date review. A live publish will be refused (APPROVAL_REQUIRED) until it is approved.",
    );
    expect(
      approvalGateWarning(
        makePlan({ approvalGate: { check: "blocked", blockedDraftIds: ["a", "b"] } }),
      ),
    ).toMatch(/^Approval required: 2 drafts in this batch have .* until they are approved\.$/);
  });

  it("treats an unverifiable gate as a refusal too", () => {
    expect(
      approvalGateWarning(
        makePlan({ approvalGate: { check: "unavailable", blockedDraftIds: [] } }),
      ),
    ).toMatch(/could not be checked/);
  });
});

describe("DryRunPlanPanel", () => {
  it("#744 — warns about the gate and tags each blocked action", () => {
    const plan = makePlan({
      approvalGate: { check: "blocked", blockedDraftIds: ["draft_000000002"] },
    });
    plan.actions[2] = { ...plan.actions[2], blockedByApprovalGate: true };
    render(<DryRunPlanPanel plan={plan} />);
    expect(screen.getByTestId("dry-run-approval-gate").textContent).toMatch(/APPROVAL_REQUIRED/);
    expect(screen.getAllByText("needs approval")).toHaveLength(1);
  });

  it("#744 — shows no gate warning or tags when the gate passes", () => {
    render(
      <DryRunPlanPanel
        plan={makePlan({ approvalGate: { check: "passed", blockedDraftIds: [] } })}
      />,
    );
    expect(screen.queryByTestId("dry-run-approval-gate")).toBeNull();
    expect(screen.queryByText("needs approval")).toBeNull();
  });

  it("renders the plan a dry run produced instead of leaving it invisible", () => {
    render(<DryRunPlanPanel plan={makePlan()} />);
    // The reported symptom: Recent batches showed "Published 0 / Failed 0 /
    // Dedup 0" and the 104-action plan was never shown anywhere.
    expect(screen.getByText(/4 actions/)).toBeTruthy();
    expect(screen.getByText(/openzigs\/example-requirements/)).toBeTruthy();
    expect(screen.getByText("[Epic] Apollo")).toBeTruthy();
    expect(screen.getByText(/issue.create × 2/)).toBeTruthy();
  });

  it("shows the credential warning prominently when it did not resolve", () => {
    render(
      <DryRunPlanPanel
        plan={makePlan({ credentialResolved: false, credentialCheck: "missing" })}
      />,
    );
    expect(screen.getByRole("status").textContent).toMatch(/live publish will be rejected/i);
  });

  it("confirms resolution when the credential is good", () => {
    render(<DryRunPlanPanel plan={makePlan()} />);
    expect(screen.getByRole("status").textContent).toMatch(/credential resolved/i);
  });

  it("renders a readable detail for every action kind the server can emit", () => {
    render(
      <DryRunPlanPanel
        plan={makePlan({
          totalActions: 6,
          actions: [
            { kind: "label.upsert", labels: ["bug", "metis-generated"] },
            { kind: "issue.create", draftId: "draft_000000001", title: "New thing" },
            {
              kind: "issue.update",
              draftId: "draft_000000002",
              existingIssueNumber: 12,
              title: "Changed thing",
            },
            {
              kind: "issue.skipDuplicate",
              draftId: "draft_000000003",
              existingIssueNumber: 13,
              reason: "body unchanged",
            },
            { kind: "subIssue.attach", draftId: "draft_000000004", parentIssueNumber: 1 },
            // `issue.close` has no detail renderer — it must not blow up.
            { kind: "issue.close", draftId: "draft_000000005" },
          ],
        })}
      />,
    );
    expect(screen.getByText("bug, metis-generated")).toBeTruthy();
    expect(screen.getByText(/#12 · Changed thing/)).toBeTruthy();
    expect(screen.getByText(/#13 · body unchanged/)).toBeTruthy();
    expect(screen.getByText(/→ epic #1/)).toBeTruthy();
  });

  it("tolerates actions missing their optional fields", () => {
    render(
      <DryRunPlanPanel
        plan={makePlan({
          totalActions: 3,
          actions: [
            { kind: "label.upsert" },
            { kind: "issue.create", draftId: "draft_000000001" },
            { kind: "subIssue.attach", draftId: "draft_000000002" },
          ],
        })}
      />,
    );
    expect(screen.getByText(/→ epic #\?/)).toBeTruthy();
  });

  it("uses the singular for a one-action plan", () => {
    render(
      <DryRunPlanPanel
        plan={makePlan({ totalActions: 1, actions: [{ kind: "label.upsert", labels: ["x"] }] })}
      />,
    );
    expect(screen.getByText(/1 action$/)).toBeTruthy();
  });

  it("caps the rendered rows and says how many were hidden", () => {
    const actions = Array.from({ length: 40 }, (_, i) => ({
      kind: "issue.create" as const,
      draftId: `draft_${String(i).padStart(9, "0")}`,
      title: `Issue ${i}`,
    }));
    render(<DryRunPlanPanel plan={makePlan({ actions, totalActions: 40 })} maxRows={10} />);
    expect(screen.getByText(/and 30 more action/)).toBeTruthy();
  });
});

describe("dry-run plan lists issues before labels (#1064)", () => {
  /** The run-7 plan: 25 label upserts, then 6 issue creates — 31 actions. */
  function run7Plan(): DryRunPlan {
    const labels = Array.from({ length: 25 }, (_, i) => ({
      kind: "label.upsert" as const,
      labels: [`label-${i}`],
    }));
    const issues = Array.from({ length: 6 }, (_, i) => ({
      kind: "issue.create" as const,
      draftId: `draft_${i}`,
      title: `[Feature] Requirement ${i}`,
    }));
    return makePlan({ actions: [...labels, ...issues], totalActions: 31 });
  }

  it("orders issue rows, then attaches, then labels — run order and step kept within each", () => {
    const rows = orderDryRunRows([
      { kind: "label.upsert", labels: ["a"] },
      { kind: "issue.create", draftId: "d1", title: "Epic" },
      { kind: "label.upsert", labels: ["b"] },
      { kind: "issue.update", draftId: "d2", existingIssueNumber: 7, title: "T" },
      { kind: "subIssue.attach", draftId: "d2", parentIssueNumber: 1 },
      { kind: "issue.skipDuplicate", draftId: "d3", existingIssueNumber: 8 },
    ]);
    expect(rows.map((r) => [r.step, r.action.kind])).toEqual([
      [2, "issue.create"],
      [4, "issue.update"],
      [6, "issue.skipDuplicate"],
      [5, "subIssue.attach"],
      [1, "label.upsert"],
      [3, "label.upsert"],
    ]);
  });

  /** An epic and `n` features under it, as the run plans them: labels first. */
  function epicPlan(n: number): DryRunPlan {
    const labels = Array.from({ length: 5 }, (_, i) => ({
      kind: "label.upsert" as const,
      labels: [`label-${i}`],
    }));
    const features = Array.from({ length: n }, (_, i) => [
      { kind: "issue.create" as const, draftId: `f${i}`, title: `[Feature] Requirement ${i}` },
      { kind: "subIssue.attach" as const, draftId: `f${i}`, parentIssueNumber: 1000 },
    ]).flat();
    const actions = [
      ...labels,
      { kind: "issue.create" as const, draftId: "epic", title: "[Epic] Batch" },
      ...features,
    ];
    return makePlan({ actions, totalActions: actions.length });
  }

  it("shows every title for an epic with 13 features, and with 24 — attaches no longer crowd them out", () => {
    for (const n of [13, 24]) {
      const { unmount } = render(<DryRunPlanPanel plan={epicPlan(n)} />);
      expect(screen.getByText("[Epic] Batch")).toBeTruthy();
      for (let i = 0; i < n; i += 1) {
        expect(screen.getByText(`[Feature] Requirement ${i}`)).toBeTruthy();
      }
      // The hidden rows are attaches and labels, never an issue title.
      expect(screen.getByTestId("dry-run-hidden").textContent).not.toContain("issue.create");
      unmount();
    }
    // One epic and 25 features is 26 titles: the cut is said, by kind.
    render(<DryRunPlanPanel plan={epicPlan(25)} />);
    expect(screen.getByTestId("dry-run-hidden").textContent).toContain("1 issue.create");
  });

  it("numbers each list item with its run step, so the announced number is the printed one", () => {
    render(<DryRunPlanPanel plan={run7Plan()} />);
    const rows = screen.getAllByTestId("dry-run-row");
    // The first row is step 26 of the run: the <li> says 26, not 1.
    expect(rows[0]!.tagName).toBe("LI");
    expect(rows[0]!.parentElement!.tagName).toBe("OL");
    expect(rows[0]!.getAttribute("value")).toBe("26");
    expect(rows[6]!.getAttribute("value")).toBe("1");
    for (const row of rows) {
      const printed = row.querySelector("[aria-hidden='true']")!;
      // The printed copy is the same number, hidden so it is not read twice.
      expect(printed.textContent).toBe(row.getAttribute("value"));
    }
  });

  it("shows every issue title when the plan is cut at 25 rows", () => {
    render(<DryRunPlanPanel plan={run7Plan()} />);
    for (let i = 0; i < 6; i += 1) {
      expect(screen.getByText(`[Feature] Requirement ${i}`)).toBeTruthy();
    }
    const rows = screen.getAllByTestId("dry-run-row");
    expect(rows).toHaveLength(25);
    // The first row is the first issue, numbered by its place in the run.
    expect(rows[0]!.textContent).toContain("26");
    expect(rows[0]!.textContent).toContain("[Feature] Requirement 0");
    expect(rows[6]!.textContent).toContain("label-0");
  });

  it("the not-shown line counts exactly what was left out, and says what it was", () => {
    render(<DryRunPlanPanel plan={run7Plan()} />);
    expect(screen.getByTestId("dry-run-hidden").textContent).toBe(
      "…and 6 more action(s) not shown (6 label.upsert).",
    );
    // 19 label rows are shown + 6 hidden = the 25 the summary chip reports.
    expect(screen.getByText("label.upsert × 25")).toBeTruthy();
    expect(
      screen.getAllByTestId("dry-run-row").filter((r) => /label\.upsert/.test(r.textContent ?? "")),
    ).toHaveLength(19);
  });

  it("names every kind left out when issues alone overflow the cap", () => {
    const plan = run7Plan();
    render(<DryRunPlanPanel plan={plan} maxRows={4} />);
    expect(screen.getByTestId("dry-run-hidden").textContent).toBe(
      "…and 27 more action(s) not shown (2 issue.create, 25 label.upsert).",
    );
    expect(describeHiddenRows([])).toBe("");
  });

  it("says the list was reordered only when it was", () => {
    const { unmount } = render(<DryRunPlanPanel plan={run7Plan()} />);
    expect(screen.getByTestId("dry-run-order-note").textContent).toContain(
      "The run upserts labels before it creates issues",
    );
    unmount();
    // A plan with no label upserts is listed in run order: no note, no hidden line.
    render(
      <DryRunPlanPanel
        plan={makePlan({
          totalActions: 1,
          actions: [{ kind: "issue.create", draftId: "d1", title: "Only" }],
        })}
      />,
    );
    expect(screen.queryByTestId("dry-run-order-note")).toBeNull();
    expect(screen.queryByTestId("dry-run-hidden")).toBeNull();
  });
});

describe("vaultRefHint (#1094)", () => {
  it("says nothing for an untouched field", () => {
    expect(vaultRefHint("")).toBeNull();
    expect(vaultRefHint("   ")).toBeNull();
  });

  it("accepts the documented form", () => {
    expect(vaultRefHint("${vault:github-mgcronin}")).toBeNull();
    expect(isVaultRefShape("${vault:github-mgcronin}")).toBe(true);
  });

  it("catches exactly the mistake the old placeholder taught", () => {
    // The placeholder read `vault:gh-publish-token`; the server 400s on it.
    const hint = vaultRefHint("vault:github-mgcronin");
    expect(hint).toContain(VAULT_REF_EXAMPLE);
    expect(hint).toMatch(/wrapper/i);
  });

  it("recognises a pasted token without repeating any of it", () => {
    const token = "ghp_averyrealisticlookingtokenvalue123456";
    const hint = vaultRefHint(token)!;
    expect(hint).toMatch(/looks like a token/i);
    // The hint is rendered into the DOM — it must not carry secret material.
    expect(hint).not.toContain(token);
    expect(hint).not.toContain("ghp_");
  });

  it("rejects an empty or whitespace-only label", () => {
    expect(vaultRefHint("${vault:}")).toBeTruthy();
    expect(vaultRefHint("${vault:   }")).toBeTruthy();
    expect(isVaultRefShape("${vault:}")).toBe(false);
  });

  it("falls back to naming the required shape for anything else", () => {
    expect(vaultRefHint("my-token-label")).toBe(`Must be written as ${VAULT_REF_EXAMPLE}.`);
  });
});
