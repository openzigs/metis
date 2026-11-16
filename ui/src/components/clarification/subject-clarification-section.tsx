"use client";

/**
 * #2270 — the clarifying questions of an Impact Analysis run, or of a portfolio
 * check, started on a document: the same `ClarificationDialogPanel` a
 * requirements analysis answers its questions in, on the result's own page.
 *
 * The run stored the requirements it read that are worded loosely enough to be
 * read two ways (a vague term, an escape clause, a TBD). Nothing is asked until
 * the analyst clicks: asking runs the model (#2509). Once a round is answered
 * and another is due, it is prepared at once, as on the analysis page (#2077).
 * Renders nothing for a result with no such requirement, or one the reader may
 * not see the document of (the server answers with no dialog).
 */
import { useEffect, useRef } from "react";
import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ambiguitiesOf, type ClarificationStatePayload } from "@/lib/analysis-api";
import { subjectClarifyApi, type ClarifySubjectKind } from "@/lib/subject-clarify-api";
import {
  ClarificationDialogPanel,
  type ClarificationPanelApi,
} from "@/components/analysis/ClarificationDialog";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

export function subjectClarifyKey(kind: ClarifySubjectKind, id: string) {
  return ["clarify", kind, id] as const;
}

export function SubjectClarificationSection({
  kind,
  id,
  canRun,
}: {
  kind: ClarifySubjectKind;
  id: string;
  /** The viewer holds `analysis.run`: only they may ask and answer. */
  canRun: boolean;
}): React.ReactElement | null {
  const queryClient = useQueryClient();
  const key = subjectClarifyKey(kind, id);
  const dialog = useQuery({
    queryKey: key,
    queryFn: () => subjectClarifyApi.get(kind, id),
    retry: false,
    refetchOnWindowFocus: false,
  });

  // #937 — keyed in the shared mutation cache, so a remount joins a start
  // still in flight instead of sending (and paying for) a second one.
  const startKey = [...key, "start"];
  const start = useMutation({
    mutationKey: startKey,
    mutationFn: () => subjectClarifyApi.start(kind, id),
    retry: false,
    onSuccess: (state) => {
      queryClient.setQueryData(key, (prev: typeof dialog.data) =>
        prev ? { ...prev, state } : prev,
      );
    },
  });
  const startInFlight = useIsMutating({ mutationKey: startKey }) > 0;
  const startMutate = start.mutate;

  const state = dialog.data?.state ?? null;
  // #2077 — an open dialog whose current round is not generated yet: a submit
  // left something open. Prepared once per round per mount.
  const nextRound =
    state &&
    !state.completed &&
    state.currentRound <= state.maxRounds &&
    state.rounds.at(-1)?.round !== state.currentRound
      ? `${id}:${state.currentRound}`
      : null;
  const roundStartedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!canRun || !nextRound || startInFlight) return;
    if (roundStartedFor.current === nextRound) return;
    roundStartedFor.current = nextRound;
    startMutate();
  }, [canRun, nextRound, startInFlight, startMutate]);

  const requirements = dialog.data?.requirements?.requirements;
  if (!requirements) return null;

  const api: ClarificationPanelApi = {
    submit: (answers) => subjectClarifyApi.submit(kind, id, answers),
  };
  const setState = (next?: ClarificationStatePayload) => {
    if (next) {
      queryClient.setQueryData(key, (prev: typeof dialog.data) =>
        prev ? { ...prev, state: next } : prev,
      );
    } else {
      void dialog.refetch();
    }
  };

  if (state) {
    return (
      <section aria-label="Clarifying questions" data-testid={`${kind}-clarification`}>
        <ClarificationDialogPanel
          api={api}
          state={state}
          requirements={requirements}
          nextRound={
            nextRound
              ? {
                  preparing: startInFlight || start.isPending,
                  failed: canRun && start.isError,
                  unreadable: false,
                  canStart: canRun,
                  onRetry: () => startMutate(),
                }
              : undefined
          }
          onComplete={(next) => {
            setState(next);
            // The refined requirement text is the dialog's own: read it again.
            void queryClient.invalidateQueries({ queryKey: key });
          }}
        />
      </section>
    );
  }

  const flagged = requirements.reduce((n, r) => n + ambiguitiesOf(r).length, 0);
  return (
    <Card className="space-y-3 p-4" data-testid={`${kind}-clarification`}>
      <h2 className="text-base font-semibold">Clarifying questions</h2>
      <p className="text-sm text-muted-foreground">
        METIS found {flagged} {flagged === 1 ? "place" : "places"} in {requirements.length}{" "}
        {requirements.length === 1 ? "requirement" : "requirements"} of the document whose wording
        could be read more than one way, such as a vague term or a TBD. It asks only where the
        readings would build different things, and keeps your answers for this project.
      </p>
      <ul className="list-disc space-y-1 pl-5 text-sm" data-testid="subject-clarify-flagged">
        {requirements.map((r) => (
          <li key={r.id}>{r.title}</li>
        ))}
      </ul>
      {start.isError ? (
        <p role="alert" className="text-sm text-destructive">
          Could not prepare the clarifying questions.
        </p>
      ) : null}
      {canRun ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            onClick={() => startMutate()}
            disabled={start.isPending || startInFlight}
            data-testid="subject-clarify-ask"
          >
            {start.isPending || startInFlight ? "Preparing questions…" : "Ask these questions"}
          </Button>
          <span className="text-xs text-muted-foreground">
            Runs the model; its cost is added to the document's project.
          </span>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          Asking these questions needs the analysis.run permission.
        </p>
      )}
    </Card>
  );
}
