/**
 * Issue #1099 (epic #1313, "no silent wrong output") — what synthesis did with
 * a malformed value in one field of one requirement.
 *
 * `runSynthesis` validated the model's whole reply with `synthesisOutputSchema`,
 * so ONE bad value — `storyPoints: null`, a 65-character label, a fractional
 * evidence index — discarded EVERY requirement, cost a second billed call, and
 * after two failures sent the run to the keyword fallback. Synthesis now repairs
 * field by field (`synthesis-reply-repair.ts`): `null` in an optional list or
 * number reads as absent, and anything else that cannot be used is dropped,
 * defaulted or shortened — and recorded here, so the analyst is told what was
 * left out instead of it vanishing.
 *
 * These fields are published to trackers and Spec Kit, which is why each
 * repair names the requirement and says exactly what was lost.
 */

/** The fields a repair can touch. `requirements` is the list itself. */
export const SYNTHESIS_REPAIRABLE_FIELDS = [
  "summary",
  "requirements",
  "requirement",
  "title",
  "body",
  "type",
  "priority",
  "labels",
  "storyPoints",
  "evidenceFindingIndexes",
  "acceptanceCriteria",
] as const;
export type SynthesisRepairableField = (typeof SYNTHESIS_REPAIRABLE_FIELDS)[number];

/**
 * What was done:
 * - `dropped`: the field was left out (it was not the right kind of value);
 * - `entries-dropped`: some entries of a list were left out, the rest kept;
 * - `truncated`: a list kept its first N entries, or a text was shortened;
 * - `defaulted`: an unknown value was replaced by the documented default;
 * - `requirement-dropped`: the requirement had no usable title or description.
 */
export const SYNTHESIS_REPAIR_ACTIONS = [
  "dropped",
  "entries-dropped",
  "truncated",
  "defaulted",
  "requirement-dropped",
] as const;
export type SynthesisRepairAction = (typeof SYNTHESIS_REPAIR_ACTIONS)[number];

/** One repair. Carries no model text beyond the requirement's own title. */
export interface SynthesisFieldRepair {
  field: SynthesisRepairableField;
  action: SynthesisRepairAction;
  /** 1-based position of the requirement in the model's reply; null for reply-level repairs. */
  requirementNumber: number | null;
  /** The requirement's title as kept (already shortened), or null when it had none. */
  requirementTitle: string | null;
}

/** Persisted to `Analysis.metadata.synthesisFieldRepairs`; absent on a run with none. */
export interface SynthesisFieldRepairs {
  /** At most {@link MAX_RECORDED_SYNTHESIS_REPAIRS} entries, in reply order. */
  repairs: SynthesisFieldRepair[];
  /** Every repair the run made, including any past the recorded cap. */
  total: number;
  /** ISO timestamp of the synthesis that made them. */
  at: string;
}

/** Cap on recorded repairs, so a pathological reply cannot bloat the metadata blob. */
export const MAX_RECORDED_SYNTHESIS_REPAIRS = 50;

/** Caps the repairs enforce; mirror `synthesizedRequirementSchema` / `synthesisOutputSchema`. */
export const SYNTHESIS_FIELD_LIMITS = {
  summaryChars: 4096,
  requirements: 100,
  titleChars: 255,
  bodyChars: 4096,
  labels: 16,
  labelChars: 64,
  storyPointsMax: 100,
  evidenceIndexes: 50,
  acceptanceCriteria: 20,
  criterionChars: 1024,
} as const;

const L = SYNTHESIS_FIELD_LIMITS;

/** What was lost, per field and action, as the analyst reads it. */
function consequence(field: SynthesisRepairableField, action: SynthesisRepairAction): string {
  switch (field) {
    case "summary":
      return action === "truncated"
        ? `the synthesis summary was shortened to ${L.summaryChars.toLocaleString("en-US")} characters`
        : "the synthesis summary was missing or empty, so a generated one is shown instead";
    case "requirements":
      return `only the first ${L.requirements} requirements were kept`;
    case "requirement":
      return "left out: it had no usable title or description";
    case "title":
      return `title shortened to ${L.titleChars} characters`;
    case "body":
      return `description shortened to ${L.bodyChars.toLocaleString("en-US")} characters`;
    case "type":
      return 'type set to "feature" because the model\'s type was missing or not one METIS knows';
    case "priority":
      return 'priority set to "medium" because the model\'s priority was missing or not one METIS knows';
    case "labels":
      if (action === "truncated") return `only the first ${L.labels} labels were kept`;
      if (action === "entries-dropped") {
        return `some labels were left out (empty, not text, or longer than ${L.labelChars} characters)`;
      }
      return "labels were left out (the model's value was not a list)";
    case "storyPoints":
      return `story points left blank (the model's value was not a whole number from 0 to ${L.storyPointsMax})`;
    case "evidenceFindingIndexes":
      if (action === "truncated") {
        return `only the first ${L.evidenceIndexes} links to findings were kept`;
      }
      if (action === "entries-dropped") {
        return "some links to findings were left out (not valid finding numbers)";
      }
      return "links to findings were left out (the model's value was not a list)";
    case "acceptanceCriteria":
      if (action === "truncated") {
        return `only the first ${L.acceptanceCriteria} acceptance criteria were kept`;
      }
      if (action === "entries-dropped") {
        return (
          `some acceptance criteria were left out (empty, not text, or longer than ` +
          `${L.criterionChars.toLocaleString("en-US")} characters)`
        );
      }
      return "acceptance criteria were left out (the model's value was not a list)";
  }
}

/** One repair as a sentence naming the requirement and what was lost. */
export function describeSynthesisFieldRepair(r: SynthesisFieldRepair): string {
  const what = consequence(r.field, r.action);
  if (r.requirementNumber === null) {
    return what.charAt(0).toUpperCase() + what.slice(1) + ".";
  }
  const which = r.requirementTitle
    ? `“${r.requirementTitle}”`
    : `Requirement ${r.requirementNumber}`;
  return `${which}: ${what}.`;
}

/** The notice's lead sentence. */
export function describeSynthesisFieldRepairs(record: SynthesisFieldRepairs): string {
  const n = record.total;
  return (
    `The model wrote ${n} ${n === 1 ? "value" : "values"} METIS could not use, so ` +
    `${n === 1 ? "it was" : "they were"} left out, defaulted or shortened and the rest of ` +
    `its answer was kept. Check these before publishing:`
  );
}

/** Narrow an untrusted metadata value; unknown entries are dropped. */
export function readSynthesisFieldRepairs(value: unknown): SynthesisFieldRepairs | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as { repairs?: unknown; total?: unknown; at?: unknown };
  if (!Array.isArray(raw.repairs)) return null;
  const repairs = raw.repairs.filter(
    (r): r is SynthesisFieldRepair =>
      !!r &&
      typeof r === "object" &&
      (SYNTHESIS_REPAIRABLE_FIELDS as readonly string[]).includes(
        (r as SynthesisFieldRepair).field,
      ) &&
      (SYNTHESIS_REPAIR_ACTIONS as readonly string[]).includes((r as SynthesisFieldRepair).action),
  );
  if (repairs.length === 0) return null;
  const total =
    typeof raw.total === "number" && raw.total >= repairs.length ? raw.total : repairs.length;
  return { repairs, total, at: typeof raw.at === "string" ? raw.at : "" };
}
