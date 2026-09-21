/**
 * Issue #1016 (epic #999) — the ONE definition of a code symbol's qualified-name
 * shape.
 *
 * Every code-graph parser builds a symbol's qualified name the same way: the file's
 * own `module` symbol is the ROOT (its qualified name IS the repo-relative file
 * path), and each nested declaration appends its simple name after a separator:
 *
 *   module            src/main/java/org/mybatis/jpetstore/domain/Account.java
 *   class             src/main/java/…/Account.java::Account
 *   method            src/main/java/…/Account.java::Account::getUsername
 *
 * That shape was previously spelled as a bare `` `${moduleQname}::${name}` ``
 * template in fourteen places across two parser files, with NOTHING tying it to the
 * consumers that have to split it apart again. The eval corpus meanwhile used a
 * dotted `org.jpetstore.domain.Account` convention, and the divergence went
 * unnoticed until it silently corrupted `buildEntityVocabulary` on real projects
 * (#1002) — the vocabulary degenerated into `"ts"`, `"java"`, and raw path
 * prefixes, which then GROUND SUCCESSFULLY and ran meaningless BM25 queries.
 *
 * Centralising the separator here means the eval harness's corpus self-check
 * ({@link ../eval/impact-recall/name-convention.ts}) derives its expectation from
 * the emitters themselves rather than restating a string that can drift.
 *
 * NOTE the schema side is deliberately NOT here: schema symbols are dotted
 * (`<schema>.<table>`, `<table>.<column>`) and their single source is
 * `schema-graph.ts` (`tableQualifiedName` / `columnQualifiedName` /
 * `routineQualifiedName`).
 */

/**
 * Separator between a code symbol's qualified-name segments.
 *
 * `::` rather than `.` because the ROOT segment is a file path, which carries dots
 * of its own (`Account.java`): splitting a production qualified name on `.` lands
 * inside the file extension.
 */
export const CODE_QUALIFIED_NAME_SEPARATOR = "::";

/**
 * The qualified name of a file's `module` symbol — the repo-relative path itself.
 * Every other symbol in the file hangs off it.
 */
export function moduleQualifiedName(filePath: string): string {
  return filePath;
}

/**
 * Append declaration segments to a parent (module or enclosing type) qualified
 * name. Empty segments are dropped so a caller with an optional enclosing type
 * does not emit a doubled separator.
 */
export function buildCodeQualifiedName(parentQualifiedName: string, ...segments: string[]): string {
  return [parentQualifiedName, ...segments.filter((s) => s !== "")].join(
    CODE_QUALIFIED_NAME_SEPARATOR,
  );
}

/**
 * Split a code qualified name into `[filePath, ...declarations]`. The file path is
 * returned whole — it is never split on `/` or `.`.
 */
export function codeQualifiedNameSegments(qualifiedName: string): string[] {
  return qualifiedName
    .split(CODE_QUALIFIED_NAME_SEPARATOR)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * True when `qualifiedName` has the shape the parsers emit for a symbol declared in
 * `filePath`: either the module row itself (equal to the path) or the path followed
 * by at least one separated declaration segment.
 *
 * The `${filePath}${SEP}` prefix test — rather than a `startsWith(filePath)` — is
 * what stops `a/Foo.ts` from claiming `a/FooBar.ts::x`.
 */
export function isCodeQualifiedNameOf(qualifiedName: string, filePath: string): boolean {
  if (!filePath) return false;
  if (qualifiedName === filePath) return true;
  return qualifiedName.startsWith(`${filePath}${CODE_QUALIFIED_NAME_SEPARATOR}`);
}
