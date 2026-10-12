/**
 * #1064 — issue drafts carried no code links. The "Related code" section lists
 * the links already persisted for the requirement; paths and symbol names are
 * untrusted text going into a Markdown body, so these tests are mostly about
 * what CANNOT get through.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { expectLinearTime } from "../../../tests/helpers/linear-time.js";

const mappingFindMany = vi.fn();
const mappingCount = vi.fn();
const repoFindMany = vi.fn();
vi.mock("../prisma.js", () => ({
  prisma: {
    requirementCodeMapping: { findMany: mappingFindMany, count: mappingCount },
    repoConnection: { findMany: repoFindMany },
  },
}));

const {
  CODE_LINK_READ_CAP,
  CODE_LINKS_AS_TEXT_NOTE,
  CODE_LINKS_EDITED_NOTE,
  MAX_DRAFT_CODE_LINKS,
  assertCodeLinksMatchTarget,
  bodyWithCodeAsText,
  publishTargetBase,
  buildCodeLinkUrl,
  codeLinkBase,
  codeLinkSectionRecord,
  inlineCode,
  loadDraftCodeLinks,
  renderCodeLinksSection,
  selectCodeLinkRepo,
} = await import("./draft-code-links.js");
const { PublishError } = await import("./types.js");
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

const TARGET = { owner: "miniflux", repo: "v2", baseUrl: null };

beforeEach(() => {
  mappingFindMany.mockReset();
  mappingCount.mockReset();
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

  it("maps a data-residency GitHub Enterprise Cloud API host to its web host", () => {
    // The API is api.<tenant>.ghe.com; blob links there are dead. The UI is <tenant>.ghe.com.
    for (const apiBaseUrl of ["https://api.acme.ghe.com", "https://API.Acme.GHE.com/"]) {
      const repo = selectCodeLinkRepo([connector({ provider: "github_enterprise", apiBaseUrl })]);
      expect(repo?.origin).toBe("https://acme.ghe.com");
    }
    // Only that exact shape: a server that merely ends in ghe.com keeps its own origin.
    expect(
      selectCodeLinkRepo([
        connector({ provider: "github_enterprise", apiBaseUrl: "https://api.x.y.ghe.com" }),
      ])?.origin,
    ).toBe("https://api.x.y.ghe.com");
    expect(
      selectCodeLinkRepo([
        connector({
          provider: "github_enterprise",
          apiBaseUrl: "https://api.ghe.com.evil.example",
        }),
      ])?.origin,
    ).toBe("https://api.ghe.com.evil.example");
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

  it("keeps every kind of line break out of the span", () => {
    // U+0085, U+2028 and U+2029 are line breaks to some renderers.
    expect(inlineCode("a\u0085b\u2028c\u2029d")).toBe("`a b c d`");
  });

  it("drops invisible format characters (zero-width, bidi overrides, BOM)", () => {
    expect(inlineCode("a\u200bb\u200dc\u202ed\u2066e\ufefff\u00adg")).toBe("`abcdefg`");
    // Nothing visible is left of a name made only of them.
    expect(inlineCode("\u200b\u200e\u202e")).toBe("`?`");
  });

  it("breaks up an HTML comment opener and closer, marker-shaped or not", () => {
    expect(inlineCode("a<!-- metis-source: x -->b")).toBe("`a<!- - metis-source: x - ->b`");
    expect(inlineCode("<!--x")).toBe("`<!- -x`");
    expect(inlineCode("x-->")).toBe("`x- ->`");
    expect(inlineCode("a<!--<!--b")).not.toContain("<!--");
    // HTML5 ends a comment at `--!>` as well; CommonMark only at `-->`.
    expect(inlineCode("x--!>y")).toBe("`x- -!>y`");
    expect(inlineCode("a<!-- b --!> c")).toBe("`a<!- - b - -!> c`");
  });

  it("links a location that holds a square bracket by a link after its code span", () => {
    // `[` + a path holding `]:` is a link reference definition to Markdown, so
    // a bracketed location is never the TEXT of a link.
    const rows = (over: Partial<DraftCodeLink>) =>
      renderCodeLinksSection([link(over)], REPO).filter((l) => l.startsWith("- "));
    const blob = "https://github.com/miniflux/v2/blob/abc1234";
    expect(
      rows({ filePath: "x]:https:/evil.example/y", startLine: null, symbolName: null }),
    ).toEqual([
      `- \`x]:https:/evil.example/y\` ([source](${blob}/x%5D%3Ahttps%3A/evil.example/y))`,
    ]);
    expect(rows({ filePath: "]", startLine: 3, endLine: 9, symbolName: null })).toEqual([
      `- \`]:3-9\` ([source](${blob}/%5D#L3-L9))`,
    ]);
    // An ordinary Next.js route keeps its link, and its symbol.
    expect(rows({ filePath: "app/[id]/page.tsx", startLine: null, symbolName: "Page" })).toEqual([
      `- \`app/[id]/page.tsx\` ([source](${blob}/app/%5Bid%5D/page.tsx)) — \`Page\` (method)`,
    ]);
    expect(
      rows({ filePath: "app/[...slug]/page.tsx", startLine: 1, endLine: null, symbolName: null }),
    ).toEqual([`- \`app/[...slug]/page.tsx:1\` ([source](${blob}/app/%5B...slug%5D/page.tsx#L1))`]);
    // A bracket in the symbol only: the location is still the link's text.
    expect(rows({ filePath: "a.go", startLine: null, symbolName: "xs[0]" })).toEqual([
      `- [\`a.go\`](${blob}/a.go) — \`xs[0]\` (method)`,
    ]);
    // A bracketed path that cannot be linked at all stays plain code.
    expect(rows({ filePath: "../[id].ts", startLine: null, symbolName: null })).toEqual([
      "- `../[id].ts`",
    ]);
  });

  it("does not split a surrogate pair at the cut", () => {
    const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
    expect(LONE_SURROGATE.test("x\ud83d")).toBe(true);
    // The 199th and 200th UTF-16 units are the two halves of one emoji.
    const text = `${"x".repeat(198)}😀${"y".repeat(50)}`;
    const span = inlineCode(text);
    expect(span).toBe(`\`${"x".repeat(198)}…\``);
    // No half of a pair is left on its own.
    expect(LONE_SURROGATE.test(span)).toBe(false);
    // A pair that ends exactly at the cut is kept whole.
    const kept = inlineCode(`${"x".repeat(197)}😀${"y".repeat(50)}`);
    expect(kept).toBe(`\`${"x".repeat(197)}😀…\``);
    expect(LONE_SURROGATE.test(kept)).toBe(false);
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
      "",
      CODE_LINKS_AS_TEXT_NOTE,
    ]);
    expect(lines.join("\n")).not.toContain("](");
  });

  it("names no repository, owner, commit or URL when the paths are text", () => {
    const text = renderCodeLinksSection(
      Array.from({ length: 14 }, (_, i) => link({ filePath: `src/f${i}.go` })),
      null,
    ).join("\n");
    for (const leak of ["miniflux", "v2", "abc1234", "http", "github", "](", "blob"]) {
      expect(text).not.toContain(leak);
    }
    // The closing line says why they are not links; the count line is still there.
    expect(text.endsWith(CODE_LINKS_AS_TEXT_NOTE)).toBe(true);
    expect(text).toContain("…and 4 more linked locations not shown");
    // A linked section carries no such line.
    expect(renderCodeLinksSection([link()], REPO).join("\n")).not.toContain(
      CODE_LINKS_AS_TEXT_NOTE,
    );
  });

  it("counts links that were not read, when the requirement holds more than were loaded", () => {
    const read = Array.from({ length: 12 }, (_, i) => link({ filePath: `src/f${i}.go` }));
    // 12 rows read (one of them a repeat) out of 300 held.
    const lines = renderCodeLinksSection([...read, read[0]!], REPO, 300);
    expect(lines.at(-1)).toBe(
      "_…and 289 more linked locations not shown — the requirement in METIS lists all 299._",
    );
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
  const row = (filePath: string, over: object = {}) => ({
    filePath,
    startLine: null,
    endLine: null,
    codeSymbol: null,
    ...over,
  });

  function mappingsByRequirement(rows: Record<string, object[]>) {
    mappingFindMany.mockImplementation(
      async ({ where, take }: { where: { requirementId: string }; take: number }) =>
        (rows[where.requirementId] ?? []).slice(0, take),
    );
    mappingCount.mockImplementation(
      async ({ where }: { where: { requirementId: string } }) =>
        (rows[where.requirementId] ?? []).length,
    );
  }

  it("reads the persisted links of each requirement, in this project, in a stable order", async () => {
    mappingsByRequirement({
      r1: [
        row("a.go", { startLine: 1, endLine: 9, codeSymbol: { name: "A", kind: "function" } }),
        row("b.go"),
      ],
      r2: [row("c.go", { startLine: 3, endLine: 3 })],
    });
    repoFindMany.mockResolvedValue([connector()]);

    const loaded = await loadDraftCodeLinks("p1", ["r1", "r2", "r3"], TARGET);

    expect(mappingFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { projectId: "p1", requirementId: "r1" },
        orderBy: [{ confidence: "desc" }, { filePath: "asc" }, { startLine: "asc" }, { id: "asc" }],
        take: CODE_LINK_READ_CAP,
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
    expect(loaded?.byRequirement.get("r1")).toEqual({
      total: 2,
      links: [
        { filePath: "a.go", startLine: 1, endLine: 9, symbolName: "A", symbolKind: "function" },
        { filePath: "b.go", startLine: null, endLine: null, symbolName: null, symbolKind: null },
      ],
    });
    expect(loaded?.byRequirement.get("r2")?.links).toHaveLength(1);
    expect(loaded?.byRequirement.get("r3")).toEqual({ total: 0, links: [] });
  });

  it("never loads more than the cap for one requirement, and counts the rest", async () => {
    const many = Array.from({ length: 700 }, (_, i) => row(`src/f${i}.go`));
    mappingsByRequirement({ r1: many, r2: [row("only.go")] });
    repoFindMany.mockResolvedValue([connector()]);

    const loaded = await loadDraftCodeLinks("p1", ["r1", "r2"], TARGET);

    // Every read is bounded: no call can return the 700 rows.
    for (const [args] of mappingFindMany.mock.calls) {
      expect((args as { take?: number }).take).toBe(CODE_LINK_READ_CAP);
    }
    expect(loaded?.byRequirement.get("r1")?.links).toHaveLength(CODE_LINK_READ_CAP);
    expect(loaded?.byRequirement.get("r1")?.total).toBe(700);
    // A requirement under the cap is not counted separately.
    expect(mappingCount).toHaveBeenCalledTimes(1);
    expect(loaded?.byRequirement.get("r2")?.total).toBe(1);
    // And the section says how many there are.
    const r1 = loaded!.byRequirement.get("r1")!;
    expect(renderCodeLinksSection(r1.links, loaded!.repo, r1.total).at(-1)).toBe(
      "_…and 690 more linked locations not shown — the requirement in METIS lists all 700._",
    );
  });

  it("offers the repository to link into only when the drafts target that repository on its host", async () => {
    mappingsByRequirement({ r1: [row("a.go")] });
    repoFindMany.mockResolvedValue([connector()]);
    // GitHub compares names case-insensitively; no base URL is public GitHub.
    for (const same of [
      TARGET,
      { owner: "Miniflux", repo: "V2", baseUrl: null },
      { owner: " miniflux ", repo: "v2", baseUrl: "https://api.github.com" },
      { owner: "miniflux", repo: "v2", baseUrl: "https://API.GitHub.com/" },
      // Left out, or empty, is public GitHub — as it is when a batch is created.
      { owner: "miniflux", repo: "v2" },
      { owner: "miniflux", repo: "v2", baseUrl: undefined },
      { owner: "miniflux", repo: "v2", baseUrl: "  " },
    ]) {
      expect(
        (await loadDraftCodeLinks("p1", ["r1"], same))?.repo,
        JSON.stringify(same),
      ).not.toBeNull();
    }
    for (const other of [
      { owner: "openzigs", repo: "flux-v2", baseUrl: null },
      { owner: "miniflux", repo: "v2-fork", baseUrl: null },
      { owner: "someone", repo: "v2", baseUrl: null },
      // The same owner and name on ANOTHER host is another repository.
      { owner: "miniflux", repo: "v2", baseUrl: "https://ghe.example.com/api/v3" },
      { owner: "miniflux", repo: "v2", baseUrl: "http://api.github.com" },
      // Not a URL at all (a half-typed field): names no host.
      { owner: "miniflux", repo: "v2", baseUrl: "github.example.com" },
    ]) {
      const loaded = await loadDraftCodeLinks("p1", ["r1"], other);
      expect(loaded?.repo, JSON.stringify(other)).toBeNull();
      // The links are still listed (as text).
      expect(loaded?.byRequirement.get("r1")?.links).toHaveLength(1);
    }
  });

  it("matches an Enterprise connector only on its own host, capitals and all", async () => {
    mappingsByRequirement({ r1: [row("a.go")] });
    repoFindMany.mockResolvedValue([
      connector({
        provider: "github_enterprise",
        ownerOrOrg: "Acme",
        repoName: "App",
        apiBaseUrl: "https://GHE.example.com/api/v3",
      }),
    ]);
    const on = (baseUrl: string | null | undefined) =>
      loadDraftCodeLinks("p1", ["r1"], { owner: "acme", repo: "app", baseUrl });
    expect((await on("https://ghe.example.com/api/v3"))?.repo).toEqual({
      origin: "https://ghe.example.com",
      owner: "Acme",
      repo: "App",
      ref: "abc1234def",
    });
    expect((await on("https://ghe.example.com"))?.repo).not.toBeNull();
    // The same names on public GitHub — which is what no host given means: text.
    expect((await on(null))?.repo).toBeNull();
    expect((await on(undefined))?.repo).toBeNull();
    expect((await on(""))?.repo).toBeNull();
    expect((await on("https://other.example.com/api/v3"))?.repo).toBeNull();
  });

  it("returns null when the links cannot be read, rather than failing the draft run", async () => {
    mappingFindMany.mockRejectedValue(new Error("db is down"));
    repoFindMany.mockResolvedValue([]);
    expect(await loadDraftCodeLinks("p1", ["r1"], TARGET)).toBeNull();
  });
});

describe("publishTargetBase — one definition of the target, for generation and for the guard", () => {
  it("is the link base of the repository, lower-cased", () => {
    expect(publishTargetBase({ owner: "Acme", repo: "App", baseUrl: null })).toBe(
      "https://github.com/acme/app",
    );
    expect(
      publishTargetBase({ owner: "Acme", repo: "App", baseUrl: "https://GHE.example.com/api/v3" }),
    ).toBe("https://ghe.example.com/acme/app");
    expect(
      publishTargetBase({ owner: "acme", repo: "app", baseUrl: "https://api.tenant.ghe.com" }),
    ).toBe("https://tenant.ghe.com/acme/app");
  });

  it("reads a base URL that was left out, null or empty as public GitHub", () => {
    for (const baseUrl of [undefined, null, "", "  "]) {
      expect(publishTargetBase({ owner: "acme", repo: "app", baseUrl }), String(baseUrl)).toBe(
        "https://github.com/acme/app",
      );
    }
    expect(publishTargetBase({ owner: "acme", repo: "app" })).toBe("https://github.com/acme/app");
    expect(
      publishTargetBase({ owner: "acme", repo: "app", baseUrl: " https://ghe.example.com " }),
    ).toBe("https://ghe.example.com/acme/app");
  });

  it("is null when the base URL is not an https URL", () => {
    expect(
      publishTargetBase({ owner: "acme", repo: "app", baseUrl: "ghe.example.com" }),
    ).toBeNull();
    expect(
      publishTargetBase({ owner: "acme", repo: "app", baseUrl: "http://x.example" }),
    ).toBeNull();
    expect(publishTargetBase({ owner: "acme", repo: "app", baseUrl: "not a url" })).toBeNull();
  });
});

describe("assertCodeLinksMatchTarget — linked drafts stay in the repository they link into", () => {
  const base = codeLinkBase(REPO);
  const linked = {
    id: "d1",
    title: "[Feature] Sign in",
    body: `- [\`a.go\`](${base}/blob/abc1234/a.go)`,
    metadata: JSON.stringify({ codeLinkBase: base }),
  };
  const same = { owner: "miniflux", repo: "v2", baseUrl: null };

  it("accepts the repository the links point into, however it is spelled", () => {
    expect(() => assertCodeLinksMatchTarget([linked], same)).not.toThrow();
    expect(() =>
      assertCodeLinksMatchTarget([linked], { ...same, baseUrl: undefined }),
    ).not.toThrow();
    expect(() =>
      assertCodeLinksMatchTarget([linked], {
        owner: "Miniflux",
        repo: "V2",
        baseUrl: "https://api.github.com",
      }),
    ).not.toThrow();
  });

  it("accepts a connector whose owner and repository are written with capitals", () => {
    // The recorded base keeps the connector's own spelling (`Acme/App`); the
    // comparison lower-cases BOTH sides, so the repository is not refused
    // publishing into itself — whichever way the batch form spells it.
    const capitals = codeLinkBase({
      origin: "https://github.com",
      owner: "Acme",
      repo: "App",
      ref: "abc1234",
    });
    expect(capitals).toBe("https://github.com/Acme/App");
    const draft = {
      id: "d1",
      body: `- [\`a.go\`](${capitals}/blob/abc1234/a.go)`,
      metadata: JSON.stringify({ codeLinkBase: capitals }),
    };
    for (const target of [
      { owner: "Acme", repo: "App", baseUrl: null },
      { owner: "acme", repo: "app", baseUrl: null },
      { owner: "ACME", repo: "APP", baseUrl: "https://api.github.com" },
    ]) {
      expect(
        () => assertCodeLinksMatchTarget([draft], target),
        JSON.stringify(target),
      ).not.toThrow();
    }
    expect(() =>
      assertCodeLinksMatchTarget([draft], { owner: "Acme", repo: "Other", baseUrl: null }),
    ).toThrow(PublishError);
  });

  it("refuses another repository, and another host with the same owner and name", () => {
    for (const target of [
      { owner: "openzigs", repo: "flux-v2", baseUrl: null },
      { owner: "miniflux", repo: "v2", baseUrl: "https://ghe.example.com/api/v3" },
      { owner: "miniflux", repo: "v2", baseUrl: "http://not-https.example" },
    ]) {
      let thrown: unknown;
      try {
        assertCodeLinksMatchTarget([linked, { id: "d2", body: "plain", metadata: null }], target);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(PublishError);
      const err = thrown as InstanceType<typeof PublishError>;
      expect(err.status).toBe(409);
      expect(err.code).toBe("CODE_LINKS_TARGET_MISMATCH");
      expect(err.details).toEqual({ draftIds: ["d1"] });
      // The message does not itself name the analysed repository.
      expect(err.message).not.toContain("abc1234");
    }
  });

  it("names the drafts it refuses, and both ways out", () => {
    const other = { owner: "openzigs", repo: "flux-v2", baseUrl: null };
    const message = (drafts: Parameters<typeof assertCodeLinksMatchTarget>[0]): string => {
      try {
        assertCodeLinksMatchTarget(drafts, other);
      } catch (err) {
        return (err as Error).message;
      }
      throw new Error("expected a refusal");
    };
    const one = message([linked]);
    expect(one).toContain("1 draft links into the analysed repository");
    expect(one).toContain('"[Feature] Sign in"');
    expect(one).toContain("openzigs/flux-v2");
    // Both remedies, and the case where the first one does not apply.
    expect(one).toMatch(
      /generate the drafts again for this target \(same owner, repository and base URL\)/,
    );
    expect(one).toMatch(/edited by hand or is kept because it is signed off/);
    expect(one).toMatch(/remove the links from that draft in the editor/);

    // Capped, the rest counted; a draft with no title is named by its id.
    const many = Array.from({ length: 8 }, (_, i) => ({
      ...linked,
      id: `d${i}`,
      title: i === 1 ? null : `Draft ${i} ${"long ".repeat(40)}`,
    }));
    const several = message(many);
    expect(several).toContain("8 drafts link into the analysed repository");
    expect(several).toContain('"Draft 0 long');
    expect(several).toContain(", d1, ");
    expect(several).toContain("and 3 more");
    expect(several).not.toContain("Draft 5");
    expect(several).toMatch(/remove the links from those drafts in the editor/);
    // A title is one line of bounded length in the message.
    expect(several.length).toBeLessThan(1200);
  });

  it("lets through a draft that has no links: text-only, never linked, or links removed", () => {
    const other = { owner: "openzigs", repo: "flux-v2", baseUrl: null };
    for (const draft of [
      { id: "d", body: "- `a.go`", metadata: JSON.stringify({ targetOwner: "x" }) },
      { id: "d", body: "- `a.go`", metadata: null },
      { id: "d", body: "- `a.go`", metadata: "{not json" },
      // A reviewer removed the links in the editor: the flag stays, the links are gone.
      { id: "d", body: "- `a.go`", metadata: linked.metadata },
      { id: "d", body: linked.body, metadata: JSON.stringify({ codeLinkBase: 7 }) },
    ]) {
      expect(() => assertCodeLinksMatchTarget([draft], other)).not.toThrow();
    }
  });
});

describe("bodyWithCodeAsText — the plain form, for a tracker that is not the repository", () => {
  // A connector spelled with capitals: the base is recorded as written.
  const ACME = {
    origin: "https://github.com",
    owner: "Acme",
    repo: "App",
    ref: "abc1234",
  };
  const base = codeLinkBase(ACME);
  const URL_A = `${base}/blob/main/src/a.ts`;
  const links = [
    link(),
    link({
      filePath: "internal/b.go",
      startLine: 7,
      endLine: null,
      symbolName: null,
    }),
    // A Next.js route: linked by the `source` link after the code span.
    link({
      filePath: "app/[id]/page.tsx",
      startLine: null,
      symbolName: "Page",
      symbolKind: null,
    }),
  ];
  const body = (
    repo: typeof ACME | null,
    text: readonly string[] = ["Requirement text."],
    rows: readonly DraftCodeLink[] = links,
  ) =>
    [
      "## Description",
      "",
      ...text,
      "",
      "## Acceptance criteria",
      "",
      "- [ ] one",
      "",
      ...renderCodeLinksSection(rows, repo),
      "",
      "## Definition of done",
      "",
      "---",
      "> Generated by METIS",
    ].join("\n");
  const meta = (rows: readonly DraftCodeLink[] = links, repo = ACME) =>
    JSON.stringify({
      codeLinkBase: codeLinkBase(repo),
      codeLinkSection: codeLinkSectionRecord(rows, repo),
    });
  const asText = (text: string, metadata: string | null = meta()) =>
    bodyWithCodeAsText({ body: text, metadata });

  /** Everything the cycle-3 review showed the whole-body scan cutting. */
  const USER_TEXT = [
    `Run \`${URL_A}\` then \`other\`.`,
    `See ${URL_A}. Next sentence.`,
    `[t](${URL_A} "title") and [t](<${URL_A}> "title")`,
    `![shot](${URL_A}?raw=true)`,
    `See [the handler](${URL_A}#L3) for detail, and <${URL_A}>.`,
    "```",
    `curl ${URL_A}`,
    "```",
    `[[a](${URL_A})](https://other.example) ${base}/tree/main ${base}/commit/abc1234`,
    "",
    "## Related code",
    "",
    "- my own list, with [a link](https://example.com/x)",
    `- and ${URL_A}`,
  ];

  describe("a section still as METIS wrote it: swapped whole, nothing else read", () => {
    it("puts exactly the text-only section in its place", () => {
      expect(body(ACME)).toContain(`${base}/blob/abc1234/`);
      expect(body(ACME)).toContain(
        `- \`app/[id]/page.tsx\` ([source](${base}/blob/abc1234/app/%5Bid%5D/page.tsx)) — \`Page\``,
      );
      expect(asText(body(ACME))).toBe(body(null));
      // Already plain: unchanged, and the note is not added twice.
      expect(asText(body(null))).toBe(body(null));
      expect(asText(asText(body(ACME))).split(CODE_LINKS_AS_TEXT_NOTE)).toHaveLength(2);
    });

    it("leaves no owner, repository, commit or URL of the analysed repository in the section", () => {
      const plain = asText(body(ACME));
      for (const leak of ["github.com", "Acme", "acme", "abc1234", "]("]) {
        expect(plain, leak).not.toContain(leak);
      }
      expect(plain).toContain(CODE_LINKS_AS_TEXT_NOTE);
    });

    it("sends the user's own text to Jira byte for byte — links, URLs, code, punctuation", () => {
      const plain = asText(body(ACME, USER_TEXT));
      expect(plain).toBe(body(null, USER_TEXT));
      for (const line of USER_TEXT) expect(plain, line).toContain(line);
      // The heading the user wrote keeps its own list and gets no METIS note:
      // the one note is under the section METIS wrote.
      expect(plain.split(CODE_LINKS_AS_TEXT_NOTE)).toHaveLength(2);
      expect(plain.indexOf(CODE_LINKS_AS_TEXT_NOTE)).toBeGreaterThan(
        plain.indexOf("## Acceptance criteria"),
      );
    });

    it("keeps a row whose symbol or path is itself a blob URL of the repository", () => {
      const rows = [
        link({
          filePath: "src/a.ts",
          startLine: 3,
          endLine: null,
          symbolName: `${base}/blob/z`,
        }),
        link({
          filePath: `x](${base}/blob/`,
          startLine: null,
          symbolName: "sym",
        }),
        link({
          filePath: "src/b.ts",
          startLine: null,
          symbolName: `[\`q\`](${base}/blob/q)`,
        }),
      ];
      const plain = asText(body(ACME, undefined, rows), meta(rows));
      expect(plain).toBe(body(null, undefined, rows));
      expect(plain).toContain(`- \`src/a.ts:3\` — \`${base}/blob/z\` (method)`);
      expect(plain).toContain(`- \`x](${base}/blob/\` — \`sym\` (method)`);
    });

    it("is its own plain form, even beside a section a user wrote the way METIS writes one", () => {
      // Adopt writes the Jira form back into the draft. The next comparison
      // must find it unchanged, or the issue reports drift for ever — and the
      // user's own section must not be taken for an edited METIS one then.
      const mine = [
        "## Related code",
        "",
        `- [\`mine.go\`](${base}/blob/main/mine.go) — my own note`,
        "",
        "## More",
      ];
      const once = asText(body(ACME, mine));
      expect(once).toBe(body(null, mine));
      expect(asText(once)).toBe(once);
      expect(once).toContain(`- [\`mine.go\`](${base}/blob/main/mine.go) — my own note`);
    });

    it("swaps every whole-line copy of the section, and no partial one", () => {
      const section = renderCodeLinksSection(links, ACME).join("\n");
      const plainSection = renderCodeLinksSection(links, null).join("\n");
      expect(asText(`${section}\n\ntext\n\n${section}`)).toBe(
        `${plainSection}\n\ntext\n\n${plainSection}`,
      );
      // Not on line boundaries: not the section. (It then counts as edited.)
      expect(asText(`> ${section}`)).toBe(`> ${section}`);
      const trailing = asText(`${section} trailing words`);
      expect(trailing).toContain(CODE_LINKS_EDITED_NOTE);
      expect(trailing).not.toContain(CODE_LINKS_AS_TEXT_NOTE);
    });

    it("adds the note to rows that never had a link, once", () => {
      // Every path here is unsafe to link, so the two sections differ only by the note.
      const rows = [link({ filePath: "../up.go", startLine: null, symbolName: null })];
      const linked = body(ACME, undefined, rows);
      expect(linked).not.toContain("](");
      const plain = asText(linked, meta(rows));
      expect(plain).toBe(body(null, undefined, rows));
      expect(asText(plain, meta(rows))).toBe(plain);
    });
  });

  describe("a section a reviewer edited: METIS's links come off its rows, nothing else", () => {
    const section = renderCodeLinksSection(links, ACME);
    const edited = (text: readonly string[] = ["Requirement text."]) =>
      body(ACME, text)
        .replace("`MarkAllAsRead` (method)", "`MarkAllAsRead` (method) — start here")
        .replace(section[2]!, `${section[2]!}\n\nReviewer: also see [the handler](${URL_A}).`);

    it("takes both link forms off, says the section was edited, and keeps the reviewer's words", () => {
      const plain = asText(edited());
      expect(plain).toContain(
        "- `internal/storage/entry.go:120-148` — `MarkAllAsRead` (method) — start here",
      );
      expect(plain).toContain("- `internal/b.go:7`\n");
      expect(plain).toContain("- `app/[id]/page.tsx` — `Page`\n");
      // A link the reviewer wrote in the section is theirs.
      expect(plain).toContain(`Reviewer: also see [the handler](${URL_A}).`);
      expect(plain).toContain(
        `- \`app/[id]/page.tsx\` — \`Page\`\n\n${CODE_LINKS_EDITED_NOTE}\n\n## Definition of done`,
      );
      expect(plain).not.toContain(CODE_LINKS_AS_TEXT_NOTE);
      expect(plain).not.toContain("abc1234");
      // Stable: a second pass finds nothing left to take off.
      expect(asText(plain)).toBe(plain);
    });

    it("still leaves every byte outside the section alone", () => {
      const plain = asText(edited(USER_TEXT));
      const expected = body(null, USER_TEXT)
        .replace("`MarkAllAsRead` (method)", "`MarkAllAsRead` (method) — start here")
        .replace(
          renderCodeLinksSection(links, null)[2]!,
          `${section[2]!}\n\nReviewer: also see [the handler](${URL_A}).`,
        )
        .replace(CODE_LINKS_AS_TEXT_NOTE, CODE_LINKS_EDITED_NOTE);
      expect(plain).toBe(expected);
      for (const line of USER_TEXT) expect(plain, line).toContain(line);
    });

    it("finds the link whatever the case of the host, owner and name — recorded or in the body", () => {
      const row = `- [\`a.go\`](${base}/blob/abc1234/a.go) — \`f\``;
      const lower = `- [\`b.go\`](${base.toLowerCase()}/blob/abc1234/b.go)`;
      const upper = `- \`c[0].go\` ([source](HTTPS://GITHUB.COM/ACME/APP/blob/abc1234/c%5B0%5D.go))`;
      const text = ["## Related code", "", row, lower, upper].join("\n");
      const expected = [
        "## Related code",
        "",
        "- `a.go` — `f`",
        "- `b.go`",
        "- `c[0].go`",
        "",
        CODE_LINKS_EDITED_NOTE,
      ].join("\n");
      expect(base).toBe("https://github.com/Acme/App");
      expect(asText(text)).toBe(expected);
      // A base recorded in lower case finds the capitals in the body too.
      const lowerMeta = JSON.stringify({
        codeLinkBase: base.toLowerCase(),
        codeLinkSection: { linked: "x", plain: "y" },
      });
      expect(asText(text, lowerMeta)).toBe(expected);
    });

    it("keeps the line endings of a body saved with CRLF", () => {
      const crlf = body(ACME).split("\n").join("\r\n");
      const plain = asText(crlf);
      expect(plain).toContain("- `internal/b.go:7`\r\n");
      expect(plain).toContain(`\r\n\r\n${CODE_LINKS_EDITED_NOTE}\r\n\r\n## Definition of done\r\n`);
      expect(plain.split("\r\n").join("\n").split("\r")).toHaveLength(1);
      expect(plain).not.toContain("abc1234");
    });

    it("changes only a row in METIS's own form, read from the start of the line", () => {
      const untouched = [
        // Not into this repository, or not a blob URL into it.
        "- [`a`](https://github.com/other/repo/blob/x)",
        `- [\`a\`](${base}-other/blob/x)`,
        `- [\`a\`](${base}/issues/1)`,
        `- \`a[0]\` ([source](${base}/tree/main/a))`,
        // Not METIS's link syntax.
        `- [a](${base}/blob/x)`,
        `- [\`a\` b](${base}/blob/x)`,
        `- [\`a\`] (${base}/blob/x)`,
        `- [\`a\`](${base}/blob/x y)`,
        `- [\`a\`](${base}/blob/x`,
        `- [\`\`a\`](${base}/blob/x)`,
        `- \`a\` ([docs](${base}/blob/x))`,
        // The same length as METIS's own syntax, and not it.
        `- \`a\` ([sourcx](${base}/blob/x))`,
        `- [\`a\`]]${base}/blob/x)`,
        `- \`a\` ([source](${base}/blob/x)`,
        `- see [\`a\`](${base}/blob/x)`,
        `  - [\`a\`](${base}/blob/x)`,
        `* [\`a\`](${base}/blob/x)`,
        `[\`a\`](${base}/blob/x)`,
        "- ",
        "- [",
        // The link is not at the start: in a symbol, or after one.
        `- \`a\` — \`[\`b\`](${base}/blob/x)\``,
      ];
      const text = ["## Related code", "", ...untouched].join("\n");
      expect(asText(text)).toBe(text);
      // Outside a Related code section even METIS's exact form is left alone.
      const elsewhere = `## Notes\n\n- [\`a.go\`](${base}/blob/abc1234/a.go)\n\n---\n- [\`a.go\`](${base}/blob/abc1234/a.go)`;
      expect(asText(elsewhere)).toBe(elsewhere);
      expect(asText(`## Related code\n\n---\n- [\`a.go\`](${base}/blob/abc1234/a.go)`)).toContain(
        "](",
      );
    });

    it("handles every Related code heading, each with its own note", () => {
      const text = [
        "## Related code",
        "",
        "- my own list",
        "",
        "## Related code",
        "- [`` a`b ``](" + `${base}/blob/abc1234/a%60b)`,
        "### Sub",
        `- [\`c.go\`](${base}/blob/abc1234/c.go)`,
        "## Related code",
        "",
        `- [\`d.go\`](${base}/blob/abc1234/d.go)`,
        "",
        "",
      ].join("\n");
      expect(asText(text)).toBe(
        [
          "## Related code",
          "",
          "- my own list",
          "",
          "## Related code",
          "- `` a`b ``",
          "",
          CODE_LINKS_EDITED_NOTE,
          "### Sub",
          `- [\`c.go\`](${base}/blob/abc1234/c.go)`,
          "## Related code",
          "",
          "- `d.go`",
          "",
          CODE_LINKS_EDITED_NOTE,
          "",
          "",
        ].join("\n"),
      );
    });

    it("cannot tell a row a user wrote in METIS's exact form from METIS's own", () => {
      // The stated limit of the edited path: under a `## Related code` heading,
      // a row written exactly as METIS writes one loses its link like any other.
      const text = `## Related code\n\n- [\`mine.go\`](${base}/blob/main/mine.go) — my note`;
      expect(asText(text)).toBe(
        `## Related code\n\n- \`mine.go\` — my note\n\n${CODE_LINKS_EDITED_NOTE}`,
      );
    });
  });

  it("reads the record from the draft's metadata; a draft that recorded only the repository gets the ordinary note", () => {
    const linked = body(ACME);
    for (const metadata of [
      JSON.stringify({ codeLinkBase: base }),
      JSON.stringify({ codeLinkBase: base, codeLinkSection: null }),
      JSON.stringify({
        codeLinkBase: base,
        codeLinkSection: { linked: 7, plain: "x" },
      }),
      JSON.stringify({ codeLinkBase: base, codeLinkSection: { linked: "x" } }),
    ]) {
      expect(asText(linked, metadata), metadata).toBe(body(null));
    }
    for (const metadata of [
      null,
      undefined,
      "{not json",
      JSON.stringify({ codeLinkBase: 7 }),
      "{}",
    ]) {
      expect(bodyWithCodeAsText({ body: linked, metadata })).toBe(linked);
    }
    // No repository recorded: the record alone is not acted on.
    expect(
      asText(linked, JSON.stringify({ codeLinkSection: codeLinkSectionRecord(links, ACME) })),
    ).toBe(linked);
  });

  it("the record is null when the two renderings are the same text", () => {
    expect(codeLinkSectionRecord([], ACME)).toBeNull();
    expect(codeLinkSectionRecord(links, ACME)).toEqual({
      linked: renderCodeLinksSection(links, ACME).join("\n"),
      plain: renderCodeLinksSection(links, null).join("\n"),
    });
  });

  it("is linear in a body built to make it scan", () => {
    const metadata = meta();
    const heading = "## Related code\n";
    expectLinearTime("headings", (n) => {
      const text = heading.repeat(Math.ceil(n / heading.length));
      return () => asText(text, metadata);
    });
    expectLinearTime("a row of backticks", (n) => {
      const text = `${heading}- [\`${"x`".repeat(n / 2)}`;
      return () => asText(text, metadata);
    });
    expectLinearTime("unfinished links", (n) => {
      const unit = `- [\`x\`](${base}/blob/\n`;
      const text = heading + unit.repeat(Math.ceil(n / unit.length));
      return () => asText(text, metadata);
    });
    expectLinearTime("near-copies of the section", (n) => {
      const unit = `${renderCodeLinksSection(links, ACME).join("\n")} x\n`;
      const text = unit.repeat(Math.ceil(n / unit.length));
      return () => asText(text, metadata);
    });
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
