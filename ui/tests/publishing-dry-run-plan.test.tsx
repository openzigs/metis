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
  credentialWarning,
  DryRunPlanPanel,
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

describe("DryRunPlanPanel", () => {
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
