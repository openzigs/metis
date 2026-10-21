/**
 * #737 — the model cites grounding source ids inline; the reader must get
 * working, readable, document-scoped references instead of nothing (the old
 * stripper), empty `(,,,)` punctuation, or URL-encoded module keys.
 */
import { describe, expect, it } from "vitest";
import {
  citationDefinitionsLength,
  renderCitationFootnotes,
  renderCitationFootnotesWithLocations,
  sourceLineLocators,
  readableSourceReference,
  renderedCitationLength,
} from "./citation-footnotes.js";
import { factsSourceId, type GroundingSource } from "./grounding/grounding-context.js";
import { renderMinedRuleInventory, toPersistedMinedRules } from "./fact-slices.js";
import { mineGoRules } from "../code-graph/go-rule-miner.js";
import { mineJavaRules } from "../code-graph/java-rule-miner.js";
import { minePyRules } from "../code-graph/py-rule-miner.js";
import { mineSqlRules } from "../code-graph/sql-rule-miner.js";
import { mineTsRules } from "../code-graph/ts-rule-miner.js";

const repo = {
  repoConnectorId: "cmurla7px000sns9kcl9mreen",
  codeGraphId: "cmurla8pu000vns9kumw4s9uh",
};
const storage0 = factsSourceId("internal/storage", 0, repo);
const storage3 = factsSourceId("internal/storage", 3, repo);
const ui0 = factsSourceId("internal/ui", 0, repo);
const symbolId = `facts:symbol:${encodeURIComponent(
  `repo:${encodeURIComponent(JSON.stringify([repo.repoConnectorId, repo.codeGraphId, "internal/model/feed.go"]))}`,
)}:sym-feed:123-150`;

function facts(sourceId: string, label: string): GroundingSource {
  return { sourceId, kind: "facts", label, text: `### MODULE: ${label}` };
}

const sources: GroundingSource[] = [
  facts(storage0, "storage"),
  facts(storage3, "storage"),
  facts(ui0, "ui"),
  { sourceId: symbolId, kind: "facts", label: "Feed.Validate", text: "func (f *Feed) Validate()" },
  {
    sourceId: "rag:doc1:chunk2",
    kind: "rag",
    label: "README.md",
    text: "readme",
    documentId: "doc1",
    chunkId: "chunk2",
  },
  { sourceId: "web:dig1", kind: "web", label: "web:go.dev", text: "digest" },
];

describe("readableSourceReference (#737)", () => {
  it("decodes a repository-scoped module id to its path", () => {
    expect(readableSourceReference(facts(storage0, "storage"))).toBe(
      "`internal/storage` (module facts)",
    );
  });

  it("gives a typed-symbol source its file:line range and symbol name", () => {
    expect(readableSourceReference(sources[3])).toBe(
      "`internal/model/feed.go:123-150` — `Feed.Validate`",
    );
  });

  it("names a retrieved chunk by its file and a web digest by its host", () => {
    expect(readableSourceReference(sources[4])).toBe("`README.md` (retrieved excerpt)");
    expect(readableSourceReference(sources[5])).toBe("`go.dev` (web research)");
  });

  it("falls back to the label for a legacy module id", () => {
    expect(readableSourceReference(facts("facts:src_orders:2", "orders"))).toBe(
      "`orders` (module facts)",
    );
  });
});

describe("a module directory named `canon` (#1119)", () => {
  // `facts:canon:` opens the id of a canonical fact (#1070) AND the legacy id
  // of the facts of a top-level module directory named `canon`.
  it("is module facts, as it was before the facts sheet, whatever the index", () => {
    for (const index of [0, 9, 123]) {
      const id = factsSourceId("canon", index);
      expect(id).toBe(`facts:canon:${index}`);
      expect(readableSourceReference(facts(id, "canon"))).toBe("`canon` (module facts)");
    }
    expect(
      renderCitationFootnotes("Rule [facts:canon:0].", [facts("facts:canon:0", "canon")]),
    ).toBe("Rule[^src-1].\n\n[^src-1]: `canon` (module facts)");
  });

  it("reads only `cf-` and ten hex digits as a canonical fact", () => {
    const canonical = "(canonical fact, read from the source)";
    expect(readableSourceReference(facts("facts:canon:cf-0123456789", "a.go:1 — N = 5"))).toBe(
      `\`a.go:1 — N = 5\` ${canonical}`,
    );
    for (const id of [
      "facts:canon:cf-012345678", // nine digits
      "facts:canon:cf-0123456789a", // eleven
      "facts:canon:cf-012345678G", // not hex
      "facts:canon:cf-0123456789:0",
      "facts:canon:",
    ]) {
      expect(readableSourceReference(facts(id, "canon"))).not.toContain(canonical);
    }
  });
});

describe("renderCitationFootnotes (#737)", () => {
  it("turns an inline marker into a footnote with a readable definition", () => {
    const out = renderCitationFootnotes(`Storage owns SQL [${storage0}].`, sources);
    expect(out).toBe("Storage owns SQL[^src-1].\n\n[^src-1]: `internal/storage` (module facts)");
    expect(out).not.toContain("%5B");
  });

  it("collapses a parenthesised list of markers — never leaves `(,,,)`", () => {
    const out = renderCitationFootnotes(
      `Reverse-proxy SSO is supported ([${storage0}], [${ui0}], [rag:doc1:chunk2]).`,
      sources,
    );
    expect(out.split("\n")[0]).toBe("Reverse-proxy SSO is supported[^src-1][^src-2][^src-3].");
    expect(out).not.toMatch(/\([,\s]*\)/);
  });

  it("splits one bracket holding several comma-separated ids", () => {
    const out = renderCitationFootnotes(`Layers [${storage0}, ${ui0}].`, sources);
    expect(out.split("\n")[0]).toBe("Layers[^src-1][^src-2].");
  });

  it("numbers document-wide: one module cited from two sections is ONE footnote", () => {
    const md = [
      "## Overview",
      "",
      `Storage first [${storage0}].`,
      "",
      "## Components",
      "",
      `UI [${ui0}] and storage again [${storage3}].`,
    ].join("\n");
    const out = renderCitationFootnotes(md, sources);
    expect(out).toContain("Storage first[^src-1].");
    expect(out).toContain("UI[^src-2] and storage again[^src-1].");
    expect(out.match(/^\[\^src-\d+\]:/gm)).toEqual(["[^src-1]:", "[^src-2]:"]);
  });

  it("drops an id that matches no admitted source, and its parentheses", () => {
    const out = renderCitationFootnotes("Invented ([facts:nowhere:9], [rag:x:y]).", sources);
    expect(out).toBe("Invented.");
  });

  it("rewrites a bare id the model put in its own key table to the readable path", () => {
    const md = ["| Handle | Source |", "|---|---|", `| S1 | \`${ui0}\` |`].join("\n");
    const out = renderCitationFootnotes(md, sources);
    expect(out).toContain("| S1 | `internal/ui` (module facts) |");
    expect(out).not.toContain("facts:repo");
  });

  it("decodes a bare repository id even when it was never admitted", () => {
    const unknown = factsSourceId("internal/worker", 7, repo);
    expect(renderCitationFootnotes(`Key: ${unknown}`, sources)).toBe("Key: `internal/worker`");
  });

  it("leaves fenced code untouched", () => {
    const md = ["```text", `[${storage0}]`, "```"].join("\n");
    expect(renderCitationFootnotes(md, sources)).toBe(md);
  });

  it("keeps an unmatched opening parenthesis and the text after it", () => {
    const out = renderCitationFootnotes(`See ([${ui0}] and more.`, sources);
    expect(out.split("\n")[0]).toBe("See ([^src-1] and more.");
  });

  it("returns markdown without markers unchanged (no definitions block)", () => {
    const md = "Plain [link](https://example.invalid) and [note][ref].";
    expect(renderCitationFootnotes(md, sources)).toBe(md);
  });

  it("leaves a bare id it cannot decode exactly as written", () => {
    const md = "Raw facts:repo:%E0%A4%A:0 and facts:symbol:x:y:notarange here.";
    expect(renderCitationFootnotes(md, sources)).toBe(md);
  });

  it("collapses a one-line symbol range to file:line", () => {
    const one = symbolId.replace(":123-150", ":42-42");
    const out = renderCitationFootnotes(`Bare ${one}`, sources);
    expect(out).toBe("Bare `internal/model/feed.go:42`");
  });

  it("keeps an unmatched closing parenthesis that belongs to the prose", () => {
    const out = renderCitationFootnotes(`(see the UI [${ui0}])`, sources);
    expect(out.split("\n")[0]).toBe("(see the UI[^src-1])");
  });

  it("stays linear on a long run of separators after a marker (no ReDoS)", () => {
    const line = `x [${ui0}]${" ,".repeat(50_000)}y`;
    const started = performance.now();
    renderCitationFootnotes(line, sources);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it("resolves an unterminated marker at end of line", () => {
    const out = renderCitationFootnotes(`Truncated [${ui0}`, sources);
    expect(out.split("\n")[0]).toBe("Truncated[^src-1]");
  });
});

describe("rendered length (#995)", () => {
  const md = [
    `Storage owns SQL [${storage0}, ${ui0}].`,
    `The UI renders it ([${ui0}]) and validates feeds [${symbolId}].`,
    "```",
    `[${storage0}] stays as written in code`,
    "```",
    "Plain prose with no citation.",
  ].join("\n");
  const rendered = renderCitationFootnotes(md, sources);
  const definitions = citationDefinitionsLength(md, sources);

  it("measures the body as rendered, each reference at a four-digit number", () => {
    const body = rendered.length - definitions;
    // Four references render; each is counted three digits wider than "[^src-1]".
    expect(renderedCitationLength(md)).toBe(body + 4 * 3);
    expect(renderedCitationLength(md)).toBeLessThan(md.length / 2);
  });

  it("counts an id no source admits as a reference: it errs long, never short", () => {
    const unknown = "Invented [facts:nowhere:9].";
    expect(renderCitationFootnotes(unknown, sources)).toBe("Invented.");
    expect(renderedCitationLength(unknown)).toBe("Invented[^src-0000].".length);
  });

  it("leaves uncited markdown at its own length", () => {
    expect(renderedCitationLength("Plain.\n\n```\n[x]\n```")).toBe(
      "Plain.\n\n```\n[x]\n```".length,
    );
  });

  it("gives the length of the appended definitions, 0 when nothing is cited", () => {
    expect(rendered.slice(rendered.length - definitions)).toMatch(/^\n\n\[\^src-1\]: /);
    expect(rendered.slice(0, rendered.length - definitions)).not.toContain("]: ");
    expect(citationDefinitionsLength("No citations here.", sources)).toBe(0);
  });
});

describe("a module-facts citation pinned to the mined rule it restates (#737)", () => {
  /** A mined-rule line exactly as `minedRuleLine` (`fact-slices.ts`) writes it. */
  const rule = (kind: string, expr: string, summary: string, at: string): string =>
    `- [go ${kind}] \`${expr}\` — ${summary} (${at})`;
  const header = (n: number): string =>
    `MINED_RULES (deterministically mined from source — ${n} rule(s); each cites file:line)`;

  // The module facts as a Rules section reads them: the LLM bullets, then the
  // deterministic mined-rule inventory.
  const storageFacts: GroundingSource = {
    sourceId: storage0,
    kind: "facts",
    label: "storage",
    text: [
      "### MODULE: storage",
      "(12 classes, 80 methods)",
      "- Feeds are stored per user; see internal/storage/feed.go:12 for the schema.",
      header(3),
      rule(
        "limit",
        "if limit > 1000 { limit = 1000 }",
        "at most 1000 entries per request",
        "internal/storage/entry_query_builder.go:42",
      ),
      rule(
        "retention",
        "cleanupRemovedEntriesDays = 60",
        "removed entries are purged after 60 days",
        "internal/storage/entry.go:310",
      ),
      rule(
        "uniqueness",
        "feeds_user_id_feed_url_key",
        "one subscription per feed URL per user",
        "internal/storage/feed.go:88",
      ),
    ].join("\n"),
  };
  const pinSources: GroundingSource[] = [storageFacts, facts(ui0, "ui")];
  const pinsOf = (markdown: string, ss: GroundingSource[] = pinSources): string[] =>
    (renderCitationFootnotes(markdown, ss).match(/^\[\^src-\d+\]: .*$/gm) ?? []).map((d) =>
      d.replace(/^\[\^src-\d+\]: /, ""),
    );

  it("reads the mined rules' locators, each with its line's words less the locator", () => {
    const locators = sourceLineLocators(storageFacts.text, "internal/storage");
    expect(locators.map((l) => l.locator)).toEqual([
      "internal/storage/entry_query_builder.go:42",
      "internal/storage/entry.go:310",
      "internal/storage/feed.go:88",
    ]);
    // The path's words are not the rule's words.
    expect(locators[1].words.has("internal")).toBe(false);
    expect(locators[1].words.has("storag")).toBe(false);
  });

  it("never reads a locator from an LLM-written bullet, only from mined-rule lines", () => {
    const locators = sourceLineLocators(storageFacts.text, "internal/storage");
    expect(locators.map((l) => l.filePath)).not.toContain("internal/storage/feed.go:12");
    expect(locators.some((l) => l.startLine === 12)).toBe(false);
    // A rule-shaped line outside a MINED_RULES block is an LLM bullet too.
    const outside = rule(
      "limit",
      "x",
      "at most 1000 entries per request",
      "internal/storage/a.go:1",
    );
    expect(sourceLineLocators(outside, "internal/storage")).toEqual([]);
  });

  it("never reads a host and port, or a file outside the cited module, as a locator", () => {
    const text = [
      header(3),
      rule("config", "addr", "the cache lives at a fixed host", "redis.example.com:6379"),
      rule("config", "dsn", "the database host", "host.docker.internal:5432"),
      rule("limit", "n > 5", "five retries are allowed", "internal/worker/retry.go:9"),
    ].join("\n");
    expect(sourceLineLocators(text, "internal/storage")).toEqual([]);
    // Without a module path (a legacy id) the file still has to be a source file.
    expect(sourceLineLocators(text, null).map((l) => l.locator)).toEqual([
      "internal/worker/retry.go:9",
    ]);
  });

  it("pins a citation to the mined rule its sentence restates", () => {
    const out = renderCitationFootnotes(
      `A request returns at most 1,000 entries [${storage0}].`,
      pinSources,
    );
    expect(out).toBe(
      "A request returns at most 1,000 entries[^src-1].\n\n" +
        "[^src-1]: `internal/storage/entry_query_builder.go:42` — `internal/storage` (module facts)",
    );
  });

  it("gives two statements citing one module the rules each one restates", () => {
    expect(
      pinsOf(
        [
          `A request returns at most 1,000 entries [${storage0}].`,
          `Removed entries are purged after 60 days [${storage0}].`,
          `Each user subscribes to a feed URL once [${storage0}].`,
        ].join("\n"),
      ),
    ).toEqual([
      "`internal/storage/entry_query_builder.go:42` — `internal/storage` (module facts)",
      "`internal/storage/entry.go:310` — `internal/storage` (module facts)",
      "`internal/storage/feed.go:88` — `internal/storage` (module facts)",
    ]);
  });

  it("reuses one footnote for two statements pinned to the same rule", () => {
    const md = [
      `Removed entries are purged after 60 days [${storage0}].`,
      `After 60 days a removed entry is purged for good [${storage0}].`,
    ].join("\n");
    const out = renderCitationFootnotes(md, pinSources);
    expect(out.match(/^\[\^src-\d+\]:/gm)).toEqual(["[^src-1]:"]);
    expect(out).toContain("for good[^src-1].");
  });

  // Off-topic sentences that share the module's vocabulary (#1305 review).
  // Each was pinned, wrongly, before the review's fixes.
  it.each([
    // The module's own path words (`internal`, `storage`, `entry`) once scored.
    ["The internal storage package persists entries in PostgreSQL"],
    // One shared number and one shared word once pinned.
    ["API keys are rotated every 60 days"],
    ["Sessions expire after 60 days of inactivity"],
    ["Storage is a layer of its own"],
  ])("keeps the module footnote for an off-topic sentence: %s", (sentence) => {
    expect(pinsOf(`${sentence} [${storage0}].`)).toEqual(["`internal/storage` (module facts)"]);
  });

  it("does not count a rule's path words: a sentence naming only its file stays unpinned", () => {
    // Read with the path, `cleanup` and `job` would pin this to cleanup_job.go.
    const source: GroundingSource = {
      ...storageFacts,
      text: [
        header(2),
        rule(
          "retention",
          "days = 60",
          "removed entries are purged after 60 days",
          "internal/storage/cleanup_job.go:5",
        ),
        rule("limit", "n > 9", "a feed keeps nine icons", "internal/storage/icon.go:7"),
      ].join("\n"),
    };
    expect(pinsOf(`A cleanup job runs nightly [${storage0}].`, [source])).toEqual([
      "`internal/storage` (module facts)",
    ]);
  });

  it("treats a tie between two rules as ambiguous and keeps the module footnote", () => {
    const source: GroundingSource = {
      ...storageFacts,
      text: [
        header(2),
        rule("retention", "a", "removed entries are purged", "internal/storage/a.go:1"),
        rule("retention", "b", "removed entries are purged", "internal/storage/b.go:2"),
      ].join("\n"),
    };
    expect(pinsOf(`Removed entries are purged [${storage0}].`, [source])).toEqual([
      "`internal/storage` (module facts)",
    ]);
  });

  it("lets a shared number decide between two rules the sentence matches equally in words", () => {
    const source: GroundingSource = {
      ...storageFacts,
      text: [
        header(2),
        rule("retention", "a", "removed entries are kept 30 days", "internal/storage/a.go:1"),
        rule(
          "retention",
          "b",
          "removed entries are purged after 60 days",
          "internal/storage/b.go:2",
        ),
      ].join("\n"),
    };
    // Words: removed, entries, kept, days against a.go (4) and removed,
    // entries, days against b.go (3); the shared 60 makes b.go 3 + 2 = 5.
    expect(pinsOf(`Removed entries are kept for 60 days [${storage0}].`, [source])).toEqual([
      "`internal/storage/b.go:2` — `internal/storage` (module facts)",
    ]);
  });

  it("reads only the sentence the marker ends, not the one before it", () => {
    expect(
      pinsOf(
        `Removed entries are purged after 60 days. Storage is a layer of its own [${storage0}].`,
      ),
    ).toEqual(["`internal/storage` (module facts)"]);
  });

  it.each([
    // The cluster takes one leading space with it; a second one is left behind.
    [`Removed entries are purged after 60 days.  [${storage0}]`],
    // A marker in a table cell of its own cites the cell before it.
    [`| Removed entries are purged after 60 days |[${storage0}]|`],
  ])("reads the sentence a marker FOLLOWS when nothing stands between: %s", (md) => {
    expect(pinsOf(md)).toEqual([
      "`internal/storage/entry.go:310` — `internal/storage` (module facts)",
    ]);
  });

  it("matches a sentence to a rule through their inflections (stemming)", () => {
    // Not one of these words is spelt as in the rule except `days`.
    expect(pinsOf(`Purging removes each entry after sixty days [${storage0}].`)).toEqual([
      "`internal/storage/entry.go:310` — `internal/storage` (module facts)",
    ]);
  });

  it("does not read a mined-rule line longer than any the miner writes", () => {
    const long = rule(
      "retention",
      "x",
      `removed entries are purged after 60 days ${"padding ".repeat(150)}`,
      "internal/storage/entry.go:310",
    );
    expect(long.length).toBeGreaterThan(1_200);
    expect(sourceLineLocators([header(1), long].join("\n"), "internal/storage")).toEqual([]);
  });

  it("reads only the first text of a legacy id, which two modules can share", () => {
    // `a/b` and `a_b` both sanitise to `a_b` (`factsSourceId`'s collision caveat).
    const legacy = factsSourceId("a/b", 0);
    expect(factsSourceId("a_b", 0)).toBe(legacy);
    const first: GroundingSource = {
      sourceId: legacy,
      kind: "facts",
      label: "b",
      text: "### MODULE: b",
    };
    const other: GroundingSource = {
      ...first,
      label: "a_b",
      text: [
        header(1),
        rule("retention", "x", "removed entries are purged after 60 days", "a_b/entry.go:3"),
      ].join("\n"),
    };
    expect(pinsOf(`Removed entries are purged after 60 days [${legacy}].`, [first, other])).toEqual(
      ["`b` (module facts)"],
    );
  });

  it("reads one table cell, not the whole row", () => {
    const md = [
      "| Rule | Detail |",
      "|---|---|",
      `| Retention | Removed entries are purged after 60 days [${storage0}] |`,
      `| Removed entries purged after 60 days | Storage is a layer of its own [${storage0}] |`,
    ].join("\n");
    const out = renderCitationFootnotes(md, pinSources);
    expect(out).toContain("[^src-1]: `internal/storage/entry.go:310`");
    // The second row's first cell restates line 310; its citing cell does not.
    expect(out).toContain("its own[^src-2] |");
    expect(out).toContain("[^src-2]: `internal/storage` (module facts)");
  });

  it("does not read the ids of earlier markers as words of the sentence", () => {
    // An id is the model's to write: read as prose, this one restates line 310.
    expect(
      pinsOf(`Layers [rag:removed-entries-purged-60-days:c1] then storage [${storage0}].`),
    ).toEqual(["`internal/storage` (module facts)"]);
  });

  it("returns the cited lines per source for the provenance manifest", () => {
    const { markdown, citedLines } = renderCitationFootnotesWithLocations(
      [
        `A request returns at most 1,000 entries [${storage0}].`,
        `Each user subscribes to a feed URL once [${storage0}].`,
        `The UI renders it [${ui0}].`,
        `Validated [${symbolId}].`,
      ].join("\n"),
      [...pinSources, sources[3]],
    );
    expect(markdown).toContain("[^src-1]");
    expect(citedLines.get(storage0)).toEqual([
      {
        filePath: "internal/storage/entry_query_builder.go",
        startLine: 42,
        endLine: 42,
      },
      { filePath: "internal/storage/feed.go", startLine: 88, endLine: 88 },
    ]);
    expect(citedLines.get(symbolId)).toEqual([
      { filePath: "internal/model/feed.go", startLine: 123, endLine: 150 },
    ]);
    // A module footnote with no line carries nothing to record.
    expect(citedLines.has(ui0)).toBe(false);
  });

  it("reads the mined rules of every section's slice of a module, not only the first", () => {
    // The Overview's slice of `storage` (no mined rules) is admitted first;
    // the Rules section's slice of the same id carries them.
    const overviewSlice: GroundingSource = { ...storageFacts, text: "### MODULE: storage" };
    expect(
      pinsOf(`Removed entries are purged after 60 days [${storage0}].`, [
        overviewSlice,
        storageFacts,
      ]),
    ).toEqual(["`internal/storage/entry.go:310` — `internal/storage` (module facts)"]);
  });

  it("never pins a retrieved excerpt", () => {
    const rag: GroundingSource = {
      ...sources[4],
      text: [header(1), storageFacts.text.split("\n").at(-2)].join("\n"),
    };
    expect(pinsOf(`Removed entries are purged after 60 days [rag:doc1:chunk2].`, [rag])).toEqual([
      "`README.md` (retrieved excerpt)",
    ]);
  });

  it("stays linear on hostile facts text (no ReDoS)", () => {
    const hostile: GroundingSource = {
      ...storageFacts,
      text: [
        header(1),
        `- [go x] ${" (".repeat(590)}`,
        `- [go x] ${"a".repeat(700)} (${"b".repeat(399)}:1`,
        `${"a".repeat(100_000)} ${"a.".repeat(50_000)}x ${"/a".repeat(50_000)}.go`,
      ].join("\n"),
    };
    const started = performance.now();
    renderCitationFootnotes(`Some words here and there [${storage0}].`, [hostile]);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it("stays linear on one long line with many markers (#1305 review)", () => {
    const line = `${`Removed entries are purged after 60 days [${storage0}] `.repeat(12_000)}.`;
    const started = performance.now();
    renderCitationFootnotes(line, pinSources);
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});
describe("pinning against the miners' real output (#1305 review)", () => {
  // Rule lines exactly as Phase 1 renders them: the real miners on small
  // snippets, through `toPersistedMinedRules` and `renderMinedRuleInventory`.
  const authRules = [
    ...toPersistedMinedRules(
      "ts",
      mineTsRules(
        [
          "export const MAX_LOGIN_ATTEMPTS = 5;",
          "type Status = 'open' | 'closed';",
          "function f(x: number) {",
          "  if (x > 100) throw new Error('Too many items in one order');",
          "  if (!user) return;",
          "}",
        ].join("\n"),
        "src/auth/login.ts",
        1,
      ),
    ),
    ...toPersistedMinedRules(
      "sql",
      mineSqlRules(
        [
          "CREATE TABLE api_keys (",
          "  id SERIAL PRIMARY KEY,",
          "  owner_id INTEGER NOT NULL REFERENCES users(id),",
          "  token TEXT UNIQUE,",
          "  rotated_days INTEGER DEFAULT 90 CHECK (rotated_days > 0)",
          ");",
        ].join("\n"),
        "src/auth/schema.sql",
        1,
      ),
    ),
    ...toPersistedMinedRules(
      "go",
      mineGoRules(
        [
          "package auth",
          'var ErrLocked = errors.New("account locked after failed logins")',
          "func Check(n int) error {",
          "  if n > 5 {",
          "    return ErrLocked",
          "  }",
          "  return nil",
          "}",
        ].join("\n"),
        "src/auth/check.go",
        1,
      ),
    ),
    ...toPersistedMinedRules(
      "java",
      mineJavaRules(
        [
          "class User {",
          "  @NotNull @Email private String email;",
          "  @Size(min = 8, max = 64) private String password;",
          "  void lock(int attempts) {",
          "    Objects.requireNonNull(name);",
          '    if (attempts > 5) throw new IllegalStateException("locked");',
          "  }",
          "}",
        ].join("\n"),
        "src/auth/User.java",
        1,
      ),
    ),
    ...toPersistedMinedRules(
      "py",
      minePyRules(
        [
          "def lock(attempts):",
          "    assert attempts >= 0, 'attempts cannot be negative'",
          "    if attempts > 5:",
          "        raise ValueError('account locked')",
        ].join("\n"),
        "src/auth/lock.py",
        1,
      ),
    ),
  ];
  const authId = factsSourceId("src/auth", 0, repo);
  const auth: GroundingSource = {
    sourceId: authId,
    kind: "facts",
    label: "auth",
    text: ["### MODULE: auth", renderMinedRuleInventory(authRules)].join("\n"),
  };
  const pin = (sentence: string): string[] =>
    (
      renderCitationFootnotes(`${sentence} [${authId}].`, [auth]).match(/^\[\^src-\d+\]: .*$/gm) ??
      []
    ).map((d) => d.replace(/^\[\^src-\d+\]: /, ""));
  const MODULE = "`src/auth` (module facts)";

  it("covers every kind the snippets yield, one locator per rendered rule", () => {
    expect(new Set(authRules.map((r) => `${r.language} ${r.kind}`))).toEqual(
      new Set([
        "ts const",
        "ts union",
        "ts throw",
        "ts guard",
        "sql primary-key",
        "sql foreign-key",
        "sql not-null",
        "sql unique",
        "sql check",
        "sql default",
        "go error",
        "go guard",
        "java annotation-validation",
        "java precondition",
        "java throw",
        "py assert",
        "py guard",
        "py raise",
      ]),
    );
    expect(sourceLineLocators(auth.text, "src/auth")).toHaveLength(authRules.length);
  });

  it.each([
    // The review's two: the template's `primary key` and `Constant` pinned them.
    ["API keys are the primary key to every integration"],
    ["A constant max is applied"],
    // Template wording and kind names alone, which every rule of a kind shares.
    ["Rejects when the field is required"],
    ["Allowed values for the default range"],
    ["Throws an error and raises a precondition"],
    ["A mandatory field is unique and referential"],
    ["Asserts that the value rule and constraints hold"],
  ])("keeps the module footnote for template wording: %s", (sentence) => {
    expect(pin(sentence)).toEqual([MODULE]);
  });

  it.each([
    ["Users get at most 5 login attempts", "src/auth/login.ts:1"],
    ["The account is locked after failed logins", "src/auth/check.go:2"],
    ["Every API key belongs to an owner who is a registered user", "src/auth/schema.sql:3"],
  ])("pins a sentence restating a rule's own text: %s", (sentence, at) => {
    expect(pin(sentence)).toEqual([`\`${at}\` — \`src/auth\` (module facts)`]);
  });
});
