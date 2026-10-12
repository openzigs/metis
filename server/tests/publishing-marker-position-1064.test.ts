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
} = await import("../src/lib/publishing/dedup.js");
const { renderCodeLinksSection } = await import("../src/lib/publishing/draft-code-links.js");
const { __testing } = await import("../src/lib/publishing/draft-generator.js");
const { buildDryRunPlan } = await import("../src/lib/publishing/dry-run.js");
const { expectLinearTime } = await import("./helpers/linear-time.js");

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
 * A line with its Markdown code spans removed, the way CommonMark reads them:
 * a run of N backticks opens a span that the next run of exactly N closes. A
 * run that nothing closes is literal text and is left in — so an unbalanced
 * fence shows up in what this returns.
 */
function outsideCodeSpans(line: string): string {
  let out = "";
  let i = 0;
  while (i < line.length) {
    if (line[i] !== "`") {
      out += line[i];
      i += 1;
      continue;
    }
    let open = i;
    while (line[open] === "`") open += 1;
    const width = open - i;
    let close = -1;
    for (let j = open; j < line.length;) {
      if (line[j] !== "`") {
        j += 1;
        continue;
      }
      let k = j;
      while (line[k] === "`") k += 1;
      if (k - j === width) {
        close = k;
        break;
      }
      j = k;
    }
    if (close === -1) {
      out += line.slice(i, open);
      i = open;
    } else {
      i = close;
    }
  }
  return out;
}

/** A "Related code" row with its code spans removed: only METIS's own markup. */
const ROW_SKELETON =
  /^- (?:\[\]\(https:\/\/github\.com\/acme\/app\/blob\/abc1234\/[A-Za-z0-9%._~!*'/-]*(?:#L\d+(?:-L\d+)?)?\))?(?: — (?: \([a-z_-]+\))?)?$/;

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
    expect(outsideCodeSpans(rows[0]!)).toMatch(ROW_SKELETON);
    // No line of the published body begins with the injected heading or task.
    for (const line of published.split("\n")) {
      expect(line.startsWith("## Injected")).toBe(false);
      expect(line.startsWith("- [ ] injected")).toBe(false);
    }
  });

  it("leaves no mention, closing keyword or attacker link outside a code span", () => {
    const outside = published.split("\n").map(outsideCodeSpans).join("\n");
    expect(outside).not.toContain("@octocat");
    expect(outside).not.toMatch(/closes #1/i);
    expect(outside).not.toContain("evil.example");
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

  it("code spans — nothing a path or symbol holds is outside its span, on any row", () => {
    let linked = 0;
    for (let seed = 1; seed <= 600; seed += 1) {
      const rand = prng(seed + 20_000);
      const { links } = hostileFeature(rand, null);
      for (const repo of [REPO, null]) {
        const rows = renderCodeLinksSection(links, repo).filter((l) => l.startsWith("- "));
        expect(rows.length, `seed ${seed}`).toBeGreaterThan(0);
        for (const row of rows) {
          // One line by every definition of a line break.
          expect(/[\n\r\u0085\u2028\u2029]/.test(row), `seed ${seed}: ${row}`).toBe(false);
          // No comment can open or close inside it.
          expect(row.includes("<!--") || row.includes("-->"), `seed ${seed}: ${row}`).toBe(false);
          // No invisible character survives to hide or reorder what is shown.
          expect(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/.test(row), row).toBe(false);
          // With the spans removed, only METIS's own markup is left: no mention,
          // no closing keyword, no link but the one METIS built.
          expect(outsideCodeSpans(row), `seed ${seed}: ${row}`).toMatch(ROW_SKELETON);
          if (row.startsWith("- [")) linked += 1;
        }
      }
    }
    // The generator does produce linkable hostile paths: the link form is exercised.
    expect(linked).toBeGreaterThan(50);
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
