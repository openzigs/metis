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
import { ApiError } from "@/lib/api-client";
import { JobProgress } from "@/components/realtime/job-progress";
import {
  FEATURE_REQUIRED_COMMANDS,
  parsePaletteCommand,
  suggestPaletteCommands,
} from "@/lib/spec-kit-palette";
import { buildHandoffInstructions } from "@/lib/spec-kit-handoff";
import { FeaturePanel } from "@/components/spec-kit/feature-panel";
import { useAuth } from "@/lib/auth-context";
import { PresenceAvatars } from "@/components/presence/PresenceAvatars";
import { CommentPanel } from "@/components/comments/CommentPanel";
import { MessageSquare } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";

const FAILED = "The Spec Kit operation failed. Please try again.";

export default function SpecKitPage() {
  const params = useParams<{ id: string }>();
  const projectId = params?.id ?? "";
  const queryClient = useQueryClient();
  // Epic #34 (AC1/AC3) — collaboration on Spec Kit artifacts.
  const { user } = useAuth();
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
  const [selectedFeature, setSelectedFeature] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState("spec.md");
  // #789 — the export may publish only after a dry run of the same feature.
  const [previewedExport, setPreviewedExport] = useState<string | null>(null);
  // #789 — what `/speckit.implement` handed off, for "Start analysis".
  const [handoff, setHandoff] = useState<{ context: string[]; feature: string | null } | null>(
    null,
  );

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
    setSelectedKey("spec.md");
    setEditingDraft(null);
    setHandoff(null);
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
      queryClient.invalidateQueries({
        queryKey: queryKeys.projects.specKitFiles(projectId),
      });
    },
  });

  const constitutionMutation = useMutation({
    mutationFn: () => specKitApi.generateConstitution(projectId),
    onSuccess: (result) => {
      // The constitution endpoint returns no `message`, so surface our own
      // confirmation in the shared result card — otherwise it keeps showing the
      // previous command's output and the user gets no feedback that the
      // constitution was generated. Also focus the viewer on the new artifact.
      setLastErrorMessage(null);
      const confirmation = result.artifact
        ? `Generated constitution.md (v${result.artifact.version}).`
        : "Generated constitution.md.";
      setLastResultMessage(confirmation);
      toast.success(confirmation);
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
        setPreviewedExport(input.options.dryRun ? (input.options.featureSlug ?? null) : null);
      }
      refreshArtifacts();
    },
    onError: (err) => {
      setLastResultMessage(null);
      setLastErrorMessage(err instanceof ApiError ? err.message : String(err));
      toast.error(FAILED);
    },
  });

  // #789 — delete the viewed artifact (project file or feature artifact).
  const deleteMutation = useMutation({
    mutationFn: () =>
      selectedFeature === null
        ? specKitApi.deleteFile(projectId, selectedName)
        : specKitApi.deleteFeatureArtifact(projectId, selectedFeature, selectedKey),
    onSuccess: () => {
      toast.success(`Deleted ${viewerTitle}.`);
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
      });
      return { id: started.id, truncated: instructions.truncated };
    },
    onSuccess: ({ id, truncated }) => {
      toast.success(
        truncated
          ? "Analysis started. spec.md was too long to send whole, so its end was cut."
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
              disabled={setEnabledMutation.isPending}
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

        <Button
          type="button"
          variant="outline"
          className="w-full"
          onClick={() => constitutionMutation.mutate()}
          disabled={!enabled || constitutionMutation.isPending}
          data-testid="spec-kit-generate-constitution"
        >
          {constitutionMutation.isPending ? "Generating…" : "Generate constitution.md"}
        </Button>
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
            {viewedContent !== undefined && editingDraft === null ? (
              <ConfirmDialog
                title={`Delete ${viewerTitle}?`}
                description="This cannot be undone."
                confirmLabel="Delete"
                onConfirm={() => deleteMutation.mutate()}
                trigger={
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={deleteMutation.isPending}
                    data-testid="spec-kit-delete-button"
                  >
                    Delete
                  </Button>
                }
              />
            ) : null}
            {selectedFeature === null && selectedArtifact && editingDraft === null ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setEditingDraft(selectedArtifact.content)}
                data-testid="spec-kit-edit-button"
              >
                Edit
              </Button>
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
          <pre
            className="h-[60vh] w-full overflow-auto rounded border bg-muted/40 p-3 text-sm"
            data-testid="spec-kit-content"
          >
            {viewedContent}
          </pre>
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
            disabled={!enabled || commandMutation.isPending}
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
          <Button
            type="button"
            size="sm"
            onClick={submitBuffer}
            disabled={!enabled || commandMutation.isPending}
            data-testid="spec-kit-run-button"
            className="w-full"
          >
            {commandMutation.isPending ? "Running…" : "Run"}
          </Button>
        </Card>

        {/* #789 — the per-feature commands that need no typed input. */}
        {selectedFeature !== null ? (
          <Card className="space-y-2 p-3" data-testid="spec-kit-feature-actions">
            <h2 className="text-sm font-semibold">Feature actions</h2>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="w-full"
              disabled={!enabled || busy}
              onClick={() => run("speckit.checklist", { featureSlug: selectedFeature })}
              data-testid="spec-kit-run-checklist"
            >
              Generate checklists
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="w-full"
              disabled={!enabled || busy}
              onClick={() =>
                run("speckit.taskstoissues", { featureSlug: selectedFeature, dryRun: true })
              }
              data-testid="spec-kit-export-preview"
            >
              Preview issue export (dry run)
            </Button>
            <ConfirmDialog
              title={`Publish the tasks of ${selectedFeature}?`}
              description="This creates an issue for every task in the project's saved issue target."
              confirmLabel="Publish"
              confirmVariant="default"
              onConfirm={() =>
                run("speckit.taskstoissues", { featureSlug: selectedFeature, dryRun: false })
              }
              trigger={
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="w-full"
                  disabled={!enabled || busy || previewedExport !== selectedFeature}
                  data-testid="spec-kit-export-publish"
                >
                  Publish issues to the saved target
                </Button>
              }
            />
            <p className="text-xs text-muted-foreground">
              Publishing is enabled after a dry run of this feature, and uses the target saved for
              the project.
            </p>
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
