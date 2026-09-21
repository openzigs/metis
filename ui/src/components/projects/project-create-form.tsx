"use client";

/**
 * New-project create form (#426, epic #407).
 *
 * Extracted out of the (coverage-excluded) projects index page so the
 * validation behaviour is unit-tested and counted:
 *
 *  - Submit is DISABLED until the required fields (Name, Slug) are valid — an
 *    empty Name can never silently no-op.
 *  - Inline, per-field error messages render on blur/submit, and any structured
 *    server-side validation error (`error.details.fields`) is mapped back onto
 *    the matching field via `mapFieldErrors`.
 *  - Friendly server errors surface through `useAppMutation`'s typed-ApiError
 *    toast; a non-field error also shows a top-level alert.
 */
import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { projectsApi, type Project } from "@/lib/projects-api";
import { queryKeys } from "@/lib/query-keys";
import { useAppMutation } from "@/lib/use-app-mutation";
import {
  hasRequiredValues,
  mapFieldErrors,
  requiredFieldErrors,
  type FieldErrorMap,
} from "@/lib/form-validation";
import { slugSuggestionMessage } from "@/lib/error-suggestion";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { VaultPicker } from "@/components/connectors/vault-picker";

const REQUIRED_FIELDS = ["name", "slug"] as const;
const FIELD_LABELS: Record<string, string> = { name: "Name", slug: "Slug" };

// Mirrors the Slug field's `pattern` (lowercase alphanumerics + hyphens, leading
// alphanumeric). A non-empty value that fails this has a *detectable* cause, so
// SC 3.3.3 requires we suggest the normalized correction rather than only flag it.
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export interface ProjectCreateFormProps {
  /** Active workspace the project should be created in (optional). */
  workspaceId?: string | null;
  /** Called with the created project after a successful create. */
  onCreated?: (project: Project) => void;
}

export function ProjectCreateForm({ workspaceId, onCreated }: ProjectCreateFormProps) {
  const qc = useQueryClient();

  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [description, setDescription] = useState("");
  const [showRepo, setShowRepo] = useState(false);
  const [repoOwner, setRepoOwner] = useState("");
  const [repoName, setRepoName] = useState("");
  const [repoApiBase, setRepoApiBase] = useState("");
  const [repoSecret, setRepoSecret] = useState("");

  // `touched` gates when inline required-field messages appear (so the form
  // doesn't shout at the user before they've interacted), while the disabled
  // submit always reflects validity.
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [serverFieldErrors, setServerFieldErrors] = useState<FieldErrorMap>({});
  const [formError, setFormError] = useState<string | null>(null);

  const hasPartialRepo = repoOwner.trim() !== "" || repoName.trim() !== "";
  const repoValid = !hasPartialRepo || (repoOwner.trim() !== "" && repoName.trim() !== "");

  const requiredErrors = useMemo(
    () => requiredFieldErrors({ name, slug }, REQUIRED_FIELDS, FIELD_LABELS),
    [name, slug],
  );

  // A non-empty but malformed slug (e.g. pasted "My Project") gets a concrete
  // correction suggestion (SC 3.3.3); an empty slug stays a required-only error.
  const slugFormatError = useMemo(() => {
    const value = slug.trim();
    if (value === "" || SLUG_PATTERN.test(value)) return undefined;
    return slugSuggestionMessage(slug);
  }, [slug]);

  const slugValid = slug.trim() === "" || SLUG_PATTERN.test(slug.trim());
  const canSubmit = hasRequiredValues({ name, slug }, REQUIRED_FIELDS) && slugValid && repoValid;

  const create = useAppMutation<Project, void>({
    mutationFn: () =>
      projectsApi.create({
        name: name.trim(),
        slug: slug.trim(),
        description: description.trim() || undefined,
        workspaceId: workspaceId ?? undefined,
        primaryRepo:
          repoOwner.trim() && repoName.trim()
            ? {
                ownerOrOrg: repoOwner.trim(),
                repoName: repoName.trim(),
                apiBaseUrl: repoApiBase.trim() || undefined,
                secretRef: repoSecret.trim() || undefined,
              }
            : undefined,
      }),
    successMessage: "Project created",
    invalidateKeys: [queryKeys.projects.all],
    onSuccess: (project) => {
      void qc.invalidateQueries({ queryKey: queryKeys.projects.all });
      setName("");
      setSlug("");
      setDescription("");
      setShowRepo(false);
      setRepoOwner("");
      setRepoName("");
      setRepoApiBase("");
      setRepoSecret("");
      setTouched({});
      setServerFieldErrors({});
      setFormError(null);
      onCreated?.(project);
    },
    onError: (err) => {
      const fieldErrors = mapFieldErrors(err);
      setServerFieldErrors(fieldErrors);
      // Only show a top-level alert when the failure is NOT field-specific.
      setFormError(Object.keys(fieldErrors).length === 0 ? "Failed to create project" : null);
    },
  });

  const markTouched = (field: string) => setTouched((t) => ({ ...t, [field]: true }));

  const errorFor = (field: string): string | undefined => {
    if (serverFieldErrors[field]) return serverFieldErrors[field];
    if (!touched[field]) return undefined;
    if (requiredErrors[field]) return requiredErrors[field];
    if (field === "slug") return slugFormatError;
    return undefined;
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    // Reveal all inline messages on a submit attempt.
    setTouched({ name: true, slug: true });
    if (!canSubmit) return;
    create.mutate();
  };

  const nameError = errorFor("name");
  const slugError = errorFor("slug");

  return (
    <form onSubmit={handleSubmit} className="space-y-4" data-testid="project-create-form">
      <div className="space-y-2">
        <Label htmlFor="name">Name</Label>
        <Input
          id="name"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setServerFieldErrors((prev) => {
              if (!prev.name) return prev;
              const { name: _omit, ...rest } = prev;
              return rest;
            });
          }}
          onBlur={() => markTouched("name")}
          aria-invalid={nameError ? true : undefined}
          aria-describedby={nameError ? "name-error" : undefined}
          data-testid="project-name-input"
        />
        {nameError ? (
          <p id="name-error" role="alert" className="text-xs text-destructive">
            {nameError}
          </p>
        ) : null}
      </div>

      <div className="space-y-2">
        <Label htmlFor="slug">Slug</Label>
        <Input
          id="slug"
          value={slug}
          onChange={(e) => setSlug(e.target.value.toLowerCase())}
          onBlur={() => markTouched("slug")}
          pattern="[a-z0-9][a-z0-9\-]*"
          aria-invalid={slugError ? true : undefined}
          aria-describedby={slugError ? "slug-error" : undefined}
          data-testid="project-slug-input"
        />
        {slugError ? (
          <p id="slug-error" role="alert" className="text-xs text-destructive">
            {slugError}
          </p>
        ) : null}
      </div>

      <div className="space-y-2">
        <Label htmlFor="description">Description</Label>
        <Input
          id="description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>

      {/* Collapsible primary repo section */}
      <div className="space-y-2">
        <button
          type="button"
          className="text-sm font-medium text-muted-foreground hover:text-foreground"
          onClick={() => setShowRepo(!showRepo)}
          data-testid="toggle-repo-section"
        >
          {showRepo ? "▾" : "▸"} Source Repository (optional)
        </button>
        {showRepo && (
          <div className="space-y-2 rounded-md border p-3">
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <Label htmlFor="repoOwner">Owner / Org</Label>
                <Input
                  id="repoOwner"
                  value={repoOwner}
                  onChange={(e) => setRepoOwner(e.target.value)}
                  placeholder="acme-corp"
                  data-testid="repo-owner-input"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="repoNameInput">Repository</Label>
                <Input
                  id="repoNameInput"
                  value={repoName}
                  onChange={(e) => setRepoName(e.target.value)}
                  placeholder="my-app"
                  data-testid="repo-name-input"
                />
              </div>
            </div>
            {hasPartialRepo && !repoValid && (
              <p className="text-xs text-destructive" role="alert">
                Both Owner and Repository are required when specifying a repo.
              </p>
            )}
            <div className="space-y-1">
              <Label htmlFor="repoApiBase">API Base URL (optional)</Label>
              <Input
                id="repoApiBase"
                value={repoApiBase}
                onChange={(e) => setRepoApiBase(e.target.value)}
                placeholder="https://api.github.com"
                data-testid="repo-api-base-input"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="repoSecret">Secret Ref (optional)</Label>
              <VaultPicker
                id="repoSecret"
                value={repoSecret}
                onChange={setRepoSecret}
                placeholder="${vault:my-pat}"
              />
            </div>
          </div>
        )}
      </div>

      {formError ? (
        <p className="text-sm text-destructive" role="alert">
          {formError}
        </p>
      ) : null}

      <div className="flex justify-end">
        <Button
          type="submit"
          disabled={create.isPending || !canSubmit}
          data-testid="project-create-submit"
        >
          {create.isPending ? "Creating…" : "Create"}
        </Button>
      </div>
    </form>
  );
}
