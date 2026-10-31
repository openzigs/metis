/**
 * Issue #1099 — repair a synthesis reply field by field before it meets
 * `synthesisOutputSchema`, so one malformed optional value costs that value and
 * not every requirement in the reply.
 *
 * Decisions, per field (the published consequence is worded in
 * `@metis/shared` `describeSynthesisFieldRepair`):
 *
 * | field                    | `null`/absent        | other bad value                                   |
 * |--------------------------|----------------------|---------------------------------------------------|
 * | storyPoints              | absent, silently     | dropped (not an integer 0..100: no rounding guess) |
 * | labels                   | absent, silently     | not a list → dropped; bad entries dropped; > 16 → first 16 |
 * | acceptanceCriteria       | absent, silently     | not a list → dropped; bad entries dropped; > 20 → first 20 |
 * | evidenceFindingIndexes   | absent, silently     | not a list → dropped; non-index entries dropped; > 50 → first 50 |
 * | acceptanceCriteriaEvidence | absent, silently   | zipped into `criterionEvidence` (#1610); a non-list entry is no evidence for its criterion |
 * | type / priority          | absent → default, silently; `null` → default, recorded | unknown → default, recorded (case/space differences read losslessly) |
 * | title / body             | requirement dropped  | over the cap → shortened                          |
 * | summary                  | generated, recorded  | over the cap → shortened                          |
 * | requirements (the list)  | —                    | over 100 → first 100                              |
 *
 * An over-long criterion or label is DROPPED, not cut: a cut criterion would be
 * published as a different, shorter claim. A title or description is shortened
 * instead, because dropping it would drop the requirement.
 *
 * Deliberately its own module: ten pipeline suites `vi.mock("./synthesis.js")`
 * exposing only `runSynthesis`, so a new value export there breaks them.
 */
import {
  REQUIREMENT_PRIORITIES,
  REQUIREMENT_TYPES,
  SYNTHESIS_FIELD_LIMITS as L,
  type SynthesisFieldRepair,
  type SynthesisRepairAction,
  type SynthesisRepairableField,
} from "@metis/shared";

export interface RepairedSynthesisReply {
  /** The reply with every repairable field repaired; still validated by the schema after. */
  reply: unknown;
  repairs: SynthesisFieldRepair[];
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

/** Cut `text` to `max` characters, marking the cut. */
function shorten(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * Repair one requirement object. Returns `null` when it cannot be kept (no
 * usable title or body); the repairs are appended to `out` either way.
 *
 * @param number 1-based position in the reply, for the analyst-facing record.
 */
export function repairSynthesizedRequirement(
  raw: unknown,
  number: number,
  out: SynthesisFieldRepair[],
): Record<string, unknown> | null {
  if (!isRecord(raw)) {
    out.push(record("requirement", "requirement-dropped", number, null));
    return null;
  }
  const r: Record<string, unknown> = { ...raw };

  const title = typeof r.title === "string" ? r.title.trim() : "";
  const body = typeof r.body === "string" ? r.body.trim() : "";
  if (!title || !body) {
    out.push(
      record(
        "requirement",
        "requirement-dropped",
        number,
        title ? shorten(title, L.titleChars) : null,
      ),
    );
    return null;
  }
  const keptTitle = shorten(title, L.titleChars);
  const repairs: Array<[SynthesisRepairableField, SynthesisRepairAction]> = [];
  r.title = keptTitle;
  if (title.length > L.titleChars) repairs.push(["title", "truncated"]);
  r.body = shorten(body, L.bodyChars);
  if (body.length > L.bodyChars) repairs.push(["body", "truncated"]);

  repairEnum(r, "type", REQUIREMENT_TYPES, repairs);
  repairEnum(r, "priority", REQUIREMENT_PRIORITIES, repairs);

  // storyPoints: an integer 0..100 or nothing. `3.5`, `"5"`, `200` are dropped
  // rather than rounded or parsed — a guessed estimate is published as real.
  if (r.storyPoints === null) delete r.storyPoints;
  else if (r.storyPoints !== undefined) {
    const sp = r.storyPoints;
    if (!(typeof sp === "number" && Number.isInteger(sp) && sp >= 0 && sp <= L.storyPointsMax)) {
      delete r.storyPoints;
      repairs.push(["storyPoints", "dropped"]);
    }
  }

  repairList(
    r,
    "labels",
    (e): e is string =>
      typeof e === "string" && e.trim().length > 0 && e.trim().length <= L.labelChars,
    (e) => (e as string).trim(),
    L.labels,
    repairs,
  );
  // #1610 — before any criterion is dropped, so the alignment still holds.
  zipCriterionEvidence(r);
  repairList(
    r,
    "acceptanceCriteria",
    (e): e is string =>
      typeof e === "string" && e.trim().length > 0 && e.trim().length <= L.criterionChars,
    (e) => (e as string).trim(),
    L.acceptanceCriteria,
    repairs,
  );
  repairList(
    r,
    "evidenceFindingIndexes",
    (e): e is number => typeof e === "number" && Number.isInteger(e) && e >= 0,
    (e) => e,
    L.evidenceIndexes,
    repairs,
  );

  for (const [field, action] of repairs) out.push(record(field, action, number, keptTitle));
  return r;
}

/**
 * Issue #1610 — turn the model's `acceptanceCriteriaEvidence` (a list of finding
 * indexes per criterion, ALIGNED with its `acceptanceCriteria`) into
 * `criterionEvidence`, keyed by the criterion's text. Keyed by text because the
 * alignment does not survive what happens next: a bad criterion is dropped by
 * the repair below, merges unite criteria lists, and the approval checkpoint
 * rebuilds them.
 *
 * Silent, like every optional list: absent or malformed evidence leaves the
 * requirement on the three-state roll-up, which is what it had before #1610. A
 * `criterionEvidence` the model wrote itself is discarded — only this zip may
 * produce one. Indexes are only shape-checked here; `runSynthesis` clamps them to
 * the findings table and to the requirement's own `evidenceFindingIndexes`.
 */
function zipCriterionEvidence(r: Record<string, unknown>): void {
  const aligned = r.acceptanceCriteriaEvidence;
  delete r.acceptanceCriteriaEvidence;
  delete r.criterionEvidence;
  const criteria = r.acceptanceCriteria;
  if (!Array.isArray(aligned) || !Array.isArray(criteria)) return;
  const zipped: Array<{ criterion: string; evidenceFindingIndexes: number[] }> = [];
  criteria.forEach((c, i) => {
    if (typeof c !== "string") return;
    const criterion = c.trim();
    if (criterion.length === 0 || criterion.length > L.criterionChars) return;
    const ix: unknown = aligned[i];
    if (!Array.isArray(ix)) return;
    const indexes = [
      ...new Set(
        ix.filter((e): e is number => typeof e === "number" && Number.isInteger(e) && e >= 0),
      ),
    ].slice(0, L.evidenceIndexes);
    zipped.push({ criterion, evidenceFindingIndexes: indexes });
  });
  if (zipped.length > 0) r.criterionEvidence = zipped.slice(0, L.acceptanceCriteria);
}

/**
 * Repair a parsed synthesis reply. A reply whose `requirements` is not a list
 * is returned unchanged: that is not one bad field, it is no answer, and the
 * schema rejects it (and synthesis re-asks) exactly as before.
 */
export function repairSynthesisReply(parsed: unknown): RepairedSynthesisReply {
  if (!isRecord(parsed) || !Array.isArray(parsed.requirements)) {
    return { reply: parsed, repairs: [] };
  }
  const repairs: SynthesisFieldRepair[] = [];
  let list = parsed.requirements as unknown[];
  if (list.length > L.requirements) {
    repairs.push(record("requirements", "truncated", null, null));
    list = list.slice(0, L.requirements);
  }
  const requirements = list.flatMap((raw, i) => {
    const kept = repairSynthesizedRequirement(raw, i + 1, repairs);
    return kept ? [kept] : [];
  });

  let summary = parsed.summary;
  if (typeof summary !== "string" || summary.trim().length === 0) {
    summary = `Synthesized ${requirements.length} requirement(s).`;
    repairs.push(record("summary", "defaulted", null, null));
  } else if (summary.length > L.summaryChars) {
    summary = shorten(summary, L.summaryChars);
    repairs.push(record("summary", "truncated", null, null));
  }

  return { reply: { ...parsed, summary, requirements }, repairs };
}

function record(
  field: SynthesisRepairableField,
  action: SynthesisRepairAction,
  requirementNumber: number | null,
  requirementTitle: string | null,
): SynthesisFieldRepair {
  return { field, action, requirementNumber, requirementTitle };
}

/**
 * An enum field: absent stays absent (the schema's default applies, as it
 * always has); a case or whitespace difference is read losslessly; `null` or an
 * unknown value is removed so the default applies, and is RECORDED, because
 * the default ("feature", "medium") is then METIS's word, not the model's.
 */
function repairEnum(
  r: Record<string, unknown>,
  field: "type" | "priority",
  allowed: readonly string[],
  repairs: Array<[SynthesisRepairableField, SynthesisRepairAction]>,
): void {
  const v = r[field];
  if (v === undefined) return;
  if (typeof v === "string") {
    const normal = v.trim().toLowerCase();
    if (allowed.includes(normal)) {
      r[field] = normal;
      return;
    }
  }
  delete r[field];
  repairs.push([field, "defaulted"]);
}

/** A list field: `null` → absent; not a list → dropped; bad entries dropped; capped. */
function repairList<T>(
  r: Record<string, unknown>,
  field: "labels" | "acceptanceCriteria" | "evidenceFindingIndexes",
  valid: (e: unknown) => e is T,
  normalize: (e: T) => T,
  cap: number,
  repairs: Array<[SynthesisRepairableField, SynthesisRepairAction]>,
): void {
  const v = r[field];
  if (v === null) {
    delete r[field];
    return;
  }
  if (v === undefined) return;
  if (!Array.isArray(v)) {
    delete r[field];
    repairs.push([field, "dropped"]);
    return;
  }
  const kept = v.filter(valid).map(normalize);
  if (kept.length < v.length) repairs.push([field, "entries-dropped"]);
  if (kept.length > cap) repairs.push([field, "truncated"]);
  r[field] = kept.slice(0, cap);
}
