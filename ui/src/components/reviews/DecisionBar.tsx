"use client";

/**
 * Epic #609 / Issue #618 — approve / reject action bar with an optional note.
 *
 * Pure presentation: the decision mutation (optimistic update + rollback)
 * lives in the detail page so this component stays trivially testable.
 */
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

export interface DecisionBarProps {
  /** True while a decision request is in flight — disables both actions. */
  pending: boolean;
  /** Error message from a failed decision, surfaced inline. */
  error: string | null;
  onDecide: (decision: "approved" | "rejected", note?: string) => void;
}

export function DecisionBar({ pending, error, onDecide }: DecisionBarProps) {
  const noteId = useId();
  const [note, setNote] = useState("");

  function submit(decision: "approved" | "rejected") {
    const trimmed = note.trim();
    onDecide(decision, trimmed === "" ? undefined : trimmed);
  }

  return (
    <section className="space-y-3 rounded-lg border p-4" data-testid="decision-bar">
      <h2 className="text-sm font-semibold">Your decision</h2>
      <div className="space-y-1">
        <Label htmlFor={noteId}>Decision note (optional)</Label>
        <Textarea
          id={noteId}
          value={note}
          maxLength={2000}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Context for your decision — visible to the requester and other reviewers."
        />
      </div>
      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button
          disabled={pending}
          onClick={() => submit("approved")}
          data-testid="decision-approve"
        >
          Approve
        </Button>
        <Button
          variant="destructive"
          disabled={pending}
          onClick={() => submit("rejected")}
          data-testid="decision-reject"
        >
          Reject
        </Button>
      </div>
    </section>
  );
}
