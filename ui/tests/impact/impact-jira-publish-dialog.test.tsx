/**
 * #2594 — the confirmation shown before an impact analysis is published to
 * Jira: what will be created, in which Jira project, and how many issues; and,
 * for a run published before, that publishing again creates no new issue.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ImpactJiraPublishDialog } from "@/components/impact/impact-jira-publish-dialog";
import type { ImpactJiraPublishPreview } from "@/lib/impact-analysis-api";

const preview: ImpactJiraPublishPreview = {
  provider: "jira",
  project: { id: "p-1", name: "Miniflux Server" },
  jiraProjectKey: "MFX",
  jiraSite: "https://jira.example.com",
  title: "Impact analysis: Add a reading-time estimate",
  issuesToCreate: 1,
  alreadyPublished: null,
};

const base = {
  open: true,
  onOpenChange: () => {},
  preview,
  previewLoading: false,
  previewError: null,
  pending: false,
  publishError: null,
  onConfirm: () => {},
};

describe("ImpactJiraPublishDialog (#2594)", () => {
  it("names the Jira project, site, METIS project, issue count and title", () => {
    render(<ImpactJiraPublishDialog {...base} />);
    expect(screen.getByText("Publish to Jira project MFX?")).toBeInTheDocument();
    expect(screen.getByText("Nothing is sent to Jira until you confirm.")).toBeInTheDocument();
    expect(screen.getByTestId("impact-publish-confirm-key")).toHaveTextContent("MFX");
    expect(screen.getByTestId("impact-publish-confirm-site")).toHaveTextContent(
      "https://jira.example.com",
    );
    expect(screen.getByTestId("impact-publish-confirm-project")).toHaveTextContent(
      "Miniflux Server",
    );
    expect(screen.getByTestId("impact-publish-confirm-count")).toHaveTextContent("1");
    expect(screen.getByTestId("impact-publish-confirm-title")).toHaveTextContent(
      "Impact analysis: Add a reading-time estimate",
    );
    expect(screen.queryByTestId("impact-publish-confirm-already")).not.toBeInTheDocument();
    expect(screen.getByTestId("impact-publish-confirm-submit")).toHaveTextContent("Publish to MFX");
  });

  it("omits the site row when the connection is gone", () => {
    render(<ImpactJiraPublishDialog {...base} preview={{ ...preview, jiraSite: null }} />);
    expect(screen.queryByTestId("impact-publish-confirm-site")).not.toBeInTheDocument();
  });

  it("says when the run was published before, and that no new issue is created", () => {
    render(
      <ImpactJiraPublishDialog
        {...base}
        preview={{
          ...preview,
          issuesToCreate: 0,
          alreadyPublished: {
            issueKey: "MFX-12",
            url: "https://jira.example.com/browse/MFX-12",
            publishedAt: "2026-11-16T10:00:00.000Z",
          },
        }}
      />,
    );
    const already = screen.getByTestId("impact-publish-confirm-already");
    expect(already).toHaveTextContent("This analysis was published before, as MFX-12");
    expect(already).toHaveTextContent("Publishing again creates no new issue: it returns MFX-12.");
    expect(screen.getByRole("link", { name: "MFX-12" })).toHaveAttribute(
      "href",
      "https://jira.example.com/browse/MFX-12",
    );
    expect(screen.getByTestId("impact-publish-confirm-count")).toHaveTextContent("0");
  });

  it("calls onConfirm only when the confirm button is clicked", () => {
    const onConfirm = vi.fn();
    render(<ImpactJiraPublishDialog {...base} onConfirm={onConfirm} />);
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("impact-publish-confirm-submit"));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("offers no confirm while the preview is loading", () => {
    render(<ImpactJiraPublishDialog {...base} preview={undefined} previewLoading />);
    expect(screen.getByText("Working out what will be published…")).toBeInTheDocument();
    expect(screen.getByTestId("impact-publish-confirm-submit")).toBeDisabled();
  });

  it("shows the preview error and offers no confirm", () => {
    render(
      <ImpactJiraPublishDialog
        {...base}
        preview={undefined}
        previewError={new Error("No project in this run has Jira configured")}
      />,
    );
    expect(screen.getByTestId("impact-publish-confirm-preview-error")).toHaveTextContent(
      "No project in this run has Jira configured",
    );
    expect(screen.getByTestId("impact-publish-confirm-submit")).toBeDisabled();
  });

  it("falls back to a generic message for a non-Error failure", () => {
    render(
      <ImpactJiraPublishDialog
        {...base}
        preview={undefined}
        previewError={"nope"}
        publishError={"also nope"}
      />,
    );
    expect(screen.getByTestId("impact-publish-confirm-preview-error")).toHaveTextContent(
      "Something went wrong.",
    );
    expect(screen.getByTestId("impact-publish-error")).toHaveTextContent("Something went wrong.");
  });

  it("disables both buttons while the publish is in flight", () => {
    render(<ImpactJiraPublishDialog {...base} pending />);
    expect(screen.getByTestId("impact-publish-confirm-submit")).toHaveTextContent("Publishing…");
    expect(screen.getByTestId("impact-publish-confirm-submit")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
  });

  it("shows the publish error and closes on Cancel", () => {
    const onOpenChange = vi.fn();
    render(
      <ImpactJiraPublishDialog
        {...base}
        onOpenChange={onOpenChange}
        publishError={new Error("Jira connection is in error state")}
      />,
    );
    expect(screen.getByTestId("impact-publish-error")).toHaveTextContent(
      "Jira connection is in error state",
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
