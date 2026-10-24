/**
 * #1133, #1469 — why the architecture document's schema check could not check
 * a name, in ONE place: the server writes these words into the section's
 * Schema check note and line, and the Provenance panel shows the same words,
 * so the document and the panel never word one reason two ways.
 *
 * The order is the order the note lists them in. Changing a phrase changes the
 * note written into a stored section (`applySchemaGrounding`), so it needs the
 * server's `SCHEMA_GROUNDING_VERSION` bumped.
 */
export const NOT_CHECKED_REASONS = [
  "unread",
  "not-a-column",
  "view",
  "diagram-line",
  "dataset",
  "no-columns",
] as const;
export type NotCheckedReason = (typeof NOT_CHECKED_REASONS)[number];

export const NOT_CHECKED_REASON_WORDS: Readonly<Record<NotCheckedReason, string>> = {
  unread: "outside the schemas that were read",
  "not-a-column":
    "an index, constraint, key or relation row, or a name that is not a plain column name",
  view: "described as a view, which the schema that was read does not list as one",
  "diagram-line": "a diagram line whose column name could not be told from its type",
  dataset: "a dataset in the code's data lineage, not a database table",
  "no-columns": "no column list for the table",
};
