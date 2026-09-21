/**
 * #1104 (D) — the confirmation surface for a live publish.
 *
 * The walkthrough created 14 issues in a real repository from one unconfirmed
 * click, and GitHub issues cannot be deleted through the normal API. The
 * dialog's job is therefore to state, before the click, WHAT will be written
 * and WHERE — the destination is caller-supplied, and a wrong repo is exactly
 * the mistake this prevents.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { DryRunPlan } from "@metis/shared";
import { PublishConfirmDialog } from "@/components/publishing/publish-confirm-dialog";

function makePlan(over: Partial<DryRunPlan> = {}): DryRunPlan {
  const actions: DryRunPlan["actions"] = [
    ...Array.from({ length: 77 }, (_, i) => ({
      kind: "label.upsert" as const,
      labels: [`l${i}`],
    })),
    ...Array.from({ length: 14 }, (_, i) => ({
      kind: "issue.create" as const,
      draftId: `draft_${i}`,
      title: `Issue ${i}`,
    })),
    ...Array.from({ length: 13 }, (_, i) => ({
      kind: "subIssue.attach" as const,
      draftId: `draft_${i + 1}`,
      parentIssueNumber: 1000,
    })),
  ];
  return {
    batchId: "preview-unsaved",
    targetOwner: "openzigs",
    targetRepo: "example-requirements",
    targetBaseUrl: null,
    provider: "github",
    totalActions: actions.length,
    estimatedDurationMs: 104_000,
    actions,
    credentialResolved: true,
    credentialCheck: "resolved",
    credentialErrorCode: null,
    ...over,
  };
}

const baseProps = {
  open: true,
  onOpenChange: () => {},
  target: { owner: "openzigs", repo: "example-requirements" },
  draftCount: 14,
  plan: null,
  planLoading: false,
  planError: null,
  pending: false,
  onConfirm: () => {},
};

describe("PublishConfirmDialog", () => {
  it("names the destination repository in the heading and the action button", () => {
    render(<PublishConfirmDialog {...baseProps} plan={makePlan()} />);
    expect(
      screen.getByRole("heading", { name: /openzigs\/example-requirements/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Publish to openzigs\/example-requirements/ }),
    ).toBeInTheDocument();
  });

  it("states the action counts from the plan", () => {
    render(<PublishConfirmDialog {...baseProps} plan={makePlan()} />);
    const summary = screen.getByTestId("publish-confirm-summary");
    expect(summary).toHaveTextContent("issue.create × 14");
    expect(summary).toHaveTextContent("subIssue.attach × 13");
    expect(summary).toHaveTextContent("label.upsert × 77");
    expect(screen.getByTestId("publish-confirm-total")).toHaveTextContent("104 actions");
  });

  it("says plainly that the writes cannot be undone", () => {
    render(<PublishConfirmDialog {...baseProps} plan={makePlan()} />);
    expect(screen.getByTestId("publish-confirm-irreversible")).toHaveTextContent(/cannot be/i);
  });

  it("calls onConfirm exactly once when confirmed", () => {
    const onConfirm = vi.fn();
    render(<PublishConfirmDialog {...baseProps} plan={makePlan()} onConfirm={onConfirm} />);
    fireEvent.click(screen.getByRole("button", { name: /Publish to openzigs/ }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("cancelling closes the dialog and never confirms", () => {
    const onConfirm = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <PublishConfirmDialog
        {...baseProps}
        plan={makePlan()}
        onConfirm={onConfirm}
        onOpenChange={onOpenChange}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("still shows the destination and selection while the plan is being computed", () => {
    render(<PublishConfirmDialog {...baseProps} planLoading />);
    // The two facts that prevent the wrong-repo mistake are available
    // immediately; only the exact counts wait on the round-trip.
    expect(
      screen.getByRole("heading", { name: /openzigs\/example-requirements/ }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("publish-confirm-selection")).toHaveTextContent("14");
    expect(screen.getByTestId("publish-confirm-summary")).toHaveTextContent(/working out/i);
  });

  it("does not block the publish when the plan could not be computed", () => {
    render(<PublishConfirmDialog {...baseProps} planError={new Error("boom")} />);
    expect(screen.getByTestId("publish-confirm-summary")).toHaveTextContent(/could not/i);
    expect(screen.getByRole("button", { name: /Publish to openzigs/ })).toBeEnabled();
  });

  it("warns when the plan says the credential will not resolve", () => {
    render(
      <PublishConfirmDialog
        {...baseProps}
        plan={makePlan({
          credentialResolved: false,
          credentialCheck: "unresolved",
          credentialErrorCode: "VAULT_REF_UNRESOLVED",
        })}
      />,
    );
    expect(screen.getByTestId("publish-confirm-credential")).toHaveTextContent(/did not resolve/i);
  });

  it("shows the estimated duration alongside the counts", () => {
    render(<PublishConfirmDialog {...baseProps} plan={makePlan()} />);
    expect(screen.getByTestId("publish-confirm-total")).toHaveTextContent("~1m 44s");
  });

  it("disables the action while a publish is already in flight", () => {
    render(<PublishConfirmDialog {...baseProps} plan={makePlan()} pending />);
    expect(screen.getByRole("button", { name: /Publishing/ })).toBeDisabled();
  });
});
