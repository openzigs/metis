"use client";

/**
 * `/projects/[id]/spec-kit` — Spec Kit Mode workspace (Epic #193).
 *
 * Three columns:
 *   1. Artifact tree (`.specify/` files) + enable toggle.
 *   2. Selected artifact viewer/editor.
 *   3. Slash-command palette + run output.
 *
 * Built on TanStack Query so command runs invalidate the file list and
 * the viewer immediately reflects new content. Uses native `<textarea>`
 * for editing (no Monaco dep — keeps the bundle slim per the existing
 * Tailwind/shadcn-only rule).
 */
import { useMemo, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SPEC_KIT_ARTIFACT_NAMES, SPEC_KIT_COMMANDS, isSpecKitCommand } from "@metis/shared";
import type { SpecKitArtifactName, SpecKitCommand } from "@metis/shared";
import { specKitApi } from "@/lib/spec-kit-api";
import { queryKeys } from "@/lib/query-keys";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiError } from "@/lib/api-client";
import { JobProgress } from "@/components/realtime/job-progress";
import { suggestSlashCommands, parseSpecKitCommand } from "@/components/chat/slash-commands";
import { useAuth } from "@/lib/auth-context";
import { PresenceAvatars } from "@/components/presence/PresenceAvatars";
import { CommentPanel } from "@/components/comments/CommentPanel";
import { MessageSquare } from "lucide-react";

const COMMAND_LABELS: Record<SpecKitCommand, string> = {
  specify: "/specify",
  plan: "/plan",
  tasks: "/tasks",
  clarify: "/clarify",
  analyze: "/analyze",
  implement: "/implement",
};

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
  const [editingDraft, setEditingDraft] = useState<string | null>(null);
  const [commandBuffer, setCommandBuffer] = useState("");
  const [lastResultMessage, setLastResultMessage] = useState<string | null>(null);
  const [lastErrorMessage, setLastErrorMessage] = useState<string | null>(null);

  const selectedArtifact = useMemo(
    () => filesQuery.data?.artifacts.find((a) => a.name === selectedName) ?? null,
    [filesQuery.data, selectedName],
  );

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
    mutationFn: (input: { command: SpecKitCommand; payload: string }) =>
      specKitApi.runCommand(projectId, input.command, input.payload),
    // Issue #423 — Spec Kit commands stream `job:lifecycle` (kind `spec-kit`).
    // The command is awaited server-side and the response carries the verbatim
    // grounded-completion line ("Generated spec.md (v3) … grounded on N retrieved
    // chunks."), so we fire the terminal toast from the callbacks (a late
    // `subscribe:job` would miss the already-emitted terminal event) and keep
    // surfacing the line in the result card. The grounded line is preserved
    // byte-for-byte as the success toast text.
    onSuccess: (result) => {
      setLastErrorMessage(null);
      setLastResultMessage(result.message);
      if (result.message) toast.success(result.message);
      setCommandBuffer("");
      if (result.artifactName) {
        setSelectedName(result.artifactName);
      }
      queryClient.invalidateQueries({
        queryKey: queryKeys.projects.specKitFiles(projectId),
      });
    },
    onError: (err) => {
      setLastResultMessage(null);
      setLastErrorMessage(err instanceof ApiError ? err.message : String(err));
      toast.error("The Spec Kit operation failed. Please try again.");
    },
  });

  const enabled = enabledQuery.data?.enabled ?? false;
  // #372 — show the BA/PM onboarding panel until the first artifact exists.
  const hasArtifacts = (filesQuery.data?.artifacts.length ?? 0) > 0;
  const suggestions = useMemo(() => suggestSlashCommands(commandBuffer), [commandBuffer]);

  const submitBuffer = (): void => {
    const parsed = parseSpecKitCommand(commandBuffer);
    if (!parsed) {
      setLastErrorMessage(
        "Buffer must start with one of " + SPEC_KIT_COMMANDS.map((c) => `/${c}`).join(", "),
      );
      return;
    }
    if (!isSpecKitCommand(parsed.command)) return;
    commandMutation.mutate({ command: parsed.command, payload: parsed.input });
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
        <header className="space-y-1">
          <h1 className="text-lg font-semibold">Spec Kit</h1>
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
        </header>

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
            Author intent as spec → plan → tasks with `/specify`, `/plan`, `/tasks`, `/clarify`,
            `/analyze`, and `/implement`. `/implement` is a manual handoff to the analysis →
            code-issue pipeline — it does not auto-run it.
          </p>
        </Card>

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
            <h2 className="text-base font-semibold">{selectedName}</h2>
            {/* Epic #34 (AC3) — live presence for the selected artifact. */}
            <PresenceAvatars
              artifactType="spec-kit-artifact"
              artifactId={`${projectId}:${selectedName}`}
            />
          </div>
          <div className="flex gap-2">
            {/* Epic #34 (AC1) — open the comment thread panel for this artifact. */}
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
            {selectedArtifact && editingDraft === null ? (
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
              with <span className="font-mono">/specify</span> to describe the outcome (what and
              why, not how), then <span className="font-mono">/plan</span> to shape the approach,
              then <span className="font-mono">/tasks</span> to break it into an atomic backlog.
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
        ) : selectedArtifact ? (
          <pre
            className="h-[60vh] w-full overflow-auto rounded border bg-muted/40 p-3 text-sm"
            data-testid="spec-kit-content"
          >
            {selectedArtifact.content}
          </pre>
        ) : (
          <Card className="p-4 text-sm text-muted-foreground" data-testid="spec-kit-empty-banner">
            {selectedName} hasn&apos;t been generated yet — run the matching slash command.
          </Card>
        )}
      </section>

      <aside className="space-y-3" aria-label="Slash commands">
        <Card className="space-y-2 p-3">
          <h2 className="text-sm font-semibold">Slash commands</h2>
          {/* #372 — palette help reframed for BA/PM intent authoring. */}
          <p className="text-xs text-muted-foreground" data-testid="spec-kit-palette-help">
            Author the intent as spec → plan → tasks: run{" "}
            <span className="font-mono">/specify</span> to state the outcome,{" "}
            <span className="font-mono">/plan</span> to shape the approach, and{" "}
            <span className="font-mono">/tasks</span> to draft the backlog. The result feeds the
            Analysis pipeline.
          </p>
          <Input
            value={commandBuffer}
            onChange={(e) => setCommandBuffer(e.target.value)}
            placeholder="/specify build a billing dashboard"
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
                    <span className="font-mono">{COMMAND_LABELS[s.command]}</span>
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
