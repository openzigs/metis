/**
 * The one way METIS parses YAML. It wraps js-yaml 5 and keeps the js-yaml 4
 * behaviour every caller was written against (#915).
 *
 * js-yaml 5 changed four things that matter here:
 *
 *   • `load()` THROWS on an empty stream ("", whitespace, comments only), where
 *     v4 returned `undefined` / `null`. Every caller treats "no document" as a
 *     soft case (fall back to defaults, report an empty frontmatter, …), so an
 *     empty stream resolves to `null` here.
 *   • An EMPTY plain scalar (`key:`, `- `, a bare `---`) is `""` under v5's
 *     FAILSAFE and JSON schemas; v4 gave `null`. A blank `version:` or `model:`
 *     would then pass `z.string()` and slip past `?? fallback` defaults, so the
 *     `failsafe` schema below restores the null.
 *   • v5's `JSON_SCHEMA` is strict JSON scalars (`~`, `True`, `0x1F`, `.5` stay
 *     strings). v4's `JSON_SCHEMA` resolved those the way v5's `CORE_SCHEMA`
 *     does, so the v4-JSON callers use `core`.
 *   • The default schema is `CORE_SCHEMA`, without v4's `<<` merge keys and
 *     timestamps. A schema is therefore always named — by key, so no caller can
 *     hand in a raw js-yaml schema with v5's semantics by accident.
 *
 * None of these schemas construct JS types (`!!js/function`, `!!js/regexp`, …):
 * those are an unknown tag and a parse error. A multi-document stream is still
 * rejected, as `load()` did in v4.
 */
import {
  CORE_SCHEMA,
  FAILSAFE_SCHEMA,
  NOT_RESOLVED,
  YAMLException,
  defineScalarTag,
  loadAll,
  mergeTag,
  type LoadOptions,
} from "js-yaml";

/** An empty plain scalar is `null`, as in js-yaml 4's FAILSAFE schema. Nothing else resolves. */
const emptyPlainScalarIsNull = defineScalarTag<null>("tag:yaml.org,2002:null", {
  implicit: true,
  implicitFirstChars: [""],
  resolve: (source) => (source === "" ? null : NOT_RESOLVED),
  identify: (data) => data === null,
  represent: () => "",
});

const SCHEMAS = {
  /** Strings, sequences and mappings only; an empty value is `null` (v4 FAILSAFE). */
  failsafe: FAILSAFE_SCHEMA.withTags(emptyPlainScalarIsNull),
  /** YAML 1.2 core scalars: null / bool / int / float. Same resolution as v4's JSON_SCHEMA. */
  core: CORE_SCHEMA,
  /**
   * Core plus `<<` merge keys — the part of v4's DEFAULT_SCHEMA that hand- or
   * model-written OpenAPI and compose files use. Timestamps are deliberately
   * NOT restored: a date-looking scalar stays a string, so no `Date` is built
   * from untrusted text and a round-trip dump keeps what was written.
   */
  "core-merge": CORE_SCHEMA.withTags(mergeTag),
} as const;

export type YamlSchemaName = keyof typeof SCHEMAS;

/** Merge-key expansion cap per load — pinned here, not inherited from js-yaml's default. */
export const YAML_MAX_TOTAL_MERGE_KEYS = 10_000;
/** Alias (`*ref`) cap per document. No caller's input needs more; it bounds alias fan-out. */
export const YAML_MAX_ALIASES = 64;

export interface YamlLoadOptions {
  schema: YamlSchemaName;
  /** Overrides {@link YAML_MAX_ALIASES}. */
  maxAliases?: number;
  filename?: string;
}

/**
 * Parse a single YAML document. Returns `null` for an empty stream (v4
 * compatibility); throws a `YAMLException` on a syntax error, when a limit is
 * exceeded, or when the stream holds more than one document.
 */
export function loadYamlDocument(text: string, options: YamlLoadOptions): unknown {
  const loadOptions: LoadOptions = {
    schema: SCHEMAS[options.schema],
    maxTotalMergeKeys: YAML_MAX_TOTAL_MERGE_KEYS,
    maxAliases: options.maxAliases ?? YAML_MAX_ALIASES,
    ...(options.filename ? { filename: options.filename } : {}),
  };
  const documents = loadAll(text, loadOptions);
  if (documents.length === 0) return null;
  if (documents.length > 1) {
    throw new YAMLException("expected a single document in the stream, but found more");
  }
  return documents[0];
}
