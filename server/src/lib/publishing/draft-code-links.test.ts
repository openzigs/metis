/**
 * #1064 — issue drafts carried no code links. The "Related code" section lists
 * the links already persisted for the requirement; paths and symbol names are
 * untrusted text going into a Markdown body, so these tests are mostly about
 * what CANNOT get through.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { expectLinearTime } from "../../../tests/helpers/linear-time.js";

const mappingFindMany = vi.fn();
const repoFindMany = vi.fn();
vi.mock("../prisma.js", () => ({
  prisma: {
    requirementCodeMapping: { findMany: mappingFindMany },
    repoConnection: { findMany: repoFindMany },
  },
}));

const {
  MAX_DRAFT_CODE_LINKS,
  buildCodeLinkUrl,
  inlineCode,
  loadDraftCodeLinks,
  renderCodeLinksSection,
  selectCodeLinkRepo,
} = await import("./draft-code-links.js");
const { __testing } = await import("./draft-generator.js");
type DraftCodeLink = import("./draft-code-links.js").DraftCodeLink;
type CodeLinkRepoSource = import("./draft-code-links.js").CodeLinkRepoSource;

const REPO = { origin: "https://github.com", owner: "miniflux", repo: "v2", ref: "abc1234" };

function link(over: Partial<DraftCodeLink> = {}): DraftCodeLink {
  return {
    filePath: "internal/storage/entry.go",
    startLine: 120,
    endLine: 148,
    symbolName: "MarkAllAsRead",
    symbolKind: "method",
    ...over,
  };
}

function connector(over: Partial<CodeLinkRepoSource> = {}): CodeLinkRepoSource {
  return {
    provider: "github",
    ownerOrOrg: "miniflux",
    repoName: "v2",
    defaultBranch: "main",
    apiBaseUrl: null,
    lastCommitSha: "abc1234def",
    ...over,
  };
}

beforeEach(() => {
  mappingFindMany.mockReset();
  repoFindMany.mockReset();
});

describe("selectCodeLinkRepo", () => {
  it("links into the project's single GitHub connector at its ingested commit", () => {
    expect(selectCodeLinkRepo([connector()])).toEqual({
      origin: "https://github.com",
      owner: "miniflux",
      repo: "v2",
      ref: "abc1234def",
    });
  });

  it("falls back to the branch when no commit was recorded", () => {
    expect(selectCodeLinkRepo([connector({ lastCommitSha: null })])?.ref).toBe("main");
    expect(selectCodeLinkRepo([connector({ lastCommitSha: "not a sha" })])?.ref).toBe("main");
  });

  it("uses the https origin of a GitHub Enterprise API base, without its path", () => {
    const ghe = connector({
      provider: "github_enterprise",
      apiBaseUrl: "https://user:pw@ghe.example.com/api/v3",
    });
    expect(selectCodeLinkRepo([ghe])?.origin).toBe("https://ghe.example.com");
    expect(selectCodeLinkRepo([connector({ apiBaseUrl: "https://api.github.com" })])?.origin).toBe(
      "https://github.com",
    );
  });

  it("is null when the repository or ref is not known safely", () => {
    for (const bad of [
      [],
      [connector(), connector({ repoName: "other" })],
      [connector({ provider: "gitlab" })],
      [connector({ provider: "local" })],
      [connector({ provider: "github_enterprise", apiBaseUrl: null })],
      [connector({ apiBaseUrl: "http://ghe.example.com/api/v3" })],
      [connector({ apiBaseUrl: "javascript:alert(1)" })],
      [connector({ apiBaseUrl: "not a url" })],
      [connector({ ownerOrOrg: null })],
      [connector({ repoName: "v2/../../evil" })],
      [connector({ lastCommitSha: null, defaultBranch: null })],
      [connector({ lastCommitSha: null, defaultBranch: "a/../b" })],
      [connector({ lastCommitSha: null, defaultBranch: "main branch" })],
    ]) {
      expect(selectCodeLinkRepo(bad)).toBeNull();
    }
  });
});

describe("buildCodeLinkUrl", () => {
  it("builds a blob URL with the line range", () => {
    expect(buildCodeLinkUrl(REPO, link())).toBe(
      "https://github.com/miniflux/v2/blob/abc1234/internal/storage/entry.go#L120-L148",
    );
    expect(buildCodeLinkUrl(REPO, link({ endLine: 120 }))).toMatch(/#L120$/);
    expect(buildCodeLinkUrl(REPO, link({ endLine: null }))).toMatch(/#L120$/);
    expect(buildCodeLinkUrl(REPO, link({ startLine: null, endLine: null }))).toMatch(/entry\.go$/);
    expect(buildCodeLinkUrl(REPO, link({ startLine: 0 }))).toMatch(/entry\.go$/);
  });

  it("encodes every segment, including the characters that end a Markdown link", () => {
    const url = buildCodeLinkUrl(REPO, link({ filePath: "docs/a (b) <c>/x y#z?.md" }));
    expect(url).toBe(
      "https://github.com/miniflux/v2/blob/abc1234/docs/a%20%28b%29%20%3Cc%3E/x%20y%23z%3F.md#L120-L148",
    );
    expect(buildCodeLinkUrl({ ...REPO, ref: "release/1.0" }, link())).toContain(
      "/blob/release/1.0/",
    );
  });

  it("refuses anything that is not a plain repository-relative path", () => {
    for (const filePath of [
      "",
      "/etc/passwd",
      "../secrets.txt",
      "a/../../b",
      "a//b",
      "./a",
      "javascript:alert(1)",
      "https://evil.example/x",
      "a\\b",
      "a\nb",
    ]) {
      expect(buildCodeLinkUrl(REPO, link({ filePath }))).toBeNull();
    }
    expect(buildCodeLinkUrl(null, link())).toBeNull();
  });
});

describe("inlineCode", () => {
  it("wraps plain text in one backtick", () => {
    expect(inlineCode("a/b.ts")).toBe("`a/b.ts`");
  });

  it("uses a fence longer than any backtick run, so the text cannot close it", () => {
    expect(inlineCode("a`b")).toBe("`` a`b ``");
    expect(inlineCode("a```b``c")).toBe("```` a```b``c ````");
  });

  it("turns control characters into spaces and cuts very long text", () => {
    expect(inlineCode("a\nb\r\tc\u0000d")).toBe("`a b  c d`");
    const long = inlineCode("x".repeat(500));
    expect(long.length).toBe(202);
    expect(long.endsWith("…`")).toBe(true);
    expect(inlineCode(" \n ")).toBe("`?`");
  });

  it("is linear in a flood of backticks", () => {
    expectLinearTime("inlineCode backticks", (n) => {
      const text = "`a".repeat(n / 2);
      return () => inlineCode(text);
    });
  });
});

describe("renderCodeLinksSection", () => {
  it("lists each link as a link into the repository, with its symbol", () => {
    expect(renderCodeLinksSection([link()], REPO)).toEqual([
      "## Related code",
      "",
      "_Code METIS linked to this requirement. A starting point, not a complete list of what to change._",
      "",
      "- [`internal/storage/entry.go:120-148`](https://github.com/miniflux/v2/blob/abc1234/internal/storage/entry.go#L120-L148) — `MarkAllAsRead` (method)",
    ]);
  });

  it("writes plain text when the repository is not known", () => {
    const lines = renderCodeLinksSection(
      [link(), link({ filePath: "ui/app.js", startLine: null, endLine: null, symbolName: null })],
      null,
    );
    expect(lines.slice(4)).toEqual([
      "- `internal/storage/entry.go:120-148` — `MarkAllAsRead` (method)",
      "- `ui/app.js`",
    ]);
    expect(lines.join("\n")).not.toContain("](");
  });

  it("keeps an unsafe path as text even when the repository is known", () => {
    const [row] = renderCodeLinksSection(
      [link({ filePath: "../../etc/passwd", symbolName: null })],
      REPO,
    ).slice(4);
    expect(row).toBe("- `../../etc/passwd:120-148`");
  });

  it("says so when the requirement has no code link", () => {
    expect(renderCodeLinksSection([], REPO)).toEqual([
      "## Related code",
      "",
      "_METIS recorded no code links for this requirement._",
    ]);
  });

  it(`lists at most ${MAX_DRAFT_CODE_LINKS} and counts the rest`, () => {
    const many = Array.from({ length: 14 }, (_, i) => link({ filePath: `src/f${i}.go` }));
    const lines = renderCodeLinksSection(many, REPO);
    expect(lines.filter((l) => l.startsWith("- "))).toHaveLength(MAX_DRAFT_CODE_LINKS);
    expect(lines.at(-1)).toBe(
      "_…and 4 more linked locations not shown — the requirement in METIS lists all 14._",
    );
    const eleven = renderCodeLinksSection(many.slice(0, 11), REPO);
    expect(eleven.at(-1)).toContain("…and 1 more linked location not shown");
    const ten = renderCodeLinksSection(many.slice(0, 10), REPO);
    expect(ten.at(-1)).toMatch(/^- /);
  });

  it("lists an exact repeat once, and does not count it as left out", () => {
    const lines = renderCodeLinksSection(
      [link(), link(), link({ startLine: 5, endLine: 9 })],
      REPO,
    );
    expect(lines.filter((l) => l.startsWith("- "))).toHaveLength(2);
  });

  it("lets no HTML or Markdown out of a hostile path or symbol name", () => {
    const hostile = link({
      filePath: "a/<img src=x onerror=alert(1)>/`](https://evil.example)\n# Heading\n<!-- x -->.go",
      symbolName: "</code><script>alert(1)</script>`**bold**`",
      symbolKind: "<b>kind</b>",
    });
    const rows = renderCodeLinksSection([hostile], REPO).filter((l) => l.startsWith("- "));
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    // One line, and no kind that is not a plain word.
    expect(row).not.toContain("\n");
    expect(row).not.toContain("<b>");
    // Everything hostile sits between fences longer than its own backtick runs:
    // outside the code spans there is only the list marker and the separator.
    const outside = row.replace(/``.*?``/g, "");
    expect(outside).toBe("-  — ");
  });

  it("drops a symbol kind that is not a plain word, keeps the name", () => {
    const [row] = renderCodeLinksSection([link({ symbolKind: "Method()" })], null).slice(4);
    expect(row).toBe("- `internal/storage/entry.go:120-148` — `MarkAllAsRead`");
  });
});

describe("loadDraftCodeLinks", () => {
  it("reads the persisted links of the given requirements, in this project, in a stable order", async () => {
    mappingFindMany.mockResolvedValue([
      {
        requirementId: "r1",
        filePath: "a.go",
        startLine: 1,
        endLine: 9,
        codeSymbol: { name: "A", kind: "function" },
      },
      { requirementId: "r1", filePath: "b.go", startLine: null, endLine: null, codeSymbol: null },
      { requirementId: "r2", filePath: "c.go", startLine: 3, endLine: 3, codeSymbol: null },
    ]);
    repoFindMany.mockResolvedValue([connector()]);

    const loaded = await loadDraftCodeLinks("p1", ["r1", "r2", "r3"]);

    expect(mappingFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { projectId: "p1", requirementId: { in: ["r1", "r2", "r3"] } },
        orderBy: [{ confidence: "desc" }, { filePath: "asc" }, { startLine: "asc" }, { id: "asc" }],
      }),
    );
    expect(repoFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          projectId: "p1",
          deletedAt: null,
          provider: { in: ["github", "github_enterprise"] },
        },
      }),
    );
    expect(loaded?.repo?.ref).toBe("abc1234def");
    expect(loaded?.byRequirement.get("r1")).toEqual([
      { filePath: "a.go", startLine: 1, endLine: 9, symbolName: "A", symbolKind: "function" },
      { filePath: "b.go", startLine: null, endLine: null, symbolName: null, symbolKind: null },
    ]);
    expect(loaded?.byRequirement.get("r2")).toHaveLength(1);
    expect(loaded?.byRequirement.has("r3")).toBe(false);
  });

  it("returns null when the links cannot be read, rather than failing the draft run", async () => {
    mappingFindMany.mockRejectedValue(new Error("db is down"));
    repoFindMany.mockResolvedValue([]);
    expect(await loadDraftCodeLinks("p1", ["r1"])).toBeNull();
  });
});

describe("renderFeatureBody — Related code (#1064)", () => {
  const base = {
    project: { id: "proj-123456789", name: "Miniflux" },
    analysis: { id: "cms3tjy9r0001259kozwuencx" },
    requirement: {
      id: "cms3tyeq0004wxyz",
      title: "Mark all as read older than X",
      body: "Body.",
      type: "feature",
      priority: "high",
      acceptanceCriteria: '["One criterion"]',
    },
    parentTitle: "[Epic] Miniflux",
  };

  it("places the section between the acceptance criteria and the definition of done", () => {
    const body = __testing.renderFeatureBody({
      ...base,
      codeLinks: { links: [link()], repo: REPO },
    });
    const at = (heading: string) => body.indexOf(heading);
    expect(at("## Related code")).toBeGreaterThan(at("## Acceptance criteria"));
    expect(at("## Related code")).toBeLessThan(at("## Definition of done"));
    expect(body).toContain("/blob/abc1234/internal/storage/entry.go#L120-L148");
  });

  it("says no link was recorded when the requirement has none", () => {
    const body = __testing.renderFeatureBody({ ...base, codeLinks: { links: [], repo: null } });
    expect(body).toContain("_METIS recorded no code links for this requirement._");
  });

  it("has no section when the links could not be read", () => {
    for (const codeLinks of [null, undefined]) {
      expect(__testing.renderFeatureBody({ ...base, codeLinks })).not.toContain("## Related code");
    }
  });
});
