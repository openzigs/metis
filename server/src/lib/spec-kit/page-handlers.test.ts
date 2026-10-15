/**
 * #1135 — which HTTP handlers serve the page or action a spec names.
 */
import { describe, expect, it } from "vitest";
import {
  isHttpHandlerSignature,
  nameTokens,
  namesPageOrUiAction,
  rankHandlers,
  specWordCounts,
} from "./page-handlers.js";

describe("namesPageOrUiAction", () => {
  it("is true for a page, a button or a shortcut, false for an API-only request", () => {
    expect(namesPageOrUiAction("After 'Mark this page as read' the feed shows 0 entries")).toBe(
      true,
    );
    expect(namesPageOrUiAction("Pressing the Refresh button does nothing")).toBe(true);
    expect(namesPageOrUiAction("The keyboard shortcut is ignored")).toBe(true);
    expect(namesPageOrUiAction("Reader API stream/items/ids count is always 1000 on 2.3.3")).toBe(
      false,
    );
  });
});

describe("isHttpHandlerSignature", () => {
  it("knows net/http, Express and Next.js handlers, and nothing else", () => {
    expect(
      isHttpHandlerSignature(
        "func (h *handler) showFeedEntriesPage(w http.ResponseWriter, r *http.Request)",
      ),
    ).toBe(true);
    expect(isHttpHandlerSignature("async function list(req, res)")).toBe(true);
    expect(isHttpHandlerSignature("export async function GET(request: NextRequest)")).toBe(true);
    expect(
      isHttpHandlerSignature("func (s *Storage) MarkFeedAsRead(userID, feedID int64) error"),
    ).toBe(false);
    expect(isHttpHandlerSignature(null)).toBe(false);
    expect(isHttpHandlerSignature(undefined)).toBe(false);
  });
});

describe("nameTokens and specWordCounts", () => {
  it("splits camelCase, snake_case and acronyms, and folds plurals", () => {
    expect(nameTokens("showFeedEntriesPage")).toEqual(["show", "feed", "entry", "page"]);
    expect(nameTokens("show_category_feeds")).toEqual(["show", "category", "feed"]);
    expect(nameTokens("showAPIKeysPage")).toEqual(["show", "api", "key", "page"]);
    // `status` and `class` are not plurals.
    expect(nameTokens("updateEntriesStatus")).toEqual(["update", "entry", "status"]);
    expect(specWordCounts("Entries, entry and FEEDS.").get("entry")).toBe(2);
  });
});

const h = (name: string, filePath = `internal/ui/${name}.go`) => ({ id: name, name, filePath });

describe("rankHandlers", () => {
  const SPEC =
    "Users reading a multi-page feed use 'Mark this page as read'. On the last page the feed entries page shows no entries.";

  it("prefers a page handler when the spec names a page, then the most name parts matched", () => {
    const ranked = rankHandlers(
      [
        h("markFeedAsReadHandler"),
        h("showSettingsPage"),
        h("showFeedEntriesPage"),
        h("showCategoryEntriesPage"),
        h("showUnreadPage"),
      ],
      SPEC,
    );
    expect(ranked.map((r) => r.handler.name)).toEqual([
      "showFeedEntriesPage",
      "showCategoryEntriesPage",
      "markFeedAsReadHandler",
    ]);
    expect(ranked[0]!.matched).toEqual(["feed", "entry"]);
    expect(ranked[1]!.precision).toBe(0.5);
  });

  it("does not prefer a page handler when the spec names no page", () => {
    const ranked = rankHandlers(
      [h("showFeedPage"), h("markFeedAsReadHandler")],
      "Clicking mark feed as read does nothing",
    );
    expect(ranked.map((r) => r.handler.name)).toEqual(["markFeedAsReadHandler", "showFeedPage"]);
  });

  it("drops a name that is all generic parts, or mostly unmatched", () => {
    expect(rankHandlers([h("showPage"), h("handleAction")], SPEC)).toEqual([]);
    expect(rankHandlers([h("showStarredHistoryEntriesPage")], SPEC)).toEqual([]);
  });

  it("orders ties by the spec's use of the words, then by name and file", () => {
    const ranked = rankHandlers(
      [h("showReadPage", "b.go"), h("showReadPage", "a.go"), h("showLastPage")],
      "Mark as read, read again, then the last page.",
    );
    expect(ranked.map((r) => `${r.handler.name}@${r.handler.filePath}`)).toEqual([
      "showReadPage@a.go",
      "showReadPage@b.go",
      "showLastPage@internal/ui/showLastPage.go",
    ]);
  });
});
