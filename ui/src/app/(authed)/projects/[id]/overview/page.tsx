"use client";

/**
 * Epic #298 / Issue #313 — project overview viewer.
 *
 * Renders the cached `project_overview.md` from the server.
 *
 * #1371 — it used to dump the markdown into a `<pre>`, so `# Project Overview`,
 * `## Summary` and the entire symbol table printed literally, delimiter row and
 * all (a DOM check found zero `table` elements). Chat renders GFM tables
 * correctly in this same app, so the page now uses that same {@link ChatMarkdown}
 * renderer. Body copy also moved off `text-zinc-400/500` on a dark card, which
 * measured below the WCAG AA 4.5:1 floor, onto the theme's `muted-foreground`
 * token used by the rest of the app.
 */
import { useParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTransientToast } from "@/hooks/use-transient-toast";
import { toast } from "sonner";
import { ApiError } from "@/lib/api-client";
import {
  projectsApi,
  type ProjectOverview,
  type ProjectOverviewWithStats,
} from "@/lib/projects-api";
import { queryKeys } from "@/lib/query-keys";
import { JobProgress } from "@/components/realtime/job-progress";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { OverviewMarkdown } from "@/components/projects/overview-markdown";

export default function ProjectOverviewPage(): React.ReactElement {
  const params = useParams<{ id: string }>();
  const projectId = params?.id ?? "";
  const qc = useQueryClient();
  // #1284 — the hook owns the 1.5s reset timer AND cancels it on unmount.
  const { toast: copyToast, showToast: showCopyToast } = useTransientToast<"copied" | "failed">(
    1500,
  );
  const copyState = copyToast ?? "idle";

  const project = useQuery({
    queryKey: queryKeys.projects.detail(projectId),
    queryFn: () => projectsApi.get(projectId),
    enabled: Boolean(projectId),
  });

  const overview = useQuery<ProjectOverview, ApiError>({
    queryKey: ["project-overview", projectId],
    queryFn: () => projectsApi.getOverview(projectId),
    enabled: Boolean(projectId),
    retry: (failureCount, err) => {
      // 404 = "never generated" — render the empty state instead of retrying.
      if (err instanceof ApiError && err.status === 404) return false;
      return failureCount < 2;
    },
  });

  // Issue #423 — regenerate now streams a `job:lifecycle` (kind
  // `overview-regenerate`) and, critically, fires the success toast that was
  // previously MISSING. The build is fast and awaited server-side, so the
  // response itself carries the result + symbol count — drive the toast from the
  // mutation callbacks (a late `subscribe:job` would miss the already-fired
  // terminal event), and show an indeterminate bar while it runs.
  const regenerate = useMutation<ProjectOverviewWithStats, ApiError>({
    mutationFn: () => projectsApi.regenerateOverview(projectId),
    onSuccess: (data) => {
      qc.setQueryData(["project-overview", projectId], {
        markdown: data.markdown,
        generatedAt: data.generatedAt,
      });
      toast.success(`Overview regenerated from ${data.stats.symbolCount} symbols.`);
    },
    onError: () => {
      // User-safe terminal message — the inline card shows the typed ApiError
      // detail; the toast stays generic so list-view watchers never see raw error.
      toast.error("The overview regeneration failed. Please try again.");
    },
  });

  const markdown = overview.data?.markdown ?? regenerate.data?.markdown ?? "";
  const generatedAt = overview.data?.generatedAt ?? regenerate.data?.generatedAt ?? null;

  async function handleCopy() {
    if (!markdown) return;
    try {
      await navigator.clipboard.writeText(markdown);
      showCopyToast("copied");
    } catch {
      showCopyToast("failed");
    }
  }

  function handleDownload() {
    if (!markdown) return;
    const blob = new Blob([markdown], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "project_overview.md";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  if (!projectId) return <p className="p-6">Missing project id.</p>;

  const isMissing =
    overview.error instanceof ApiError && overview.error.status === 404 && !markdown;
  const regenerateError = regenerate.error;

  return (
    <div className="space-y-6 p-6" data-testid="project-overview-page">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">
            {/* #29 — "Overview" alone names the project landing page. */}
            Code Overview — {project.data?.name ?? "loading…"}
          </h1>
          <p className="text-sm text-muted-foreground">
            Auto-generated from the AST CodeGraph. Top symbols by in-degree, entry points, and a
            deterministic summary.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="secondary"
            onClick={handleCopy}
            disabled={!markdown}
            data-testid="overview-copy"
          >
            {copyState === "copied" ? "Copied" : copyState === "failed" ? "Copy failed" : "Copy"}
          </Button>
          <Button
            variant="secondary"
            onClick={handleDownload}
            disabled={!markdown}
            data-testid="overview-download"
          >
            Download
          </Button>
          <Button
            onClick={() => regenerate.mutate()}
            disabled={regenerate.isPending}
            data-testid="overview-regenerate"
          >
            {regenerate.isPending ? "Regenerating…" : "Regenerate"}
          </Button>
        </div>
      </header>

      {generatedAt ? (
        <p className="text-xs text-muted-foreground" data-testid="overview-generated-at">
          Generated {new Date(generatedAt).toLocaleString()}.
        </p>
      ) : null}

      {regenerate.isPending ? (
        <JobProgress
          indeterminate
          message="Regenerating project overview…"
          label="Overview regeneration"
          testId="overview-progress"
        />
      ) : null}

      {regenerateError ? (
        <Card role="alert" className="border-red-700 bg-red-950/30 p-3 text-sm text-red-200">
          Failed to regenerate: {regenerateError.message}
          {regenerateError.code ? ` (${regenerateError.code})` : null}
        </Card>
      ) : null}

      {overview.isLoading ? (
        <p role="status" className="text-sm text-muted-foreground">
          Loading overview…
        </p>
      ) : isMissing ? (
        <Card className="space-y-3 p-4" data-testid="overview-empty-state">
          <h2 className="text-lg font-semibold">No overview yet</h2>
          <p className="text-sm text-muted-foreground">
            This project has not had its overview generated. Click <strong>Regenerate</strong> to
            compute one from the CodeGraph. It is a deterministic AST pass — no LLM cost.
          </p>
          <p className="text-xs text-muted-foreground">
            Note: regenerate fails with 409 (NO_GRAPH) when the project has not yet been ingested.
            Run a repo ingest first.
          </p>
        </Card>
      ) : (
        <Card className="overflow-x-auto p-4">
          <OverviewMarkdown markdown={markdown} />
        </Card>
      )}
    </div>
  );
}
