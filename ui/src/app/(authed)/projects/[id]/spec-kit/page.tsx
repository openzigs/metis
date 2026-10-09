"use client";

/**
 * `/projects/[id]/spec-kit` — Spec Kit Mode workspace (Epic #193).
 *
 * Three columns:
 *   1. Feature selector + artifact tree (the project's `.specify/` files, or
 *      the selected feature's `specs/<slug>/` artifacts) + enable toggle.
 *   2. Selected artifact viewer/editor.
 *   3. `speckit.*` command palette, feature actions + run output.
 *
 * Built on TanStack Query so command runs invalidate the file list and
 * the viewer immediately reflects new content. Uses native `<textarea>`
 * for editing (no Monaco dep — keeps the bundle slim per the existing
 * Tailwind/shadcn-only rule).
 *
 * #789 — the palette dispatches the canonical `speckit.*` commands (it used to
 * offer only the deprecated short aliases), per feature when one is selected;
 * checklists, issue export, delete and the `/speckit.implement` → analysis
 * handoff are buttons.
 */
import { useEffect, useMemo, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SPEC_KIT_ARTIFACT_NAMES, isSpecKitArtifactName } from "@metis/shared";
import type { SpecKitArtifactName, SpecKitNamespacedCommand } from "@metis/shared";
import { specKitApi, type SpecKitRunOptions } from "@/lib/spec-kit-api";
import { analysisApi } from "@/lib/analysis-api";
import { queryKeys } from "@/lib/query-keys";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/alert-dialog";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { JobProgress } from "@/components/realtime/job-progress";
import {
  FEATURE_REQUIRED_COMMANDS,
  parsePaletteCommand,
  suggestPaletteCommands,
} from "@/lib/spec-kit-palette";
import { buildHandoffInstructions } from "@/lib/spec-kit-handoff";
import { FeaturePanel } from "@/components/spec-kit/feature-panel";
import { ArtifactContent } from "@/components/spec-kit/artifact-content";
import { HoverHint } from "@/components/spec-kit/hover-hint";
import {
  describeSpecKitError,
  isNoProjectAccess,
  loadHandoff,
  saveHandoff,
  type SpecKitHandoff,
} from "@/lib/spec-kit-display";
import { useAuth } from "@/lib/auth-context";
import { PresenceAvatars } from "@/components/presence/PresenceAvatars";
import { CommentPanel } from "@/components/comments/CommentPanel";
import { MessageSquare } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { VaultPicker } from "@/components/connectors/vault-picker";
import { vaultRefHint, VAULT_REF_EXAMPLE } from "@/lib/vault-ref";

const FAILED = "The Spec Kit operation failed. Please try again.";
/** Shown on a write control the viewer cannot use (#789 — the server gates it). */
const REQUIRES_UPDATE = "Requires project.update";
/** #936 — shown when the server's dry run reports it cannot publish (`publishAvailable: false`). */
const PUBLISH_UNAVAILABLE =
  "Publishing issues to GitHub is not available on this server yet. The dry run lists the issues it would create.";
/** #962 — Publish waits while another export holds a task. */
const EXPORT_IN_PROGRESS =
  "Another export of this feature is still running. Wait a few minutes, then run the dry run again.";
const CLAIM_TEXT: Record<"in_progress" | "reconcile", string> = {
  in_progress: "in progress",
  reconcile: "abandoned, will reconcile",
};
/** #953 — Publish needs the dry run to have resolved a vault secret. */
const CREDENTIAL_NEEDED = "Pick a GitHub token from the vault, then run the dry run again.";
const CREDENTIAL_TEXT: Record<"resolved" | "missing" | "unresolved", string> = {
  resolved: "The vault secret resolved — Publish will use it.",
  missing: "No GitHub token picked — choose a vault secret and run the dry run again.",
  unresolved: "That vault secret ref does not name a vault secret.",
};

export default function SpecKitPage() {
  const params = useParams<{ id: string }>();
  const projectId = params?.id ?? "";
  const queryClient = useQueryClient();
  // Epic #34 (AC1/AC3) — collaboration on Spec Kit artifacts.
  const { user } = useAuth();
  // #789 — every write on this page (toggle, edit, delete, commands, constitution,
  // feature archive) is `project.update` server-side; a viewer without it gets
  // the read-only page rather than controls that 403.
  const canWrite = user?.permissions.includes("project.update") ?? false;
  const writeHint = canWrite ? undefined : REQUIRES_UPDATE;
  const [commentsOpen, setCommentsOpen] = useState(false);

  const enabledQuery = useQuery({
    queryKey: queryKeys.projects.specKitEnabled(projectId),
    queryFn: () => specKitApi.getEnabled(projectId),
    enabled: Boolean(projectId),
  });
  const filesQuery = useQuery({
    queryKey: queryKeys.projects.specKitFiles(projectId),
    queryFn: () => specKitApi.listFiles(projectId),
    enabled: Boolean(projectId),
  });

  const [selectedName, setSelectedName] = useState<SpecKitArtifactName>("spec.md");
  // #735 — a comment @mention links here as `?artifact=<name>`: open that
  // artifact with its comments. Keyed on the param, so following a second link
  // while already on this page still switches.
  const searchParams = useSearchParams();
  const linkedArtifact = searchParams?.get("artifact") ?? null;
  useEffect(() => {
    if (!linkedArtifact || !isSpecKitArtifactName(linkedArtifact)) return;
    setSelectedName(linkedArtifact);
    setCommentsOpen(true);
  }, [linkedArtifact]);
  const [editingDraft, setEditingDraft] = useState<string | null>(null);
  const [commandBuffer, setCommandBuffer] = useState("");
  const [lastResultMessage, setLastResultMessage] = useState<string | null>(null);
  const [lastErrorMessage, setLastErrorMessage] = useState<string | null>(null);
  const router = useRouter();
  // #789 — null ⇒ the project-level `.specify/` set; otherwise a feature slug.
  // #945 — kept in the URL (`?feature=<slug>`), so leaving the page and coming
  // back (or reloading) reopens the same feature.
  const linkedFeature = searchParams?.get("feature") || null;
  const [selectedFeature, setSelectedFeature] = useState<string | null>(linkedFeature);
  const [selectedKey, setSelectedKey] = useState("spec.md");
  // #789 — the export may publish only after a dry run of the same feature.
  // It records the tasks.md version previewed, so regenerating tasks.md voids it.
  // #936 — and what the dry run planned: the target, the titles, and whether
  // this server can publish at all.
  // #953 — plus the plan Publish sends back, the vault secret the dry run
  // checked, and whether it resolved. Titles are the issues it would CREATE.
  const [previewedExport, setPreviewedExport] = useState<{
    feature: string;
    tasksVersion: number | null;
    repo: string | null;
    titles: string[];
    publishAvailable: boolean;
    plan: { tasksVersion: number; digest: string } | null;
    secretRef: string;
    credentialCheck: "resolved" | "missing" | "unresolved";
    /** #962 — tasks an earlier export claimed: not new, so listed apart. */
    claims: Array<{ title: string; state: "in_progress" | "reconcile" }>;
  } | null>(null);
  // #953 — the `${vault:label}` the export publishes with (VaultPicker only).
  const [exportSecretRef, setExportSecretRef] = useState("");
  // #789 — what `/speckit.implement` handed off, for "Start analysis".
  // #945 — kept in this tab's session storage so navigation does not lose it.
  const [handoff, setHandoffState] = useState<SpecKitHandoff | null>(null);
  const setHandoff = (next: SpecKitHandoff | null): void => {
    setHandoffState(next);
    saveHandoff(projectId, next);
  };
  useEffect(() => {
    if (projectId) setHandoffState(loadHandoff(projectId));
  }, [projectId]);

  const featureArtifactsQuery = useQuery({
    queryKey: queryKeys.projects.specKitFeatureArtifacts(projectId, selectedFeature ?? ""),
    queryFn: () => specKitApi.listFeatureArtifacts(projectId, selectedFeature ?? ""),
    enabled: Boolean(projectId) && selectedFeature !== null,
  });
  const featureArtifacts = useMemo(
    () =>
      [...(featureArtifactsQuery.data?.artifacts ?? [])].sort((a, b) => a.key.localeCompare(b.key)),
    [featureArtifactsQuery.data],
  );

  const selectedArtifact = useMemo(
    () => filesQuery.data?.artifacts.find((a) => a.name === selectedName) ?? null,
    [filesQuery.data, selectedName],
  );
  const selectedFeatureArtifact =
    selectedFeature === null ? null : (featureArtifacts.find((a) => a.key === selectedKey) ?? null);
  const viewerTitle =
    selectedFeature === null ? selectedName : `specs/${selectedFeature}/${selectedKey}`;
  const viewedContent =
    selectedFeature === null ? selectedArtifact?.content : selectedFeatureArtifact?.content;

  const selectFeature = (slug: string | null): void => {
    setSelectedFeature(slug);
    router.replace(
      `/projects/${projectId}/spec-kit${slug ? `?feature=${encodeURIComponent(slug)}` : ""}`,
      { scroll: false },
    );
    setSelectedKey("spec.md");
    setEditingDraft(null);
    setHandoff(null);
    setPreviewedExport(null);
  };
  const refreshArtifacts = (): void => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.projects.specKitFiles(projectId) });
    void queryClient.invalidateQueries({
      queryKey: queryKeys.projects.specKitFeaturesAll(projectId),
    });
  };

  const setEnabledMutation = useMutation({
    mutationFn: (enabled: boolean) => specKitApi.setEnabled(projectId, enabled),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.projects.specKitEnabled(projectId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.projects.specKitFiles(projectId),
      });
    },
  });

  const writeMutation = useMutation({
    mutationFn: (input: { name: SpecKitArtifactName; content: string }) =>
      specKitApi.putFile(projectId, input.name, input.content),
    onSuccess: () => {
      setEditingDraft(null);
      setLastErrorMessage(null);
      queryClient.invalidateQueries({
        queryKey: queryKeys.projects.specKitFiles(projectId),
      });
    },
    // #945 — a refused save (e.g. too long) says why, in words, and keeps the draft.
    onError: (err) => {
      setLastErrorMessage(describeSpecKitError(err));
      toast.error(FAILED);
    },
  });

  const constitutionMutation = useMutation({
    mutationFn: () => specKitApi.generateConstitution(projectId),
    onSuccess: (result) => {
      // Surface the outcome in the shared result card — otherwise it keeps
      // showing the previous command's output. #788: the server's `message`
      // says whether the constitution was derived from project knowledge or is
      // only a skeleton (and why); older servers send none, so fall back to our
      // own confirmation. Also focus the viewer on the new artifact.
      setLastErrorMessage(null);
      const confirmation =
        result.message ??
        (result.artifact
          ? `Generated constitution.md (v${result.artifact.version}).`
          : "Generated constitution.md.");
      setLastResultMessage(confirmation);
      if (result.grounded === false) toast.warning(confirmation);
      else toast.success(confirmation);
      setSelectedName("constitution.md");
      selectFeature(null);
      queryClient.invalidateQueries({
        queryKey: queryKeys.projects.specKitFiles(projectId),
      });
    },
    onError: () => {
      // Issue #423 — user-safe terminal failure toast (no raw error leak).
      toast.error("The Spec Kit operation failed. Please try again.");
    },
  });

  const commandMutation = useMutation({
    mutationFn: (input: { command: SpecKitNamespacedCommand; options: SpecKitRunOptions }) =>
      specKitApi.runCommand(projectId, input.command, input.options),
    // #936 — a command is a write (an artifact, a model call, issues on GitHub):
    // never resend it on a 5xx, which sent one click's request twice.
    retry: false,
    // Issue #423 — Spec Kit commands stream `job:lifecycle` (kind `spec-kit`).
    // The command is awaited server-side and the response carries the verbatim
    // grounded-completion line ("Generated spec.md (v3) … grounded on N retrieved
    // chunks."), so we fire the terminal toast from the callbacks (a late
    // `subscribe:job` would miss the already-emitted terminal event) and keep
    // surfacing the line in the result card. The grounded line is preserved
    // byte-for-byte as the success toast text.
    onSuccess: (result, input) => {
      setLastErrorMessage(null);
      setLastResultMessage(result.message);
      if (result.message) toast.success(result.message);
      setCommandBuffer("");
      const featureSlug = input.options.featureSlug ?? null;
      if (result.feature) {
        // `/speckit.specify` created (or re-specified) a feature: open it.
        selectFeature(result.feature.slug);
      } else if (result.artifactName) {
        // In a feature, tasks/clarify/analyze name the feature artifact they wrote.
        if (featureSlug !== null) setSelectedKey(result.artifactName);
        else setSelectedName(result.artifactName);
      } else if (result.artifacts && result.artifacts.length > 0) {
        setSelectedKey(result.artifacts[result.artifacts.length - 1]!.key);
      }
      // `/speckit.implement` returns its handoff as `artifact: { context, orchestratorRoute }`.
      if (result.artifact && "orchestratorRoute" in result.artifact) {
        setHandoff({ context: result.artifact.context, feature: featureSlug });
      }
      if (input.command === "speckit.taskstoissues") {
        setPreviewedExport(
          input.options.dryRun && input.options.featureSlug
            ? {
                feature: input.options.featureSlug,
                tasksVersion: featureArtifacts.find((a) => a.key === "tasks.md")?.version ?? null,
                repo: result.repo ? `${result.repo.owner}/${result.repo.name}` : null,
                titles: (result.created ?? [])
                  .filter((c) => (c.state ? c.state === "new" : !c.upserted))
                  .map((c) => c.title ?? c.taskId),
                claims: (result.created ?? []).flatMap((c) =>
                  c.state === "in_progress" || c.state === "reconcile"
                    ? [{ title: c.title ?? c.taskId, state: c.state }]
                    : [],
                ),
                publishAvailable: result.publishAvailable === true,
                plan:
                  typeof result.tasksVersion === "number" && typeof result.planDigest === "string"
                    ? { tasksVersion: result.tasksVersion, digest: result.planDigest }
                    : null,
                secretRef: input.options.secretRef ?? "",
                credentialCheck: result.credentialCheck ?? "missing",
              }
            : null,
        );
      }
      refreshArtifacts();
    },
    onError: (err) => {
      setLastResultMessage(null);
      // #945 — the page's own words, never API field names or a raw issue array.
      setLastErrorMessage(describeSpecKitError(err));
      toast.error(FAILED);
    },
  });

  // #789 — delete the viewed artifact (project file or feature artifact).
  const deleteMutation = useMutation({
    // The target is captured at click time, so the toast names the file that
    // was deleted even if the selection changes while the request is in flight.
    mutationFn: (target: { feature: string | null; key: string; title: string }) =>
      target.feature === null
        ? specKitApi.deleteFile(projectId, target.key as SpecKitArtifactName)
        : specKitApi.deleteFeatureArtifact(projectId, target.feature, target.key),
    onSuccess: (_void, target) => {
      toast.success(`Deleted ${target.title}.`);
      setEditingDraft(null);
      refreshArtifacts();
    },
    onError: () => {
      toast.error(FAILED);
    },
  });

  // #789 — "Start analysis with these artifacts" after `/speckit.implement`.
  const analysisMutation = useMutation({
    mutationFn: async (h: { context: string[]; feature: string | null }) => {
      const spec =
        h.feature === null
          ? (filesQuery.data?.artifacts.find((a) => a.name === "spec.md")?.content ?? null)
          : ((await specKitApi.listFeatureArtifacts(projectId, h.feature)).artifacts.find(
              (a) => a.key === "spec.md",
            )?.content ?? null);
      const instructions = buildHandoffInstructions(h.context, spec);
      const started = await analysisApi.start(projectId, {
        extraInstructions: instructions.text,
        // #994 — recorded on the run, so the analysis page names what was left out.
        specKitHandoff: {
          artifacts: h.context,
          sent: instructions.sent,
          omitted: instructions.omitted,
        },
      });
      return { id: started.id, omitted: instructions.omitted };
    },
    onSuccess: ({ id, omitted }) => {
      toast.success(
        omitted.length > 0
          ? `Analysis started. ${omitted.length} part(s) of spec.md did not fit and were not sent; the analysis page lists them.`
          : "Analysis started.",
      );
      setHandoff(null);
      router.push(`/projects/${projectId}/analysis?analysisId=${encodeURIComponent(id)}`);
    },
    onError: () => {
      toast.error(FAILED);
    },
  });

  const enabled = enabledQuery.data?.enabled ?? false;
  // #372 — show the BA/PM onboarding panel until the first artifact exists.
  const hasArtifacts = (filesQuery.data?.artifacts.length ?? 0) > 0;
  const suggestions = useMemo(() => suggestPaletteCommands(commandBuffer), [commandBuffer]);
  const busy = commandMutation.isPending;
  // #789 / #936 — the dry run that Publish acts on: same feature, same tasks.md.
  const tasksVersion = featureArtifacts.find((a) => a.key === "tasks.md")?.version ?? null;
  const exportPreview =
    previewedExport?.feature === selectedFeature && previewedExport.tasksVersion === tasksVersion
      ? previewedExport
      : null;
  const publishUnavailable = exportPreview !== null && !exportPreview.publishAvailable;
  // #953 — Publish uses the secret the dry run checked, and only if it resolved.
  const credentialReady =
    exportPreview !== null &&
    exportPreview.plan !== null &&
    exportPreview.credentialCheck === "resolved" &&
    exportPreview.secretRef === exportSecretRef.trim();
  const exportSecretHint = vaultRefHint(exportSecretRef);
  // #962 — a task another export holds blocks Publish; an abandoned one is
  // reconciled by it (looked up on GitHub, adopted or created).
  const exportInProgress = exportPreview?.claims.some((c) => c.state === "in_progress") ?? false;
  const reconcileCount = exportPreview?.claims.filter((c) => c.state === "reconcile").length ?? 0;
  const publishCount = (exportPreview?.titles.length ?? 0) + reconcileCount;

  // #945 — the reason Publish is disabled, shown on hover through a wrapper.
  const publishHint =
    writeHint ??
    (publishUnavailable
      ? PUBLISH_UNAVAILABLE
      : exportInProgress
        ? EXPORT_IN_PROGRESS
        : exportPreview && !credentialReady
          ? CREDENTIAL_NEEDED
          : undefined);
  const clearHint = writeHint ?? (!credentialReady ? CREDENTIAL_NEEDED : undefined);

  const run = (command: SpecKitNamespacedCommand, options: SpecKitRunOptions = {}): void => {
    commandMutation.mutate({ command, options });
  };

  const submitBuffer = (): void => {
    const parsed = parsePaletteCommand(commandBuffer);
    if (!parsed) {
      setLastErrorMessage(
        "Start with a Spec Kit command, e.g. /speckit.specify, /speckit.plan or /speckit.tasks.",
      );
      return;
    }
    if (FEATURE_REQUIRED_COMMANDS.has(parsed.command) && selectedFeature === null) {
      setLastErrorMessage(`Select a feature first: /${parsed.command} works on one feature.`);
      return;
    }
    // The constitution is the project's; every other command runs in the
    // selected feature when there is one.
    const scoped = selectedFeature !== null && parsed.command !== "speckit.constitution";
    run(parsed.command, {
      input: parsed.input,
      ...(scoped ? { featureSlug: selectedFeature } : {}),
    });
  };

  if (!projectId) {
    return <div className="p-6">Invalid project id.</div>;
  }

  // #945 — a non-member gets 404 from every Spec Kit call. Saying "Spec Kit
  // Mode is disabled" there sent them looking for a toggle they cannot use.
  if (isNoProjectAccess(enabledQuery.error)) {
    return (
      <div className="space-y-4 p-6" data-testid="spec-kit-root">
        <PageHeader title="Spec Kit" />
        <Card className="p-4 text-sm text-muted-foreground" data-testid="spec-kit-no-access">
          This project does not exist, or you are not a member of its workspace. Ask a workspace
          admin to add you, then open Spec Kit again.
        </Card>
      </div>
    );
  }

  return (
    <div
      className="grid gap-6 p-6 xl:grid-cols-[240px_minmax(0,1fr)_300px]"
      data-testid="spec-kit-root"
    >
      <aside className="space-y-4" aria-label="Spec Kit navigation">
        <PageHeader title="Spec Kit">
          {/* #372 (Epic #370, Phase 1): frame Spec Kit as the BA/PM
              "author the intent" front-door — where a business analyst or
              product manager authors intent (spec → plan → tasks) that then
              feeds METIS's RAG analysis → requirements → code-issue →
              reviewed-PR pipeline. Copy/framing only; no behavior change. */}
          <p className="text-xs text-muted-foreground" data-testid="spec-kit-subtitle">
            The BA/PM front-door to author the intent — capture spec → plan → tasks here, then hand
            off to the{" "}
            <Link
              className="underline"
              href={`/projects/${projectId}/analysis`}
              data-testid="spec-kit-subtitle-analysis-link"
            >
              Analysis
            </Link>{" "}
            pipeline.
          </p>
          <Link
            className="text-xs text-muted-foreground underline"
            href={`/projects/${projectId}`}
            data-testid="spec-kit-back"
          >
            ← Back to project
          </Link>
        </PageHeader>

        <Card className="space-y-2 p-3" data-testid="spec-kit-toggle-card">
          <div className="flex items-center justify-between">
            <Label htmlFor="spec-kit-enabled-toggle" className="text-sm font-medium">
              Spec Kit Mode
            </Label>
            <button
              id="spec-kit-enabled-toggle"
              type="button"
              role="switch"
              aria-checked={enabled}
              data-testid="spec-kit-toggle"
              onClick={() => setEnabledMutation.mutate(!enabled)}
              disabled={!canWrite || setEnabledMutation.isPending}
              title={writeHint}
              className={`inline-flex h-6 w-11 items-center rounded-full transition ${
                enabled ? "bg-primary" : "bg-muted"
              }`}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-background transition ${
                  enabled ? "translate-x-6" : "translate-x-1"
                }`}
              />
            </button>
          </div>
          <p className="text-xs text-muted-foreground">
            Author intent as spec → plan → tasks with `/speckit.specify`, `/speckit.plan`,
            `/speckit.tasks`, `/speckit.clarify`, `/speckit.analyze`, and `/speckit.implement`.
            `/speckit.implement` is a manual handoff to the analysis → code-issue pipeline — it does
            not auto-run it.
          </p>
        </Card>

        <FeaturePanel
          projectId={projectId}
          enabled={enabled}
          canWrite={canWrite}
          selectedSlug={selectedFeature}
          onSelect={selectFeature}
        />

        {selectedFeature !== null ? (
          <Card className="space-y-1 p-3" data-testid="spec-kit-feature-tree">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              specs/{selectedFeature}/
            </h2>
            {featureArtifacts.length === 0 ? (
              <p className="text-xs text-muted-foreground">No artifacts yet.</p>
            ) : (
              <ul className="space-y-1">
                {featureArtifacts.map((a) => (
                  <li key={a.key}>
                    <button
                      type="button"
                      data-testid={`spec-kit-feature-artifact-${a.key}`}
                      onClick={() => setSelectedKey(a.key)}
                      className={`flex w-full items-center justify-between rounded px-2 py-1 text-sm hover:bg-muted ${
                        selectedKey === a.key ? "bg-muted" : ""
                      }`}
                    >
                      <span className="truncate">{a.key}</span>
                      <span className="text-xs text-muted-foreground">v{a.version}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        ) : (
          <Card className="space-y-1 p-3" data-testid="spec-kit-tree">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              .specify/
            </h2>
            <ul className="space-y-1">
              {SPEC_KIT_ARTIFACT_NAMES.map((name) => {
                const artifact = filesQuery.data?.artifacts.find((a) => a.name === name);
                const present = Boolean(artifact);
                return (
                  <li key={name}>
                    <button
                      type="button"
                      data-testid={`spec-kit-artifact-${name}`}
                      onClick={() => {
                        setSelectedName(name);
                        setEditingDraft(null);
                      }}
                      className={`flex w-full items-center justify-between rounded px-2 py-1 text-sm hover:bg-muted ${
                        selectedName === name ? "bg-muted" : ""
                      }`}
                    >
                      <span className="flex items-center gap-2">
                        <span className={present ? "text-foreground" : "text-muted-foreground/60"}>
                          {name}
                        </span>
                      </span>
                      {present ? (
                        <span className="text-xs text-muted-foreground">v{artifact?.version}</span>
                      ) : (
                        <span className="text-xs text-muted-foreground/60">—</span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          </Card>
        )}

        <HoverHint hint={writeHint} className="flex w-full">
          <Button
            type="button"
            variant="outline"
            className="w-full"
            onClick={() => constitutionMutation.mutate()}
            disabled={!canWrite || !enabled || constitutionMutation.isPending}
            title={writeHint}
            data-testid="spec-kit-generate-constitution"
          >
            {constitutionMutation.isPending ? "Generating…" : "Generate constitution.md"}
          </Button>
        </HoverHint>
      </aside>

      <section
        className="min-w-0 space-y-3"
        data-testid="spec-kit-viewer"
        aria-label="Artifact viewer"
      >
        <header className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-3">
            <h2 className="text-base font-semibold" data-testid="spec-kit-viewer-title">
              {viewerTitle}
            </h2>
            {/* Epic #34 (AC3) — live presence for the selected artifact. */}
            {selectedFeature === null ? (
              <PresenceAvatars
                artifactType="spec-kit-artifact"
                artifactId={`${projectId}:${selectedName}`}
              />
            ) : null}
          </div>
          <div className="flex gap-2">
            {/* Epic #34 (AC1) — open the comment thread panel for this artifact.
                Comments are on the project's `.specify/` artifacts only. */}
            {selectedFeature === null ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setCommentsOpen(true)}
                data-testid="spec-kit-comments-button"
              >
                <MessageSquare className="mr-1 h-3.5 w-3.5" aria-hidden />
                Comments
              </Button>
            ) : null}
            {/* #789 — delete the viewed artifact, after a confirmation. */}
            {enabled && viewedContent !== undefined && editingDraft === null ? (
              <HoverHint hint={writeHint}>
                <ConfirmDialog
                  title={`Delete ${viewerTitle}?`}
                  description="This cannot be undone."
                  confirmLabel="Delete"
                  onConfirm={() =>
                    deleteMutation.mutate({
                      feature: selectedFeature,
                      key: selectedFeature === null ? selectedName : selectedKey,
                      title: viewerTitle,
                    })
                  }
                  trigger={
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={!canWrite || deleteMutation.isPending}
                      title={writeHint}
                      data-testid="spec-kit-delete-button"
                    >
                      Delete
                    </Button>
                  }
                />
              </HoverHint>
            ) : null}
            {selectedFeature === null && selectedArtifact && editingDraft === null ? (
              <HoverHint hint={writeHint}>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setEditingDraft(selectedArtifact.content)}
                  disabled={!canWrite}
                  title={writeHint}
                  data-testid="spec-kit-edit-button"
                >
                  Edit
                </Button>
              </HoverHint>
            ) : null}
            {editingDraft !== null ? (
              <>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setEditingDraft(null)}
                  data-testid="spec-kit-cancel-button"
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  size="sm"
                  onClick={() =>
                    writeMutation.mutate({ name: selectedName, content: editingDraft ?? "" })
                  }
                  disabled={writeMutation.isPending}
                  data-testid="spec-kit-save-button"
                >
                  {writeMutation.isPending ? "Saving…" : "Save"}
                </Button>
              </>
            ) : null}
          </div>
        </header>

        {/* #372 — BA/PM onboarding: shown while Spec Kit is enabled but no
            artifacts exist yet. Explains the spec → plan → tasks authoring flow
            and points to the adjacent Analysis surface as the downstream
            consumer. Copy only — it does not change command dispatch, artifact
            names, or generation behavior, and deliberately avoids implying that
            `/implement` auto-runs the pipeline (it is a manual handoff). */}
        {enabled && !hasArtifacts ? (
          <Card
            className="space-y-3 p-4 text-sm text-muted-foreground"
            data-testid="spec-kit-onboarding"
          >
            <p className="font-medium text-foreground">Author the intent for this project.</p>
            <p>
              Spec Kit is the BA/PM front-door for capturing intent as spec → plan → tasks. Start
              with <span className="font-mono">/speckit.specify</span> to describe the outcome (what
              and why, not how), then <span className="font-mono">/speckit.plan</span> to shape the
              approach, then <span className="font-mono">/speckit.tasks</span> to break it into an
              atomic backlog.
            </p>
            <p>
              When you are ready, hand the authored intent off to the{" "}
              <Link
                className="font-medium underline"
                href={`/projects/${projectId}/analysis`}
                data-testid="spec-kit-analysis-link"
              >
                Analysis
              </Link>{" "}
              surface — the downstream consumer that grounds it in your project and drives the
              requirements → code-issue → reviewed-PR pipeline. This handoff is manual; nothing here
              kicks off that pipeline on its own.
            </p>
          </Card>
        ) : null}

        {!enabled ? (
          <Card
            className="p-4 text-sm text-muted-foreground"
            data-testid="spec-kit-disabled-banner"
          >
            Spec Kit Mode is disabled for this project. Toggle it on to start authoring intent as
            spec → plan → tasks.
          </Card>
        ) : editingDraft !== null ? (
          <textarea
            className="h-[60vh] w-full rounded border bg-background p-3 font-mono text-sm"
            value={editingDraft}
            onChange={(e) => setEditingDraft(e.target.value)}
            data-testid="spec-kit-editor"
          />
        ) : viewedContent !== undefined ? (
          <ArtifactContent
            name={selectedFeature === null ? selectedName : selectedKey}
            content={viewedContent}
          />
        ) : (
          <Card className="p-4 text-sm text-muted-foreground" data-testid="spec-kit-empty-banner">
            {viewerTitle} hasn&apos;t been generated yet — run the matching slash command.
          </Card>
        )}
      </section>

      <aside className="space-y-3" aria-label="Slash commands">
        <Card className="space-y-2 p-3">
          <h2 className="text-sm font-semibold">Slash commands</h2>
          {/* #372 — palette help reframed for BA/PM intent authoring. */}
          <p className="text-xs text-muted-foreground" data-testid="spec-kit-palette-help">
            Author the intent as spec → plan → tasks: run{" "}
            <span className="font-mono">/speckit.specify</span> to state the outcome,{" "}
            <span className="font-mono">/speckit.plan</span> to shape the approach, and{" "}
            <span className="font-mono">/speckit.tasks</span> to draft the backlog. The result feeds
            the Analysis pipeline.
          </p>
          <p className="text-xs text-muted-foreground" data-testid="spec-kit-palette-scope">
            {selectedFeature === null
              ? "Runs on the project's .specify/ files."
              : `Runs on feature ${selectedFeature}.`}
          </p>
          <Input
            value={commandBuffer}
            onChange={(e) => setCommandBuffer(e.target.value)}
            placeholder="/speckit.specify build a billing dashboard"
            disabled={!canWrite || !enabled || commandMutation.isPending}
            title={writeHint}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submitBuffer();
              }
            }}
            data-testid="spec-kit-command-input"
          />
          {suggestions.length > 0 ? (
            <ul className="space-y-1" data-testid="spec-kit-suggestions">
              {suggestions.map((s) => (
                <li key={s.command}>
                  <button
                    type="button"
                    data-testid={`spec-kit-suggestion-${s.command}`}
                    onClick={() => setCommandBuffer(`/${s.command} `)}
                    className="flex w-full justify-between rounded px-2 py-1 text-left text-xs hover:bg-muted"
                  >
                    <span className="font-mono">/{s.command}</span>
                    <span className="text-muted-foreground">{s.hint}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          <HoverHint hint={writeHint} className="flex w-full">
            <Button
              type="button"
              size="sm"
              onClick={submitBuffer}
              disabled={!canWrite || !enabled || commandMutation.isPending}
              title={writeHint}
              data-testid="spec-kit-run-button"
              className="w-full"
            >
              {commandMutation.isPending ? "Running…" : "Run"}
            </Button>
          </HoverHint>
        </Card>

        {/* #789 — the per-feature commands that need no typed input. */}
        {selectedFeature !== null ? (
          <Card className="space-y-2 p-3" data-testid="spec-kit-feature-actions">
            <h2 className="text-sm font-semibold">Feature actions</h2>
            <HoverHint hint={writeHint} className="flex w-full">
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="w-full"
                disabled={!canWrite || !enabled || busy}
                title={writeHint}
                onClick={() => run("speckit.checklist", { featureSlug: selectedFeature })}
                data-testid="spec-kit-run-checklist"
              >
                Generate checklists
              </Button>
            </HoverHint>
            {/* #953 — the export's GitHub token: a vault secret, never a pasted token. */}
            <div className="space-y-1">
              <Label htmlFor="spec-kit-export-secret" className="text-xs">
                GitHub token (vault secret)
              </Label>
              <VaultPicker
                id="spec-kit-export-secret"
                value={exportSecretRef}
                onChange={setExportSecretRef}
                placeholder={VAULT_REF_EXAMPLE}
              />
              {exportSecretHint ? (
                <p className="text-xs text-destructive">{exportSecretHint}</p>
              ) : null}
            </div>
            <HoverHint hint={writeHint} className="flex w-full">
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="w-full"
                disabled={!canWrite || !enabled || busy}
                title={writeHint}
                onClick={() =>
                  run("speckit.taskstoissues", {
                    featureSlug: selectedFeature,
                    dryRun: true,
                    ...(exportSecretRef.trim() ? { secretRef: exportSecretRef.trim() } : {}),
                  })
                }
                data-testid="spec-kit-export-preview"
              >
                Preview issue export (dry run)
              </Button>
            </HoverHint>
            <HoverHint hint={publishHint} className="flex w-full">
              <ConfirmDialog
                title={`Publish the tasks of ${selectedFeature}?`}
                description={
                  exportPreview
                    ? `This creates ${exportPreview.titles.length} ${
                        exportPreview.titles.length === 1 ? "issue" : "issues"
                      } in ${exportPreview.repo ?? "the project's saved issue target"}.${
                        reconcileCount > 0
                          ? ` It first looks there for ${reconcileCount} ${
                              reconcileCount === 1 ? "issue" : "issues"
                            } an abandoned export may have created, and records any it finds instead of creating them again.`
                          : ""
                      }`
                    : "This creates an issue for every task in the project's saved issue target."
                }
                confirmLabel="Publish"
                confirmVariant="default"
                onConfirm={() => {
                  // #953 — the live run sends back the dry run's plan and the same
                  // vault secret; the server refuses it if either has changed.
                  if (!exportPreview?.plan || !exportPreview.secretRef) return;
                  run("speckit.taskstoissues", {
                    featureSlug: selectedFeature,
                    dryRun: false,
                    secretRef: exportPreview.secretRef,
                    expectedPlan: exportPreview.plan,
                  });
                }}
                trigger={
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="w-full"
                    title={publishHint}
                    disabled={
                      !canWrite ||
                      !enabled ||
                      busy ||
                      exportPreview === null ||
                      publishUnavailable ||
                      !credentialReady ||
                      exportInProgress ||
                      publishCount === 0
                    }
                    data-testid="spec-kit-export-publish"
                  >
                    Publish issues to the saved target
                  </Button>
                }
              />
            </HoverHint>
            {exportPreview && exportPreview.titles.length > 0 ? (
              <div className="space-y-1 text-xs">
                <p className="text-muted-foreground">
                  Would create in {exportPreview.repo ?? "the saved target"}:
                </p>
                <ul className="list-disc pl-4" data-testid="spec-kit-export-titles">
                  {exportPreview.titles.map((t, i) => (
                    <li key={`${i}-${t}`}>{t}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {exportPreview && exportPreview.claims.length > 0 ? (
              <div className="space-y-1 text-xs" data-testid="spec-kit-export-claims">
                <p className="text-muted-foreground">Claimed by an earlier export (not new):</p>
                <ul className="list-disc pl-4">
                  {exportPreview.claims.map((c, i) => (
                    <li key={`${i}-${c.title}`}>
                      {c.title} — {CLAIM_TEXT[c.state]}
                    </li>
                  ))}
                </ul>
                {/* #962 — resolve the claims now: each is looked up on GitHub and
                    recorded if found, cleared if not. A live one is left alone. */}
                <HoverHint hint={clearHint} className="flex w-full">
                  <ConfirmDialog
                    title={`Clear the stuck export of ${selectedFeature}?`}
                    description={`METIS looks in ${
                      exportPreview.repo ?? "the saved target"
                    } for the issues the earlier export may have created, records any it finds, and clears the rest so the next export creates them. Tasks another export is still running are left alone.`}
                    confirmLabel="Clear stuck export"
                    confirmVariant="default"
                    onConfirm={() => {
                      if (!exportPreview.secretRef) return;
                      run("speckit.taskstoissues", {
                        featureSlug: selectedFeature,
                        clearStuckClaims: true,
                        secretRef: exportPreview.secretRef,
                      });
                    }}
                    trigger={
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="w-full"
                        title={clearHint}
                        disabled={!canWrite || !enabled || busy || !credentialReady}
                        data-testid="spec-kit-export-clear"
                      >
                        Clear stuck export
                      </Button>
                    }
                  />
                </HoverHint>
              </div>
            ) : null}
            {exportPreview && !publishUnavailable ? (
              <p className="text-xs text-muted-foreground" data-testid="spec-kit-export-credential">
                {exportPreview.secretRef !== exportSecretRef.trim()
                  ? "The vault secret changed since the dry run — run it again."
                  : CREDENTIAL_TEXT[exportPreview.credentialCheck]}
              </p>
            ) : null}
            {publishUnavailable ? (
              <p
                className="text-xs text-muted-foreground"
                data-testid="spec-kit-export-unavailable"
              >
                {PUBLISH_UNAVAILABLE}
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">
                Publishing is enabled after a dry run of this feature with a GitHub token picked
                from the vault, and creates exactly the issues the dry run listed in the target
                saved for the project.
              </p>
            )}
          </Card>
        ) : null}

        {/* #789 — `/speckit.implement` hands off to an analysis, from here. */}
        {handoff ? (
          <Card className="space-y-2 p-3" data-testid="spec-kit-handoff">
            <p className="text-xs text-muted-foreground">
              Hand off {handoff.context.length} artifact(s): {handoff.context.join(", ")}.
            </p>
            <Button
              type="button"
              size="sm"
              className="w-full"
              disabled={analysisMutation.isPending}
              onClick={() => analysisMutation.mutate(handoff)}
              data-testid="spec-kit-start-analysis"
            >
              {analysisMutation.isPending ? "Starting…" : "Start analysis with these artifacts"}
            </Button>
          </Card>
        ) : null}

        {commandMutation.isPending || constitutionMutation.isPending ? (
          <JobProgress
            indeterminate
            message="Running Spec Kit command…"
            label="Spec Kit command progress"
            testId="spec-kit-progress"
          />
        ) : null}

        {lastResultMessage ? (
          <Card className="p-3 text-xs" data-testid="spec-kit-result">
            {lastResultMessage}
          </Card>
        ) : null}
        {lastErrorMessage ? (
          <Card
            className="border-destructive p-3 text-xs text-destructive"
            data-testid="spec-kit-error"
            role="alert"
          >
            {lastErrorMessage}
          </Card>
        ) : null}
      </aside>

      {/* Epic #34 (AC1) — slide-out comment thread panel for the artifact. */}
      <CommentPanel
        open={commentsOpen}
        onClose={() => setCommentsOpen(false)}
        projectId={projectId}
        artifactName={selectedName}
        currentUserId={user?.id}
        title={`Comments — ${selectedName}`}
      />
    </div>
  );
}
