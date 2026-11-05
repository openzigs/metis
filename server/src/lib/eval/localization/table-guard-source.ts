/**
 * #1823 — the repository behind the table-precision guard's corpus, and how
 * its code agent's citations are read on the corpus.
 *
 * `impact-recall-01-jpetstore` is a hand-authored, JPetStore-6-style graph
 * (#930, #939): its symbols have no source text, so the code agent cannot read
 * it. Arm A7 needs citations stored by a real "Evaluate new requirements" run,
 * so `pnpm eval:materialize impact-recall-01-jpetstore` materializes the
 * schema-bearing repository the fixture models: mybatis/jpetstore-6 at
 * `jpetstore-6.3.0`, the last release with the Stripes action beans the
 * fixture's web layer models (6.4.0 replaced them with Spring controllers).
 *
 * The fixture's paths are the repository's, shortened: `domain/Account.java`
 * is `src/main/java/org/mybatis/jpetstore/domain/Account.java`, and its
 * `persistence/` package is the repository's `mapper/` (Java in
 * `src/main/java`, the MyBatis XML in `src/main/resources`). A stored citation
 * is translated onto the fixture's graph by {@link translateCitations}: its
 * symbol when the fixture holds that symbol, else the cited file, else it is
 * dropped. Every outcome is counted, so a reading says how much of what the
 * agent cited reached the fixture.
 */
import type { StoredLinkRow } from "../../impact-analysis/change-seeds.js";
import type { ImpactRecallFixture } from "../impact-recall/fixture.js";
import { fileKey, type LocalizationRepo } from "./corpus.js";

/** The table-precision guard's corpus (`eval-data/corpus/<name>`). */
export const TABLE_GUARD_CORPUS = "impact-recall-01-jpetstore";

/** The repository the fixture models, pinned: what `eval:materialize` clones and ingests. */
export const TABLE_GUARD_REPO: LocalizationRepo = {
  name: "jpetstore",
  url: "https://github.com/mybatis/jpetstore-6",
  ref: "jpetstore-6.3.0",
  sha: "ce8015be2c2658d0b657be20328e53045f3a9641",
};

/** Repository prefix → fixture prefix, the first match wins. */
const PATH_RULES: ReadonlyArray<readonly [string, string]> = [
  ["src/main/java/org/mybatis/jpetstore/mapper/", "persistence/"],
  ["src/main/resources/org/mybatis/jpetstore/mapper/", "persistence/"],
  ["src/main/java/org/mybatis/jpetstore/", ""],
  ["src/site/", "src/site/"],
];

/**
 * Fixture files the repository has no file for at the pinned commit: the
 * fixture's own modelling (#939 added the `web/beans` layer, and split
 * inventory, profile and sign-on out of the account and item classes).
 */
export const FIXTURE_ONLY_FILES: ReadonlySet<string> = new Set([
  "domain/Inventory.java",
  "domain/Profile.java",
  "domain/Signon.java",
  "persistence/InventoryMapper.java",
  "persistence/InventoryMapper.xml",
  "persistence/SignonMapper.java",
  "persistence/SignonMapper.xml",
]);

/** A repository path as the fixture names it, or null when no rule maps it. */
export function toFixturePath(repoPath: string): string | null {
  for (const [from, to] of PATH_RULES) {
    if (repoPath.startsWith(from)) return to + repoPath.slice(from.length);
  }
  return null;
}

/** A fixture path as the repository names it, or null when no rule maps it back. */
export function toRepoPath(fixturePath: string): string | null {
  if (fixturePath.startsWith("persistence/")) {
    const rest = fixturePath.slice("persistence/".length);
    const root = rest.endsWith(".xml") ? "src/main/resources" : "src/main/java";
    return `${root}/org/mybatis/jpetstore/mapper/${rest}`;
  }
  if (fixturePath.startsWith("src/site/")) return fixturePath;
  if (/^(domain|service|web\/actions)\//.test(fixturePath)) {
    return `src/main/java/org/mybatis/jpetstore/${fixturePath}`;
  }
  return null;
}

/**
 * The files the materialized graph must hold (`<repo>:<path>`): every fixture
 * code file the repository has, so each can receive a citation.
 */
export function requiredRepoFiles(fixture: Pick<ImpactRecallFixture, "manifest">): string[] {
  const files = new Set<string>();
  for (const s of fixture.manifest.codeSymbols) {
    if (FIXTURE_ONLY_FILES.has(s.filePath)) continue;
    const repoPath = toRepoPath(s.filePath);
    if (repoPath) files.add(fileKey(TABLE_GUARD_REPO.name, repoPath));
  }
  return [...files].sort();
}

/** How a reading's citations reached the fixture. */
export interface CitationTranslation {
  /** Cited symbols the fixture holds under the same qualified name. */
  symbol: number;
  /** Cited symbols the fixture holds in another file of the same layer, by method or statement name. */
  member: number;
  /** Citations read as their file: the fixture holds the file, not the symbol. */
  file: number;
  /** Citations of a file the fixture does not hold: dropped. */
  dropped: number;
}

export function emptyTranslation(): CitationTranslation {
  return { symbol: 0, member: 0, file: 0, dropped: 0 };
}

/**
 * A repository symbol's qualified name as the fixture writes it, or null.
 * Code symbols are `path::Type::member`, the path translated. A MyBatis
 * statement is `org.mybatis.jpetstore.mapper.<Mapper>.<id>` in the repository
 * and `org.jpetstore.persistence.<Mapper>.<id>.statement` in the fixture.
 */
export function toFixtureQualifiedName(repoName: string): string | null {
  const sep = repoName.indexOf("::");
  if (sep > 0) {
    const filePath = toFixturePath(repoName.slice(0, sep));
    return filePath === null ? null : filePath + repoName.slice(sep);
  }
  const statement = /^org\.mybatis\.jpetstore\.mapper\.(\w+)\.(\w+)$/.exec(repoName);
  return statement ? `org.jpetstore.persistence.${statement[1]}.${statement[2]}.statement` : null;
}

/**
 * What a symbol is matched on across files: a method's name, or a statement's
 * id (`<id>.statement`); null for anything else (a type, a module).
 */
function memberOf(fixtureName: string): string | null {
  const parts = fixtureName.split("::");
  if (parts.length >= 3) return parts[parts.length - 1]!;
  const statement = /\.(\w+\.statement)$/.exec(fixtureName);
  return parts.length === 1 && statement ? statement[1]! : null;
}

/** The layer of a fixture path: its directory (`persistence/`, `web/actions/`, …). */
function layerOf(fixturePath: string): string {
  return fixturePath.slice(0, fixturePath.lastIndexOf("/") + 1);
}

/**
 * Translate a requirement's stored citations (repository paths, and the
 * materialized graph's symbol ids, resolved by `qualifiedNames`) onto the
 * fixture. In order of preference, a citation becomes:
 *
 *   1. `symbol` — the fixture symbol with the translated qualified name;
 *   2. `member` — else the one fixture method (or MyBatis statement) of that
 *      name in the same layer (the fixture keeps `insertLineItem` in
 *      `OrderMapper`, the repository in `LineItemMapper`);
 *   3. `file` — else the translated file, when the fixture holds it, with no
 *      symbol and no lines (the fixture's lines are not the repository's), so
 *      the stage reads it as production reads a file-level citation;
 *   4. dropped — else.
 *
 * The order and the confidences are kept, so the stage orders them as it
 * would the stored ones. `counts` is incremented in place.
 */
export function translateCitations(
  links: readonly StoredLinkRow[],
  qualifiedNames: ReadonlyMap<string, string>,
  fixture: Pick<ImpactRecallFixture, "manifest">,
  counts: CitationTranslation,
): StoredLinkRow[] {
  const symbols = fixture.manifest.codeSymbols;
  const byQualifiedName = new Map(symbols.map((s) => [s.qualifiedName, s]));
  const files = new Set(symbols.map((s) => s.filePath));
  const out: StoredLinkRow[] = [];
  for (const link of links) {
    const filePath = toFixturePath(link.filePath);
    const repoName = link.codeSymbolId ? qualifiedNames.get(link.codeSymbolId) : undefined;
    const fixtureName = repoName ? toFixtureQualifiedName(repoName) : null;
    const exact = fixtureName ? byQualifiedName.get(fixtureName) : undefined;
    let match = exact;
    const member = fixtureName ? memberOf(fixtureName) : null;
    if (!match && member && filePath) {
      const layer = layerOf(filePath);
      const same = symbols.filter(
        (s) => layerOf(s.filePath) === layer && memberOf(s.qualifiedName) === member,
      );
      if (same.length === 1) match = same[0];
    }
    if (match) {
      counts[exact ? "symbol" : "member"]++;
      out.push({
        ...link,
        codeSymbolId: match.id,
        filePath: match.filePath,
        startLine: null,
        endLine: null,
      });
    } else if (filePath && files.has(filePath)) {
      counts.file++;
      out.push({ ...link, codeSymbolId: null, filePath, startLine: null, endLine: null });
    } else {
      counts.dropped++;
    }
  }
  return out;
}
