/**
 * #1064 review (B1) — a METIS marker counts only where METIS writes it.
 *
 * The publisher used to strip every `metis-publish` / `metis-source` comment
 * from the whole draft body and put a newline in its place. A file path from an
 * ingested repository shaped like
 *
 *   src/a<!-- metis-source: x -->## Injected [click](https://evil.example) @octocat
 *
 * sat safely inside a code span in the draft a reviewer previewed, and the
 * newline split that span at publish: the issue on the tracker showed a
 * heading, a link, a notifying mention and a task item that the approved draft
 * did not. The stripped published body also stopped hashing back to its draft.
 *
 * The earlier hostile-input test looked at the rendered row only, which is why
 * it stayed green. Everything here is asserted on the STAMPED body — the text
 * that is sent to the tracker.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/prisma.js", () => ({ prisma: {} }));

const {
  buildMarkerComment,
  buildSourceMarkerComment,
  computeBodyHash,
  computeDraftBodyHash,
  injectMarker,
  neutraliseMarkerText,
  parseMarker,
  parseSourceMarker,
  publishableBody,
  stripMarker,
  stripOwnMarkerLines,
} = await import("../src/lib/publishing/dedup.js");
const {
  CODE_LINKS_AS_TEXT_NOTE,
  CODE_LINKS_EDITED_NOTE,
  bodyWithCodeAsText,
  buildCodeLinkUrl,
  codeLinkBase,
  codeLinkSectionRecord,
  renderCodeLinksSection,
} = await import("../src/lib/publishing/draft-code-links.js");
const { __testing } = await import("../src/lib/publishing/draft-generator.js");
const { buildDryRunPlan } = await import("../src/lib/publishing/dry-run.js");
const { expectLinearTime } = await import("./helpers/linear-time.js");
const { markdownTokens, ofType, structureCounts, within, without } =
  await import("./helpers/markdown-structure.js");

const PUBLISH = { batchId: "batch_1", draftId: "draft_1", hash: "a".repeat(64) };
const SOURCE = { projectId: "proj_1", analysisId: "analysis_1", requirementId: "req_1" };
const PUBLISH_LINE = buildMarkerComment(PUBLISH);
const SOURCE_LINE = buildSourceMarkerComment(SOURCE)!;
/** Exactly what METIS appends to a draft body when it publishes it. */
const BLOCK = `\n\n${SOURCE_LINE}\n${PUBLISH_LINE}\n`;
const REPO = { origin: "https://github.com", owner: "acme", repo: "app", ref: "abc1234" };

/** Anything shaped like a METIS marker, however loosely. */
const MARKER_SHAPED = /<!--\s*metis-(?:publish|source)\s*:/i;

// ---- helpers ---------------------------------------------------------------

/** Deterministic PRNG (mulberry32), so a failure reproduces from its seed. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** What a hostile repository, document or import can put in a name or a text. */
const FRAGMENTS = [
  "<!--",
  "-->",
  // HTML5 also ends a comment at `--!>`, and reads these two as whole comments.
  "--!>",
  "<!-->",
  "<!--->",
  "<!-- metis-publish: batch=b draft=d hash=h --!>",
  "<!-- metis-source: project=p --!>",
  // Square brackets: `[` + text holding `]:` is a link reference definition.
  "]",
  "]:",
  "[",
  "]: https://evil.example/d",
  "]:https:/evil.example/e",
  "[ref]: https://evil.example/r",
  "[ref]",
  "][ref]",
  // Ordinary bracketed names: Next.js dynamic routes, an indexed symbol, nesting.
  "app/[id]/page",
  "[...slug]",
  "[[...all]]",
  "items[0]",
  "[a[b]c]",
  // The repository's own blob prefix — the one string the Jira form looks for —
  // bare, in METIS's two link forms, with capitals, and as a whole section.
  "https://github.com/acme/app/blob/",
  "https://github.com/acme/app/blob/abc1234/src/a.ts#L3",
  "https://GitHub.com/Acme/App/blob/z",
  "](https://github.com/acme/app/blob/x",
  "](https://github.com/acme/app/blob/x)",
  "[`a.ts`](https://github.com/acme/app/blob/abc1234/a.ts)",
  " ([source](https://github.com/acme/app/blob/abc1234/a.ts))",
  "\n## Related code\n",
  "\n- [`a.ts`](https://github.com/acme/app/blob/abc1234/a.ts) — `f`\n",
  "\n- `a[0].ts` ([source](https://github.com/acme/app/blob/abc1234/a%5B0%5D.ts))\n",
  "\n---\n",
  "www.evil.example",
  "https://evil.example/bare",
  "![i](https://evil.example/i.png)",
  "~~s~~",
  "**b**",
  "&amp;",
  "<!-- metis-publish: batch=b draft=d hash=h -->",
  "<!-- metis-source: project=p analysis=a requirement=r -->",
  "<!-- metis-source: x -->",
  "<!--metis-source:x-->",
  "<!--\tMETIS-PUBLISH : batch=b draft=d hash=h-->",
  "<!--\nmetis-source: project=p -->",
  "\n<!-- metis-publish: batch=b draft=d hash=h -->\n",
  "\n<!-- metis-source: project=evil -->\n<!-- metis-publish: batch=x draft=y hash=z -->",
  "\n",
  "\n\n",
  "\r\n",
  "\u2028",
  "\u2029",
  "\u0085",
  "`",
  "``",
  "```",
  "`````",
  "@octocat",
  " @org/team ",
  "closes #1",
  "Fixes #2",
  "resolves acme/app#3",
  "[l](https://evil.example/x)",
  "](https://evil.example/y)",
  "<https://evil.example/z>",
  "## Injected heading",
  "- [ ] injected task",
  "\u200b",
  "\u200d",
  "\u202e",
  "\ufeff",
  "😀",
  "</code>",
  "<img src=x onerror=alert(1)>",
  "|",
  "    ",
  " ",
  "src/",
  "a",
  ".ts",
  "\\",
];

function hostile(rand: () => number, max = 8): string {
  const n = 1 + Math.floor(rand() * max);
  let out = "";
  for (let i = 0; i < n; i += 1) out += FRAGMENTS[Math.floor(rand() * FRAGMENTS.length)];
  return out;
}

/**
 * A "Related code" row with its code spans removed — the spans as the Markdown
 * PARSER found them, not as a scan for backticks would: only METIS's own markup
 * is left.
 */
// No link; the code span as the link's text; or the fixed `source` link after it.
const ROW_SKELETON =
  /^- (?:\[\]\(https:\/\/github\.com\/acme\/app\/blob\/abc1234\/[A-Za-z0-9%._~!*'/-]*(?:#L\d+(?:-L\d+)?)?\)| \(\[source\]\(https:\/\/github\.com\/acme\/app\/blob\/abc1234\/[A-Za-z0-9%._~!*'/-]*(?:#L\d+(?:-L\d+)?)?\)\))?(?: — (?: \([a-z_-]+\))?)?$/;

/** Where METIS's own links go, and nowhere else. */
const ALLOWED_LINK_PREFIX = "https://github.com/acme/app/blob/abc1234/";

/** Everything the parser may find inside a row: a list item of code spans and one link. */
const ROW_TOKEN_TYPES = new Set([
  // The list itself, when it holds this one row.
  "listUnordered",
  "listItemPrefix",
  "listItemMarker",
  "listItemPrefixWhitespace",
  "content",
  "paragraph",
  "data",
  "codeText",
  "codeTextSequence",
  "codeTextData",
  "codeTextPadding",
  "link",
  "label",
  "labelMarker",
  "labelText",
  "resource",
  "resourceMarker",
  "resourceDestination",
  "resourceDestinationRaw",
  "resourceDestinationString",
]);

type HostileLink = {
  filePath: string;
  startLine: number | null;
  endLine: number | null;
  symbolName: string | null;
  symbolKind: string | null;
};

const SAFE_LINK: HostileLink = {
  filePath: "src/safe.ts",
  startLine: 3,
  endLine: 9,
  symbolName: "safe",
  symbolKind: "function",
};

/** A feature body whose ONLY untrusted text is its code links (and `text`, when given). */
function featureWithLinks(
  links: readonly HostileLink[],
  repo: typeof REPO | null,
  text = "Body text.",
): string {
  return __testing.renderFeatureBody({
    project: { id: "proj_1", name: "App" },
    analysis: { id: "analysis_1" },
    requirement: {
      id: "req_1",
      title: "T",
      body: text,
      type: "feature",
      priority: "high",
      acceptanceCriteria: JSON.stringify(["First criterion", "Second criterion"]),
    },
    parentTitle: "[Epic] App",
    codeLinks: { links, repo },
  });
}

/** How many rows the section shows: exact repeats once, at most ten. */
function expectedRows(links: readonly HostileLink[]): number {
  const keys = new Set(
    links.map((l) => JSON.stringify([l.filePath, l.startLine, l.endLine, l.symbolName])),
  );
  return Math.min(keys.size, 10);
}

/**
 * The Related code invariant, asserted on the PARSED stamped body — what the
 * tracker's Markdown renderer will make of the text METIS sends:
 *
 *  (i)   every row is a list item holding only code spans, METIS's own
 *        separators, and at most METIS's own link to the allowed origin, whose
 *        text is a code span with no square bracket in it or the word `source`;
 *  (ii)  no heading, list, quote, task item, HTML, image, autolink, link
 *        reference definition, code block, emphasis or table in the document
 *        comes from a path or a symbol: the document has exactly the structure
 *        of the same body with one harmless link, and no link but METIS's;
 *  (iii) nothing mention-shaped, no closing keyword and no foreign host sits
 *        outside a code span.
 */
function expectRelatedCodeInert(
  links: readonly HostileLink[],
  repo: typeof REPO | null,
  label: string,
): { rows: number; linked: number; afterSpan: number } {
  let afterSpan = 0;
  const draft = featureWithLinks(links, repo);
  const published = injectMarker(draft, PUBLISH, SOURCE);
  expect(published, label).toBe(draft + BLOCK);
  const tokens = markdownTokens(published);
  const control = markdownTokens(
    injectMarker(featureWithLinks([SAFE_LINK], repo), PUBLISH, SOURCE),
  );

  // (ii) the structure is the template's: nothing was added, nothing swallowed.
  expect(structureCounts(tokens), label).toEqual(structureCounts(control));
  const headings = ofType(tokens, "atxHeading");
  expect(
    headings.map((t) => t.text),
    label,
  ).toEqual(ofType(control, "atxHeading").map((t) => t.text));
  expect(
    ofType(tokens, "htmlFlow").map((t) => t.text),
    label,
  ).toEqual([SOURCE_LINE, PUBLISH_LINE]);

  // (i) the rows.
  const at = headings.findIndex((t) => t.text === "## Related code");
  expect(at, label).toBeGreaterThanOrEqual(0);
  const sectionStart = headings[at]!.end;
  const sectionEnd = headings[at + 1]!.start;
  const prefixes = ofType(within(tokens, sectionStart, sectionEnd), "listItemPrefix");
  expect(prefixes.length, label).toBe(expectedRows(links));
  const rowLines = published
    .slice(sectionStart, sectionEnd)
    .split("\n")
    .filter((l) => l.startsWith("- "));
  expect(rowLines.length, label).toBe(prefixes.length);
  const resources: Array<{ start: number; end: number }> = [];
  for (const prefix of prefixes) {
    const end = published.indexOf("\n", prefix.start);
    const rowLabel = `${label}: ${published.slice(prefix.start, end)}`;
    expect(published[prefix.start - 1], rowLabel).toBe("\n");
    const row = within(tokens, prefix.start, end);
    expect(
      row.filter((t) => !ROW_TOKEN_TYPES.has(t.type)).map((t) => t.type),
      rowLabel,
    ).toEqual([]);
    const codes = ofType(row, "codeText");
    expect(codes.length === 1 || codes.length === 2, rowLabel).toBe(true);
    const rowLinks = ofType(row, "link");
    expect(rowLinks.length, rowLabel).toBeLessThanOrEqual(repo ? 1 : 0);
    for (const link of rowLinks) {
      const inside = within(row, link.start, link.end);
      const text = ofType(inside, "labelText");
      expect(text, rowLabel).toHaveLength(1);
      const bracketed = /[[\]]/.test(codes[0]!.text);
      if (link.start === prefix.end) {
        // The link opens the row and wraps exactly the first code span, which
        // holds no square bracket.
        expect([text[0]!.start, text[0]!.end], rowLabel).toEqual([codes[0]!.start, codes[0]!.end]);
        expect(bracketed, rowLabel).toBe(false);
      } else {
        // The first code span opens the row, holds a bracket, and is followed
        // by METIS's fixed link text.
        expect(codes[0]!.start, rowLabel).toBe(prefix.end);
        expect(published.slice(codes[0]!.end, link.start), rowLabel).toBe(" (");
        expect(text[0]!.text, rowLabel).toBe("source");
        expect(bracketed, rowLabel).toBe(true);
        afterSpan += 1;
      }
      const destination = ofType(inside, "resourceDestinationString");
      expect(destination, rowLabel).toHaveLength(1);
      expect(destination[0]!.text.startsWith(ALLOWED_LINK_PREFIX), rowLabel).toBe(true);
      resources.push(...ofType(inside, "resource"));
    }
    expect(without(published, codes, prefix.start, end), rowLabel).toMatch(ROW_SKELETON);
  }
  // (ii) no link anywhere but METIS's own, counted above. A reference-style
  // link (one resolved through a definition) has no resource and so no place
  // in that count.
  expect(ofType(tokens, "link").length, label).toBe(resources.length);

  // (iii) outside the code spans and METIS's own link targets.
  const outside = without(published, [...ofType(tokens, "codeText"), ...resources]);
  expect(outside, label).not.toMatch(/@[A-Za-z0-9]/);
  expect(outside, label).not.toMatch(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b[^\n]*#\d/i);
  expect(outside, label).not.toContain("evil.example");
  return { rows: prefixes.length, linked: resources.length, afterSpan };
}

function hostileFeature(rand: () => number, repo: typeof REPO | null) {
  const links = Array.from({ length: 1 + Math.floor(rand() * 4) }, () => ({
    filePath: hostile(rand),
    startLine: rand() < 0.5 ? 3 : null,
    endLine: rand() < 0.5 ? 9 : null,
    symbolName: rand() < 0.8 ? hostile(rand) : null,
    symbolKind: rand() < 0.5 ? "function" : hostile(rand, 2),
  }));
  const draft = __testing.renderFeatureBody({
    project: { id: "proj_1", name: hostile(rand, 3) },
    analysis: { id: "analysis_1" },
    requirement: {
      id: "req_1",
      title: hostile(rand, 4),
      body: hostile(rand, 12),
      type: "feature",
      priority: "high",
      acceptanceCriteria: JSON.stringify([hostile(rand, 4), hostile(rand, 4)]),
    },
    parentTitle: `[Epic] ${hostile(rand, 4)}`,
    codeLinks: { links, repo },
  });
  return { draft, links };
}

/** The invariants every draft body METIS writes must hold once it is stamped. */
function expectPublishedAsPreviewed(draft: string, label: string) {
  const published = injectMarker(draft, PUBLISH, SOURCE);
  // 1. What is sent is the previewed draft plus exactly METIS's marker block.
  expect(published, label).toBe(draft + BLOCK);
  // 2. The published body strips and hashes back to its draft.
  const stripped = stripMarker(published);
  expect(stripped, label).toBe(draft);
  expect(computeBodyHash(stripped), label).toBe(computeBodyHash(draft));
  expect(computeDraftBodyHash(draft), label).toBe(computeBodyHash(draft));
  // 3. Stripping is idempotent, and a draft holds nothing to strip.
  expect(stripMarker(stripped), label).toBe(stripped);
  expect(stripMarker(draft), label).toBe(draft);
  // 4. The only markers in the published body are the two METIS wrote.
  expect(MARKER_SHAPED.test(draft), label).toBe(false);
  expect(parseMarker(published), label).toEqual(PUBLISH);
  expect(parseSourceMarker(published), label).toEqual({ form: "marker", ...SOURCE });
  // 5. Publishing again (a retry, another batch) changes only the block.
  expect(injectMarker(published, PUBLISH, SOURCE), label).toBe(published);
}

// ---- the reported case -----------------------------------------------------

describe("the reviewer's reproduction: a marker-shaped path and symbol name", () => {
  const links = [
    {
      filePath:
        "src/a<!-- metis-source: x -->## Injected heading [click](https://evil.example/x) @octocat closes #1 .ts",
      startLine: 3,
      endLine: 9,
      symbolName:
        "sym<!-- metis-publish: batch=b draft=d hash=h -->- [ ] injected task [l](https://evil.example/y)",
      symbolKind: "function",
    },
  ];
  const draft = __testing.renderFeatureBody({
    project: { id: "proj_1", name: "App" },
    analysis: { id: "analysis_1" },
    requirement: { id: "req_1", title: "T", body: "Body.", type: "feature", priority: "high" },
    parentTitle: "[Epic] App",
    codeLinks: { links, repo: REPO },
  });
  const published = injectMarker(draft, PUBLISH, SOURCE);

  it("publishes the previewed draft, unchanged, in front of the marker block", () => {
    expectPublishedAsPreviewed(draft, "reproduction");
  });

  it("keeps the row on one line, so nothing in it starts a block on the tracker", () => {
    const rows = published.split("\n").filter((l) => l.startsWith("- `"));
    expect(rows).toHaveLength(1);
    // No line of the published body begins with the injected heading or task.
    for (const line of published.split("\n")) {
      expect(line.startsWith("## Injected")).toBe(false);
      expect(line.startsWith("- [ ] injected")).toBe(false);
    }
  });

  it("parses as one row of code spans: no heading, task, link, mention or keyword from the names", () => {
    // The row is plain code in both modes: a path holding `//` is not a
    // plain repository-relative path, so there is nothing to link to.
    const plainRow = { rows: 1, linked: 0, afterSpan: 0 };
    expect(expectRelatedCodeInert(links, REPO, "reproduction")).toEqual(plainRow);
    expect(expectRelatedCodeInert(links, null, "reproduction, text")).toEqual(plainRow);
  });

  it("the dry-run plan shows the same body the live run sends", () => {
    const plan = buildDryRunPlan({
      batchId: PUBLISH.batchId,
      targetOwner: "acme",
      targetRepo: "app",
      targetBaseUrl: "https://api.github.com",
      provider: "github",
      drafts: [
        {
          id: PUBLISH.draftId,
          title: "T",
          body: draft,
          labels: [],
          parentDraftId: null,
          draftType: "feature",
          source: SOURCE,
        },
      ],
      additionalLabels: [],
      existingByHash: new Map(),
      perCallMs: 0,
    });
    const create = plan.actions.find((a) => a.kind === "issue.create");
    expect(stripMarker(create!.body!)).toBe(draft);
    expect(create!.body!.startsWith(`${draft}\n\n${SOURCE_LINE}\n`)).toBe(true);
  });
});

// ---- the property ----------------------------------------------------------

describe("property: hostile text never changes what is published relative to the preview", () => {
  it("feature drafts — paths, symbols, titles, bodies, criteria, project and epic names", () => {
    for (let seed = 1; seed <= 400; seed += 1) {
      const rand = prng(seed);
      const { draft } = hostileFeature(rand, seed % 2 === 0 ? REPO : null);
      expectPublishedAsPreviewed(draft, `feature seed ${seed}`);
    }
  });

  it("epic drafts — project name and requirement titles", () => {
    for (let seed = 1; seed <= 200; seed += 1) {
      const rand = prng(seed + 10_000);
      const draft = __testing.renderEpicBody({
        project: { id: "proj_1", name: hostile(rand, 4) },
        analysis: { id: "analysis_1", startedAt: new Date("2026-09-29T14:05:33.000Z") },
        requirements: Array.from({ length: 3 }, (_, i) => ({
          id: `req_${i}`,
          title: hostile(rand, 6),
          type: "feature",
          priority: "high",
        })),
      });
      expectPublishedAsPreviewed(draft, `epic seed ${seed}`);
    }
  });

  it("Related code, through a Markdown parser — a path or symbol adds nothing to the issue", () => {
    let rows = 0;
    let linked = 0;
    let afterSpan = 0;
    let bracketedLinked = 0;
    for (let seed = 1; seed <= 500; seed += 1) {
      const rand = prng(seed + 20_000);
      const links: HostileLink[] = Array.from({ length: 1 + Math.floor(rand() * 4) }, () => ({
        // Half are hostile through and through; half are a plain relative path
        // with something hostile in it, which is what gets as far as a link.
        filePath: rand() < 0.5 ? hostile(rand) : `src/${hostile(rand, 2)}.ts`,
        startLine: rand() < 0.5 ? 3 : null,
        endLine: rand() < 0.5 ? 9 : null,
        symbolName: rand() < 0.6 ? hostile(rand, 3) : null,
        symbolKind: rand() < 0.5 ? "function" : hostile(rand, 2),
      }));
      for (const repo of [REPO, null]) {
        const seen = expectRelatedCodeInert(links, repo, `seed ${seed}${repo ? "" : " (text)"}`);
        rows += seen.rows;
        linked += seen.linked;
        afterSpan += seen.afterSpan;
      }
      // Rows whose LOCATION holds a square bracket and that have a URL: every
      // one of them is linked, by the link that follows the code span.
      const shown = new Set<string>();
      for (const l of links) {
        const key = JSON.stringify([l.filePath, l.startLine, l.endLine, l.symbolName]);
        if (shown.has(key)) continue;
        shown.add(key);
        if (/[[\]]/.test(l.filePath) && buildCodeLinkUrl(REPO, l) !== null) bracketedLinked += 1;
      }
      for (const row of renderCodeLinksSection(links, REPO).filter((l) => l.startsWith("- "))) {
        // One line by every definition of a line break.
        expect(/[\n\r\u0085\u2028\u2029]/.test(row), `seed ${seed}: ${row}`).toBe(false);
        // No comment can open or close inside it, by HTML5's rules or CommonMark's.
        expect(/<!--|--!?>/.test(row), `seed ${seed}: ${row}`).toBe(false);
        // No invisible character survives to hide or reorder what is shown.
        expect(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/.test(row), row).toBe(false);
      }
    }
    // The generator reaches every form: rows linked through their code span,
    // and bracketed rows linked by the `source` link — none of which lost it.
    expect(rows).toBeGreaterThan(1500);
    expect(linked - afterSpan).toBeGreaterThan(100);
    expect(afterSpan).toBeGreaterThan(100);
    expect(afterSpan).toBe(bracketedLinked);
  });

  const BARE_LINK = { startLine: null, endLine: null, symbolName: null, symbolKind: null };

  it("the parser check is real: it fails on the row a bracketed path used to produce", () => {
    // Red control. This is the row METIS wrote for the path
    // `x]:https:/evil.example/y` when every location was link text — to
    // Markdown a link reference definition: an empty bullet, and a label the
    // rest of the body can link through.
    const before =
      "- [`x]:https:/evil.example/y`](https://github.com/acme/app/blob/abc1234/x%5D%3Ahttps%3A/evil.example/y)";
    const body = `## Related code\n\n${before}\n\nSee [\`x] for details.\n`;
    const tokens = markdownTokens(body);
    expect(ofType(tokens, "definition")).toHaveLength(1);
    const resolved = ofType(tokens, "link");
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.text).toBe("[`x]");
    // …and the invariant sees it: the same row fed through the check fails.
    const link = { ...BARE_LINK, filePath: "x]:https:/evil.example/y" };
    const now = renderCodeLinksSection([link], REPO).filter((l) => l.startsWith("- "));
    expect(now).toEqual([
      "- `x]:https:/evil.example/y` ([source](https://github.com/acme/app/blob/abc1234/x%5D%3Ahttps%3A/evil.example/y))",
    ]);
    const published = injectMarker(featureWithLinks([link], REPO), PUBLISH, SOURCE);
    expect(ofType(markdownTokens(published.replace(now[0]!, before)), "definition")).toHaveLength(
      1,
    );
    expect(ofType(markdownTokens(published), "definition")).toHaveLength(0);
  });

  it("a bracketed location keeps its link — written after the code span, with METIS's own text", () => {
    // The cycle-2 attack shapes and the ordinary ones (a Next.js route is a
    // bracketed path): each row is linked, defines nothing, and passes the
    // whole parser invariant.
    for (const filePath of [
      "]",
      "]:",
      "x]:https:/evil.example/y",
      "[",
      "[[",
      "]]",
      "a]b.ts",
      "a[b.ts",
      "[a[b]c]/[[...all]]/x.ts",
      "][ref]",
      "[ref]: x",
      "app/[id]/page.tsx",
      "app/[...slug]/page.tsx",
    ]) {
      for (const range of [
        { startLine: null, endLine: null },
        { startLine: 3, endLine: 9 },
      ]) {
        for (const symbolName of [null, "items[0]: x", "]: https://evil.example/s"]) {
          const link = { ...BARE_LINK, ...range, filePath, symbolName };
          const label = `${filePath} ${range.startLine ?? "-"} ${symbolName ?? "-"}`;
          const [row] = renderCodeLinksSection([link], REPO).filter((l) => l.startsWith("- "));
          expect(row!.startsWith("- `"), label).toBe(true);
          expect(row, label).toContain(" ([source](https://github.com/acme/app/blob/abc1234/");
          expect(expectRelatedCodeInert([link], REPO, label), label).toEqual({
            rows: 1,
            linked: 1,
            afterSpan: 1,
          });
        }
      }
    }
    // A bracket in the SYMBOL alone changes nothing: the location is the link's text.
    const symbolRow = renderCodeLinksSection(
      [{ ...BARE_LINK, filePath: "src/a.ts", symbolName: "items[0]: x" }],
      REPO,
    );
    expect(symbolRow.filter((l) => l.startsWith("- "))).toEqual([
      "- [`src/a.ts`](https://github.com/acme/app/blob/abc1234/src/a.ts) — `items[0]: x`",
    ]);
    expect(
      expectRelatedCodeInert(
        [{ ...BARE_LINK, filePath: "src/a.ts", symbolName: "items[0]: x" }],
        REPO,
        "bracketed symbol",
      ),
    ).toEqual({ rows: 1, linked: 1, afterSpan: 0 });
  });

  /** The metadata a draft generated for `repo` records, as the generator writes it. */
  function linkedMetadata(links: readonly HostileLink[], repo: typeof REPO): string {
    const codeLinkSection = codeLinkSectionRecord(links, repo);
    return JSON.stringify({
      codeLinkBase: codeLinkBase(repo),
      ...(codeLinkSection ? { codeLinkSection } : {}),
    });
  }

  function hostileLinks(rand: () => number): HostileLink[] {
    return Array.from({ length: 1 + Math.floor(rand() * 13) }, () => ({
      filePath: rand() < 0.3 ? hostile(rand) : `src/${hostile(rand, 2)}.ts`,
      startLine: rand() < 0.5 ? 3 : null,
      endLine: rand() < 0.5 ? 9 : null,
      symbolName: rand() < 0.6 ? hostile(rand, 3) : null,
      symbolKind: rand() < 0.5 ? "function" : null,
    }));
  }

  it("the plain form has one definition: the linked body's Jira form equals the body generated as text", () => {
    // Jira, and any tracker that is not the analysed repository, gets
    // `bodyWithCodeAsText(linked draft)`. For every set of links AND every
    // requirement text that must be, character for character, what the
    // generator writes when it has no repository to link into: the section is
    // the plain one and nothing else in the body moved — including text that
    // holds the repository's own blob URLs, link forms and section heading.
    let rewritten = 0;
    let prefixInText = 0;
    let prefixInRows = 0;
    for (let seed = 1; seed <= 400; seed += 1) {
      const rand = prng(seed + 40_000);
      // The connector's spelling is recorded as written, capitals included.
      const repo = seed % 3 === 0 ? { ...REPO, owner: "Acme", repo: "App" } : REPO;
      const links = hostileLinks(rand);
      const text = hostile(rand, 10);
      const linkedBody = featureWithLinks(links, repo, text);
      const textBody = featureWithLinks(links, null, text);
      const metadata = linkedMetadata(links, repo);
      const plain = bodyWithCodeAsText({ body: linkedBody, metadata });
      expect(plain, `seed ${seed}`).toBe(textBody);
      // Already plain: unchanged.
      expect(bodyWithCodeAsText({ body: plain, metadata }), `seed ${seed}`).toBe(plain);
      if (linkedBody !== textBody) rewritten += 1;
      if (/github\.com\/acme\/app\/blob\//i.test(text)) prefixInText += 1;
      if (links.some((l) => /github\.com\/acme\/app\/blob\//i.test(`${l.filePath}${l.symbolName}`)))
        prefixInRows += 1;
    }
    expect(rewritten).toBeGreaterThan(200);
    // The generator did produce the input the swap could have mistaken.
    expect(prefixInText).toBeGreaterThan(100);
    expect(prefixInRows).toBeGreaterThan(100);
  });

  it("an edited section loses METIS's links and nothing else, row for row as the plain form", () => {
    // A reviewer's edit means the recorded section no longer matches, so the
    // links are taken off row by row. For every set of links that gives the
    // plain rows exactly — the two ways of getting there agree — under the
    // note that says the section was edited.
    const INTRO = "_Code METIS linked to this requirement.";
    let stripped = 0;
    for (let seed = 1; seed <= 400; seed += 1) {
      const rand = prng(seed + 50_000);
      const repo = seed % 3 === 0 ? { ...REPO, owner: "Acme", repo: "App" } : REPO;
      const links = hostileLinks(rand);
      const edit = (body: string) => body.replace(INTRO, `Reviewed. ${INTRO}`);
      const linkedBody = edit(featureWithLinks(links, repo));
      const textBody = edit(featureWithLinks(links, null));
      expect(linkedBody).toContain(`Reviewed. ${INTRO}`);
      // Does any shown row carry a link? (Exact repeats once, the first ten.)
      const rowsOf = (r: typeof REPO | null) =>
        renderCodeLinksSection(links, r).filter((l) => l.startsWith("- "));
      const anyLink = rowsOf(repo).join("\n") !== rowsOf(null).join("\n");
      for (const metadata of [
        linkedMetadata(links, repo),
        // A draft that recorded only the repository gets the ordinary note.
        JSON.stringify({ codeLinkBase: codeLinkBase(repo) }),
      ]) {
        const recorded = metadata.includes("codeLinkSection");
        const expected = !anyLink
          ? linkedBody
          : recorded
            ? textBody.replace(CODE_LINKS_AS_TEXT_NOTE, CODE_LINKS_EDITED_NOTE)
            : textBody;
        expect(bodyWithCodeAsText({ body: linkedBody, metadata }), `seed ${seed}`).toBe(expected);
      }
      if (anyLink) stripped += 1;
    }
    expect(stripped).toBeGreaterThan(200);
  });

  it("a body written before this rule still publishes one stable text", () => {
    // Rows stored before marker text was neutralised can hold it anywhere,
    // including as their last lines. Whatever they hold: the published text is
    // stable, hashes back, and re-stamps to itself — so no PATCH on every run.
    for (let seed = 1; seed <= 400; seed += 1) {
      const rand = prng(seed + 30_000);
      const legacy = hostile(rand, 14);
      const published = injectMarker(legacy, PUBLISH, SOURCE);
      const label = `legacy seed ${seed}`;
      expect(published, label).toBe(publishableBody(legacy) + BLOCK);
      expect(computeBodyHash(stripMarker(published)), label).toBe(computeDraftBodyHash(legacy));
      expect(stripMarker(stripMarker(published)), label).toBe(stripMarker(published));
      expect(injectMarker(published, PUBLISH, SOURCE), label).toBe(published);
      expect(parseMarker(published), label).toEqual(PUBLISH);
      expect(MARKER_SHAPED.test(stripMarker(published)), label).toBe(false);
    }
  });
});

// ---- the rule, case by case ------------------------------------------------

describe("stripMarker — only the trailing block METIS wrote", () => {
  it("removes the block and the blank lines before it", () => {
    expect(stripMarker(`Body${BLOCK}`)).toBe("Body");
    expect(stripMarker(`Body\n\n\n${PUBLISH_LINE}\n\n\n`)).toBe("Body");
    expect(stripMarker(`Body\n${PUBLISH_LINE}`)).toBe("Body");
    // An issue edited on github.com comes back with CRLF line endings.
    expect(stripMarker(`Body\r\n\r\n${SOURCE_LINE}\r\n${PUBLISH_LINE}\r\n`)).toBe("Body");
  });

  it("never touches marker-shaped text anywhere else", () => {
    for (const body of [
      `a ${PUBLISH_LINE} b`,
      `\`src/a${SOURCE_LINE}b.ts\``,
      `${PUBLISH_LINE}\nmore text`,
      `a\n\n${SOURCE_LINE}\n${PUBLISH_LINE}\n\ntext added below the block`,
      // Indented four spaces it is a code block, not a marker line.
      `a\n\n    ${PUBLISH_LINE}`,
      `a\n> ${PUBLISH_LINE}`,
      // A source marker alone is not something METIS writes.
      `a\n\n${SOURCE_LINE}`,
      "a\n<!-- metis-publish: batch=b -->",
    ]) {
      expect(stripMarker(body)).toBe(body);
    }
  });

  it("with a marker mid-body AND the block, removes only the block", () => {
    const body = `one ${SOURCE_LINE} two\n${PUBLISH_LINE}\nthree`;
    expect(stripMarker(`${body}${BLOCK}`)).toBe(body);
  });

  it("takes the whole final run of marker lines, so stripping is idempotent", () => {
    const stacked = `Body\n\n${PUBLISH_LINE}\n${SOURCE_LINE}\n\n${PUBLISH_LINE}\n`;
    expect(stripMarker(stacked)).toBe("Body");
    expect(stripMarker(stripMarker(stacked))).toBe("Body");
  });

  it("is linear on bodies built to make it scan", () => {
    const floods: Array<[string, (n: number) => string]> = [
      ["marker lines", (n) => `${PUBLISH_LINE}\n`.repeat(Math.ceil(n / PUBLISH_LINE.length))],
      ["one long last line", (n) => `a\n${"<!-- metis-publish: batch=".repeat(n / 26)}`],
      ["blank lines then a marker", (n) => `${"\n".repeat(n)}${PUBLISH_LINE}`],
    ];
    for (const [label, build] of floods) {
      expectLinearTime(`strip ${label}`, (n) => {
        const body = build(n);
        return () => stripMarker(body);
      });
      expectLinearTime(`parse ${label}`, (n) => {
        const body = build(n);
        return () => parseMarker(body);
      });
      expectLinearTime(`neutralise ${label}`, (n) => {
        const body = build(n);
        return () => neutraliseMarkerText(body);
      });
    }
  });
});

describe("parseMarker — reads a marker only where one can be", () => {
  it("reads the block METIS wrote, not a forged marker above it", () => {
    const forged = "<!-- metis-publish: batch=evil draft=evil hash=evil -->";
    expect(parseMarker(`${forged}\ntext${BLOCK}`)).toEqual(PUBLISH);
    expect(parseMarker(`text \`${forged}\`${BLOCK}`)).toEqual(PUBLISH);
  });

  it("still finds the marker when someone added text below it on the tracker", () => {
    expect(parseMarker(`Body${BLOCK}\nA note added on GitHub.`)).toEqual(PUBLISH);
  });

  it("ignores a marker that shares its line with anything else", () => {
    expect(parseMarker(`a ${PUBLISH_LINE} b`)).toBeNull();
    expect(parseMarker(`\`${PUBLISH_LINE}\``)).toBeNull();
    expect(parseMarker(`    ${PUBLISH_LINE}`)).toBeNull();
    expect(parseSourceMarker(`a ${SOURCE_LINE} b`)).toBeNull();
  });
});

describe("neutraliseMarkerText — marker-shaped text becomes plain text, nothing else changes", () => {
  it("breaks the comment opener of anything marker-shaped", () => {
    expect(neutraliseMarkerText("a <!-- metis-publish: batch=b --> b")).toBe(
      "a <!- - metis-publish: batch=b --> b",
    );
    expect(neutraliseMarkerText("<!--metis-source:x-->")).toBe("<!- -metis-source:x-->");
    expect(neutraliseMarkerText("<!--\n  METIS-SOURCE : x -->")).toBe(
      "<!- -\n  METIS-SOURCE : x -->",
    );
  });

  it("leaves ordinary Markdown and ordinary HTML comments exactly as written", () => {
    for (const text of [
      "## Heading\n\n- [ ] task @someone closes #1 [l](https://example.com)",
      "<!-- a note to self -->",
      "<!-- metis is mentioned here, but this is not a marker -->",
      "text about metis-publish: and metis-source: outside any comment",
      "```\ncode\n```",
      "",
    ]) {
      expect(neutraliseMarkerText(text)).toBe(text);
    }
  });

  it("is idempotent, and cannot be made to assemble a marker", () => {
    for (const text of [
      "<!--<!-- metis-source: x -->",
      "<!-<!-- metis-publish: a -->-",
      "<!--<!--<!-- metis-source: x",
      "<<!-- metis-source: x -->!-- metis-source: y -->",
    ]) {
      const once = neutraliseMarkerText(text);
      expect(neutraliseMarkerText(once)).toBe(once);
      expect(MARKER_SHAPED.test(once)).toBe(false);
    }
  });
});

describe("publishableBody — rows written before the rule", () => {
  it("drops METIS's own block from a draft that adopted a remote body", () => {
    expect(publishableBody(`Adopted text${BLOCK}`)).toBe("Adopted text");
  });

  it("makes a marker in the middle inert instead of cutting the text there", () => {
    const body = `\`src/a${SOURCE_LINE}## heading\` and more`;
    const out = publishableBody(body);
    expect(out).toBe(
      "`src/a<!- - metis-source: project=proj_1 analysis=analysis_1 requirement=req_1 -->## heading` and more",
    );
    expect(out.split("\n")).toHaveLength(1);
  });

  it("is the body itself for anything the generator or the editor wrote", () => {
    const clean = "## Description\n\nText\n\n---\n> Generated by METIS";
    expect(publishableBody(clean)).toBe(clean);
    expect(computeDraftBodyHash(clean)).toBe(computeBodyHash(clean));
  });
});

// ---- #1102 review, cycle 2 -------------------------------------------------

describe("comment closers — HTML5 ends a comment at --!> too, CommonMark only at -->", () => {
  it("a code span holds neither closer, and none of the opener's forms", async () => {
    const { inlineCode } = await import("../src/lib/publishing/draft-code-links.js");
    expect(inlineCode("a-->b")).toBe("`a- ->b`");
    expect(inlineCode("a--!>b")).toBe("`a- -!>b`");
    // The short forms HTML5 and CommonMark both read as whole comments.
    expect(inlineCode("a<!-->b")).toBe("`a<!- ->b`");
    expect(inlineCode("a<!--->b")).toBe("`a<!- - ->b`");
    expect(inlineCode("<!-- x --!>")).toBe("`<!- - x - -!>`");
    for (const text of ["-->", "--!>", "<!-->", "<!--->", "<!---->", "--!>-->", "---!>"]) {
      expect(/<!--|--!?>/.test(inlineCode(`x${text}y`)), text).toBe(false);
    }
  });

  it("a line ending --!> is not a marker, and its opener is made inert all the same", () => {
    const line = "<!-- metis-publish: batch=b draft=d hash=h --!>";
    expect(parseMarker(`Body\n\n${line}\n`)).toBeNull();
    expect(stripMarker(`Body\n\n${line}\n`)).toBe(`Body\n\n${line}\n`);
    expect(parseSourceMarker("Body\n\n<!-- metis-source: project=p --!>\n")).toBeNull();
    // Inert under both readings: with no `<!--` there is no comment to end.
    expect(publishableBody(`Body\n\n${line}`)).toBe(
      "Body\n\n<!- - metis-publish: batch=b draft=d hash=h --!>",
    );
    const published = injectMarker(`Body\n\n${line}`, PUBLISH, SOURCE);
    expect(parseMarker(published)).toEqual(PUBLISH);
    expect(ofType(markdownTokens(published), "htmlFlow", "htmlText").map((t) => t.text)).toEqual([
      SOURCE_LINE,
      PUBLISH_LINE,
    ]);
  });
});

describe("stripOwnMarkerLines — this issue's marker lines, wherever they now sit", () => {
  const OWN = {
    draftId: PUBLISH.draftId,
    dedupHash: PUBLISH.hash,
    projectId: SOURCE.projectId,
    requirementId: SOURCE.requirementId,
  };

  it("removes the block when text was added below it, and keeps that text", () => {
    expect(stripOwnMarkerLines(`Body${BLOCK}\nA note added on GitHub.`, OWN)).toBe(
      "Body\n\nA note added on GitHub.",
    );
    expect(stripOwnMarkerLines(`Body${BLOCK}A note with no blank line.`, OWN)).toBe(
      "Body\n\nA note with no blank line.",
    );
    // An issue edited on github.com comes back with CRLF line endings.
    expect(
      stripOwnMarkerLines(`Body\r\n\r\n${SOURCE_LINE}\r\n${PUBLISH_LINE}\r\n\r\nNote\r\n`, OWN),
    ).toBe("Body\r\n\r\nNote");
  });

  it("removes a trailing block exactly as stripMarker does", () => {
    expect(stripOwnMarkerLines(`Body${BLOCK}`, OWN)).toBe("Body");
    expect(stripOwnMarkerLines(`Body\n\n${PUBLISH_LINE}\n`, OWN)).toBe("Body");
  });

  it("removes its lines from several places at once", () => {
    const body = `One\n\n${SOURCE_LINE}\n${PUBLISH_LINE}\n\nTwo\n\n${SOURCE_LINE}\n${PUBLISH_LINE}\n\nThree`;
    expect(stripOwnMarkerLines(body, OWN)).toBe("One\n\nTwo\n\nThree");
  });

  it("keeps every marker-shaped line that is not this issue's own", () => {
    const otherDraft = buildMarkerComment({ ...PUBLISH, draftId: "draft_other" });
    const otherHash = buildMarkerComment({ ...PUBLISH, hash: "b".repeat(64) });
    const otherProject = buildSourceMarkerComment({ ...SOURCE, projectId: "proj_other" })!;
    // Same project, another requirement: another issue's source line.
    const otherRequirement = buildSourceMarkerComment({ ...SOURCE, requirementId: "req_2" })!;
    const noRequirement = buildSourceMarkerComment({ ...SOURCE, requirementId: null })!;
    for (const line of [
      otherDraft,
      otherHash,
      otherProject,
      otherRequirement,
      noRequirement,
      // …also when it stands above a publish marker that is not this issue's.
      `${otherRequirement}\n${otherDraft}`,
      // Not alone on its line, not flush left, quoted, fenced off by text.
      `    ${PUBLISH_LINE}`,
      ` ${SOURCE_LINE}`,
      `> ${PUBLISH_LINE}`,
      `text ${PUBLISH_LINE}`,
      `${PUBLISH_LINE} text`,
      `\`${SOURCE_LINE}\``,
      "<!-- metis-publish: batch=batch_1 draft=draft_1 -->",
      "<!-- metis-source: analysis=analysis_1 -->",
      "<!-- an ordinary comment -->",
    ]) {
      const body = `Body\n\n${line}\n\nNote`;
      expect(stripOwnMarkerLines(body, OWN), line).toBe(body);
    }
  });

  it("knows its source line by the requirement, or by standing on its own publish marker", () => {
    const otherRequirement = buildSourceMarkerComment({ ...SOURCE, requirementId: "req_2" })!;
    const noRequirement = buildSourceMarkerComment({ ...SOURCE, requirementId: null })!;
    // Its own requirement, wherever the line sits.
    expect(stripOwnMarkerLines(`Body\n\n${SOURCE_LINE}\n\nNote`, OWN)).toBe("Body\n\nNote");
    // A later analysis re-linked the draft to a new requirement row: the block
    // on the tracker still names the old one, and is still this issue's block.
    const relinked = { ...OWN, requirementId: "req_1_v2" };
    expect(stripOwnMarkerLines(`Body\n\n${SOURCE_LINE}\n${PUBLISH_LINE}\n\nNote`, relinked)).toBe(
      "Body\n\nNote",
    );
    // …but the same line on its own is then some other issue's.
    const alone = `Body\n\n${SOURCE_LINE}\n\nNote`;
    expect(stripOwnMarkerLines(alone, relinked)).toBe(alone);
    // An epic is linked to no requirement, and its source line names none.
    const epic = { ...OWN, requirementId: null };
    expect(stripOwnMarkerLines(`Body\n\n${noRequirement}\n\nNote`, epic)).toBe("Body\n\nNote");
    const featureLine = `Body\n\n${otherRequirement}\n\nNote`;
    expect(stripOwnMarkerLines(featureLine, epic)).toBe(featureLine);
    // Only the line directly above the publish marker is vouched for by it.
    const apart = `Body\n\n${otherRequirement}\n\n${PUBLISH_LINE}\n\nNote`;
    expect(stripOwnMarkerLines(apart, OWN)).toBe(`Body\n\n${otherRequirement}\n\nNote`);
  });

  it("leaves no blank line at the top when the block was moved there", () => {
    // An edit on the tracker can put the block first. What is left must be the
    // text, not the text behind a blank line that then reads as drift.
    expect(stripOwnMarkerLines(`${SOURCE_LINE}\n${PUBLISH_LINE}\n\ntext\n\nmore`, OWN)).toBe(
      "text\n\nmore",
    );
    expect(stripOwnMarkerLines(`\n\n${PUBLISH_LINE}\n\n\ntext`, OWN)).toBe("text");
    expect(stripOwnMarkerLines(`${PUBLISH_LINE}\r\n\r\ntext\r\n`, OWN)).toBe("text");
    expect(stripOwnMarkerLines(`${PUBLISH_LINE}\n`, OWN)).toBe("");
    // A blank first line the user wrote stays when the block was not above the text.
    expect(stripOwnMarkerLines(`\nBody${BLOCK}\nNote`, OWN)).toBe("\nBody\n\nNote");
  });

  it("with no recorded hash, the draft id alone identifies the publish marker", () => {
    const own = { ...OWN, dedupHash: null };
    const otherHash = buildMarkerComment({ ...PUBLISH, hash: "b".repeat(64) });
    expect(stripOwnMarkerLines(`Body\n\n${otherHash}\n\nNote`, own)).toBe("Body\n\nNote");
    const otherDraft = buildMarkerComment({ ...PUBLISH, draftId: "draft_other" });
    expect(stripOwnMarkerLines(`Body\n\n${otherDraft}\n\nNote`, own)).toBe(
      `Body\n\n${otherDraft}\n\nNote`,
    );
  });

  it("never cuts into a line, and returns a body with nothing to remove as it is", () => {
    for (const body of ["", "Body", "Body\n\n\n\nwith gaps\n", `a ${PUBLISH_LINE} b`]) {
      expect(stripOwnMarkerLines(body, OWN)).toBe(body);
    }
  });

  it("is linear in the body", () => {
    expectLinearTime("own marker lines", (n) => {
      const body = `${PUBLISH_LINE}\ntext\n`.repeat(Math.ceil(n / (PUBLISH_LINE.length + 6)));
      return () => stripOwnMarkerLines(body, OWN);
    });
    expectLinearTime("lines of spaces ending in a letter", (n) => {
      const body = `<!--\n${`${" ".repeat(598)}a\n`.repeat(Math.ceil(n / 600))}`;
      return () => {
        stripOwnMarkerLines(body, OWN);
        parseMarker(body);
        parseSourceMarker(body);
      };
    });
  });
});
