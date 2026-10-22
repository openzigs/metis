/**
 * Issue #1389 — "Re-synthesis suggested different acceptance criteria" on an
 * approved requirement's card.
 *
 * A Regenerate (or resume) re-synthesised the requirements. The requirement
 * kept the acceptance criteria approved at the checkpoint, so it is still
 * Approved; the new synthesis's criteria wait here. The analyst can compare
 * the two lists and either Accept them (written through version history with
 * the analyst as actor, so Restore returns to the approved criteria) or
 * Dismiss them (no content change; the same suggestion is not raised again).
 */
"use client";

import * as React from "react";
import type { RequirementCriteriaProposal } from "@metis/shared";
import { Button } from "@/components/ui/button";
import { useAppMutation } from "@/lib/use-app-mutation";
import { requirementCriteriaProposalApi } from "@/lib/collaboration-api";
import { useQueryClient, type QueryKey } from "@tanstack/react-query";

export interface CriteriaProposalNoticeProps {
  requirementId: string;
  /** The requirement's title, so each card's buttons say which requirement they answer. */
  title: string;
  /** The version the card shows, sent with "Accept". */
  version: number;
  proposal: RequirementCriteriaProposal | null | undefined;
  /** The approved criteria the requirement kept. */
  current: string[];
  /** Refetched once the analyst has answered. */
  invalidateKeys?: QueryKey[];
}

function CriteriaList({ items, label }: { items: string[]; label: string }): React.ReactElement {
  if (items.length === 0) return <p className="italic text-muted-foreground">(none)</p>;
  return (
    <ul className="list-disc space-y-0.5 pl-4" aria-label={label}>
      {items.map((c, i) => (
        <li key={i} className="whitespace-pre-wrap break-words">
          {c}
        </li>
      ))}
    </ul>
  );
}

export function CriteriaProposalNotice({
  requirementId,
  title,
  version,
  proposal,
  current,
  invalidateKeys = [],
}: CriteriaProposalNoticeProps): React.ReactElement | null {
  const [open, setOpen] = React.useState(false);
  const queryClient = useQueryClient();
  const resolve = useAppMutation({
    mutationFn: (choice: "accept" | "dismiss") =>
      requirementCriteriaProposalApi.resolve(requirementId, {
        choice,
        ...(choice === "accept" ? { version } : {}),
      }),
    successMessage: (_d, choice) =>
      choice === "accept"
        ? "Accepted the suggested acceptance criteria"
        : "Kept the approved acceptance criteria",
    invalidateKeys,
    // A 409 means the requirement changed or the suggestion is gone: reload,
    // so the next answer is about what is really there.
    onError: () => {
      for (const key of invalidateKeys) void queryClient.invalidateQueries({ queryKey: key });
    },
  });

  if (!proposal) return null;

  return (
    <div
      className="mt-2 rounded border border-info/40 bg-info-muted p-2 text-xs"
      data-testid={`criteria-proposal-${requirementId}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded bg-info-muted px-1.5 py-0.5 font-medium text-info">
          Re-synthesis suggested different acceptance criteria
        </span>
        <span className="text-muted-foreground">The approved criteria were kept.</span>
        <Button
          size="sm"
          variant="ghost"
          aria-expanded={open}
          aria-label={`${open ? "Hide" : "Review"} suggested acceptance criteria for ${title}`}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? "Hide" : "Review"}
        </Button>
      </div>
      {open ? (
        <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
          <div>
            <p className="font-medium">Approved (kept)</p>
            <CriteriaList items={current} label="Approved acceptance criteria" />
          </div>
          <div>
            <p className="font-medium">Suggested</p>
            <CriteriaList items={proposal.proposed} label="Suggested acceptance criteria" />
          </div>
        </div>
      ) : null}
      <div className="mt-2 flex gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={resolve.isPending}
          aria-label={`Accept suggested acceptance criteria for ${title}`}
          onClick={() => resolve.mutate("accept")}
        >
          Accept
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={resolve.isPending}
          aria-label={`Dismiss suggested acceptance criteria for ${title}`}
          onClick={() => resolve.mutate("dismiss")}
        >
          Dismiss
        </Button>
      </div>
    </div>
  );
}
