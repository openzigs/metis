/**
 * Thin wrapper over js-yaml 5's loader that keeps the v4 contract every METIS
 * caller was written against (#915).
 *
 * js-yaml 5 changed two things that matter here:
 *
 *   • `load()` THROWS on an empty stream ("", whitespace, comments only), where
 *     v4 returned `undefined` / `null`. Every caller treats "no document" as a
 *     soft case (fall back to defaults, report an empty frontmatter, …), not as
 *     a parse error, so an empty stream resolves to `null` here.
 *   • The default loader schema is now `CORE_SCHEMA`, which drops v4's
 *     `DEFAULT_SCHEMA` extras (`!!timestamp`, `!!binary`, `!!omap`, `!!pairs`,
 *     `!!set`, and `<<` merge keys). Callers must name a schema explicitly; see
 *     {@link CORE_WITH_MERGE_SCHEMA} for the one place that needs merge keys.
 *
 * Neither v4's nor v5's built-in schemas construct JS types (`!!js/function`,
 * `!!js/regexp`, …) — those are an unknown tag and a parse error. A multi-document
 * stream is still rejected, as `load()` did in v4.
 */
import {
  CORE_SCHEMA,
  YAMLException,
  loadAll,
  mergeTag,
  type LoadOptions,
  type Schema,
} from "js-yaml";

/**
 * YAML 1.2 core scalars plus `<<` merge keys — the part of v4's `DEFAULT_SCHEMA`
 * a hand- or model-written OpenAPI document actually uses (anchors + merges for
 * shared response bodies). Merge expansion stays bounded by js-yaml's
 * `maxTotalMergeKeys` default (10 000), the same bound as v4.3.2. Timestamps are
 * deliberately NOT restored: a date-looking scalar stays a string, so no `Date`
 * is constructed from untrusted text and a round-trip dump keeps what was written.
 */
export const CORE_WITH_MERGE_SCHEMA = CORE_SCHEMA.withTags(mergeTag);

/**
 * Parse a single YAML document. Returns `null` for an empty stream (v4
 * compatibility); throws a `YAMLException` on a syntax error or when the
 * stream holds more than one document. `schema` is required so no caller
 * silently inherits whatever a future major makes the default.
 */
export function loadYamlDocument(text: string, options: LoadOptions & { schema: Schema }): unknown {
  const documents = loadAll(text, options);
  if (documents.length === 0) return null;
  if (documents.length > 1) {
    throw new YAMLException("expected a single document in the stream, but found more");
  }
  return documents[0];
}
