"use client";

/**
 * Epic #176 / Issue #180 — Deep Dive → Issue dialog.
 *
 * Expands a single analysis finding into an editable issue draft (Sub 2,
 * `POST .../deep-dive`), lets the operator review/edit it, and publishes it to
 * the project's configured destination(s) (Sub 3, `POST .../publish`). The
 * originating persona (Sub 1) is shown in the header so the reader knows *who*
 * surfaced the finding.
 *
 * Behaviour contract (Issue #180 acceptance criteria):
 *  - On open, the deep-dive runs once and a loading state is shown.
 *  - When the draft returns, every field is editable.
 *  - On publish success, the created issue link(s) are shown (one per
 *    destination for `both`) plus a success toast.
 *  - On any deep-dive / publish error the dialog stays open with an inline
 *    error so the user can retry without losing their edits.
 */
import * as React from "react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { PersonaTag, type PersonaTagPersona } from "@/components/findings/persona-tag";
import { ApiError } from "@/lib/api-client";
import { triggerDownload } from "@/lib/plugins-api";
import { analysisApi, type FindingIssueDraft, type PublishedIssueLink } from "@/lib/analysis-api";

export interface DeepDiveDialogFinding {
  id: string;
  title: string;
  agentKey: string;
}

export interface DeepDiveDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  analysisId: string;
  finding: DeepDiveDialogFinding | null;
  persona?: PersonaTagPersona;
}

type Phase = "idle" | "loading" | "editing" | "publishing" | "published";

function linesToArray(value: string): string[] {
  return value
    .split("\n")
    .map((x) => x.trim())
    .filter(Boolean);
}

function csvToArray(value: string): string[] {
  return value
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function errMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

export function DeepDiveDialog({
  open,
  onOpenChange,
  projectId,
  analysisId,
  finding,
  persona,
}: DeepDiveDialogProps): React.ReactElement {
  const [phase, setPhase] = React.useState<Phase>("idle");
  const [error, setError] = React.useState<string | null>(null);
  const [links, setLinks] = React.useState<PublishedIssueLink[]>([]);

  // Editable draft fields. Multi-line collections are kept as raw text and
  // split on submit so editing stays natural (one item per line).
  const [title, setTitle] = React.useState("");
  const [problem, setProblem] = React.useState("");
  const [files, setFiles] = React.useState("");
  const [reqs, setReqs] = React.useState("");
  const [criteria, setCriteria] = React.useState("");
  const [labels, setLabels] = React.useState("");

  // Auto-load the draft once per (open, finding). A ref guards against the
  // effect re-firing into an infinite loop after a failed load — the user
  // re-triggers explicitly via the Retry button.
  const loadedFor = React.useRef<string | null>(null);

  const applyDraft = React.useCallback((draft: FindingIssueDraft) => {
    setTitle(draft.title);
    setProblem(draft.problemStatement);
    setFiles(draft.affected.files.join("\n"));
    setReqs(draft.affected.requirementIds.join("\n"));
    setCriteria(draft.acceptanceCriteria.join("\n"));
    setLabels(draft.suggestedLabels.join(", "));
  }, []);

  const runDeepDive = React.useCallback(
    async (findingId: string) => {
      setPhase("loading");
      setError(null);
      setLinks([]);
      try {
        const res = await analysisApi.deepDiveFinding(projectId, analysisId, findingId, {});
        applyDraft(res.draft);
        setPhase("editing");
      } catch (err) {
        setError(errMessage(err, "Deep dive failed. Please retry."));
        setPhase("idle");
      }
    },
    [projectId, analysisId, applyDraft],
  );

  React.useEffect(() => {
    if (!open || !finding) return;
    if (loadedFor.current === finding.id) return;
    loadedFor.current = finding.id;
    void runDeepDive(finding.id);
  }, [open, finding, runDeepDive]);

  // Reset all transient state when the dialog closes so the next open starts
  // clean (and the draft re-loads).
  React.useEffect(() => {
    if (open) return;
    loadedFor.current = null;
    setPhase("idle");
    setError(null);
    setLinks([]);
  }, [open]);

  // Reconstruct the FindingIssueDraft from the current (possibly edited) fields —
  // shared by publish and the #744 export/copy actions.
  function currentDraft(): FindingIssueDraft {
    return {
      title: title.trim(),
      problemStatement: problem.trim(),
      affected: { files: linesToArray(files), requirementIds: linesToArray(reqs) },
      acceptanceCriteria: linesToArray(criteria),
      suggestedLabels: csvToArray(labels),
    };
  }

  // #744 — download the issue draft as markdown (server-serialized, injection-safe).
  async function handleExportMarkdown(): Promise<void> {
    if (!finding) return;
    setError(null);
    try {
      const { blob, filename } = await analysisApi.exportFindingIssueDraftMarkdown(
        projectId,
        analysisId,
        finding.id,
        currentDraft(),
      );
      triggerDownload(blob, filename);
    } catch (err) {
      setError(errMessage(err, "Export failed. Please retry."));
    }
  }

  // #744 — copy the paste-ready issue-draft markdown body to the clipboard.
  async function handleCopyIssueDraft(): Promise<void> {
    if (!finding) return;
    setError(null);
    try {
      const draft = await analysisApi.exportFindingIssueDraft(
        projectId,
        analysisId,
        finding.id,
        currentDraft(),
      );
      await navigator.clipboard.writeText(draft.body);
      toast.success("Issue draft copied to clipboard");
    } catch (err) {
      setError(errMessage(err, "Copy failed. Please retry."));
    }
  }

  async function handlePublish(): Promise<void> {
    if (!finding) return;
    setPhase("publishing");
    setError(null);
    const draft = currentDraft();
    try {
      const res = await analysisApi.publishFinding(projectId, analysisId, finding.id, { draft });
      setLinks(res.links);
      setPhase("published");
      toast.success(res.links.length > 1 ? `Created ${res.links.length} issues` : "Issue created");
    } catch (err) {
      setError(errMessage(err, "Publish failed. Your edits are preserved — please retry."));
      setPhase("editing");
    }
  }

  const showForm = phase === "editing" || phase === "publishing" || phase === "published";
  const publishing = phase === "publishing";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="deep-dive-dialog"
        className="max-h-[85vh] overflow-y-auto sm:max-w-2xl"
      >
        <DialogHeader>
          <DialogTitle>Deep Dive → Issue</DialogTitle>
          <DialogDescription className="flex flex-wrap items-center gap-2">
            <span className="text-zinc-400">{finding?.title ?? "Finding"}</span>
            {finding ? <PersonaTag persona={persona} agentKey={finding.agentKey} compact /> : null}
          </DialogDescription>
        </DialogHeader>

        {phase === "loading" ? (
          <div
            data-testid="deep-dive-loading"
            role="status"
            aria-live="polite"
            className="py-10 text-center text-sm text-zinc-400"
          >
            Generating issue draft…
          </div>
        ) : null}

        {phase === "idle" && error ? (
          <div className="space-y-3 py-6 text-center">
            <p data-testid="deep-dive-error" role="alert" className="text-sm text-red-400">
              {error}
            </p>
            <Button
              data-testid="deep-dive-retry"
              variant="outline"
              size="sm"
              onClick={() => finding && void runDeepDive(finding.id)}
            >
              Retry
            </Button>
          </div>
        ) : null}

        {showForm ? (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="dd-title">Title</Label>
              <Input
                id="dd-title"
                data-testid="deep-dive-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="dd-problem">Problem statement</Label>
              <Textarea
                id="dd-problem"
                data-testid="deep-dive-problem"
                rows={5}
                value={problem}
                onChange={(e) => setProblem(e.target.value)}
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="dd-files">Affected files (one per line)</Label>
                <Textarea
                  id="dd-files"
                  data-testid="deep-dive-files"
                  rows={3}
                  value={files}
                  onChange={(e) => setFiles(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="dd-reqs">Related requirements (one per line)</Label>
                <Textarea
                  id="dd-reqs"
                  data-testid="deep-dive-reqs"
                  rows={3}
                  value={reqs}
                  onChange={(e) => setReqs(e.target.value)}
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="dd-criteria">Acceptance criteria (one per line)</Label>
              <Textarea
                id="dd-criteria"
                data-testid="deep-dive-criteria"
                rows={4}
                value={criteria}
                onChange={(e) => setCriteria(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="dd-labels">Suggested labels (comma-separated)</Label>
              <Input
                id="dd-labels"
                data-testid="deep-dive-labels"
                value={labels}
                onChange={(e) => setLabels(e.target.value)}
              />
            </div>

            {phase === "editing" && error ? (
              <p data-testid="deep-dive-error" role="alert" className="text-sm text-red-400">
                {error}
              </p>
            ) : null}

            {links.length > 0 ? (
              <div
                data-testid="deep-dive-links"
                className="space-y-1 rounded border border-emerald-700/40 bg-emerald-950/20 p-3"
              >
                <p className="text-xs font-semibold uppercase tracking-wide text-emerald-300">
                  Created
                </p>
                <ul className="space-y-1 text-sm">
                  {links.map((link) => (
                    <li key={`${link.provider}-${link.issueKey}`}>
                      <a
                        href={link.url}
                        target="_blank"
                        rel="noreferrer"
                        data-testid="deep-dive-link"
                        className="text-sky-300 underline hover:text-sky-200"
                      >
                        {link.provider}: {link.issueKey}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        ) : null}

        <DialogFooter>
          {showForm ? (
            <>
              <Button
                variant="outline"
                data-testid="deep-dive-copy"
                onClick={() => void handleCopyIssueDraft()}
              >
                Copy issue draft
              </Button>
              <Button
                variant="outline"
                data-testid="deep-dive-export-md"
                onClick={() => void handleExportMarkdown()}
              >
                Export markdown
              </Button>
            </>
          ) : null}
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {phase === "published" ? "Close" : "Cancel"}
          </Button>
          {showForm && phase !== "published" ? (
            <Button
              data-testid="deep-dive-publish"
              onClick={() => void handlePublish()}
              disabled={publishing || title.trim().length === 0}
            >
              {publishing ? "Creating…" : "Create Issue"}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
