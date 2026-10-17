/**
 * #1223 — the business-language rule for the main part of a reader-layout BRD,
 * and the deterministic check that flags code identifiers in it. Pure: no
 * model, no database.
 *
 * The true positives are the shapes the #1074 comparison quoted from both
 * models' main parts; the true negatives are business prose that must stay
 * unflagged (brand names, acronyms, hyphenated words, settings an
 * administrator changes, statuses a user sees, and citations, which stay as
 * footnotes).
 */
import { describe, expect, it } from "vitest";
import { APPENDIX_DIVIDER, REQUIREMENTS_LEAD_IN } from "./brd-layout.js";
import {
  CODE_IDENTIFIER_EXAMPLES_MAX,
  codeIdentifierReport,
  findCodeIdentifiers,
  MAIN_PART_LANGUAGE_RULES,
  type CodeIdentifierHit,
} from "./main-part-language.js";

const hits = (markdown: string): CodeIdentifierHit[] => findCodeIdentifiers(markdown);
const texts = (markdown: string): string[] => hits(markdown).map((h) => h.text);

describe("findCodeIdentifiers — what it flags", () => {
  it.each<[string, string, CodeIdentifierHit]>([
    [
      "a backticked call (DeepSeek, #1074)",
      "When `ShouldMarkAsReadOnView(user)` is true, viewing an entry marks it read.",
      { kind: "inline-code", text: "ShouldMarkAsReadOnView(user)" },
    ],
    [
      "a backticked Go constant",
      "Viewing an entry flips `EntryStatusUnread` to read.",
      { kind: "inline-code", text: "EntryStatusUnread" },
    ],
    [
      "a backticked HTTP header (Sonnet, #1074)",
      "Then the response carries `Access-Control-Max-Age: 3600`.",
      { kind: "inline-code", text: "Access-Control-Max-Age: 3600" },
    ],
    [
      "a backticked SQL clause",
      "Old entries are deleted with `FOR UPDATE SKIP LOCKED`.",
      { kind: "inline-code", text: "FOR UPDATE SKIP LOCKED" },
    ],
    [
      "a backticked endpoint",
      "Readers call `GET /v1/entries` to list articles.",
      { kind: "inline-code", text: "GET /v1/entries" },
    ],
    [
      "a backticked snake_case column",
      "The `feed_id` of each entry is kept.",
      { kind: "inline-code", text: "feed_id" },
    ],
    [
      "a file path",
      "The rule lives in server/src/lib/x.ts and nowhere else.",
      { kind: "file-path", text: "server/src/lib/x.ts" },
    ],
    [
      "a file with a line range",
      "The code is generated in crypto.go:39-40 as hex.",
      { kind: "file-path", text: "crypto.go:39-40" },
    ],
    [
      "a bare source file",
      "Settings are read from config.yaml at start-up.",
      { kind: "file-path", text: "config.yaml" },
    ],
    [
      "a path to a JavaScript file",
      "The script ui/lib/app.js renders the list.",
      { kind: "file-path", text: "ui/lib/app.js" },
    ],
    [
      "a snake_case column in prose",
      "Each entry records its published_at time.",
      { kind: "snake-case", text: "published_at" },
    ],
    [
      "a camelCase name in prose",
      "The markAsRead flag decides it.",
      { kind: "camel-case", text: "markAsRead" },
    ],
    [
      "a PascalCase call in prose",
      "ArchiveEntries(status, days) deletes entries oldest-first.",
      { kind: "function-call", text: "ArchiveEntries(status, days)" },
    ],
    [
      "a dotted call in prose",
      "It calls store.Archive(days) every night.",
      { kind: "function-call", text: "store.Archive(days)" },
    ],
    [
      "an empty-argument call in prose",
      "Then refresh() runs again.",
      { kind: "function-call", text: "refresh()" },
    ],
    [
      "a SQL clause in prose",
      "Rows are taken FOR UPDATE SKIP LOCKED so two workers never share one.",
      { kind: "sql", text: "FOR UPDATE SKIP LOCKED" },
    ],
  ])("%s", (_, markdown, expected) => {
    expect(hits(markdown)).toEqual([expected]);
  });

  it("flags a code block, but not a Mermaid diagram", () => {
    const markdown = [
      "Readers subscribe to feeds.",
      "```go",
      "func Archive(days int) error { return nil }",
      "```",
      "```mermaid",
      "graph LR",
      "  reader_role[Reader] --> S[System]",
      "```",
    ].join("\n");
    expect(hits(markdown)).toEqual([{ kind: "code-block", text: "```go" }]);
  });

  it("flags an unterminated code block and reads nothing inside it", () => {
    expect(hits("Intro.\n\n```\nfoo_bar = baz()\n")).toEqual([{ kind: "code-block", text: "```" }]);
  });

  it("lists every occurrence, and the report counts a name once", () => {
    expect(texts("`feed_id` here, `feed_id` there, and feed_id again.")).toEqual([
      "feed_id",
      "feed_id",
      "feed_id",
    ]);
    expect(codeIdentifierReport("`feed_id` here, `feed_id` there.")).toEqual({
      count: 1,
      examples: [{ kind: "inline-code", text: "feed_id" }],
    });
  });

  it("reads double-backtick spans", () => {
    expect(hits("Uses ``user_id`` to look it up.")).toEqual([
      { kind: "inline-code", text: "user_id" },
    ]);
  });

  it("flags several kinds in one paragraph, in document order", () => {
    expect(
      hits(
        "In `internal/storage/entry.go` the published_at column is set by refreshFeed(id) via fetchAll.",
      ),
    ).toEqual([
      { kind: "inline-code", text: "internal/storage/entry.go" },
      { kind: "snake-case", text: "published_at" },
      { kind: "function-call", text: "refreshFeed(id)" },
      { kind: "camel-case", text: "fetchAll" },
    ]);
  });
});

describe("findCodeIdentifiers — what it passes", () => {
  it.each<[string, string]>([
    ["plain business prose", "A reader who opens an article sees it marked as read."],
    [
      "capitalised words and acronyms",
      "The RSS, Atom and JSON Feed formats; OPML import; HTTP and TLS.",
    ],
    ["hyphenated words", "Force-refresh is rate-limited; a read-only, opt-in, two-factor login."],
    ["requirement numbers", "### RC-3: Article retention\n\nSee RC-1 and RC-12."],
    [
      "brand names in PascalCase",
      "Save to Pocket, Wallabag, GitHub, YouTube, WordPress, PostgreSQL or DeepSeek.",
    ],
    [
      "brand names in lower camel case",
      "Works on iPhone, iPad, macOS, watchOS and eBay listings, with jQuery.",
    ],
    ["JavaScript product names", "Built with Node.js and Next.js; React/Next.js front ends."],
    ["a lower-case JavaScript product name", "It runs on node.js."],
    ["times of day", "Feeds refresh at 9 a.m. and again at 5 p.m. each day."],
    ["domains and versions", "Hosted at miniflux.app, version 2.3.3, see example.com."],
    ["a plural in parentheses", "The user(s) who subscribed and the feed(s) they follow."],
    ["an aside in parentheses", "Feeds are refreshed (every 60 minutes by default)."],
    [
      "an administrator's setting",
      "An administrator changes POLLING_FREQUENCY to refresh more often.",
    ],
    ["an administrator's setting in backticks", "Set `POLLING_FREQUENCY` to change it."],
    ["a status a user sees, in backticks", "The article becomes `unread` again, or `All`."],
    ["a number in backticks", "At most `1000` entries."],
    ["a plain phrase in backticks", "The page says `Shortened for length` at the end."],
    ["emphasis with underscores", "This is _important_ and __very__ so."],
    ["a lone parenthesis word", "Readers (and administrators) agree."],
    ["SQL words in ordinary prose", "Select a feed, update it, and order by date."],
  ])("%s", (_, markdown) => {
    expect(hits(markdown)).toEqual([]);
  });

  it("ignores citation markers, which stay as footnotes", () => {
    const markdown = [
      "Entries older than 60 days are removed [facts:repo%3A%5B%22c%22%2C%22g%22%2C%22internal%2Fstorage%2Fentry.go%22%5D:0].",
      "Shares use a random code [facts:symbol:repo%3A%5B%5D:GenerateRandomStringHex:39-40, rag:doc1:chunk2] (web:https://example.com/a_b.html).",
      "A bare id `facts:module:internal/storage/entry.go:0` the model copied.",
    ].join("\n");
    expect(hits(markdown)).toEqual([]);
  });

  it("ignores footnote references and definitions", () => {
    const markdown = [
      "Entries older than 60 days are removed.[^src-1] Shares are random.[^src-2]",
      "",
      "[^src-1]: internal/storage/entry.go",
      "[^src-2]: internal/crypto/crypto.go:39-40 (GenerateRandomStringHex)",
    ].join("\n");
    expect(hits(markdown)).toEqual([]);
  });

  it("ignores a relative link target", () => {
    expect(hits("See [the guide](docs/how_to.md).")).toEqual([]);
  });

  it("ignores a URL in prose, whatever its path", () => {
    expect(hits("Read https://x.io/how_to_use/readFeed for more.")).toEqual([]);
  });

  it("ignores footnote references the model named itself", () => {
    expect(hits("Entries expire.[^entry_store] Readers agree.[^readerRules]")).toEqual([]);
  });

  it("ignores link targets, autolinks and bare URLs, but reads link text", () => {
    expect(
      hits(
        "See [the guide](https://miniflux.app/docs/how_to.html) or <https://x.io/a_b.go> or https://x.io/src/main.go.",
      ),
    ).toEqual([]);
    expect(hits("See [refreshFeed](https://x.io).")).toEqual([
      { kind: "camel-case", text: "refreshFeed" },
    ]);
  });

  it("ignores HTML comments and display math", () => {
    expect(hits("<!-- section: feed_id -->\nPlain.\n$$\n\\text{max_items} = 100\n$$")).toEqual([]);
  });

  it("passes METIS's own lead-in and appendix divider", () => {
    expect(hits(`## Requirements\n\n${REQUIREMENTS_LEAD_IN}\n\n${APPENDIX_DIVIDER}`)).toEqual([]);
  });
});

describe("codeIdentifierReport", () => {
  it("is zero with no examples for business prose", () => {
    expect(codeIdentifierReport("A reader follows feeds.")).toEqual({ count: 0, examples: [] });
  });

  it("counts distinct identifiers and keeps the first few as examples, in order", () => {
    const names = Array.from({ length: CODE_IDENTIFIER_EXAMPLES_MAX + 3 }, (_, i) => `field_${i}`);
    const report = codeIdentifierReport(`${names.join(", ")}, field_0 again.`);
    expect(report.count).toBe(names.length);
    expect(report.examples).toHaveLength(CODE_IDENTIFIER_EXAMPLES_MAX);
    expect(report.examples[0]).toEqual({ kind: "snake-case", text: "field_0" });
    expect(report.examples.at(-1)).toEqual({
      kind: "snake-case",
      text: `field_${CODE_IDENTIFIER_EXAMPLES_MAX - 1}`,
    });
  });

  it("truncates a very long example", () => {
    const long = `a_${"b".repeat(300)}`;
    const [example] = codeIdentifierReport(long).examples;
    expect(example.text.length).toBeLessThanOrEqual(80);
    expect(example.text.endsWith("…")).toBe(true);
  });
});

describe("MAIN_PART_LANGUAGE_RULES", () => {
  it("asks for business language and sends code detail to the appendix", () => {
    for (const text of [
      "what the system does, for whom, and why",
      "file paths",
      "table or column names",
      "inline code",
      "appendix",
      "footnotes",
      "a setting an administrator changes",
      "a status or label a user sees",
    ]) {
      expect(MAIN_PART_LANGUAGE_RULES).toContain(text);
    }
  });

  it("overrides the system prompt's verbatim-names rule", () => {
    expect(MAIN_PART_LANGUAGE_RULES).toMatch(/override/i);
  });
});
