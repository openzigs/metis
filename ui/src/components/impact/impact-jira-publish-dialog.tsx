"use client";

/**
 * #2594 — confirm before an impact analysis is published to Jira.
 *
 * "Publish to Jira" used to post the moment it was clicked. This dialog opens
 * first and says what will be created, in which Jira project (and site), through
 * which METIS project, and how many issues. Nothing is sent until the analyst
 * clicks the confirm button.
 *
 * Unlike the GitHub batch confirmation (#1104), the destination here is chosen
 * by the server from the run's projects, so the analyst cannot see it until the
 * preview arrives. The confirm button therefore waits for the preview: without
 * it there is nothing to confirm.
 *
 * A connection the publish would refuse (removed, or in an error state) is
 * said so up front, with no confirm offered.
 *
 * A run published before is said so. Publishing it again creates no second
 * issue (the server returns the one it created), and the dialog says that
 * rather than promising a new one.
 */
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { ImpactJiraPublishPreview } from "@/lib/impact-analysis-api";

export interface ImpactJiraPublishDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  preview: ImpactJiraPublishPreview | undefined;
  previewLoading: boolean;
  previewError: unknown;
  /** True while the publish request itself is in flight. */
  pending: boolean;
  /** Error from the publish request, shown inside the dialog. */
  publishError: unknown;
  onConfirm: () => void;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : "Something went wrong.";
}

export function ImpactJiraPublishDialog({
  open,
  onOpenChange,
  preview,
  previewLoading,
  previewError,
  pending,
  publishError,
  onConfirm,
}: ImpactJiraPublishDialogProps) {
  const published = preview?.alreadyPublished ?? null;
  const blocked = preview?.blockedReason ?? null;
  // A published run confirms into the issue it already has, so the title and
  // button name that issue rather than today's target (#2594 review).
  const movedFrom =
    published && preview && published.jiraProjectKey !== preview.jiraProjectKey
      ? published.jiraProjectKey
      : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="impact-publish-confirm">
        <DialogHeader>
          <DialogTitle>
            {published
              ? `Already in Jira as ${published.issueKey}`
              : preview
                ? `Publish to Jira project ${preview.jiraProjectKey}?`
                : "Publish to Jira?"}
          </DialogTitle>
          <DialogDescription>Nothing is sent to Jira until you confirm.</DialogDescription>
        </DialogHeader>

        {preview ? (
          <>
            <dl className="mt-2 space-y-1 text-sm">
              <div className="flex gap-2">
                <dt className="text-muted-foreground">Jira project</dt>
                <dd className="font-mono font-medium" data-testid="impact-publish-confirm-key">
                  {preview.jiraProjectKey}
                </dd>
              </div>
              {preview.jiraSite ? (
                <div className="flex gap-2">
                  <dt className="text-muted-foreground">Jira site</dt>
                  <dd className="font-mono" data-testid="impact-publish-confirm-site">
                    {preview.jiraSite}
                  </dd>
                </div>
              ) : null}
              <div className="flex gap-2">
                <dt className="text-muted-foreground">Through project</dt>
                <dd className="font-medium" data-testid="impact-publish-confirm-project">
                  {preview.project.name}
                </dd>
              </div>
              <div className="flex gap-2">
                <dt className="text-muted-foreground">Issues to create</dt>
                <dd className="font-medium" data-testid="impact-publish-confirm-count">
                  {preview.issuesToCreate}
                </dd>
              </div>
              <div className="flex gap-2">
                <dt className="text-muted-foreground">Title</dt>
                <dd data-testid="impact-publish-confirm-title">{preview.title}</dd>
              </div>
            </dl>

            {published ? (
              <p
                className="mt-3 rounded bg-warning-muted p-2 text-sm text-warning"
                data-testid="impact-publish-confirm-already"
              >
                This analysis was published before, as{" "}
                <a
                  href={published.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-medium underline"
                >
                  {published.issueKey}
                </a>{" "}
                on {new Date(published.publishedAt).toLocaleDateString()}.
                {movedFrom ? (
                  <>
                    {" "}
                    It is in Jira project {movedFrom}, not {preview.jiraProjectKey}, which this run
                    would publish to now.
                  </>
                ) : null}{" "}
                Publishing again creates no new issue: it returns {published.issueKey}.
              </p>
            ) : (
              <p className="mt-3 text-sm text-muted-foreground">
                One Jira issue holding the whole report is created. Jira issues cannot be deleted
                from METIS.
              </p>
            )}

            {blocked ? (
              <p
                className="mt-2 text-sm text-destructive"
                data-testid="impact-publish-confirm-blocked"
              >
                {blocked}
              </p>
            ) : null}
          </>
        ) : previewLoading ? (
          <p className="mt-2 text-sm text-muted-foreground">Working out what will be published…</p>
        ) : (
          <p
            className="mt-2 text-sm text-destructive"
            data-testid="impact-publish-confirm-preview-error"
          >
            {previewError ? errorText(previewError) : "Could not work out what will be published."}
          </p>
        )}

        {publishError ? (
          <p className="mt-2 text-sm text-destructive" data-testid="impact-publish-error">
            {errorText(publishError)}
          </p>
        ) : null}

        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button
            data-testid="impact-publish-confirm-submit"
            onClick={onConfirm}
            disabled={!preview || blocked !== null || pending}
          >
            {pending
              ? "Publishing…"
              : published
                ? `Return existing issue ${published.issueKey}`
                : preview
                  ? `Publish to ${preview.jiraProjectKey}`
                  : "Publish to Jira"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
