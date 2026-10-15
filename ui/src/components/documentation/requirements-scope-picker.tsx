"use client";

/**
 * #1129 — limit a requirements BRD to chosen requirements of one run.
 *
 * The requirements scope (#991) covered the whole run: on a run started from
 * five ticked imported items the BRD named 33 requirements. This lists the
 * run's requirements so the user can choose some, offers "only the ticked
 * items" in one click, and says how many the document will cover before it is
 * generated. `value === null` means the whole run (no `requirementIds` sent).
 */
import { useQuery } from "@tanstack/react-query";
import { analysisApi } from "@/lib/analysis-api";
import { queryKeys } from "@/lib/query-keys";
import { Button } from "@/components/ui/button";
import { tickedRequirementIds } from "@/components/reviews/request-review-card";

interface Props {
  analysisId: string;
  approvedOnly: boolean;
  value: ReadonlySet<string> | null;
  onChange: (next: ReadonlySet<string> | null) => void;
}

export function RequirementsScopePicker({
  analysisId,
  approvedOnly,
  value,
  onChange,
}: Props): React.ReactElement | null {
  const detail = useQuery({
    queryKey: queryKeys.analyses.detail(analysisId),
    queryFn: () => analysisApi.get(analysisId),
    enabled: Boolean(analysisId),
  });
  const all = Array.isArray(detail.data?.requirements) ? detail.data.requirements : [];
  if (all.length === 0) return null;
  const eligible = approvedOnly ? all.filter((r) => r.reviewStatus === "approved") : all;
  const isChosen = (id: string): boolean => value === null || value.has(id);
  const covered = eligible.filter((r) => isChosen(r.id)).length;
  const ticked = tickedRequirementIds(eligible);

  const toggle = (id: string, checked: boolean): void => {
    const next = new Set(value ?? all.map((r) => r.id));
    if (checked) next.add(id);
    else next.delete(id);
    onChange(next.size === all.length ? null : next);
  };

  return (
    <fieldset className="space-y-1" data-testid="requirements-scope-picker">
      <legend className="text-sm font-medium">Requirements in this document</legend>
      <p className="text-sm" data-testid="requirements-scope-count">
        The document will cover {covered} of {eligible.length} requirement
        {eligible.length === 1 ? "" : "s"}.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={() => onChange(null)}>
          Choose all
        </Button>
        {ticked.length > 0 && ticked.length < eligible.length ? (
          <Button type="button" size="sm" variant="ghost" onClick={() => onChange(new Set(ticked))}>
            Only the {ticked.length} from ticked items
          </Button>
        ) : null}
      </div>
      <ul className="max-h-48 space-y-1 overflow-y-auto rounded-md border p-2">
        {eligible.map((r) => (
          <li key={r.id} className="text-sm">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={isChosen(r.id)}
                onChange={(e) => toggle(r.id, e.target.checked)}
              />
              {r.title}
            </label>
          </li>
        ))}
      </ul>
    </fieldset>
  );
}
