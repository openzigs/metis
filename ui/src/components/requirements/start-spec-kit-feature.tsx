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
 *
 * #1702 — the request is held for the whole model run, so its response can be
 * lost while the feature is made anyway. Each start carries a start token
 * (`X-SpecKit-Start-Token`); after a lost response the same selection is sent
 * again with the SAME token, and the server answers with the feature the first
 * send made instead of making a second. Any answer from the server, or a
 * different selection, starts afresh with a new token. The page moves to the
 * new feature only while this action is still on screen.
 *
 * #1749 — while Spec Kit is off for the project the action is disabled with
 * that reason, and links to the Spec Kit page where it is turned on, instead of
 * explaining only through a 409 after the click. The 409 (Spec Kit turned off
 * after the page loaded) links there too.
 */
import { useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  SPEC_KIT_FROM_REQUIREMENTS_MAX_IDS,
  SPEC_KIT_REQUIREMENTS_NOT_APPROVED_CODE,
  SPEC_KIT_REQUIREMENTS_NOT_FOUND_CODE,
} from "@metis/shared";
import { ApiError } from "@/lib/api-client";
import { specKitApi } from "@/lib/spec-kit-api";
import { describeSpecKitError } from "@/lib/spec-kit-display";
import { isLostResponse, newSpecKitStartToken } from "@/lib/spec-kit-jobs";
import { queryKeys } from "@/lib/query-keys";
import { Button } from "@/components/ui/button";
import { HoverHint } from "@/components/spec-kit/hover-hint";

/** A requirement the user ticked, as the list shows it. */
export interface SpecKitSeedCandidate {
  id: string;
  title: string;
  reviewStatus?: string | null;
}

/** #1749 — why the action is disabled while Spec Kit is off for the project. */
export const SPEC_KIT_OFF_REASON =
  "Spec Kit is off for this project. Turn it on from the Spec Kit page first.";

/**
 * Why the action cannot run on `selected`, or `undefined` when it can.
 * `writeHint` is the page's own reason the viewer cannot write (no `project.update`).
 * `specKitOff` is true only once the project is known to have Spec Kit off.
 */
export function startSpecKitFeatureBlocker(
  selected: readonly SpecKitSeedCandidate[],
  writeHint?: string,
  specKitOff = false,
): string | undefined {
  if (writeHint) return writeHint;
  if (specKitOff) return SPEC_KIT_OFF_REASON;
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

/** #1702 — shown when the response was lost: the feature may exist already. */
const START_SPEC_KIT_RESPONSE_LOST =
  "The response was lost, so the feature may already have been created. Start again with the same selection: it opens that feature rather than creating a second one.";

const isSpecKitDisabled = (err: unknown): boolean =>
  err instanceof ApiError && err.code === "SPEC_KIT_DISABLED";

function describeFailure(err: unknown): string {
  if (isLostResponse(err)) return START_SPEC_KIT_RESPONSE_LOST;
  if (isSpecKitDisabled(err)) {
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
  const qc = useQueryClient();
  const [failure, setFailure] = useState<{
    text: string;
    ids: string[] | null;
    specKitOff: boolean;
  } | null>(null);
  // #1749 — read whether Spec Kit is on; an unread state blocks nothing (the server checks).
  const specKit = useQuery({
    queryKey: queryKeys.projects.specKitEnabled(projectId),
    queryFn: () => specKitApi.getEnabled(projectId),
    retry: false,
  });
  const specKitOff = specKit.data?.enabled === false;
  const specKitHref = `/projects/${encodeURIComponent(projectId)}/spec-kit`;
  /** This start's token and the selection it sends; kept only after a lost response. */
  const pendingStart = useRef<{ ids: string; token: string } | null>(null);
  const start = useMutation({
    mutationFn: ({ ids, token }: { ids: string[]; token: string }) =>
      specKitApi.startFeatureFromRequirements(projectId, ids, token),
    onMutate: () => setFailure(null),
    onSuccess: (data) => {
      pendingStart.current = null;
      toast.success(data.message);
      void qc.invalidateQueries({ queryKey: queryKeys.projects.specKitFeaturesAll(projectId) });
    },
    onError: (err) => {
      // Only a lost response keeps its token: the server never answered, so the
      // feature may exist, and a retry must name the same start.
      if (!isLostResponse(err)) pendingStart.current = null;
      const text = describeFailure(err);
      setFailure({ text, ids: refusedRequirementIds(err), specKitOff: isSpecKitDisabled(err) });
      if (isSpecKitDisabled(err)) {
        void qc.invalidateQueries({ queryKey: queryKeys.projects.specKitEnabled(projectId) });
      }
      toast.error(text);
    },
  });
  const run = (): void => {
    const ids = selected.map((r) => r.id);
    const key = ids.join(",");
    if (pendingStart.current?.ids !== key) {
      pendingStart.current = { ids: key, token: newSpecKitStartToken() };
    }
    // Per call, not in the options: TanStack runs a call's own `onSuccess` only
    // while this component is mounted, so a user who left mid-run stays put.
    start.mutate(
      { ids, token: pendingStart.current.token },
      {
        onSuccess: (data) =>
          router.push(
            `/projects/${encodeURIComponent(projectId)}/spec-kit?feature=${encodeURIComponent(data.feature.slug)}`,
          ),
      },
    );
  };
  const blocker = startSpecKitFeatureBlocker(selected, writeHint, specKitOff);
  const titleOf = new Map(selected.map((r) => [r.id, r.title]));

  return (
    <div className="space-y-2" data-testid="start-spec-kit-feature">
      <div className="flex flex-wrap items-center gap-2">
        <HoverHint hint={blocker}>
          <Button
            size="sm"
            variant="outline"
            disabled={blocker !== undefined || start.isPending}
            onClick={run}
            data-testid="start-spec-kit-feature-button"
          >
            {start.isPending ? "Starting Spec Kit feature…" : "Start Spec Kit feature"}
          </Button>
        </HoverHint>
        {specKitOff && !writeHint ? (
          <span className="text-xs text-muted-foreground" data-testid="start-spec-kit-off">
            Spec Kit is off for this project.{" "}
            <Link href={specKitHref} className="font-medium text-foreground underline">
              Turn it on from the Spec Kit page
            </Link>
          </span>
        ) : (
          <span
            className="text-xs text-muted-foreground"
            data-testid="start-spec-kit-feature-count"
          >
            {selected.length === 0
              ? "Tick approved requirements to start a Spec Kit feature from them."
              : `${selected.length} selected`}
          </span>
        )}
      </div>
      {failure ? (
        <div role="alert" className="text-sm text-destructive" data-testid="start-spec-kit-error">
          <p>{failure.text}</p>
          {failure.specKitOff ? (
            <Link href={specKitHref} className="font-medium underline">
              Open the Spec Kit page
            </Link>
          ) : null}
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
