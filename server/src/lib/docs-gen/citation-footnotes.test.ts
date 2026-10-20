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

describe("a module-facts citation pinned to the file:line it describes (#737)", () => {
  // The module facts as the section read them: the LLM bullets and the mined
  // rules, each mined rule ending in the `file:line` it was mined from.
  const storageFacts: GroundingSource = {
    sourceId: storage0,
    kind: "facts",
    label: "storage",
    text: [
      "### MODULE: storage",
      "(12 classes, 80 methods)",
      "- Feeds are stored per user; a user cannot subscribe to the same feed URL twice.",
      "MINED_RULES (deterministically mined from source — 3 rule(s); each cites file:line)",
      "- [go limit] `if limit > 1000 { limit = 1000 }` — at most 1000 entries per request (internal/storage/entry_query_builder.go:42)",
      "- [go retention] `cleanupRemovedEntriesDays = 60` — removed entries are purged after 60 days (internal/storage/entry.go:310)",
      "- [go uniqueness] `feeds_user_id_feed_url_key` — one subscription per feed URL per user (internal/storage/feed.go:88-97)",
    ].join("\n"),
  };
  const pinSources: GroundingSource[] = [storageFacts, facts(ui0, "ui")];

  it("reads every file:line and file:start-end locator in a source's text", () => {
    expect(sourceLineLocators(storageFacts.text).map((l) => l.locator)).toEqual([
      "internal/storage/entry_query_builder.go:42",
      "internal/storage/entry.go:310",
      "internal/storage/feed.go:88-97",
    ]);
  });

  it("pins a citation to the mined line its sentence restates", () => {
    const out = renderCitationFootnotes(
      `A request returns at most 1,000 entries [${storage0}].`,
      pinSources,
    );
    expect(out).toBe(
      "A request returns at most 1,000 entries[^src-1].\n\n" +
        "[^src-1]: `internal/storage/entry_query_builder.go:42` — `internal/storage` (module facts)",
    );
  });

  it("gives two statements citing one module the lines each one describes", () => {
    const md = [
      `A request returns at most 1,000 entries [${storage0}].`,
      `Removed entries are purged after 60 days [${storage0}].`,
      `Each user subscribes to a feed URL once [${storage0}].`,
    ].join("\n");
    const out = renderCitationFootnotes(md, pinSources);
    expect(out).toContain(
      "[^src-1]: `internal/storage/entry_query_builder.go:42` — `internal/storage` (module facts)",
    );
    expect(out).toContain(
      "[^src-2]: `internal/storage/entry.go:310` — `internal/storage` (module facts)",
    );
    expect(out).toContain(
      "[^src-3]: `internal/storage/feed.go:88-97` — `internal/storage` (module facts)",
    );
  });

  it("reuses one footnote for two statements pinned to the same line", () => {
    const md = [
      `Removed entries are purged after 60 days [${storage0}].`,
      `After 60 days a removed entry is purged for good [${storage0}].`,
    ].join("\n");
    const out = renderCitationFootnotes(md, pinSources);
    expect(out.match(/^\[\^src-\d+\]:/gm)).toEqual(["[^src-1]:"]);
    expect(out).toContain("for good[^src-1].");
  });

  it("keeps the module footnote when the sentence matches no line well enough", () => {
    const out = renderCitationFootnotes(`Storage is a layer of its own [${storage0}].`, pinSources);
    expect(out).toContain("[^src-1]: `internal/storage` (module facts)");
  });

  it("reads only the sentence the marker ends, not the one before it", () => {
    const out = renderCitationFootnotes(
      `Removed entries are purged after 60 days. Storage is a layer of its own [${storage0}].`,
      pinSources,
    );
    expect(out).toContain("[^src-1]: `internal/storage` (module facts)");
  });

  it("reads the sentence a marker FOLLOWS when it stands after the full stop", () => {
    const out = renderCitationFootnotes(
      `Removed entries are purged after 60 days. [${storage0}]`,
      pinSources,
    );
    expect(out).toContain("[^src-1]: `internal/storage/entry.go:310`");
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
    const out = renderCitationFootnotes(
      `Layers [rag:purged-after-60-days:c1] then storage [${storage0}].`,
      pinSources,
    );
    expect(out).toContain("`internal/storage` (module facts)");
    expect(out).not.toContain(".go:");
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
      { filePath: "internal/storage/entry_query_builder.go", startLine: 42, endLine: 42 },
      { filePath: "internal/storage/feed.go", startLine: 88, endLine: 97 },
    ]);
    expect(citedLines.get(symbolId)).toEqual([
      { filePath: "internal/model/feed.go", startLine: 123, endLine: 150 },
    ]);
    // A module footnote with no line carries nothing to record.
    expect(citedLines.has(ui0)).toBe(false);
  });

  it("never pins a canonical fact, a typed symbol or a retrieved excerpt", () => {
    const rag: GroundingSource = {
      ...sources[4],
      text: "purged after 60 days (internal/storage/entry.go:310)",
    };
    const out = renderCitationFootnotes(
      `Removed entries are purged after 60 days [rag:doc1:chunk2].`,
      [rag],
    );
    expect(out).toContain("[^src-1]: `README.md` (retrieved excerpt)");
  });

  it("stays linear on a long word-character run in the facts text (no ReDoS)", () => {
    const hostile: GroundingSource = {
      ...storageFacts,
      text: `${"a".repeat(100_000)} ${"a.".repeat(50_000)}x ${"/a".repeat(50_000)}.go`,
    };
    const started = performance.now();
    renderCitationFootnotes(`Some words here and there [${storage0}].`, [hostile]);
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});
