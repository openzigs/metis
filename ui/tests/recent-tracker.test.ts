import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { titleFromQuestion } from "@metis/shared";
import { recentTracker, sessionTitleAfterTurn, _MAX_PER_KIND } from "@/lib/recent-tracker";

/**
 * #1139 (PR #1234 review) — Recent lists the title the server holds. The
 * server renames only a "New Chat" session, only on its first stored question,
 * with the shared `titleFromQuestion`; this is the same rule on the same inputs.
 */
describe("sessionTitleAfterTurn (#1139)", () => {
  it("names a new chat after its first question, exactly as the server does", () => {
    const q = "  Which   tables\nhold invoices? ";
    expect(sessionTitleAfterTurn("New Chat", q, true)).toBe("Which tables hold invoices?");
    expect(sessionTitleAfterTurn("New Chat", q, true)).toBe(titleFromQuestion(q));
    const long = `${"word ".repeat(30)}end`;
    expect(sessionTitleAfterTurn("New Chat", long, true)).toBe(titleFromQuestion(long));
  });

  it("keeps the stored title on a later turn, e.g. after a resume", () => {
    expect(sessionTitleAfterTurn("New Chat", "a later question", false)).toBe("New Chat");
    expect(sessionTitleAfterTurn("Invoice tables", "something else", false)).toBe("Invoice tables");
  });

  it("never renames a title the server would not: a Workbench or a chosen title", () => {
    expect(sessionTitleAfterTurn("Workbench", "first question", true)).toBe("Workbench");
    expect(sessionTitleAfterTurn("Invoice tables", "first question", true)).toBe("Invoice tables");
  });

  it("keeps 'New Chat' for a question with no visible text", () => {
    expect(sessionTitleAfterTurn("New Chat", "   ", true)).toBe("New Chat");
  });
});

describe("recentTracker", () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => window.localStorage.clear());

  it("returns empty list when nothing tracked", () => {
    expect(recentTracker.list()).toEqual([]);
  });

  it("touch upserts and orders by most recent", () => {
    recentTracker.touch({
      kind: "session",
      id: "a",
      label: "A",
      href: "/a",
      touchedAt: "2025-01-01T00:00:00Z",
    });
    recentTracker.touch({
      kind: "session",
      id: "b",
      label: "B",
      href: "/b",
      touchedAt: "2025-01-02T00:00:00Z",
    });
    recentTracker.touch({
      kind: "session",
      id: "a",
      label: "A2",
      href: "/a2",
      touchedAt: "2025-01-03T00:00:00Z",
    });
    const list = recentTracker.list("session");
    expect(list[0]?.id).toBe("a");
    expect(list[0]?.label).toBe("A2");
    expect(list[1]?.id).toBe("b");
    expect(list.length).toBe(2);
  });

  it("filters by kind", () => {
    recentTracker.touch({
      kind: "session",
      id: "s",
      label: "S",
      href: "/s",
      touchedAt: "2025-01-01T00:00:00Z",
    });
    recentTracker.touch({
      kind: "analysis",
      id: "an",
      label: "An",
      href: "/an",
      touchedAt: "2025-01-02T00:00:00Z",
    });
    expect(recentTracker.list("session").map((e) => e.id)).toEqual(["s"]);
    expect(recentTracker.list("analysis").map((e) => e.id)).toEqual(["an"]);
    expect(recentTracker.list().length).toBe(2);
  });

  it("caps each kind at the configured maximum", () => {
    for (let i = 0; i < _MAX_PER_KIND + 5; i++) {
      recentTracker.touch({
        kind: "session",
        id: `s${i}`,
        label: `S${i}`,
        href: `/s/${i}`,
        touchedAt: `2025-01-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
      });
    }
    expect(recentTracker.list("session").length).toBe(_MAX_PER_KIND);
  });

  it("clear removes everything", () => {
    recentTracker.touch({
      kind: "session",
      id: "s",
      label: "S",
      href: "/s",
      touchedAt: "2025-01-01T00:00:00Z",
    });
    recentTracker.clear();
    expect(recentTracker.list()).toEqual([]);
  });

  it("ignores malformed JSON", () => {
    window.localStorage.setItem("metis.workbench.recent", "{not json");
    expect(recentTracker.list()).toEqual([]);
  });

  it("filters out malformed entries", () => {
    window.localStorage.setItem(
      "metis.workbench.recent",
      JSON.stringify([
        { kind: "session", id: "ok", label: "ok", href: "/ok", touchedAt: "2025-01-01T00:00:00Z" },
        { kind: "bogus", id: "x", label: "x", href: "/x", touchedAt: "2025" },
      ]),
    );
    const list = recentTracker.list();
    expect(list.length).toBe(1);
    expect(list[0]?.id).toBe("ok");
  });

  it("rejects entries with unsafe href when read from localStorage", () => {
    window.localStorage.setItem(
      "metis.workbench.recent",
      JSON.stringify([
        {
          kind: "session",
          id: "evil1",
          label: "xss",
          href: "javascript:alert(1)",
          touchedAt: "2025-01-01T00:00:00Z",
        },
        {
          kind: "session",
          id: "evil2",
          label: "proto-relative",
          href: "//evil.com/steal",
          touchedAt: "2025-01-02T00:00:00Z",
        },
        {
          kind: "session",
          id: "evil3",
          label: "backslash",
          href: "/\\evil.com",
          touchedAt: "2025-01-03T00:00:00Z",
        },
        {
          kind: "session",
          id: "evil4",
          label: "data",
          href: "data:text/html,<script>alert(1)</script>",
          touchedAt: "2025-01-04T00:00:00Z",
        },
        {
          kind: "session",
          id: "good",
          label: "ok",
          href: "/workbench/sessions/abc",
          touchedAt: "2025-01-05T00:00:00Z",
        },
      ]),
    );
    const list = recentTracker.list();
    expect(list.map((e) => e.id)).toEqual(["good"]);
  });

  it("rejects touch() when href is unsafe", () => {
    recentTracker.touch({
      kind: "session",
      id: "evil",
      label: "xss",
      href: "javascript:alert(1)",
      touchedAt: "2025-01-01T00:00:00Z",
    });
    recentTracker.touch({
      kind: "session",
      id: "evil2",
      label: "proto",
      href: "//evil.com",
      touchedAt: "2025-01-02T00:00:00Z",
    });
    recentTracker.touch({
      kind: "session",
      id: "ok",
      label: "ok",
      href: "/workbench/sessions/x",
      touchedAt: "2025-01-03T00:00:00Z",
    });
    const list = recentTracker.list();
    expect(list.map((e) => e.id)).toEqual(["ok"]);
  });
});
