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

// #733 — the saved publish target (pre-fill) and the analysed repo (warning).
const getDestination = vi.fn();
vi.mock("@/lib/change-analysis-api", () => ({
  publishDestinationApi: { get: (...a: unknown[]) => getDestination(...a) },
}));
const getPrimary = vi.fn();
vi.mock("@/lib/connectors-api", () => ({
  repoConnectorsApi: { getPrimary: (...a: unknown[]) => getPrimary(...a) },
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
  getDestination.mockResolvedValue({
    publishDestination: "github",
    jiraProjectKey: null,
    jiraConnectionId: null,
    githubOwner: "openzigs",
    githubRepo: "flux-v2",
  });
  getPrimary.mockResolvedValue({ ownerOrOrg: "miniflux", repoName: "v2" });
});

/** Wait for the saved target to land in the dialog's target fields. */
async function waitForSavedTarget(): Promise<void> {
  await waitFor(() => expect(screen.getByTestId("deep-dive-target-owner")).toHaveValue("openzigs"));
}

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
    await waitForSavedTarget();
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
    await waitForSavedTarget();

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
    await waitForSavedTarget();
    fireEvent.click(screen.getByTestId("deep-dive-publish"));

    await screen.findByTestId("deep-dive-links");
    expect(screen.getAllByTestId("deep-dive-link")).toHaveLength(2);
    expect(toastSuccess).toHaveBeenCalledWith("Created 2 issues");
  });
});

describe("<DeepDiveDialog /> — publish target (#733)", () => {
  it("shows the saved project target and files the issue into it", async () => {
    renderDialog();
    await screen.findByTestId("deep-dive-title");
    await waitForSavedTarget();
    expect(screen.getByTestId("deep-dive-target-repo")).toHaveValue("flux-v2");
    expect(screen.queryByTestId("deep-dive-target-upstream-warning")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("deep-dive-publish"));
    await screen.findByTestId("deep-dive-links");
    const [projectId, , , body] = publishFinding.mock.calls[0];
    expect(projectId).toBe("proj_1");
    expect((body as { target: unknown }).target).toEqual({ owner: "openzigs", repo: "flux-v2" });
  });

  it("lets the user change the target, and files into the edited one", async () => {
    renderDialog();
    await screen.findByTestId("deep-dive-title");
    await waitForSavedTarget();
    fireEvent.change(screen.getByTestId("deep-dive-target-owner"), { target: { value: " me " } });
    fireEvent.change(screen.getByTestId("deep-dive-target-repo"), { target: { value: "sandbox" } });
    fireEvent.click(screen.getByTestId("deep-dive-publish"));
    await screen.findByTestId("deep-dive-links");
    const [, , , body] = publishFinding.mock.calls[0];
    expect((body as { target: unknown }).target).toEqual({ owner: "me", repo: "sandbox" });
  });

  it("never defaults to the analysed repo: with no saved target the fields are empty and Create Issue is disabled", async () => {
    getDestination.mockResolvedValue({
      publishDestination: "github",
      jiraProjectKey: null,
      jiraConnectionId: null,
      githubOwner: null,
      githubRepo: null,
    });
    renderDialog();
    await screen.findByTestId("deep-dive-title");
    await waitFor(() => expect(getPrimary).toHaveBeenCalledWith("proj_1"));
    await waitFor(() => expect(getDestination).toHaveBeenCalledWith("proj_1"));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByTestId("deep-dive-target-owner")).toHaveValue("");
    expect(screen.getByTestId("deep-dive-target-repo")).toHaveValue("");
    expect(screen.getByTestId("deep-dive-target-hint")).toBeInTheDocument();
    expect(screen.getByTestId("deep-dive-publish")).toBeDisabled();
  });

  it("keeps Create Issue disabled when the target lookup fails", async () => {
    getDestination.mockRejectedValue(new Error("down"));
    getPrimary.mockRejectedValue(new Error("down"));
    renderDialog();
    await screen.findByTestId("deep-dive-title");
    await waitFor(() => expect(getDestination).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByTestId("deep-dive-target-owner")).toBeInTheDocument();
    expect(screen.getByTestId("deep-dive-publish")).toBeDisabled();
  });

  it("pre-fills owner and repo only as a pair, never into a half-typed target", async () => {
    let resolveDest!: (v: unknown) => void;
    getDestination.mockReturnValue(new Promise((r) => (resolveDest = r)));
    renderDialog();
    await screen.findByTestId("deep-dive-title");
    // The user starts typing before the saved target arrives.
    fireEvent.change(screen.getByTestId("deep-dive-target-owner"), { target: { value: "me" } });
    resolveDest({
      publishDestination: "github",
      jiraProjectKey: null,
      jiraConnectionId: null,
      githubOwner: "openzigs",
      githubRepo: "flux-v2",
    });
    await waitFor(() => expect(getPrimary).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByTestId("deep-dive-target-owner")).toHaveValue("me");
    // Not me/flux-v2 — a repository the user never chose under that owner.
    expect(screen.getByTestId("deep-dive-target-repo")).toHaveValue("");
  });

  it("warns when the target is the analysed (connector) repository", async () => {
    renderDialog();
    await screen.findByTestId("deep-dive-title");
    await waitForSavedTarget();
    fireEvent.change(screen.getByTestId("deep-dive-target-owner"), {
      target: { value: "Miniflux" },
    });
    fireEvent.change(screen.getByTestId("deep-dive-target-repo"), { target: { value: "v2" } });
    expect(await screen.findByTestId("deep-dive-target-upstream-warning")).toHaveTextContent(
      "Miniflux/v2 is the repository this project analyses",
    );
  });

  it("shows no GitHub target and sends none for a Jira-only project", async () => {
    getDestination.mockResolvedValue({
      publishDestination: "jira",
      jiraProjectKey: "ACME",
      jiraConnectionId: "jc_1",
      githubOwner: null,
      githubRepo: null,
    });
    renderDialog();
    await screen.findByTestId("deep-dive-title");
    await waitFor(() =>
      expect(screen.queryByTestId("deep-dive-target-owner")).not.toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId("deep-dive-publish"));
    await screen.findByTestId("deep-dive-links");
    const [, , , body] = publishFinding.mock.calls[0];
    expect("target" in (body as object)).toBe(false);
  });

  it("clears the typed target when the dialog closes", async () => {
    const view = renderDialog();
    await screen.findByTestId("deep-dive-title");
    await waitForSavedTarget();
    fireEvent.change(screen.getByTestId("deep-dive-target-owner"), { target: { value: "typed" } });
    getDestination.mockResolvedValue({
      publishDestination: "github",
      jiraProjectKey: null,
      jiraConnectionId: null,
      githubOwner: null,
      githubRepo: null,
    });
    view.rerender(
      <DeepDiveDialog
        open={false}
        onOpenChange={vi.fn()}
        projectId="proj_1"
        analysisId="ana_1"
        finding={FINDING}
        persona={PERSONA}
      />,
    );
    view.rerender(
      <DeepDiveDialog
        open
        onOpenChange={vi.fn()}
        projectId="proj_1"
        analysisId="ana_1"
        finding={FINDING}
        persona={PERSONA}
      />,
    );
    await screen.findByTestId("deep-dive-title");
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByTestId("deep-dive-target-owner")).toHaveValue("");
  });
});
