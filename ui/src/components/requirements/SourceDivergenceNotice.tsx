/**
 * Issue #1220 — "Diverged from source" on an imported requirement's card.
 *
 * Re-sync found that both the source issue and the local copy changed since
 * the last sync, so it kept the analyst's text and recorded the source's. This
 * shows the badge, lets the analyst compare the two field by field, and offers
 * the two answers: "Take the source version" (written through version
 * history; a review pinned to the old version goes stale) or "Keep mine" (no
 * content change and no new version, so an approved review stays current).
 * Either is shown in History.
 */
"use client";

import * as React from "react";
import type { RequirementSourceDivergence } from "@metis/shared";
import { Button } from "@/components/ui/button";
import { useAppMutation } from "@/lib/use-app-mutation";
import { requirementSourceApi } from "@/lib/collaboration-api";
import { useQueryClient, type QueryKey } from "@tanstack/react-query";
import { HoverHint } from "@/components/spec-kit/hover-hint";

export interface SourceDivergenceNoticeProps {
  requirementId: string;
  /** The version the card shows, sent with "Take the source version". */
  version: number;
  divergence: RequirementSourceDivergence | null | undefined;
  /** The local copy, to compare with the source's. */
  local: { title: string; body: string; type: string; priority: string; labels: string[] };
  /** Refetched once the analyst has answered. */
  invalidateKeys?: QueryKey[];
  /**
   * #1587 — why the viewer cannot make this write (they lack `project.update`,
   * which the server requires). Set: the write controls are disabled and carry
   * this hint. Omitted: they are enabled.
   */
  writeHint?: string;
}

const FIELDS = ["title", "body", "type", "priority", "labels"] as const;
type Field = (typeof FIELDS)[number];

function show(field: Field, value: string | string[]): string {
  if (field === "labels") {
    const labels = value as string[];
    return labels.length > 0 ? labels.join(", ") : "(none)";
  }
  return (value as string) || "(empty)";
}

function differs(field: Field, a: string | string[], b: string | string[]): boolean {
  if (field === "labels") {
    const sa = [...(a as string[])].sort().join("\u0000");
    const sb = [...(b as string[])].sort().join("\u0000");
    return sa !== sb;
  }
  return a !== b;
}

export function SourceDivergenceNotice({
  requirementId,
  version,
  divergence,
  local,
  invalidateKeys = [],
  writeHint,
}: SourceDivergenceNoticeProps): React.ReactElement | null {
  const [open, setOpen] = React.useState(false);
  const queryClient = useQueryClient();
  const resolve = useAppMutation({
    mutationFn: (choice: "source" | "local") =>
      requirementSourceApi.resolveDivergence(requirementId, {
        choice,
        sourceFingerprint: divergence!.sourceFingerprint,
        ...(choice === "source" ? { version } : {}),
      }),
    successMessage: (d, choice) =>
      choice === "local"
        ? "Kept your version"
        : d.superseded
          ? "Took that source version, but the source has changed again — compare again"
          : "Took the source version",
    invalidateKeys,
    // A 409 means the source moved again or the copy changed: reload either
    // way, so the comparison shown is the one the next answer is about.
    onError: () => {
      for (const key of invalidateKeys) void queryClient.invalidateQueries({ queryKey: key });
    },
  });

  if (!divergence) return null;
  const changed = FIELDS.filter((f) => differs(f, local[f], divergence.source[f]));
  const detected = new Date(divergence.detectedAt);

  return (
    <div
      className="mt-2 rounded border border-warning/40 bg-warning-muted p-2 text-xs"
      data-testid={`source-divergence-${requirementId}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span
          className="rounded bg-warning px-1.5 py-0.5 font-medium text-warning-foreground"
          role="status"
        >
          Diverged from source
        </span>
        <span className="text-muted-foreground" data-testid="source-divergence-explanation">
          {divergence.baselineUnknown ? (
            // Synced before METIS tracked its source: there is no record of the
            // source at the time of the edit, only that it now differs.
            <>
              This requirement was edited in METIS before METIS tracked its source; the source has
              changed. Compare and choose.
            </>
          ) : (
            <>
              The source changed
              {Number.isNaN(detected.getTime()) ? "" : ` (seen ${detected.toLocaleString()})`} and
              so did this copy. Re-sync kept your text.
            </>
          )}
        </span>
        <Button size="sm" variant="ghost" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {open ? "Hide comparison" : "Compare"}
        </Button>
      </div>
      {open ? (
        <table
          className="mt-2 w-full table-fixed border-collapse"
          aria-label="Your version and the source's"
        >
          <thead>
            <tr className="text-left text-muted-foreground">
              <th className="w-20 pr-2 font-medium">Field</th>
              <th className="pr-2 font-medium">Yours</th>
              <th className="font-medium">Source</th>
            </tr>
          </thead>
          <tbody>
            {(changed.length > 0 ? changed : FIELDS).map((f) => (
              <tr key={f} className="align-top">
                <th scope="row" className="pr-2 text-left font-medium">
                  {f}
                </th>
                <td className="whitespace-pre-wrap break-words pr-2">{show(f, local[f])}</td>
                <td className="whitespace-pre-wrap break-words">{show(f, divergence.source[f])}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      <div className="mt-2 flex gap-2">
        <HoverHint hint={writeHint}>
          <Button
            size="sm"
            variant="outline"
            disabled={Boolean(writeHint) || resolve.isPending}
            onClick={() => resolve.mutate("source")}
          >
            Take the source version
          </Button>
        </HoverHint>
        <HoverHint hint={writeHint}>
          <Button
            size="sm"
            variant="outline"
            disabled={Boolean(writeHint) || resolve.isPending}
            onClick={() => resolve.mutate("local")}
          >
            Keep mine
          </Button>
        </HoverHint>
      </div>
    </div>
  );
}
