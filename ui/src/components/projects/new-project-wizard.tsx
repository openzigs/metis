"use client";

/**
 * #273 — the New-project wizard: name → source → create in one dialog.
 *
 * #2349 — it is the ONE way a project is created: Home, the Projects list and
 * the command palette all open it (the Projects list's separate Create form is
 * gone). Its source step starts on "Documents only", so an analyst with no
 * repository and no database is asked for nothing they do not have, and it ends
 * by offering "New change request" — where those documents are uploaded — or
 * the project's Overview.
 *
 * Before #273, a first project took the Projects list, the Create form, the
 * Overview's "Connect a source" link, the Connections page's repository form and
 * a separate Deep Ingest click. Here the create step makes the project with its
 * primary repository (`POST /projects` links it) and starts the Deep Ingest
 * (`POST …/deep-ingest`, 202 + job id).
 *
 * The started job is folded into the shared active-jobs store, so the Overview
 * reads "Ingesting…" at once: the `started` event went out before this browser
 * had joined the new project's room, and the socket alone would miss it.
 *
 * Once the project exists, a failure to link the repository or to start the
 * ingest is reported but still goes on to the last step — the project was
 * created, and Connections is where either is retried.
 */
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { projectsApi, type CreatedProject } from "@/lib/projects-api";
import { repoConnectorsApi } from "@/lib/connectors-api";
import { applyJobLifecycleEvent } from "@/hooks/use-active-jobs";
import { queryKeys } from "@/lib/query-keys";
import { useValidatedActiveWorkspaceId, type ActiveWorkspaceStatus } from "@/lib/active-workspace";
import { useAuth } from "@/lib/auth-context";
import { WorkspaceStatusNotice } from "@/components/projects/workspace-status-notice";
import { mapFieldErrors, type FieldErrorMap } from "@/lib/form-validation";
import {
  isHttpUrl,
  normalizeSlug,
  slugSuggestionMessage,
  urlSuggestionMessage,
} from "@/lib/error-suggestion";
import { resolveErrorMessage } from "@/lib/use-app-mutation";
import { newChangeRequestHref } from "@/lib/project-pipeline";
import { getProjectTabModel, resolveActiveProjectTab } from "@/components/projects/project-tabs";
import { warnPrimaryRepoNotLinked } from "@/components/projects/primary-repo-warning";
import { VaultPicker } from "@/components/connectors/vault-picker";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

// Mirrors the server's project slug rule (lowercase alphanumerics + hyphens,
// leading alphanumeric). A non-empty value that fails this has a *detectable*
// cause, so SC 3.3.3 requires we suggest the normalized correction.
export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

// #23 — a Name may run to 128 characters but a slug only to 64
// (`projectSchema`, packages/shared/src/project.ts), so the derived slug is cut
// to fit, without leaving a trailing hyphen at the cut.
const SLUG_MAX = 64;
export function deriveSlug(name: string): string {
  return normalizeSlug(name).slice(0, SLUG_MAX).replace(/-+$/, "");
}

type StepId = "name" | "source" | "create" | "next";
const STEPS: ReadonlyArray<{ id: StepId; label: string }> = [
  { id: "name", label: "Name" },
  { id: "source", label: "Source" },
  { id: "create", label: "Create" },
  { id: "next", label: "Change request" },
];

/**
 * #2388 — the tab a source is connected from later, by the tab bar's own name
 * for the section that holds Connections, so this copy cannot name a tab that
 * does not exist. The label does not depend on the project, which does not
 * exist yet.
 */
function connectionsTabName(): string {
  const model = getProjectTabModel("new");
  return (
    resolveActiveProjectTab("/projects/new/connections", model)?.section.label ?? "Connections"
  );
}

type IngestOutcome =
  | { kind: "skipped" }
  | { kind: "not-connected" }
  | { kind: "started"; jobId: string }
  | { kind: "failed"; message: string };

export interface NewProjectWizardProps {
  /** Active workspace the project is created in (optional). */
  workspaceId?: string | null;
  /**
   * #2208 — whether `workspaceId` is known yet (`useValidatedActiveWorkspaceId`).
   * Create is disabled until it is `ready`. Defaults to `ready`.
   */
  workspaceStatus?: ActiveWorkspaceStatus;
  /** Re-read the workspaces after an error; a returned promise settles with the read. */
  onRetryWorkspaces?: () => unknown;
  /** Called once the project exists, as the last step is offered. */
  onCreated?: (project: CreatedProject) => void;
  /** Called on leaving the last step, before navigating — e.g. close the dialog. */
  onDone?: () => void;
}

export function NewProjectWizard({
  workspaceId,
  workspaceStatus = "ready",
  onRetryWorkspaces,
  onCreated,
  onDone,
}: NewProjectWizardProps) {
  const qc = useQueryClient();
  const router = useRouter();
  const [step, setStep] = useState<StepId>("name");

  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [description, setDescription] = useState("");

  // #2349 — documents only unless a repository is chosen: nothing is asked for
  // that an analyst with only documents does not have.
  const [useRepo, setUseRepo] = useState(false);
  const [owner, setOwner] = useState("");
  const [repo, setRepo] = useState("");
  const [apiBase, setApiBase] = useState("");
  const [secretRef, setSecretRef] = useState("");

  const [fieldErrors, setFieldErrors] = useState<FieldErrorMap>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ project: CreatedProject; ingest: IngestOutcome } | null>(
    null,
  );

  const slugMalformed = slug.trim() !== "" && !SLUG_PATTERN.test(slug.trim());
  const nameValid = name.trim() !== "" && slug.trim() !== "" && !slugMalformed;
  const apiBaseMalformed = apiBase.trim() !== "" && !isHttpUrl(apiBase);
  // One of Owner / Repository without the other: say why Next is disabled.
  const repoHalfFilled = useRepo && (owner.trim() === "") !== (repo.trim() === "");
  const sourceValid = !useRepo || (owner.trim() !== "" && repo.trim() !== "" && !apiBaseMalformed);
  const repoLabel = `${owner.trim()}/${repo.trim()}`;

  // #2388 — false once the dialog closes and unmounts this wizard. TanStack
  // Query still runs the hook-level `onSuccess` after that, and its `onCreated`
  // would hand this opening's project to the dialog's NEXT opening.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const create = useMutation({
    mutationFn: async (): Promise<{ project: CreatedProject; ingest: IngestOutcome }> => {
      const project = await projectsApi.create({
        name: name.trim(),
        slug: slug.trim(),
        description: description.trim() || undefined,
        workspaceId: workspaceId ?? undefined,
        primaryRepo: useRepo
          ? {
              ownerOrOrg: owner.trim(),
              repoName: repo.trim(),
              apiBaseUrl: apiBase.trim() || undefined,
              secretRef: secretRef.trim() || undefined,
            }
          : undefined,
      });
      if (!useRepo) return { project, ingest: { kind: "skipped" } };
      const connectorId = project.primaryRepo?.id;
      if (!connectorId) return { project, ingest: { kind: "not-connected" } };
      try {
        const started = await repoConnectorsApi.deepIngest(project.id, connectorId);
        return { project, ingest: { kind: "started", jobId: started.jobId } };
      } catch (err) {
        return { project, ingest: { kind: "failed", message: resolveErrorMessage(err) } };
      }
    },
    onSuccess: ({ project, ingest }) => {
      void qc.invalidateQueries({ queryKey: queryKeys.projects.all });
      if (ingest.kind === "started") {
        applyJobLifecycleEvent({
          kind: "repo-ingest",
          jobId: ingest.jobId,
          projectId: project.id,
          status: "started",
          message: "Full re-read started",
          ts: Date.now(),
        });
        toast.success("Project created — ingest started");
      } else if (ingest.kind === "skipped") {
        toast.success("Project created");
      } else if (ingest.kind === "not-connected") {
        // #448 — name the reason `POST /projects` gave (#428).
        warnPrimaryRepoNotLinked(project, (path) => router.push(path));
      } else {
        toast.error(`Project created, but the ingest did not start: ${ingest.message}`);
      }
      // The project exists and the toast said so; an opening closed mid-create
      // is over, so it takes no step and reports no project.
      if (!mounted.current) return;
      setCreated({ project, ingest });
      setStep("next");
      onCreated?.(project);
    },
    onError: (err) => {
      const mapped = mapFieldErrors(err);
      setFieldErrors(mapped);
      if (mapped.name || mapped.slug) {
        setFormError(null);
        setStep("name");
        return;
      }
      setFormError(resolveErrorMessage(err, "Failed to create project"));
    },
  });

  const clearFieldError = (field: string) =>
    setFieldErrors((prev) => {
      if (!prev[field]) return prev;
      const { [field]: _omit, ...rest } = prev;
      return rest;
    });

  // #23 — a Name that yields no slug leaves Next disabled; say why at once.
  const slugError =
    fieldErrors.slug ??
    (slugMalformed
      ? slugSuggestionMessage(slug)
      : name.trim() !== "" && slug.trim() === ""
        ? "Short name is required"
        : undefined);
  const stepIndex = STEPS.findIndex((s) => s.id === step);

  const leave = (path: string) => {
    onDone?.();
    router.push(path);
  };

  return (
    <div className="space-y-4" data-testid="new-project-wizard">
      <ol aria-label="New project steps" className="flex gap-2 text-xs">
        {STEPS.map((s, i) => (
          <li
            key={s.id}
            aria-current={s.id === step ? "step" : undefined}
            className={cn(
              "flex-1 rounded-md border px-2 py-1",
              s.id === step
                ? "border-primary font-medium text-foreground"
                : i < stepIndex
                  ? "text-foreground"
                  : "text-muted-foreground",
            )}
          >
            {i + 1}. {s.label}
          </li>
        ))}
      </ol>

      {step === "name" ? (
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="wizard-name">Name</Label>
            <Input
              id="wizard-name"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                if (!slugEdited) setSlug(deriveSlug(e.target.value));
                clearFieldError("name");
              }}
              aria-invalid={fieldErrors.name ? true : undefined}
              aria-describedby={fieldErrors.name ? "wizard-name-error" : undefined}
              data-testid="wizard-name-input"
            />
            {fieldErrors.name ? (
              <p id="wizard-name-error" role="alert" className="text-xs text-destructive">
                {fieldErrors.name}
              </p>
            ) : null}
          </div>
          <div className="space-y-2">
            <Label htmlFor="wizard-slug">Short name</Label>
            <Input
              id="wizard-slug"
              value={slug}
              onChange={(e) => {
                const next = e.target.value.toLowerCase();
                setSlug(next);
                setSlugEdited(next !== "");
                clearFieldError("slug");
              }}
              onBlur={() => {
                if (slug === "") setSlug(deriveSlug(name));
              }}
              aria-invalid={slugError ? true : undefined}
              aria-describedby={
                slugError ? "wizard-slug-help wizard-slug-error" : "wizard-slug-help"
              }
              data-testid="wizard-slug-input"
            />
            <p id="wizard-slug-help" className="text-xs text-muted-foreground">
              Used in URLs. Filled in from the name — edit it to choose your own.
            </p>
            {slugError ? (
              <p id="wizard-slug-error" role="alert" className="text-xs text-destructive">
                {slugError}
              </p>
            ) : null}
          </div>
          <div className="space-y-2">
            <Label htmlFor="wizard-description">Description</Label>
            <Input
              id="wizard-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <div className="flex justify-end">
            <Button type="button" disabled={!nameValid} onClick={() => setStep("source")}>
              Next
            </Button>
          </div>
        </div>
      ) : null}

      {step === "source" ? (
        <div className="space-y-4">
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">What does the project start from?</legend>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="wizard-source"
                checked={!useRepo}
                onChange={() => setUseRepo(false)}
              />
              Documents only
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="wizard-source"
                checked={useRepo}
                onChange={() => setUseRepo(true)}
              />
              A GitHub repository
            </label>
          </fieldset>

          {useRepo ? (
            <div className="space-y-2 rounded-md border p-3">
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <Label htmlFor="wizard-owner">Owner / Org</Label>
                  <Input
                    id="wizard-owner"
                    value={owner}
                    onChange={(e) => setOwner(e.target.value)}
                    placeholder="acme-corp"
                    data-testid="wizard-owner-input"
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="wizard-repo">Repository</Label>
                  <Input
                    id="wizard-repo"
                    value={repo}
                    onChange={(e) => setRepo(e.target.value)}
                    placeholder="my-app"
                    data-testid="wizard-repo-input"
                  />
                </div>
              </div>
              {repoHalfFilled ? (
                <p role="alert" className="text-xs text-destructive">
                  Both Owner and Repository are required when specifying a repo.
                </p>
              ) : null}
              <div className="space-y-1">
                <Label htmlFor="wizard-api-base">API base URL (optional)</Label>
                <Input
                  id="wizard-api-base"
                  value={apiBase}
                  onChange={(e) => setApiBase(e.target.value)}
                  placeholder="https://api.github.com"
                  aria-invalid={apiBaseMalformed ? true : undefined}
                  aria-describedby={apiBaseMalformed ? "wizard-api-base-error" : undefined}
                />
                {apiBaseMalformed ? (
                  <p id="wizard-api-base-error" role="alert" className="text-xs text-destructive">
                    {urlSuggestionMessage(apiBase)}
                  </p>
                ) : null}
              </div>
              <div className="space-y-1">
                <Label htmlFor="wizard-secret">Access token (vault secret)</Label>
                <VaultPicker
                  id="wizard-secret"
                  value={secretRef}
                  onChange={setSecretRef}
                  placeholder="Choose a vault secret"
                />
                <p className="text-xs text-muted-foreground">Needed for a private repository.</p>
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              Nothing to connect now: you upload your documents with the project&apos;s first change
              request. A repository or database can be connected later, from {connectionsTabName()}.
            </p>
          )}

          <div className="flex justify-between">
            <Button type="button" variant="outline" onClick={() => setStep("name")}>
              Back
            </Button>
            <Button type="button" disabled={!sourceValid} onClick={() => setStep("create")}>
              Next
            </Button>
          </div>
        </div>
      ) : null}

      {step === "create" ? (
        <div className="space-y-4">
          <dl className="space-y-1 rounded-md border p-3 text-sm" data-testid="wizard-summary">
            <div className="flex gap-2">
              <dt className="text-muted-foreground">Project</dt>
              <dd>
                {name.trim()} (<code>{slug.trim()}</code>)
              </dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-muted-foreground">Source</dt>
              <dd>{useRepo ? repoLabel : "Documents only"}</dd>
            </div>
          </dl>
          <p className="text-sm text-muted-foreground">
            {useRepo
              ? `Creating the project clones ${repoLabel} and ingests it in the background while you carry on.`
              : "The project is created empty; its documents come with its first change request."}
          </p>

          {formError ? (
            <p role="alert" className="text-sm text-destructive">
              {formError}
            </p>
          ) : null}

          <WorkspaceStatusNotice status={workspaceStatus} onRetry={onRetryWorkspaces} />

          <div className="flex justify-between">
            <Button
              type="button"
              variant="outline"
              disabled={create.isPending}
              onClick={() => setStep("source")}
            >
              Back
            </Button>
            <Button
              type="button"
              disabled={create.isPending || workspaceStatus !== "ready"}
              onClick={() => {
                setFormError(null);
                create.mutate();
              }}
              data-testid="wizard-create"
            >
              {create.isPending
                ? "Creating…"
                : useRepo
                  ? "Create and start ingest"
                  : "Create project"}
            </Button>
          </div>
        </div>
      ) : null}

      {step === "next" && created ? (
        <div className="space-y-4" data-testid="wizard-next-step">
          <p role="status" className="text-sm font-medium">
            {created.project.name} is created.
            {created.ingest.kind === "started" ? " Its repository is being ingested." : null}
          </p>
          <p className="text-sm text-muted-foreground">
            Start a change request: upload the documents that describe the change, and METIS
            analyses them. Or open the project&apos;s Overview and start one later.
          </p>
          <div className="flex justify-between">
            <Button
              type="button"
              variant="outline"
              onClick={() => leave(`/projects/${created.project.id}`)}
              data-testid="wizard-skip"
            >
              Skip — open the Overview
            </Button>
            <Button
              type="button"
              onClick={() => leave(newChangeRequestHref(created.project.id))}
              data-testid="wizard-new-change-request"
            >
              New change request
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * #2368 — what a role without `project.create` sees where New project would be:
 * who can create one, instead of a form `POST /api/projects` refuses on submit.
 */
export function ProjectCreateForbiddenNotice() {
  return (
    <p className="text-sm text-muted-foreground" data-testid="new-project-forbidden">
      Ask an admin or coordinator to create projects.
    </p>
  );
}

export interface NewProjectDialogProps {
  /** `data-testid` of the "New project" button. */
  triggerTestId?: string;
  /**
   * Controlled open state, for a caller with its own way in (the command
   * palette). When set, no trigger button is rendered.
   */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

/**
 * #2349 — the wizard behind every "New project": Home's Projects card, the
 * Projects list and the command palette. Closing it on the last step (Escape,
 * the close button) is a skip: it lands on the new project's Overview, never
 * back where the dialog was opened with the project nowhere in sight.
 */
export function NewProjectDialog({
  triggerTestId = "new-project-wizard-button",
  open: controlledOpen,
  onOpenChange,
}: NewProjectDialogProps = {}) {
  const router = useRouter();
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const controlled = controlledOpen !== undefined;
  const open = controlled ? controlledOpen : uncontrolledOpen;
  // The project made in this opening, until the dialog closes.
  const createdId = useRef<string | null>(null);
  // #2197 — the active workspace the top bar shows, validated: a stored id the
  // caller is not a member of is never sent as the new project's workspace.
  const workspace = useValidatedActiveWorkspaceId();

  const setOpen = (next: boolean) => {
    if (!next) createdId.current = null;
    if (controlled) onOpenChange?.(next);
    else setUncontrolledOpen(next);
  };
  const handleOpenChange = (next: boolean) => {
    const id = createdId.current;
    setOpen(next);
    if (!next && id) router.push(`/projects/${id}`);
  };
  const { user } = useAuth();
  if (!(user?.permissions.includes("project.create") ?? false)) {
    return <ProjectCreateForbiddenNotice />;
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      {controlled ? null : (
        <DialogTrigger asChild>
          <Button size="sm" data-testid={triggerTestId}>
            New project
          </Button>
        </DialogTrigger>
      )}
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New project</DialogTitle>
          <DialogDescription>
            Name it, say what it starts from, and go straight to its first change request.
          </DialogDescription>
        </DialogHeader>
        {open ? (
          <NewProjectWizard
            workspaceId={workspace.workspaceId}
            workspaceStatus={workspace.status}
            onRetryWorkspaces={workspace.retry}
            onCreated={(project) => {
              createdId.current = project.id;
            }}
            onDone={() => setOpen(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
