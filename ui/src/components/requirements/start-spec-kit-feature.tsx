"use client";

/**
 * #1617 — "Start Spec Kit feature" on the requirements list.
 *
 * Sends the selected requirements to `POST /spec-kit/features/from-requirements`
 * (#1616), which creates a feature whose `spec.md` lists each one, then opens
 * that feature on the Spec Kit page. Only approved requirements can start one:
 * the action is disabled, with the reason on hover, while the selection holds
 * any other. The server checks again; when it refuses ids (422 not approved,
 * 404 not in this project) the ids it named are listed.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  SPEC_KIT_FROM_REQUIREMENTS_MAX_IDS,
  SPEC_KIT_REQUIREMENTS_NOT_APPROVED_CODE,
  SPEC_KIT_REQUIREMENTS_NOT_FOUND_CODE,
} from "@metis/shared";
import { ApiError } from "@/lib/api-client";
import { specKitApi } from "@/lib/spec-kit-api";
import { describeSpecKitError } from "@/lib/spec-kit-display";
import { Button } from "@/components/ui/button";
import { HoverHint } from "@/components/spec-kit/hover-hint";

/** A requirement the user ticked, as the list shows it. */
export interface SpecKitSeedCandidate {
  id: string;
  title: string;
  reviewStatus?: string | null;
}

/**
 * Why the action cannot run on `selected`, or `undefined` when it can.
 * `writeHint` is the page's own reason the viewer cannot write (no `project.update`).
 */
export function startSpecKitFeatureBlocker(
  selected: readonly SpecKitSeedCandidate[],
  writeHint?: string,
): string | undefined {
  if (writeHint) return writeHint;
  if (selected.length === 0) {
    return "Select one or more approved requirements to start a Spec Kit feature from them.";
  }
  const notApproved = selected.filter((r) => r.reviewStatus !== "approved");
  if (notApproved.length > 0) {
    const names = notApproved.map((r) => `"${r.title}"`).join(", ");
    return `Only approved requirements can start a Spec Kit feature. Not approved: ${names}.`;
  }
  if (selected.length > SPEC_KIT_FROM_REQUIREMENTS_MAX_IDS) {
    return `Select at most ${SPEC_KIT_FROM_REQUIREMENTS_MAX_IDS} requirements.`;
  }
  return undefined;
}

/** The requirement ids a refusal names, or null when it names none. */
export function refusedRequirementIds(err: unknown): string[] | null {
  if (!(err instanceof ApiError)) return null;
  if (
    err.code !== SPEC_KIT_REQUIREMENTS_NOT_APPROVED_CODE &&
    err.code !== SPEC_KIT_REQUIREMENTS_NOT_FOUND_CODE
  ) {
    return null;
  }
  const ids = (err.details as { requirementIds?: unknown } | undefined)?.requirementIds;
  return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === "string") : null;
}

function describeFailure(err: unknown): string {
  if (err instanceof ApiError && err.code === "SPEC_KIT_DISABLED") {
    return "Spec Kit is off for this project. Turn it on from the Spec Kit page, then try again.";
  }
  if (err instanceof ApiError && err.code === SPEC_KIT_REQUIREMENTS_NOT_APPROVED_CODE) {
    return "Only approved requirements can start a Spec Kit feature. The server refused:";
  }
  if (err instanceof ApiError && err.code === SPEC_KIT_REQUIREMENTS_NOT_FOUND_CODE) {
    return "These requirements are not in this project:";
  }
  return describeSpecKitError(err);
}

interface Props {
  projectId: string;
  /** The ticked requirements, in list order. */
  selected: readonly SpecKitSeedCandidate[];
  /** Set when the viewer cannot write to the project (the page's own hint). */
  writeHint?: string;
}

export function StartSpecKitFeatureAction({ projectId, selected, writeHint }: Props) {
  const router = useRouter();
  const [failure, setFailure] = useState<{ text: string; ids: string[] | null } | null>(null);
  const start = useMutation({
    mutationFn: () =>
      specKitApi.startFeatureFromRequirements(
        projectId,
        selected.map((r) => r.id),
      ),
    onMutate: () => setFailure(null),
    onSuccess: (data) => {
      toast.success(data.message);
      router.push(
        `/projects/${encodeURIComponent(projectId)}/spec-kit?feature=${encodeURIComponent(data.feature.slug)}`,
      );
    },
    onError: (err) => {
      const text = describeFailure(err);
      setFailure({ text, ids: refusedRequirementIds(err) });
      toast.error(text);
    },
  });
  const blocker = startSpecKitFeatureBlocker(selected, writeHint);
  const titleOf = new Map(selected.map((r) => [r.id, r.title]));

  return (
    <div className="space-y-2" data-testid="start-spec-kit-feature">
      <div className="flex flex-wrap items-center gap-2">
        <HoverHint hint={blocker}>
          <Button
            size="sm"
            variant="outline"
            disabled={blocker !== undefined || start.isPending}
            onClick={() => start.mutate()}
            data-testid="start-spec-kit-feature-button"
          >
            {start.isPending ? "Starting Spec Kit feature…" : "Start Spec Kit feature"}
          </Button>
        </HoverHint>
        <span className="text-xs text-muted-foreground" data-testid="start-spec-kit-feature-count">
          {selected.length === 0
            ? "Tick approved requirements to start a Spec Kit feature from them."
            : `${selected.length} selected`}
        </span>
      </div>
      {failure ? (
        <div role="alert" className="text-sm text-destructive" data-testid="start-spec-kit-error">
          <p>{failure.text}</p>
          {failure.ids && failure.ids.length > 0 ? (
            <ul className="list-disc pl-5" data-testid="start-spec-kit-refused-ids">
              {failure.ids.map((id) => (
                <li key={id}>
                  <code>{id}</code>
                  {titleOf.has(id) ? ` — ${titleOf.get(id)}` : ""}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
