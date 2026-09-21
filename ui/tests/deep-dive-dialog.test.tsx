/**
 * Component tests for <DeepDiveDialog /> (Epic #176 / Issue #180).
 *
 * Covers: open → loading → editable draft, edit fields, successful publish
 * (links + toast), publish error (edits preserved, dialog stays open), and the
 * deep-dive error → retry path.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const deepDiveFinding = vi.fn();
const publishFinding = vi.fn();
vi.mock("@/lib/analysis-api", () => ({
  analysisApi: {
    deepDiveFinding: (...args: unknown[]) => deepDiveFinding(...args),
    publishFinding: (...args: unknown[]) => publishFinding(...args),
  },
}));

const toastSuccess = vi.fn();
vi.mock("sonner", () => ({ toast: { success: (...a: unknown[]) => toastSuccess(...a) } }));

import { DeepDiveDialog } from "@/components/findings/deep-dive-dialog";

interface FindingIssueDraftShape {
  title: string;
  problemStatement: string;
  affected: { files: string[]; requirementIds: string[] };
  acceptanceCriteria: string[];
  suggestedLabels: string[];
}

const FINDING = { id: "find_1", title: "No audit logging", agentKey: "code" };
const PERSONA = { agentKey: "code", name: "Winston", role: "Solution Architect", avatar: "🏛️" };

const DRAFT = {
  title: "Add audit logging to all mutations",
  problemStatement: "Mutations are not audited.",
  affected: { files: ["src/routes/users.ts"], requirementIds: ["REQ-1"] },
  acceptanceCriteria: ["Every mutation writes an AuditLog row"],
  suggestedLabels: ["security"],
};

function renderDialog(open = true) {
  return render(
    <DeepDiveDialog
      open={open}
      onOpenChange={vi.fn()}
      projectId="proj_1"
      analysisId="ana_1"
      finding={FINDING}
      persona={PERSONA}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  deepDiveFinding.mockResolvedValue({ draft: DRAFT, meta: { tokensUsed: 1, model: "haiku" } });
  publishFinding.mockResolvedValue({
    links: [{ provider: "github", url: "https://gh/issues/42", issueKey: "42" }],
  });
});

describe("<DeepDiveDialog />", () => {
  it("does not trigger a deep dive while closed", () => {
    renderDialog(false);
    expect(deepDiveFinding).not.toHaveBeenCalled();
  });

  it("runs the deep dive on open and shows a loading state then editable fields", async () => {
    let resolve!: (v: unknown) => void;
    deepDiveFinding.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    renderDialog();

    // Loading state visible while the deep dive is in flight.
    expect(await screen.findByTestId("deep-dive-loading")).toBeInTheDocument();
    expect(deepDiveFinding).toHaveBeenCalledWith("proj_1", "ana_1", "find_1", {});

    resolve({ draft: DRAFT, meta: { tokensUsed: 1, model: "haiku" } });

    const titleField = (await screen.findByTestId("deep-dive-title")) as HTMLInputElement;
    expect(titleField.value).toBe(DRAFT.title);
    expect(screen.getByTestId("persona-tag-name")).toHaveTextContent("Winston");
  });

  it("publishes the edited draft and shows the created issue link + toast", async () => {
    renderDialog();
    const titleField = (await screen.findByTestId("deep-dive-title")) as HTMLInputElement;

    fireEvent.change(titleField, { target: { value: "Edited title" } });
    fireEvent.change(screen.getByTestId("deep-dive-problem"), {
      target: { value: "Rewritten problem" },
    });
    fireEvent.change(screen.getByTestId("deep-dive-files"), {
      target: { value: "a.ts\nb.ts" },
    });
    fireEvent.change(screen.getByTestId("deep-dive-reqs"), {
      target: { value: "REQ-9" },
    });
    fireEvent.change(screen.getByTestId("deep-dive-criteria"), {
      target: { value: "Does the thing\nAnd the other" },
    });
    fireEvent.change(screen.getByTestId("deep-dive-labels"), {
      target: { value: "security, audit" },
    });
    fireEvent.click(screen.getByTestId("deep-dive-publish"));

    await screen.findByTestId("deep-dive-links");
    expect(publishFinding).toHaveBeenCalledTimes(1);
    const [, , , body] = publishFinding.mock.calls[0];
    const draft = (body as { draft: FindingIssueDraftShape }).draft;
    expect(draft.title).toBe("Edited title");
    expect(draft.problemStatement).toBe("Rewritten problem");
    expect(draft.affected.files).toEqual(["a.ts", "b.ts"]);
    expect(draft.affected.requirementIds).toEqual(["REQ-9"]);
    expect(draft.acceptanceCriteria).toEqual(["Does the thing", "And the other"]);
    expect(draft.suggestedLabels).toEqual(["security", "audit"]);

    expect(screen.getByTestId("deep-dive-link")).toHaveAttribute("href", "https://gh/issues/42");
    expect(toastSuccess).toHaveBeenCalledTimes(1);
  });

  it("disables the publish button when the title is cleared", async () => {
    renderDialog();
    const titleField = await screen.findByTestId("deep-dive-title");
    fireEvent.change(titleField, { target: { value: "" } });
    expect(screen.getByTestId("deep-dive-publish")).toBeDisabled();
  });

  it("keeps the dialog open with an inline error and preserves edits on publish failure", async () => {
    publishFinding.mockRejectedValueOnce(new Error("boom"));
    renderDialog();
    const titleField = (await screen.findByTestId("deep-dive-title")) as HTMLInputElement;
    fireEvent.change(titleField, { target: { value: "Keep me" } });

    fireEvent.click(screen.getByTestId("deep-dive-publish"));

    expect(await screen.findByTestId("deep-dive-error")).toBeInTheDocument();
    // Edits preserved; form still visible.
    expect((screen.getByTestId("deep-dive-title") as HTMLInputElement).value).toBe("Keep me");
    expect(screen.queryByTestId("deep-dive-links")).not.toBeInTheDocument();
  });

  it("shows an error with a retry when the deep dive fails", async () => {
    deepDiveFinding.mockRejectedValueOnce(new Error("nope"));
    renderDialog();

    expect(await screen.findByTestId("deep-dive-error")).toBeInTheDocument();
    const retry = screen.getByTestId("deep-dive-retry");

    deepDiveFinding.mockResolvedValueOnce({ draft: DRAFT, meta: { tokensUsed: 1, model: "h" } });
    fireEvent.click(retry);

    await waitFor(() => expect(screen.getByTestId("deep-dive-title")).toBeInTheDocument());
    expect(deepDiveFinding).toHaveBeenCalledTimes(2);
  });

  it("publishes to multiple destinations and pluralises the toast", async () => {
    publishFinding.mockResolvedValueOnce({
      links: [
        { provider: "github", url: "https://gh/issues/1", issueKey: "1" },
        { provider: "jira", url: "https://jira/ACME-2", issueKey: "ACME-2" },
      ],
    });
    renderDialog();
    await screen.findByTestId("deep-dive-title");
    fireEvent.click(screen.getByTestId("deep-dive-publish"));

    await screen.findByTestId("deep-dive-links");
    expect(screen.getAllByTestId("deep-dive-link")).toHaveLength(2);
    expect(toastSuccess).toHaveBeenCalledWith("Created 2 issues");
  });
});
