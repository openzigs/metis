/**
 * #1360 / #1369 — values written into the one-line facts of the impact-analysis
 * prompts.
 *
 * Table and column names come from a repository's DDL, ORM annotations
 * (`@Table(name = "…")`) or a live database, where a quoted identifier may hold
 * any character; symbol and file names come from the repository; rationales,
 * clauses and suggested DDL are model-written. Written raw, a `"` ended the
 * `key="…"` value, a line break started a forged fact line (`1. table="…"`,
 * `[0] table="…"`, `- severity=…`), and a run of `<` or `>` closed an untrusted
 * block such as `<<<IMPACTED ITEMS>>>`.
 */
import {
  scrubItemsFenceLookalikes,
  scrubRequirementFenceLookalikes,
} from "../ai/tool-runtime/fence-scrub.js";

/** Every line break a reader (or a model) may take as the start of a new line. */
const LINE_BREAKS = /\r\n|[\r\n\v\f\x85\p{Zl}\p{Zp}]/gu;

/** A name that can stand bare in a list: letters, digits and `_ $ . # @ -`, nothing else. */
const BARE_NAME = /^[\p{L}\p{N}_$.#@-]+$/u;

/**
 * `text` as a JSON string literal on one line: line breaks collapsed to a space,
 * the angle-bracket fences (`<<<…>>>`, `<<END ITEMS>>`) redacted, then
 * `JSON.stringify`, so a `"` is `\"` and cannot end the value. For text with no
 * `"`, `\`, control character, line break or fence this is `"text"` — the same
 * bytes the prompts wrote before.
 */
export function quotedPromptValue(text: string): string {
  const oneLine = text.replace(LINE_BREAKS, " ");
  return JSON.stringify(
    scrubItemsFenceLookalikes(
      scrubRequirementFenceLookalikes(oneLine, "[REDACTED-FENCE]"),
      "[REDACTED-FENCE]",
    ),
  );
}

/**
 * A name as an item of an unquoted, comma-separated list (`tables=[a, b]`,
 * `columns: a, b`): itself when it is a plain identifier, else
 * {@link quotedPromptValue}. A name that could end the list, start a line or
 * hold a fence is never a plain identifier, so it is always quoted; a plain one
 * is written as before.
 */
export function promptNameItem(name: string): string {
  return BARE_NAME.test(name) ? name : quotedPromptValue(name);
}
