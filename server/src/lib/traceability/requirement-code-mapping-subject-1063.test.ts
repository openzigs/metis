/**
 * Issue #1063, reopened after #706 run 9 (journey 1, step `f-j1-2-2`). With the
 * two-shared-name-terms rule from PR #1095 in place, the Affected code panel
 * still linked, as DIRECT matches:
 *
 *   NR-2 "Last Successful refresh in feed API":
 *     `WebSession::LastForceRefresh` (confidence 1.00), `api_keys.last_used_at`,
 *     and the test function `TestRefreshFeedEndpoint`;
 *   NR-1 "Mark all as read older than X":
 *     `users.mark_read_on_view` and the form's `markReadBehavior`.
 *
 * Every row below is copied from the run-9 Miniflux code graph (project
 * `cmvagy3w…`): name, qualified name, file and kind are as ingested. The
 * "before" tests reproduce the five links with the rule #1095 shipped, so the
 * "after" tests are not passing against a corpus that never had the defect.
 */
import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import {
  ANALYSIS_LINK_MIN_SHARED_TERMS,
  ANALYSIS_LINK_SEARCH_OPTIONS,
  Bm25CodeSymbolSearcher,
  MemoizingBm25CodeSymbolSearcher,
  denoiseRequirementQuery,
  mapRequirementToCode,
  sharesRequirementSubject,
  singularTerm,
  symbolNameTerms,
  type Bm25SearcherOptions,
} from "./requirement-code-mapping.js";
import { tokenizeCode } from "../code-graph/hybrid-search.js";

const PROJECT = "proj-miniflux-run9";

/** [name, qualifiedName, filePath, kind] — as ingested in run 9. */
const RUN9: Array<[string, string, string, string]> = [
  ["MarkAllAsRead", "client/client.go::Client::MarkAllAsRead", "client/client.go", "function"],
  [
    "MarkCategoryAsRead",
    "client/client.go::Client::MarkCategoryAsRead",
    "client/client.go",
    "function",
  ],
  ["MarkFeedAsRead", "client/client.go::Client::MarkFeedAsRead", "client/client.go", "function"],
  ["RefreshFeed", "client/client.go::Client::RefreshFeed", "client/client.go", "function"],
  [
    "RefreshFeedContext",
    "client/client.go::Client::RefreshFeedContext",
    "client/client.go",
    "function",
  ],
  [
    "TestRefreshFeed",
    "client/client_test.go::TestRefreshFeed",
    "client/client_test.go",
    "function",
  ],
  [
    "TestRefreshFeedEndpoint",
    "internal/api/api_integration_test.go::TestRefreshFeedEndpoint",
    "internal/api/api_integration_test.go",
    "function",
  ],
  [
    "refreshFeedHandler",
    "internal/api/feed_handlers.go::handler::refreshFeedHandler",
    "internal/api/feed_handlers.go",
    "function",
  ],
  ["APIKey", "internal/model/api_key.go::APIKey", "internal/model/api_key.go", "class"],
  ["Feed", "internal/model/feed.go::Feed", "internal/model/feed.go", "class"],
  [
    "WebSession",
    "internal/model/web_session.go::WebSession",
    "internal/model/web_session.go",
    "class",
  ],
  [
    "LastForceRefresh",
    "internal/model/web_session.go::WebSession::LastForceRefresh",
    "internal/model/web_session.go",
    "function",
  ],
  [
    "RefreshFeed",
    "internal/reader/handler/handler.go::RefreshFeed",
    "internal/reader/handler/handler.go",
    "function",
  ],
  [
    "RefreshFeedEntries",
    "internal/storage/entry.go::Storage::RefreshFeedEntries",
    "internal/storage/entry.go",
    "function",
  ],
  [
    "MarkAllAsRead",
    "internal/storage/entry.go::Storage::MarkAllAsRead",
    "internal/storage/entry.go",
    "function",
  ],
  [
    "MarkAllAsReadBeforeDate",
    "internal/storage/entry.go::Storage::MarkAllAsReadBeforeDate",
    "internal/storage/entry.go",
    "function",
  ],
  [
    "markCategoryAsRead",
    "internal/ui/category_mark_as_read.go::handler::markCategoryAsRead",
    "internal/ui/category_mark_as_read.go",
    "function",
  ],
  [
    "markCategoryFeedAsRead",
    "internal/ui/category_mark_feed_as_read.go::handler::markCategoryFeedAsRead",
    "internal/ui/category_mark_feed_as_read.go",
    "function",
  ],
  [
    "markFeedAsRead",
    "internal/ui/feed_mark_as_read.go::handler::markFeedAsRead",
    "internal/ui/feed_mark_as_read.go",
    "function",
  ],
  ["feed_refresh.go", "internal/ui/feed_refresh.go", "internal/ui/feed_refresh.go", "module"],
  [
    "refreshFeed",
    "internal/ui/feed_refresh.go::handler::refreshFeed",
    "internal/ui/feed_refresh.go",
    "function",
  ],
  [
    "markReadBehavior",
    "internal/ui/form/settings.go::markReadBehavior",
    "internal/ui/form/settings.go",
    "type",
  ],
  [
    "markAllAsRead",
    "internal/ui/unread_mark_all_read.go::handler::markAllAsRead",
    "internal/ui/unread_mark_all_read.go",
    "function",
  ],
  ["entries", "entries", "internal/database/migrations.go", "table"],
  ["users", "users", "internal/database/migrations.go", "table"],
  ["api_keys", "api_keys", "internal/database/migrations.go", "table"],
  ["user_sessions", "user_sessions", "internal/database/migrations.go", "table"],
  ["feeds", "feeds", "internal/database/migrations.go", "table"],
  ["web_sessions", "web_sessions", "internal/storage/web_session.go", "table"],
  ["last_used_at", "api_keys.last_used_at", "internal/storage/api_key.go", "column"],
  ["checked_at", "feeds.checked_at", "internal/storage/feed.go", "column"],
  ["mark_read_on_view", "users.mark_read_on_view", "internal/storage/user.go", "column"],
  [
    "mark_read_on_media_player_completion",
    "users.mark_read_on_media_player_completion",
    "internal/storage/user.go",
    "column",
  ],
];

const rows = RUN9.map(([name, qualifiedName, filePath, kind], i) => ({
  id: `sym-${i}`,
  name,
  qualifiedName,
  kind,
  filePath,
  startLine: 10 + i,
  endLine: 20 + i,
}));

function fakePrisma() {
  const findMany = vi.fn(async (args: { where?: { projectId?: string } }) =>
    args?.where?.projectId === PROJECT ? rows : [],
  );
  return {
    prisma: { codeSymbol: { findMany } } as unknown as Pick<PrismaClient, "codeSymbol">,
    findMany,
  };
}

const NR1 = "Mark all as read older than X";
const NR2 = "Last Successful refresh in feed API";

/** The arm #1095 shipped: two shared name terms and nothing else. */
const BEFORE: Bm25SearcherOptions = { minSharedTerms: ANALYSIS_LINK_MIN_SHARED_TERMS };

const linked = async (requirement: string, options: Bm25SearcherOptions): Promise<string[]> =>
  (
    await new Bm25CodeSymbolSearcher(fakePrisma().prisma, options).search(requirement, PROJECT, {
      limit: 50,
    })
  ).map((h) => h.qualifiedName);

const rowOf = (qualifiedName: string) => rows.find((r) => r.qualifiedName === qualifiedName)!;

const WRONG_NR2 = [
  "internal/model/web_session.go::WebSession::LastForceRefresh",
  "api_keys.last_used_at",
  "internal/api/api_integration_test.go::TestRefreshFeedEndpoint",
];
const WRONG_NR1 = ["internal/ui/form/settings.go::markReadBehavior", "users.mark_read_on_view"];

describe("run 9 — the links #1095's rule still let through", () => {
  it("BEFORE: NR-2 links the session throttle, the API-key column and a test", async () => {
    expect(await linked(NR2, BEFORE)).toEqual(expect.arrayContaining(WRONG_NR2));
  });

  it("BEFORE: NR-1 links the mark-read-on-view setting and its form type", async () => {
    expect(await linked(NR1, BEFORE)).toEqual(expect.arrayContaining(WRONG_NR1));
  });

  it("BEFORE: relative confidence reports one of the wrong links at 1.0", async () => {
    // In run 9's full graph the top hit was LastForceRefresh; in this excerpt the
    // corpus statistics differ and it is api_keys.last_used_at. Either way the
    // best surviving hit reads 1.0, because confidence is relative to it.
    const searcher = new Bm25CodeSymbolSearcher(fakePrisma().prisma, BEFORE);
    const [top] = await mapRequirementToCode(
      { id: "NR-2", title: NR2, body: NR2 },
      PROJECT,
      {},
      { searcher },
    );
    expect(top!.confidence).toBe(1);
    expect(WRONG_NR2).toContain(top!.qualifiedName);
  });

  it("root cause: api_keys.last_used_at shares 'last' through its own name and 'api' through its table", () => {
    const query = new Set(tokenizeCode(denoiseRequirementQuery(NR2)));
    const shared = [...symbolNameTerms(rowOf("api_keys.last_used_at"))].filter((t) => query.has(t));
    expect(shared.sort()).toEqual(["api", "last"]);
  });

  it("root cause: LastForceRefresh shares 'last' and 'refresh', both through its own name", () => {
    const query = new Set(tokenizeCode(denoiseRequirementQuery(NR2)));
    const shared = [
      ...symbolNameTerms(rowOf("internal/model/web_session.go::WebSession::LastForceRefresh")),
    ].filter((t) => query.has(t));
    expect(shared.sort()).toEqual(["last", "refresh"]);
  });
});

describe("run 9 — with the analysis path's link options", () => {
  it("NR-2 links none of the three, and keeps the feed-refresh code", async () => {
    const after = await linked(NR2, ANALYSIS_LINK_SEARCH_OPTIONS);
    for (const wrong of WRONG_NR2) expect(after).not.toContain(wrong);
    expect(after).toEqual(
      expect.arrayContaining([
        "internal/api/feed_handlers.go::handler::refreshFeedHandler",
        "internal/ui/feed_refresh.go::handler::refreshFeed",
        "client/client.go::Client::RefreshFeed",
        "internal/reader/handler/handler.go::RefreshFeed",
        "internal/storage/entry.go::Storage::RefreshFeedEntries",
      ]),
    );
  });

  it("every NR-2 link names the requirement's subject, a feed", async () => {
    const after = await linked(NR2, ANALYSIS_LINK_SEARCH_OPTIONS);
    expect(after.length).toBeGreaterThan(0);
    for (const q of after) {
      expect([...symbolNameTerms(rowOf(q))].map(singularTerm)).toContain("feed");
    }
  });

  it("NR-1 links neither near-namesake, and keeps the mark-all-as-read code", async () => {
    const after = await linked(NR1, ANALYSIS_LINK_SEARCH_OPTIONS);
    for (const wrong of WRONG_NR1) expect(after).not.toContain(wrong);
    expect(after).toEqual(
      expect.arrayContaining([
        "internal/ui/unread_mark_all_read.go::handler::markAllAsRead",
        "internal/storage/entry.go::Storage::MarkAllAsRead",
        "internal/storage/entry.go::Storage::MarkAllAsReadBeforeDate",
        "client/client.go::Client::MarkAllAsRead",
        "internal/ui/category_mark_as_read.go::handler::markCategoryAsRead",
      ]),
    );
  });

  it("the top NR-2 match is feed-refresh code, not the session throttle", async () => {
    const searcher = new Bm25CodeSymbolSearcher(fakePrisma().prisma, ANALYSIS_LINK_SEARCH_OPTIONS);
    const matches = await mapRequirementToCode(
      { id: "NR-2", title: NR2, body: NR2 },
      PROJECT,
      {},
      { searcher },
    );
    expect(matches[0]!.qualifiedName).not.toContain("LastForceRefresh");
    expect([...symbolNameTerms(rowOf(matches[0]!.qualifiedName))]).toContain("feed");
  });

  it("the memoizing searcher applies the same options", async () => {
    const seeds = new MemoizingBm25CodeSymbolSearcher(fakePrisma().prisma);
    const links = seeds.withOptions(ANALYSIS_LINK_SEARCH_OPTIONS);
    const shown = (await links.search(NR2, PROJECT, { limit: 50 })).map((h) => h.qualifiedName);
    for (const wrong of WRONG_NR2) expect(shown).not.toContain(wrong);
    // The seed reading of the same corpus is unchanged: it still has all three.
    const seeded = (await seeds.search(NR2, PROJECT, { limit: 50 })).map((h) => h.qualifiedName);
    expect(seeded).toEqual(expect.arrayContaining(WRONG_NR2));
  });
});

describe("each rule on its own", () => {
  const only = (extra: Bm25SearcherOptions): Bm25SearcherOptions => ({ ...BEFORE, ...extra });

  it("excludeTestCode drops symbols in test files, and only those", async () => {
    const before = await linked(NR2, BEFORE);
    const after = await linked(NR2, only({ excludeTestCode: true }));
    expect(before.filter((q) => !after.includes(q)).sort()).toEqual([
      "client/client_test.go::TestRefreshFeed",
      "internal/api/api_integration_test.go::TestRefreshFeedEndpoint",
    ]);
  });

  it("requireSubject without excludeTestCode keeps a test that names the subject", async () => {
    const after = await linked(NR2, only({ requireSubject: true }));
    expect(after).toContain("internal/api/api_integration_test.go::TestRefreshFeedEndpoint");
    expect(after).not.toContain("internal/model/web_session.go::WebSession::LastForceRefresh");
    expect(after).not.toContain("api_keys.last_used_at");
  });

  it("all options are off by default: a searcher without them is unchanged", async () => {
    const plain = await linked(NR2, {});
    expect(plain).toEqual(expect.arrayContaining(WRONG_NR2));
  });
});

describe("sharesRequirementSubject", () => {
  const entities = new Set(["feed", "user", "entry"]);
  const words = (text: string) =>
    new Set(tokenizeCode(denoiseRequirementQuery(text)).map(singularTerm));
  const row = (qualifiedName: string) => rowOf(qualifiedName);

  it("rule 1: a requirement that names a stored entity needs a symbol that names it", () => {
    const w = words(NR2);
    expect(
      sharesRequirementSubject(
        row("internal/model/web_session.go::WebSession::LastForceRefresh"),
        w,
        entities,
      ),
    ).toBe(false);
    expect(
      sharesRequirementSubject(
        row("internal/api/feed_handlers.go::handler::refreshFeedHandler"),
        w,
        entities,
      ),
    ).toBe(true);
  });

  it("rule 1 does not fire when the requirement names no stored entity", () => {
    expect(
      sharesRequirementSubject(
        row("internal/model/web_session.go::WebSession::LastForceRefresh"),
        words("Show the last force refresh"),
        entities,
      ),
    ).toBe(true);
  });

  it("rule 1 is not triggered by an actor word #943 strips ('users')", () => {
    // "Given two users" names the actor, not the users table.
    const w = words("Given two users, mark all as read");
    expect(w.has("user")).toBe(true);
    expect(
      sharesRequirementSubject(
        row("internal/ui/unread_mark_all_read.go::handler::markAllAsRead"),
        w,
        entities,
      ),
    ).toBe(true);
  });

  it("rule 2: a type links only when the requirement uses the last word of its name", () => {
    expect(
      sharesRequirementSubject(
        row("internal/ui/form/settings.go::markReadBehavior"),
        words(NR1),
        entities,
      ),
    ).toBe(false);
    expect(
      sharesRequirementSubject(
        row("internal/ui/form/settings.go::markReadBehavior"),
        words("Change the mark read behavior"),
        entities,
      ),
    ).toBe(true);
    expect(
      sharesRequirementSubject(
        row("internal/model/api_key.go::APIKey"),
        words("List each API key"),
        entities,
      ),
    ).toBe(true);
  });

  it("rule 2 reads a table by the last word of its name, singular", () => {
    expect(sharesRequirementSubject(row("api_keys"), words("Rotate API keys"), entities)).toBe(
      true,
    );
    expect(sharesRequirementSubject(row("api_keys"), words(NR2), entities)).toBe(false);
  });

  it("rule 3: a column links only when the requirement names its table", () => {
    expect(sharesRequirementSubject(row("users.mark_read_on_view"), words(NR1), entities)).toBe(
      false,
    );
    expect(sharesRequirementSubject(row("api_keys.last_used_at"), words(NR2), entities)).toBe(
      false,
    );
    expect(
      sharesRequirementSubject(
        row("feeds.checked_at"),
        words("Show when feeds were last checked"),
        entities,
      ),
    ).toBe(true);
    expect(
      sharesRequirementSubject(
        row("api_keys.last_used_at"),
        words("Show when an API key was last used"),
        new Set(),
      ),
    ).toBe(true);
  });

  it("rule 3 lets a column with no table in its name through", () => {
    expect(
      sharesRequirementSubject(
        { name: "checked_at", qualifiedName: "checked_at", filePath: "x.sql", kind: "column" },
        words("checked at"),
        new Set(),
      ),
    ).toBe(true);
  });

  it("rule 3 reads only the table next to the column in a schema-qualified name", () => {
    expect(
      sharesRequirementSubject(
        {
          name: "checked_at",
          qualifiedName: "public.feeds.checked_at",
          filePath: "x.sql",
          kind: "column",
        },
        words("Show when feeds were last checked"),
        new Set(),
      ),
    ).toBe(true);
  });

  it("a type with an empty name never links", () => {
    expect(
      sharesRequirementSubject(
        { name: "", qualifiedName: "x.go::", filePath: "x.go", kind: "class" },
        words("anything"),
        new Set(),
      ),
    ).toBe(false);
  });

  it("a feed requirement links the feeds table and a column of it", async () => {
    const after = await linked("Show when feeds were last checked", ANALYSIS_LINK_SEARCH_OPTIONS);
    expect(after).toContain("feeds.checked_at");
  });
});

describe("singularTerm", () => {
  it.each([
    ["feeds", "feed"],
    ["entries", "entry"],
    ["categories", "category"],
    ["keys", "key"],
    ["users", "user"],
    ["status", "status"],
    ["class", "class"],
    ["analysis", "analysis"],
    ["ies", "ies"],
    ["api", "api"],
    ["bus", "bus"],
    ["feed", "feed"],
  ])("%s → %s", (input, expected) => {
    expect(singularTerm(input)).toBe(expected);
  });
});
