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
      "an unquoted PascalCase call name (#1226 review)",
      "When ShouldMarkAsReadOnView is true, viewing an entry marks it read.",
      { kind: "pascal-case", text: "ShouldMarkAsReadOnView" },
    ],
    [
      "an unquoted PascalCase constant",
      "Viewing an entry flips EntryStatusUnread to read.",
      { kind: "pascal-case", text: "EntryStatusUnread" },
    ],
    [
      "an unquoted three-hump PascalCase name",
      "A request is capped at MaxEntryLimit articles.",
      { kind: "pascal-case", text: "MaxEntryLimit" },
    ],
    [
      "an unquoted endpoint",
      "Readers call GET /v1/entries to list articles.",
      { kind: "endpoint", text: "GET /v1/entries" },
    ],
    [
      "an unquoted endpoint with a parameter, before a comma",
      "Then DELETE /v1/feeds/{id}, and the feed is gone.",
      { kind: "endpoint", text: "DELETE /v1/feeds/{id}" },
    ],
    [
      "a backticked path without an extension",
      "Requests go to `api/v1/entries` first.",
      { kind: "inline-code", text: "api/v1/entries" },
    ],
    [
      "a backticked dotted name",
      "The `feeds.disabled` flag hides it.",
      { kind: "inline-code", text: "feeds.disabled" },
    ],
    // #1231 (PR #1267 review): source code under a host-like directory is code.
    [
      "a .NET project path (#1231 review)",
      "The rule is in Contoso.Web/Controllers/UserController.cs today.",
      { kind: "file-path", text: "Contoso.Web/Controllers/UserController.cs" },
    ],
    [
      "a path in a package named like a product (#1231 review)",
      "It is drawn by chart.js/src/core.ts on load.",
      { kind: "file-path", text: "chart.js/src/core.ts" },
    ],
    [
      "a Go import path to a source file (#1231 review)",
      "Feeds are parsed in github.com/miniflux/v2/internal/reader.go first.",
      { kind: "file-path", text: "github.com/miniflux/v2/internal/reader.go" },
    ],
    [
      "a backticked resource and id (#1231 review)",
      "Each user lives at `users/42` in the store.",
      { kind: "inline-code", text: "users/42" },
    ],
    [
      "a backticked longer resource id (#1231 review)",
      "Open `orders/1234` to see it.",
      { kind: "inline-code", text: "orders/1234" },
    ],
    [
      "a backticked flag set to a value (#1231 review)",
      "Set `v2: true` to opt in.",
      { kind: "inline-code", text: "v2: true" },
    ],
    [
      "a backticked typed value (#1231 review)",
      "The field is `int32: 5` by default.",
      { kind: "inline-code", text: "int32: 5" },
    ],
    [
      "a backticked host and port (#1231 review)",
      "It listens on `127.0.0.1:8080` locally.",
      { kind: "inline-code", text: "127.0.0.1:8080" },
    ],
    // #1231: the false-flag fixes keep these.
    [
      "a backticked path of one slash with a version (#1231)",
      "Requests go to `api/v1` first.",
      { kind: "inline-code", text: "api/v1" },
    ],
    [
      "a backticked root path (#1231)",
      "Requests go to `/entries` first.",
      { kind: "inline-code", text: "/entries" },
    ],
    [
      "an endpoint whose path is one character (#1231)",
      "Readers call GET /x to list articles.",
      { kind: "endpoint", text: "GET /x" },
    ],
    [
      "a path in a dot directory (#1231)",
      "The workflow lives in .github/workflows/ci.yml today.",
      { kind: "file-path", text: ".github/workflows/ci.yml" },
    ],
    [
      "a backticked name: value pair whose value is a time (#1231)",
      "The schedule says `runAt: 9:00` each day.",
      { kind: "inline-code", text: "runAt: 9:00" },
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
    [
      "abbreviations, versions and file names (#1226 review)",
      "At 9 a.m., e.g. daily, i.e. once; Node.js 18, PostgreSQL 14.2, version 2.3.3, see README.md.",
    ],
    [
      "lower camel case brands",
      "On iPhone, iPadOS, macOS, eBay or YouTube, hosted at miniflux.app.",
    ],
    [
      "two-hump PascalCase brands",
      "Export to PowerPoint, SharePoint, LinkedIn or PayPal; written in JavaScript or TypeScript on GitHub.",
    ],
    ["a plural and a slash label in prose", "Feed(s) can be read/unread (e.g. title or author)."],
    ["a slash label in backticks", "The status is `read/unread`, or `Yes/No`."],
    ["a two-hump PascalCase word", "The EntryStatus is shown."],
    // Kept on purpose (see SETTING_NAME_RE): a constant in a setting's shape passes.
    ["a constant in a setting's shape", "Set to `ENTRY_STATUS_UNREAD` or ENTRY_STATUS_READ."],
    // Known blind spot (module doc): unquoted, a dotted name reads as a domain.
    ["an unquoted dotted name", "The feeds.disabled flag hides it."],
    // #1231: false flags the #1226 re-review found.
    [
      "two HTTP methods named together (#1231)",
      "It accepts GET / POST requests and HEAD / OPTIONS.",
    ],
    [
      "brand names of three or more humps (#1231)",
      "Import meals from MyFitnessPal, show places on OpenStreetMap, search with DuckDuckGo.",
    ],
    [
      "a number label with a slash, in backticks (#1231)",
      "Support is `24/7`, or `9/5` on weekdays.",
    ],
    [
      "a label with spaces or hyphens and a slash, in backticks (#1231)",
      "Choose `Opt in/Opt out`, `read-only/read-write` or `Page 1/10`.",
    ],
    [
      "a time of day in backticks (#1231)",
      "The digest goes out at `9:00`, `17:30` or `9:00 am` each day.",
    ],
    [
      "a URL without a scheme (#1231)",
      "See example.com/docs/setup.html, www.miniflux.app/app.js or docs.github.com/en/start.md.",
    ],
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

// #1223, from the 2026-10-22 DeepSeek reader-BRD re-run: the check reported
// 0 in every section while Key Business Rules named the session cookie
// constant. A run of capitals was not a hump, so a name ending (or starting)
// in an acronym had too few humps to count.
describe("findCodeIdentifiers — acronym runs are humps (#1223)", () => {
  it("flags the live run's line: 3. **MinifluxSessionID** …", () => {
    const markdown = [
      "### Accounts",
      "",
      "1. A reader signs in with a username and password.",
      "2. An administrator can disable an account.",
      "3. **MinifluxSessionID** …",
    ].join("\n");
    expect(hits(markdown)).toEqual([{ kind: "pascal-case", text: "MinifluxSessionID" }]);
    expect(codeIdentifierReport(markdown)).toEqual({
      count: 1,
      examples: [{ kind: "pascal-case", text: "MinifluxSessionID" }],
    });
  });

  it.each<[string, string, CodeIdentifierHit]>([
    [
      "a name ending in an acronym",
      "The cookie MinifluxSessionID is cleared.",
      { kind: "pascal-case", text: "MinifluxSessionID" },
    ],
    [
      "a name ending in a plural acronym",
      "Each of the MinifluxSessionIDs is cleared.",
      { kind: "pascal-case", text: "MinifluxSessionIDs" },
    ],
    [
      "a name starting with an acronym",
      "It is fetched with XMLHttpRequest.",
      { kind: "pascal-case", text: "XMLHttpRequest" },
    ],
    [
      "an acronym and one word",
      "Requests go through the HTTPServer.",
      { kind: "pascal-case", text: "HTTPServer" },
    ],
    [
      "an acronym inside a name",
      "It reads the FeedURLList.",
      { kind: "pascal-case", text: "FeedURLList" },
    ],
    [
      "lower camel case ending in an acronym",
      "The link is checked by parseURL first.",
      { kind: "camel-case", text: "parseURL" },
    ],
    [
      "a name in __bold__",
      "3. __MinifluxSessionID__ is cleared.",
      { kind: "pascal-case", text: "MinifluxSessionID" },
    ],
    [
      "a name in _italics_",
      "The link is checked by _parseURL_ first.",
      { kind: "camel-case", text: "parseURL" },
    ],
    [
      "a snake_case name in __bold__",
      "The __feed_id__ is kept.",
      { kind: "snake-case", text: "feed_id" },
    ],
    [
      "a name in ***bold italics***",
      "***EntryStatusUnread*** is the default.",
      { kind: "pascal-case", text: "EntryStatusUnread" },
    ],
  ])("flags %s", (_, markdown, expected) => {
    expect(hits(markdown)).toEqual([expected]);
  });

  it.each<[string, string]>([
    ["an all-caps format name", "Export your subscriptions as OPML."],
    ["a protocol with a version", "Served over HTTP/2 or HTTP/3."],
    ["an all-caps option a user picks", "Set the visibility to PUBLIC."],
    ["acronyms in prose", "Each RSS feed has a URL, an ID and an API key."],
    ["acronyms in bold", "**OPML**, **PUBLIC**, **RSS** and **URL**."],
    ["plural acronyms", "Upload PDFs, paste URLs, list IDs and APIs."],
    ["two-hump brands", "JavaScript, LinkTaco, YouTube and GitHub."],
    ["two-hump brands in bold", "Share to **LinkTaco** or **YouTube**."],
    [
      "two-hump brands ending in an acronym",
      "Stored in PostgreSQL, MySQL or NoSQL; queried by GraphQL.",
    ],
    ["brands with a lone capital", "Sign in with OAuth; an IoT device; a SaaS product; a PhD."],
    ["acronym brands", "Stored in SQLite; watch on HBOMax or YouTubeTV."],
    ["brands ending in OS", "On macOS, tvOS, watchOS or visionOS, and the phpBB forum."],
    ["ordinary capitalised words", "**Accounts**: Readers, Administrators and Feeds."],
    ["a two-hump name ending in an acronym", "Each SessionID is cleared."],
  ])("passes %s", (_, markdown) => {
    expect(hits(markdown)).toEqual([]);
  });

  it("reads a very long run of capitals and letters in linear time", () => {
    const started = performance.now();
    findCodeIdentifiers(`${"Ab".repeat(60_000)} ${"ABC".repeat(40_000)}_ ${"aB".repeat(60_000)}`);
    findCodeIdentifiers(`${"_a".repeat(60_000)} ${"__".repeat(60_000)}`);
    expect(performance.now() - started).toBeLessThan(1_000);
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

  it("never cuts an example inside a surrogate pair", () => {
    // 78 code units, then an emoji whose high surrogate is the 79th: a plain
    // `slice(0, 79)` would end on it.
    const long = `\`a_${"b".repeat(76)}\u{1F600}${"c".repeat(10)}\``;
    const [example] = codeIdentifierReport(long).examples;
    expect(example.text).toBe(`a_${"b".repeat(76)}…`);
    expect(example.text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  it("truncates a very long example", () => {
    const long = `a_${"b".repeat(300)}`;
    const [example] = codeIdentifierReport(long).examples;
    expect(example.text.length).toBeLessThanOrEqual(80);
    expect(example.text.endsWith("…")).toBe(true);
  });
});

describe("findCodeIdentifiers — linear time on hostile input (#1226 review)", () => {
  // Each case names the pre-#1226 pattern it guards (PR #1226's first commit,
  // aea490e5) and is a shape that pattern was quadratic on: 3.5-5.3 s here
  // against that commit's detector, a few milliseconds now. The bound leaves
  // two orders of magnitude for a contended machine (#1379), so it cannot
  // flake, and a return of the old pattern cannot pass it.
  //
  // #1231: no case for display math, PascalCase or an endpoint. `$$…$$` was
  // never quadratic (a later `$$` always closes an earlier one), and the
  // PascalCase and endpoint patterns did not exist before #1226, so a timing
  // case for them could not fail against anything that was ever written.
  it.each<[string, string, string]>([
    ["link-target openers", String.raw`/(?<=\])\([^)\n]*\)/g`, "](".repeat(80_000)],
    ["footnote openers", String.raw`/\[\^[^\]\n]+\]/g`, "[^".repeat(80_000)],
    ["footnote openers with text", String.raw`/\[\^[^\]\n]+\]/g`, "[^a".repeat(55_000)],
    ["unclosed HTML comments", String.raw`/<!--[\s\S]*?-->/g`, "<!--".repeat(120_000)],
  ])("%s (guards %s)", (_, _guards, markdown) => {
    const started = performance.now();
    findCodeIdentifiers(markdown);
    expect(performance.now() - started).toBeLessThan(1_000);
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

  it("keeps a Mermaid diagram the section asks for, despite the no-code-blocks rule", () => {
    expect(MAIN_PART_LANGUAGE_RULES).toContain(
      "The one exception is a Mermaid diagram this section asks for: draw it as asked",
    );
    expect(MAIN_PART_LANGUAGE_RULES).toContain("they do not withdraw a diagram");
  });

  it("overrides the system prompt's verbatim-names rule", () => {
    expect(MAIN_PART_LANGUAGE_RULES).toMatch(/override/i);
  });
});
