"use client";

/**
 * #273 — the first-run New-project wizard: name → source → ingest in one dialog.
 *
 * Before this, a first project took the Projects list, the Create form, the
 * Overview's "Connect a source" link, the Connections page's repository form and
 * a separate Deep Ingest click. Here the last step creates the project with its
 * primary repository (`POST /projects` links it), starts the Deep Ingest
 * (`POST …/deep-ingest`, 202 + job id) and lands on the project's Overview.
 *
 * The started job is folded into the shared active-jobs store, so the Overview
 * reads "Ingesting…" at once: the `started` event went out before this browser
 * had joined the new project's room, and the socket alone would miss it.
 *
 * Once the project exists, a failure to link the repository or to start the
 * ingest is reported but still lands on the project — it was created, and
 * Connections is where either is retried.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { projectsApi, type CreatedProject } from "@/lib/projects-api";
import { repoConnectorsApi } from "@/lib/connectors-api";
import { applyJobLifecycleEvent } from "@/hooks/use-active-jobs";
import { queryKeys } from "@/lib/query-keys";
import { mapFieldErrors, type FieldErrorMap } from "@/lib/form-validation";
import { isHttpUrl, slugSuggestionMessage, urlSuggestionMessage } from "@/lib/error-suggestion";
import { resolveErrorMessage } from "@/lib/use-app-mutation";
import { deriveSlug, SLUG_PATTERN } from "@/components/projects/project-create-form";
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

type StepId = "name" | "source" | "ingest";
const STEPS: ReadonlyArray<{ id: StepId; label: string }> = [
  { id: "name", label: "Name" },
  { id: "source", label: "Source" },
  { id: "ingest", label: "Ingest" },
];

type IngestOutcome =
  | { kind: "skipped" }
  | { kind: "not-connected" }
  | { kind: "started"; jobId: string }
  | { kind: "failed"; message: string };

export interface NewProjectWizardProps {
  /** Active workspace the project is created in (optional). */
  workspaceId?: string | null;
  /** Called once the project exists, before navigating — e.g. close the dialog. */
  onDone?: () => void;
}

export function NewProjectWizard({ workspaceId, onDone }: NewProjectWizardProps) {
  const qc = useQueryClient();
  const router = useRouter();
  const [step, setStep] = useState<StepId>("name");

  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [description, setDescription] = useState("");

  const [useRepo, setUseRepo] = useState(true);
  const [owner, setOwner] = useState("");
  const [repo, setRepo] = useState("");
  const [apiBase, setApiBase] = useState("");
  const [secretRef, setSecretRef] = useState("");

  const [fieldErrors, setFieldErrors] = useState<FieldErrorMap>({});
  const [formError, setFormError] = useState<string | null>(null);

  const slugMalformed = slug.trim() !== "" && !SLUG_PATTERN.test(slug.trim());
  const nameValid = name.trim() !== "" && slug.trim() !== "" && !slugMalformed;
  const apiBaseMalformed = apiBase.trim() !== "" && !isHttpUrl(apiBase);
  const sourceValid = !useRepo || (owner.trim() !== "" && repo.trim() !== "" && !apiBaseMalformed);
  const repoLabel = `${owner.trim()}/${repo.trim()}`;

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
          message: "Deep ingest started",
          ts: Date.now(),
        });
        toast.success("Project created — ingest started");
      } else if (ingest.kind === "skipped") {
        toast.success("Project created");
      } else if (ingest.kind === "not-connected") {
        // #448 — name the reason `POST /projects` gave (#428), as the Create form does.
        warnPrimaryRepoNotLinked(project, (path) => router.push(path));
      } else {
        toast.error(`Project created, but the ingest did not start: ${ingest.message}`);
      }
      onDone?.();
      router.push(`/projects/${project.id}`);
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

  const slugError = fieldErrors.slug ?? (slugMalformed ? slugSuggestionMessage(slug) : undefined);
  const stepIndex = STEPS.findIndex((s) => s.id === step);

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
            <Label htmlFor="wizard-slug">Slug</Label>
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
            <legend className="text-sm font-medium">Where is the code?</legend>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="wizard-source"
                checked={useRepo}
                onChange={() => setUseRepo(true)}
              />
              GitHub repository
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="wizard-source"
                checked={!useRepo}
                onChange={() => setUseRepo(false)}
              />
              Skip — add a source later
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
                <Label htmlFor="wizard-secret">Secret ref (optional)</Label>
                <VaultPicker
                  id="wizard-secret"
                  value={secretRef}
                  onChange={setSecretRef}
                  placeholder="${vault:my-pat}"
                />
                <p className="text-xs text-muted-foreground">Needed for a private repository.</p>
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              The project starts empty. Connect a repository, database or documents from its
              Connections page.
            </p>
          )}

          <div className="flex justify-between">
            <Button type="button" variant="outline" onClick={() => setStep("name")}>
              Back
            </Button>
            <Button type="button" disabled={!sourceValid} onClick={() => setStep("ingest")}>
              Next
            </Button>
          </div>
        </div>
      ) : null}

      {step === "ingest" ? (
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
              <dd>{useRepo ? repoLabel : "None"}</dd>
            </div>
          </dl>
          <p className="text-sm text-muted-foreground">
            {useRepo
              ? `Creating the project clones ${repoLabel} and ingests it in the background; you land on the Overview while it runs.`
              : "The project is created empty and opens on its Overview."}
          </p>

          {formError ? (
            <p role="alert" className="text-sm text-destructive">
              {formError}
            </p>
          ) : null}

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
              disabled={create.isPending}
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
    </div>
  );
}

const WORKSPACE_STORAGE_KEY = "metis.activeWorkspaceId";

function activeWorkspaceId(): string | null {
  try {
    return window.localStorage.getItem(WORKSPACE_STORAGE_KEY);
  } catch {
    return null;
  }
}

/** The wizard behind a "New project" button — the Home empty state's action. */
export function NewProjectDialog() {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" data-testid="new-project-wizard-button">
          New project
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New project</DialogTitle>
          <DialogDescription>
            Name it, point it at its code, and start the ingest — in one go.
          </DialogDescription>
        </DialogHeader>
        {/* Mounted only while open, so the workspace is read when it is used. */}
        {open ? (
          <NewProjectWizard workspaceId={activeWorkspaceId()} onDone={() => setOpen(false)} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
