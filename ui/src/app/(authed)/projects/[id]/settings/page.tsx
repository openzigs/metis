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
import { SafetySettingsCard } from "@/components/projects/safety-settings-card";
import { BudgetSettingsCard } from "@/components/projects/budget-settings-card";
import { AutopilotSettingsCard } from "@/components/projects/autopilot-settings-card";
import { DatabaseAwareAnalysisSettingsCard } from "@/components/projects/database-aware-analysis-settings-card";
import { SqlLineageSettingsCard } from "@/components/projects/sql-lineage-settings-card";
import { AgentsMdCard } from "@/components/projects/agents-md-card";
import { CustomAgentsEnablementCard } from "@/components/projects/custom-agents-enablement-card";
import { InferenceProfileCard } from "@/components/projects/inference-profile-card";
import { QuarantinePanel } from "@/components/projects/quarantine-panel";
import { ChroniclePanel } from "@/components/projects/chronicle-panel";

export default function ProjectSettingsPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id ?? "";
  const qc = useQueryClient();
  const { user } = useAuth();
  const canEditBudget = user?.role === "admin";
  // #469 — the per-project skill allowlist lives in Library; the link is shown
  // only to users the server's `project.update` gate would let save it.
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
  if (project.isLoading) return <div className="p-6">Loading…</div>;
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
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Project settings</h1>
          <p className="text-sm text-muted-foreground">
            {p.name} · <code>{p.slug}</code> · {p.status}
          </p>
        </div>
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
      </header>

      <Card className="space-y-4 p-4">
        <h2 className="text-lg font-semibold">Settings</h2>
        <AiProviderPicker projectId={id} current={p.aiProviderId} />
        <AiModelPicker projectId={id} current={p.aiModel} />
        <PrimaryRepoCard projectId={id} />
        <InferenceProfileCard projectId={id} />
        <SafetySettingsCard projectId={id} current={p.safetyMode} />
        <BudgetSettingsCard projectId={id} current={p.monthlyTokenBudget} canEdit={canEditBudget} />
        <AutopilotSettingsCard
          projectId={id}
          enabled={p.autopilotEnabled}
          costCeilingCents={p.autopilotCostCeilingCents}
        />
        <DatabaseAwareAnalysisSettingsCard projectId={id} />
        <SqlLineageSettingsCard projectId={id} />
        <AgentsMdCard projectId={id} />
        <CustomAgentsEnablementCard projectId={id} />
        <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <Link
            href={`/projects/${id}/settings/models`}
            className="underline"
            data-testid="model-settings-link"
          >
            Configure model preferences →
          </Link>
          {canManageSkills ? (
            <Link
              href={`/library?projectId=${encodeURIComponent(id)}`}
              className="underline"
              data-testid="project-skills-link"
            >
              Manage this project&apos;s skills in Library →
            </Link>
          ) : null}
        </p>
      </Card>

      <QuarantinePanel projectId={id} />

      <ChroniclePanel projectId={id} />
    </div>
  );
}
