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
  MAX_DRAFT_CODE_LINKS,
  assertCodeLinksMatchTarget,
  bodyWithCodeAsText,
  codeLinksAsText,
  publishTargetBase,
  buildCodeLinkUrl,
  codeLinkBase,
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

  it("writes a row whose path or symbol holds a square bracket as plain code, never a link", () => {
    // `[` + a path holding `]:` is a link reference definition to Markdown.
    const rows = (over: Partial<DraftCodeLink>) =>
      renderCodeLinksSection([link(over)], REPO).filter((l) => l.startsWith("- "));
    expect(
      rows({ filePath: "x]:https:/evil.example/y", startLine: null, symbolName: null }),
    ).toEqual(["- `x]:https:/evil.example/y`"]);
    expect(rows({ filePath: "]", startLine: 3, endLine: 9, symbolName: null })).toEqual([
      "- `]:3-9`",
    ]);
    expect(rows({ filePath: "app/[id]/page.tsx", startLine: null, symbolName: null })).toEqual([
      "- `app/[id]/page.tsx`",
    ]);
    expect(rows({ filePath: "a.go", startLine: null, symbolName: "xs[0]" })).toEqual([
      "- `a.go` — `xs[0]` (method)",
    ]);
    // Without a bracket the same row is still a link.
    expect(rows({ filePath: "a.go", startLine: null, symbolName: "xs" })[0]).toMatch(
      /^- \[`a\.go`\]\(https:\/\/github\.com\/miniflux\/v2\/blob\/abc1234\/a\.go\) — `xs`/,
    );
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
      // The host was not given: not known to be the analysed repository.
      { owner: "miniflux", repo: "v2", baseUrl: undefined },
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
    // The same names on public GitHub, or with no host given: text.
    expect((await on(null))?.repo).toBeNull();
    expect((await on(undefined))?.repo).toBeNull();
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

  it("is null when the host is not known or not https", () => {
    expect(publishTargetBase({ owner: "acme", repo: "app", baseUrl: undefined })).toBeNull();
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

describe("codeLinksAsText / bodyWithCodeAsText — the plain form, for a tracker that is not the repository", () => {
  const base = codeLinkBase(REPO);
  const links = [
    link(),
    link({ filePath: "internal/b.go", startLine: 7, endLine: null, symbolName: null }),
  ];
  const section = (repo: typeof REPO | null) =>
    [
      "## Acceptance criteria",
      "",
      "- [ ] one",
      "",
      ...renderCodeLinksSection(links, repo),
      "",
      "## Definition of done",
      "",
      "---",
      "> Generated by METIS",
    ].join("\n");

  it("rewrites a linked section into exactly the text-only section", () => {
    expect(section(REPO)).toContain(`${base}/blob/abc1234/`);
    expect(codeLinksAsText(section(REPO), base)).toBe(section(null));
    expect(codeLinksAsText(section(null), base)).toBe(section(null));
  });

  it("leaves no owner, repository, commit or URL of the analysed repository", () => {
    const plain = codeLinksAsText(section(REPO), base);
    expect(plain).not.toContain("github.com");
    expect(plain).not.toContain("miniflux");
    expect(plain).not.toContain("abc1234");
    expect(plain).toContain(CODE_LINKS_AS_TEXT_NOTE);
  });

  it("takes out a blob URL a reviewer typed, in whatever case, and keeps other links", () => {
    const edited = [
      "See https://GitHub.com/Miniflux/v2/blob/abc1234/internal/a.go#L3 for context,",
      `and <${base}/blob/main/README.md> and [docs](https://example.com/docs).`,
      `Also [the handler](${base}/blob/abc1234/internal/a.go).`,
    ].join("\n");
    const plain = codeLinksAsText(edited, base);
    expect(plain).toBe(
      [
        "See (link removed) for context,",
        "and <(link removed)> and [docs](https://example.com/docs).",
        "Also the handler.",
      ].join("\n"),
    );
  });

  it("adds the note once, under the rows, and only to a section that lists code", () => {
    const empty = [
      "## Related code",
      "",
      "_METIS recorded no code links for this requirement._",
    ].join("\n");
    expect(codeLinksAsText(empty, base)).toBe(empty);
    expect(codeLinksAsText("No section here.", base)).toBe("No section here.");
    const twice = codeLinksAsText(codeLinksAsText(section(REPO), base), base);
    expect(twice.split(CODE_LINKS_AS_TEXT_NOTE)).toHaveLength(2);
  });

  it("reads the repository from the draft's metadata; without one the body is untouched", () => {
    const body = section(REPO);
    expect(bodyWithCodeAsText({ body, metadata: JSON.stringify({ codeLinkBase: base }) })).toBe(
      section(null),
    );
    for (const metadata of [
      null,
      undefined,
      "{not json",
      JSON.stringify({ codeLinkBase: 7 }),
      "{}",
    ]) {
      expect(bodyWithCodeAsText({ body, metadata })).toBe(body);
    }
  });

  it("is linear in a body built to make it scan", () => {
    expectLinearTime("open brackets", (n) => {
      const body = "[".repeat(n);
      return () => codeLinksAsText(body, base);
    });
    expectLinearTime("unfinished links", (n) => {
      const unit = `[x](${base}/blob/`;
      const body = unit.repeat(Math.ceil(n / unit.length));
      return () => codeLinksAsText(body, base);
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
