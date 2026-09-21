"use client";

/**
 * Issue #1112 (Epic #1107) — input-side coverage for the "Evaluate new
 * requirements" box.
 *
 * #1101: a user pasted seven requirements, six were mapped, and the seventh was
 * sliced off by the candidate cap. The run reported success and nothing on the
 * page said otherwise — the user could not tell "METIS considered R7 and found
 * nothing" from "METIS never looked at R7".
 *
 * This panel states the account: how many requirements were parsed out of the
 * paste, which were analyzed, which were folded into another as duplicates
 * (naming the survivor — a merge is NOT a loss), and which were dropped, with
 * the reason. It renders only for runs that carried free-text requirements, so
 * it adds nothing to a plain analysis.
 *
 * Merges are rendered in neutral tone and drops in amber: conflating them would
 * either alarm users about correct de-duplication or bury a genuine loss.
 */
import type { AnalysisCapability, RequirementInputDropReason } from "@metis/shared";

interface Props {
  capability: AnalysisCapability | null;
}

/** Plain-language cause for each machine-readable drop reason. */
const DROP_REASON_TEXT: Record<RequirementInputDropReason, string> = {
  "candidate-cap":
    "over the per-run limit on requirements (the paste split into more blocks than the run accepts)",
  unparseable: "no requirement text could be read from this block",
};

export function RequirementInputAccountPanel({ capability }: Props): React.ReactElement | null {
  const account = capability?.requirementInputAccount;
  if (!account || account.parsedCount === 0) return null;

  const analyzedCount = account.analyzedIds.length;
  const discarded = account.dropped.length > 0 || account.inputTruncated;

  return (
    <div data-testid="requirement-input-account-panel" className="space-y-2">
      <h4 className="text-sm font-semibold uppercase tracking-wide text-zinc-400">
        Requirements you supplied
      </h4>
      <p
        className={`text-xs ${discarded ? "text-amber-300" : "text-zinc-500"}`}
        data-testid="requirement-input-account-summary"
      >
        {analyzedCount} of {account.parsedCount} requirement
        {account.parsedCount === 1 ? "" : "s"} you supplied {analyzedCount === 1 ? "was" : "were"}{" "}
        analyzed.
      </p>

      {account.inputTruncated ? (
        <p className="text-xs text-amber-300" data-testid="requirement-input-truncated">
          Your text reached the input limit, so anything after it was cut before this run started —
          the end of your paste may be missing.
        </p>
      ) : null}

      {account.merged.length > 0 ? (
        <ul className="space-y-1" data-testid="requirement-input-merged-list">
          {account.merged.map((m) => (
            <li
              key={m.id}
              data-testid={`requirement-input-merged-${m.id}`}
              className="text-xs text-zinc-400"
            >
              <span className="font-mono text-zinc-500">{m.id}</span>{" "}
              <span className="text-zinc-300">“{m.excerpt}”</span> — merged into{" "}
              <span className="font-mono text-zinc-300">{m.mergedIntoId}</span> as a duplicate (
              {m.mergedIntoExcerpt}). It was analyzed under that requirement.
            </li>
          ))}
        </ul>
      ) : null}

      {account.dropped.length > 0 ? (
        <ul className="space-y-1" data-testid="requirement-input-dropped-list">
          {account.dropped.map((d) => (
            <li
              key={d.id}
              data-testid={`requirement-input-dropped-${d.id}`}
              className="text-xs text-amber-200"
            >
              <span className="font-mono text-amber-400">{d.id}</span> <span>“{d.excerpt}”</span> —
              not analyzed: {DROP_REASON_TEXT[d.reason]}.
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
