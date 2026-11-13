"use client";

/**
 * Project settings — the ⚙ tab (#29, epic #26). This form used to BE the
 * project's landing page, titled "Overview"; the landing page now shows the
 * pipeline, and everything configurable about a project lives here.
 */
import Link from "next/link";
import { notFound, useParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError } from "@/lib/api-client";
import { projectsApi } from "@/lib/projects-api";
import { useAuth } from "@/lib/auth-context";
import { queryKeys } from "@/lib/query-keys";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { AiProviderPicker } from "@/components/projects/ai-provider-picker";
import { AiModelPicker } from "@/components/projects/ai-model-picker";
import { PrimaryRepoCard } from "@/components/projects/primary-repo-card";
import { AutoReviewPrsSettingsCard } from "@/components/projects/auto-review-prs-settings-card";
import { WorkspaceAssignCard } from "@/components/projects/workspace-assign-card";
import { SafetySettingsCard } from "@/components/projects/safety-settings-card";
import { BudgetSettingsCard } from "@/components/projects/budget-settings-card";
import { AutopilotSettingsCard } from "@/components/projects/autopilot-settings-card";
import { DatabaseAwareAnalysisSettingsCard } from "@/components/projects/database-aware-analysis-settings-card";
import { SqlLineageSettingsCard } from "@/components/projects/sql-lineage-settings-card";
import { AgentsMdCard } from "@/components/projects/agents-md-card";
import { InferenceProfileCard } from "@/components/projects/inference-profile-card";
import { QuarantinePanel } from "@/components/projects/quarantine-panel";
import { ChroniclePanel } from "@/components/projects/chronicle-panel";
import { ApprovalGateSettingsCard } from "@/components/publishing/approval-gate-card";
import { PageHeader } from "@/components/ui/page-header";
import { SkeletonText } from "@/components/ui/skeleton";

export default function ProjectSettingsPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id ?? "";
  const qc = useQueryClient();
  const { user } = useAuth();
  const canEditBudget = user?.role === "admin";
  // #469 — the per-project skill allowlist lives in Library; the link is shown
  // only to users the server's `project.update` gate would let save it. #1169 —
  // the same gate decides whether the automatic PR review switch is enabled.
  const canManageSkills = user?.permissions.includes("project.update") ?? false;

  const project = useQuery({
    queryKey: queryKeys.projects.detail(id),
    queryFn: () => projectsApi.get(id),
    enabled: Boolean(id),
  });

  const archive = useMutation({
    mutationFn: () => projectsApi.archive(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.projects.all }),
  });

  if (!id) return <div className="p-6">Invalid project id.</div>;
  if (project.isLoading) {
    return (
      <div className="p-6">
        <SkeletonText lines={4} label="Loading project settings…" />
      </div>
    );
  }
  if (project.error instanceof ApiError && project.error.status === 404) {
    notFound();
  }
  if (project.error || !project.data) {
    return <div className="p-6 text-destructive">Project not found.</div>;
  }
  const p = project.data;
  const isArchived = p.status === "archived";

  return (
    <div className="space-y-6 p-2 md:p-0" data-testid="project-settings-root">
      <PageHeader
        title="Project settings"
        description={
          <>
            {p.name} · <code>{p.slug}</code> · {p.status}
          </>
        }
        actions={
          <>
            {!isArchived ? (
              <Button
                variant="outline"
                onClick={() => archive.mutate()}
                disabled={archive.isPending}
                data-testid="archive-button"
              >
                {archive.isPending ? "Archiving…" : "Archive"}
              </Button>
            ) : null}
          </>
        }
      />

      {/* #2337 — grouped General / AI & cost / Advanced; Advanced starts closed.
          Every card is still here and keeps its own behaviour. */}
      <Card className="space-y-4 p-4" data-testid="project-settings-general">
        <h2 className="text-lg font-semibold">General</h2>
        <WorkspaceAssignCard projectId={id} workspaceId={p.workspaceId} />
        <PrimaryRepoCard projectId={id} />
        <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {canManageSkills ? (
            <Link
              href={`/library?tab=skills&projectId=${encodeURIComponent(id)}`}
              className="underline"
              data-testid="project-skills-link"
            >
              Manage this project&apos;s skills in Library →
            </Link>
          ) : null}
          {/* #31 — custom agents are managed on Library → Agents, scoped to this project. */}
          <Link
            href={`/library?tab=agents&projectId=${encodeURIComponent(id)}`}
            className="underline"
            data-testid="project-agents-link"
          >
            Manage this project&apos;s agents in Library →
          </Link>
        </p>
      </Card>

      {/* #2452 — the approval rules (self-approval, approved review to publish)
          are project-wide, so they are here, where an analyst looks for one; the
          same card stays on Deliverables → Publish. */}
      <ApprovalGateSettingsCard projectId={id} />

      <Card className="space-y-4 p-4" data-testid="project-settings-ai-cost">
        <h2 className="text-lg font-semibold">AI &amp; cost</h2>
        <AiProviderPicker projectId={id} current={p.aiProviderId} />
        <AiModelPicker projectId={id} current={p.aiModel} />
        <p className="text-xs text-muted-foreground">
          <Link
            href={`/projects/${id}/settings/models`}
            className="underline"
            data-testid="model-settings-link"
          >
            Configure model preferences →
          </Link>
        </p>
        <SafetySettingsCard projectId={id} current={p.safetyMode} />
        <BudgetSettingsCard projectId={id} current={p.monthlyTokenBudget} canEdit={canEditBudget} />
        <AutopilotSettingsCard
          projectId={id}
          enabled={p.autopilotEnabled}
          costCeilingCents={p.autopilotCostCeilingCents}
        />
        <AutoReviewPrsSettingsCard
          projectId={id}
          enabled={p.autoReviewPrs}
          monthlyBudgetCents={p.prReviewMonthlyBudgetCents}
          canEdit={canManageSkills}
        />
      </Card>

      {/* A native disclosure: keyboard-operable and announced as expandable with no script. */}
      <details className="group rounded-lg border bg-card" data-testid="project-settings-advanced">
        <summary
          className="cursor-pointer select-none p-4 text-lg font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          data-testid="project-settings-advanced-toggle"
        >
          Advanced
          <span className="ml-2 text-sm font-normal text-muted-foreground">
            Cloud inference profile, database and SQL analysis, AGENTS.md
          </span>
        </summary>
        <div className="space-y-4 px-4 pb-4">
          <InferenceProfileCard projectId={id} />
          <DatabaseAwareAnalysisSettingsCard projectId={id} />
          <SqlLineageSettingsCard projectId={id} />
          <AgentsMdCard projectId={id} />
        </div>
      </details>

      <QuarantinePanel projectId={id} />

      <ChroniclePanel projectId={id} />
    </div>
  );
}
