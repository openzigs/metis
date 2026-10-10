import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  INLINE_WARN_BYTES,
  buildSlideshow,
  comparePhase,
  escapeHtml,
  formatCost,
  formatSignedCost,
  groupChapters,
  orderSteps,
  parseArgs,
  parseManifest,
  parseRunInfo,
  plural,
  readAssets,
  renderDeck,
  renderInline,
  renderNarration,
  resolveScreenshot,
  runCli,
  selectTutorialSteps,
  validateStep,
} from "./walkthrough-slideshow-core.mjs";

/**
 * Tests for the walkthrough slideshow generator (#829). Each `describe` pins one rule the
 * issue states: manifest validation, ordering, tutorial filtering, escaping, path containment,
 * the inline build, and a smoke run of the real CLI on a 3-step fixture.
 */

const scriptsDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CLI = path.join(scriptsDir, "walkthrough", "build-slideshow.mjs");

// A valid 1x1 PNG.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

/** @param {Record<string, unknown>} [over] */
function step(over = {}) {
  return {
    id: "a-1",
    wave: "A",
    phase: "1",
    chapter: "Connect a repository",
    title: "Add the repo connector",
    screenshot: "wave-a/01.png",
    tutorial: "Open **Connectors** and choose `GitHub`.",
    result: "Connector created; commit c4d54f87.",
    works: "pass",
    useful: "pass",
    issues: [714],
    tokens: 1200,
    costCents: 0.5,
    ts: "2026-10-03T09:00:00Z",
    ...over,
  };
}

/** @param {Record<string, unknown>[]} rows */
function jsonl(rows) {
  return rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
}

/** @param {Record<string, unknown>} [over] */
function valid(over) {
  const { step: s, errors } = validateStep(step(over), 1);
  expect(errors).toEqual([]);
  return /** @type {import("./walkthrough-slideshow-core.mjs").Step} */ (s);
}

describe("manifest validation", () => {
  it("accepts a complete step and fills optional defaults", () => {
    const { step: s } = validateStep(
      { ...step(), tutorial: undefined, result: undefined, issues: undefined, tokens: undefined },
      1,
    );
    expect(s).toMatchObject({ tutorial: "", result: "", issues: [], tokens: undefined });
  });

  it("accepts wave F, the persona journeys (#954)", () => {
    expect(valid({ wave: "F", phase: "J1.4", chapter: "Journey: Business analyst" }).wave).toBe(
      "F",
    );
  });

  it("accepts wave G, the optional implement-the-plan wave (#1043)", () => {
    expect(valid({ wave: "G", phase: "G", chapter: "Implement the plan" }).wave).toBe("G");
  });

  it("rejects a non-object line", () => {
    expect(validateStep([1], 3).errors).toEqual(["steps.jsonl line 3: expected a JSON object"]);
    expect(validateStep(null, 3).errors).toHaveLength(1);
  });

  it.each([
    ["id", ""],
    ["chapter", 7],
    ["title", "   "],
    ["screenshot", undefined],
    ["ts", "yesterday"],
    ["ts", "March 5, 2026"],
    ["ts", "2026-10-03"],
    ["wave", "H"],
    ["wave", "BA"],
    ["works", "ok"],
    ["works", "weak"],
    ["works", undefined],
    ["useful", "ok"],
    ["useful", "partial"],
    ["useful", undefined],
    ["verdict", "pass"],
    ["tutorial", 5],
    ["issues", ["714"]],
    ["issues", [0]],
    ["issues", 714],
    ["tokens", -1],
    ["tokens", 1.5],
    ["costCents", "1"],
    ["costCents", Number.NaN],
    ["costCents", -0.1],
  ])("rejects %s = %j", (field, value) => {
    const { step: s, errors } = validateStep(step({ [field]: value }), 2);
    expect(s).toBeNull();
    expect(errors.join("\n")).toContain(`"${field}"`);
  });

  it("rejects an unknown field, so a typo cannot silently drop data", () => {
    expect(validateStep(step({ tutorail: "x" }), 1).errors).toEqual([
      'steps.jsonl line 1: unknown field "tutorail"',
    ]);
  });

  it("parses a manifest, skipping blank lines and reporting bad JSON and duplicate ids", () => {
    const text = `${JSON.stringify(step())}\n\n{oops\n${JSON.stringify(step())}\n${JSON.stringify(step({ id: "a-2" }))}\n`;
    const { steps, errors } = parseManifest(text);
    expect(steps.map((s) => s.id)).toEqual(["a-1", "a-2"]);
    expect(errors).toEqual([
      "steps.jsonl line 3: not valid JSON",
      'steps.jsonl line 4: duplicate id "a-1"',
    ]);
  });

  it("collects field errors from every line, and flags an empty manifest", () => {
    expect(parseManifest(jsonl([step({ wave: "Z" })])).errors).toHaveLength(1);
    expect(parseManifest("\n \n").errors).toEqual(["steps.jsonl: no steps"]);
  });
});

describe("ordering and chapter grouping", () => {
  it("orders phases naturally: numbers before prefixed, numerically within", () => {
    const phases = ["S10", "10", "2", "S2", "2b", "S4"];
    expect([...phases].sort(comparePhase)).toEqual(["2", "2b", "10", "S2", "S4", "S10"]);
    expect(comparePhase("x", "3")).toBe(1);
    expect(comparePhase("3", "3")).toBe(0);
  });

  it("orders by wave, then phase, keeping manifest order inside a phase", () => {
    const steps = [
      valid({ id: "d", wave: "D", phase: "S1" }),
      valid({ id: "b2", wave: "B", phase: "10" }),
      valid({ id: "b1", wave: "B", phase: "5" }),
      valid({ id: "a1", wave: "A", phase: "2" }),
      valid({ id: "a2", wave: "A", phase: "2" }),
    ];
    expect(orderSteps(steps).map((s) => s.id)).toEqual(["a1", "a2", "b1", "b2", "d"]);
  });

  it("orders wave G after wave F (#1043)", () => {
    const steps = [
      valid({ id: "g", wave: "G", phase: "G" }),
      valid({ id: "f", wave: "F", phase: "J2.4" }),
      valid({ id: "a", wave: "A", phase: "1" }),
    ];
    expect(orderSteps(steps).map((s) => s.id)).toEqual(["a", "f", "g"]);
  });

  it("groups chapters in order of their first step", () => {
    const steps = orderSteps([
      valid({ id: "1", chapter: "Ask", wave: "B" }),
      valid({ id: "2", chapter: "Connect", wave: "A" }),
      valid({ id: "3", chapter: "Connect", wave: "C" }),
    ]);
    expect(groupChapters(steps).map((c) => [c.chapter, c.steps.map((s) => s.id)])).toEqual([
      ["Connect", ["2", "3"]],
      ["Ask", ["1"]],
    ]);
  });
});

describe("report order", () => {
  it("keeps strict wave-then-phase order when two waves share a chapter name", () => {
    const steps = [
      valid({ id: "a", wave: "A", chapter: "Connect", title: "First-A" }),
      valid({ id: "b", wave: "B", chapter: "Ask", title: "Second-B" }),
      valid({ id: "c", wave: "C", chapter: "Connect", title: "Third-C" }),
    ];
    const html = renderDeck({
      kind: "report",
      title: "T",
      steps,
      imageSrc: () => "x.png",
      inlineAssets: null,
    });
    const at = (t) => html.indexOf(`aria-label="${t}"`);
    expect(at("First-A")).toBeLessThan(at("Second-B"));
    expect(at("Second-B")).toBeLessThan(at("Third-C"));
  });
});

describe("tutorial filtering", () => {
  it("excludes failed or blocked steps, useless steps and steps with no tutorial text", () => {
    const steps = [
      valid({ id: "pass" }),
      valid({ id: "partial", works: "partial", useful: "weak" }),
      valid({ id: "works-not-useful", useful: "weak" }),
      valid({ id: "na", useful: "n/a" }),
      valid({ id: "useless", useful: "fail" }),
      valid({ id: "fail", works: "fail", useful: "n/a" }),
      valid({ id: "blocked", works: "blocked", useful: "n/a" }),
      valid({ id: "empty", tutorial: "  \n " }),
    ];
    expect(selectTutorialSteps(steps).map((s) => s.id)).toEqual([
      "pass",
      "partial",
      "works-not-useful",
      "na",
    ]);
  });

  it("escapes **bold** content", () => {
    const steps = [valid({ tutorial: "Click **<img src=x onerror=alert(1)>** now" })];
    const html = renderDeck({
      kind: "tutorial",
      title: "T",
      steps,
      imageSrc: () => "x.png",
      inlineAssets: null,
    });
    expect(html).toContain("<strong>&lt;img src=x onerror=alert(1)&gt;</strong>");
    expect(html).not.toContain("<img src=x onerror");
  });

  it("the tutorial deck shows tutorial text only; the report shows every step with badges", () => {
    const steps = [
      valid({ id: "ok", title: "Good step", tutorial: "TUTORIAL-TEXT", result: "RESULT-TEXT" }),
      valid({
        id: "bad",
        title: "Broken step",
        works: "fail",
        useful: "n/a",
        tutorial: "never taught",
      }),
    ];
    const base = { title: "T", steps, imageSrc: () => "x.png", inlineAssets: null };
    const tutorial = renderDeck({ ...base, kind: "tutorial" });
    const report = renderDeck({ ...base, kind: "report" });

    expect(tutorial).toContain("TUTORIAL-TEXT");
    expect(tutorial).not.toContain("Broken step");
    expect(tutorial).not.toContain("badge--fail");
    // The result is reachable only as presenter notes in the tutorial.
    expect(tutorial).toMatch(/<aside class="notes"[^>]*><p>RESULT-TEXT<\/p><\/aside>/);

    expect(report).toContain("Broken step");
    expect(report).toContain('<span class="badge badge--fail">Works: fail</span>');
    expect(report).toContain('<span class="badge badge--na">Useful: n/a</span>');
    expect(report).toContain("RESULT-TEXT");
    expect(report).not.toContain("TUTORIAL-TEXT");
    expect(report).toContain('href="https://github.com/openzigs/metis/issues/714"');
  });
});

describe("escaping and the Markdown subset", () => {
  it("escapes every HTML-significant character", () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;",
    );
  });

  it("renders bold, code and http(s) links", () => {
    expect(renderInline("Click **Save** then run `pnpm test`")).toBe(
      "Click <strong>Save</strong> then run <code>pnpm test</code>",
    );
    expect(renderInline("See [the **docs**](https://example.com/a?b=1&c=2).")).toBe(
      'See <a href="https://example.com/a?b=1&amp;c=2" rel="noopener noreferrer" target="_blank">the <strong>docs</strong></a>.',
    );
  });

  it("does not apply Markdown inside code", () => {
    expect(renderInline("`**not bold** <b>`")).toBe("<code>**not bold** &lt;b&gt;</code>");
  });

  it.each([
    "[x](javascript:alert(1))",
    "[x](data:text/html,<script>alert(1)</script>)",
    "[x](//evil.example)",
    "[x](vbscript:msgbox)",
  ])("leaves a non-http(s) link as escaped text: %s", (md) => {
    const html = renderInline(md);
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("<script");
  });

  it("cannot break out of the href attribute", () => {
    const html = renderInline('[x](https://a.example/"onmouseover="alert(1))');
    expect(html).not.toMatch(/"\s*onmouseover=/);
  });

  it("renders a <script> payload in narration as text, in both decks", () => {
    const payload = '<script>alert("xss")</script><img src=x onerror=alert(1)>';
    const steps = [valid({ tutorial: payload, result: payload, title: payload, chapter: payload })];
    for (const kind of /** @type {const} */ (["tutorial", "report"])) {
      const html = renderDeck({
        kind,
        title: payload,
        steps,
        imageSrc: () => "a.png",
        inlineAssets: null,
      });
      expect(html).not.toContain("<script>alert");
      expect(html).not.toContain("<img src=x");
      expect(html).toContain("&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;");
    }
  });

  it("splits narration into paragraphs and line breaks", () => {
    expect(renderNarration("one\ntwo\n\n\nthree")).toBe("<p>one<br>two</p><p>three</p>");
    expect(renderNarration("  ")).toBe("");
  });

  it("pluralises counts", () => {
    expect(plural(1, "step")).toBe("1 step");
    expect(plural(0, "chapter")).toBe("0 chapters");
  });

  it("formats cost in dollars", () => {
    expect(formatCost(0.5)).toBe("$0.0050");
    expect(formatCost(1234)).toBe("$12.34");
  });
});

describe("filesystem", () => {
  /** @type {string} */
  let tmp;
  /** @type {string} */
  let evidence;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "slideshow-829-"));
    evidence = path.join(tmp, "evidence");
    fs.mkdirSync(path.join(evidence, "wave-a"), { recursive: true });
    fs.writeFileSync(path.join(evidence, "wave-a", "01.png"), PNG);
    fs.writeFileSync(path.join(tmp, "secret.png"), PNG);
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  describe("path traversal", () => {
    it("resolves a screenshot inside the evidence directory", () => {
      expect(resolveScreenshot(evidence, "wave-a/01.png")).toBe(
        fs.realpathSync(path.join(evidence, "wave-a", "01.png")),
      );
    });

    it.each([
      ["../secret.png", '".."'],
      ["wave-a/../../secret.png", '".."'],
      ["wave-a\\..\\..\\secret.png", '".."'],
      ["/etc/passwd.png", "relative"],
      ["C:\\secret.png", "relative"],
      ["file:///etc/x.png", "relative"],
      ["wave-a/notes.txt", "image type"],
      ["wave-a/missing.png", "does not exist"],
    ])("rejects %s", (rel, message) => {
      expect(() => resolveScreenshot(evidence, rel)).toThrow(message);
    });

    it("rejects a symlink that escapes the evidence directory", () => {
      fs.symlinkSync(path.join(tmp, "secret.png"), path.join(evidence, "link.png"));
      expect(() => resolveScreenshot(evidence, "link.png")).toThrow("outside the evidence");
    });

    it("fails the build, naming the step, when a manifest path escapes", () => {
      fs.writeFileSync(
        path.join(evidence, "steps.jsonl"),
        jsonl([step({ id: "evil", screenshot: "../secret.png" })]),
      );
      expect(() =>
        buildSlideshow({
          inDir: evidence,
          outDir: path.join(tmp, "out"),
          deck: "both",
          title: undefined,
          inlineImages: false,
        }),
      ).toThrow(/step "evil": screenshot "..\/secret.png" must not contain/);
      expect(fs.existsSync(path.join(tmp, "out"))).toBe(false);
    });
  });

  it("refuses a missing or invalid manifest", () => {
    const opts = {
      inDir: evidence,
      outDir: path.join(tmp, "out"),
      deck: /** @type {const} */ ("report"),
      title: undefined,
      inlineImages: false,
    };
    expect(() => buildSlideshow(opts)).toThrow("no steps.jsonl");
    fs.writeFileSync(path.join(evidence, "steps.jsonl"), "{}\n");
    expect(() => buildSlideshow(opts)).toThrow("invalid manifest");
  });

  describe("3-step fixture", () => {
    beforeEach(() => {
      fs.writeFileSync(path.join(evidence, "wave-a", "02 step.png"), PNG);
      fs.mkdirSync(path.join(evidence, "wave-d"));
      fs.writeFileSync(path.join(evidence, "wave-d", "s4.png"), PNG);
      fs.writeFileSync(
        path.join(evidence, "steps.jsonl"),
        jsonl([
          step({
            id: "d-s4",
            wave: "D",
            phase: "S4",
            chapter: "Write a spec",
            title: "Run clarify",
            screenshot: "wave-d/s4.png",
            works: "blocked",
            useful: "n/a",
            tutorial: "Blocked step text",
            issues: [801],
          }),
          step({
            id: "a-2",
            phase: "2",
            title: "Wait for indexing",
            screenshot: "wave-a/02 step.png",
            works: "partial",
            useful: "weak",
            tokens: undefined,
            costCents: undefined,
          }),
          step(),
        ]),
      );
    });

    it("builds both folder decks with copied assets and no network references", () => {
      const out = path.join(tmp, "out");
      const { decks, warnings } = buildSlideshow({
        inDir: evidence,
        outDir: out,
        deck: "both",
        title: undefined,
        inlineImages: false,
        now: new Date("2026-10-03T10:00:00Z"),
      });
      expect(warnings).toEqual([]);
      expect(decks.map((d) => d.kind)).toEqual(["tutorial", "report"]);

      const tutorial = fs.readFileSync(path.join(out, "tutorial", "index.html"), "utf8");
      const report = fs.readFileSync(path.join(out, "report", "index.html"), "utf8");
      // Tutorial: the blocked step's screenshot is not even copied.
      expect(fs.readdirSync(path.join(out, "tutorial", "assets", "img"))).toEqual([
        "001-02_step.png",
        "002-01.png",
      ]);
      expect(fs.readdirSync(path.join(out, "report", "assets", "img"))).toHaveLength(3);
      for (const html of [tutorial, report]) {
        expect(html).toContain('<link rel="stylesheet" href="assets/slideshow.css">');
        expect(html).toContain('<script src="assets/slideshow.js"></script>');
        expect(html).toContain("script-src 'self'");
        expect(html).not.toMatch(/(src|href)="(https?:)?\/\/(?!github\.com\/openzigs)/);
        expect(html).not.toMatch(/\son[a-z]+=/i);
      }
      expect(fs.readFileSync(path.join(out, "tutorial", "assets", "slideshow.js"), "utf8")).toBe(
        readAssets().js,
      );

      // Tutorial: title, contents, chapter intro, then 2 steps in order (phase 1 before 2).
      const sections = [...tutorial.matchAll(/<section class="slide slide--(\w+)/g)].map(
        (m) => m[1],
      );
      expect(sections).toEqual(["title", "toc", "chapter", "step", "step"]);
      expect(tutorial.indexOf("Add the repo connector")).toBeLessThan(
        tutorial.indexOf('aria-label="Wait for indexing"'),
      );
      expect(tutorial).toContain('<a href="#3">Connect a repository</a>');
      expect(tutorial).toContain("2 steps in 1 chapter · Generated 2026-10-03");
      expect(tutorial).toContain('<span class="muted">2 steps</span>');
      expect(report).toContain("Run report, 3 steps");
      expect(tutorial).not.toContain("Blocked step text");
      expect(tutorial).toContain('alt="Add the repo connector"');

      // Report: title, summary, then all 3 steps; the blocked one carries its badge.
      const reportSections = [...report.matchAll(/<section class="slide slide--(\w+)/g)].map(
        (m) => m[1],
      );
      expect(reportSections).toEqual(["title", "summary", "step", "step", "step"]);
      expect(report).toContain('<span class="badge badge--blocked">Works: blocked</span>');
      // The tally has one row per axis, so run 2's Works and Useful counts are reproducible.
      expect(report).toMatch(
        /Works<\/span>[\s\S]*badge--pass">pass<\/span><span class="tally__n">1</,
      );
      expect(report).toMatch(/badge--partial">partial<\/span><span class="tally__n">1</);
      expect(report).toMatch(/badge--blocked">blocked<\/span><span class="tally__n">1</);
      expect(report).toMatch(
        /Useful<\/span>[\s\S]*badge--weak">weak<\/span><span class="tally__n">1</,
      );
      expect(report).toMatch(/badge--na">n\/a<\/span><span class="tally__n">1</);
      expect(report).toContain("<strong>2,400</strong> tokens");
      expect(report).toContain("<strong>$0.0100</strong>");
      expect(report).toContain("issues/801");
      expect(report).toContain("<title>METIS walkthrough</title>");
    });

    it("a rebuild into the same folder drops screenshots from the earlier build", () => {
      const out = path.join(tmp, "out");
      const opts = {
        inDir: evidence,
        outDir: out,
        deck: "report",
        title: undefined,
        inlineImages: false,
        now: new Date("2026-10-03T10:00:00Z"),
      };
      buildSlideshow(opts);
      const orphan = path.join(out, "report", "assets", "img", "99-stale.png");
      fs.writeFileSync(orphan, PNG);
      buildSlideshow(opts);
      expect(fs.existsSync(orphan)).toBe(false);
      expect(fs.readdirSync(path.join(out, "report", "assets", "img")).length).toBe(3);
    });

    it("--inline-images writes one self-contained file per deck, allowed by CSP hashes", () => {
      const out = path.join(tmp, "inline");
      buildSlideshow({
        inDir: evidence,
        outDir: out,
        deck: "tutorial",
        title: "Run 3",
        inlineImages: true,
      });
      expect(fs.readdirSync(path.join(out, "tutorial"))).toEqual(["index.html"]);
      expect(fs.existsSync(path.join(out, "report"))).toBe(false);
      const html = fs.readFileSync(path.join(out, "tutorial", "index.html"), "utf8");
      expect(html).toContain(`src="data:image/png;base64,${PNG.toString("base64")}"`);
      expect(html).not.toContain("assets/");
      expect(html).toMatch(/script-src 'sha256-[A-Za-z0-9+/=]+'/);
      expect(html).toMatch(/style-src 'sha256-[A-Za-z0-9+/=]+'/);
      expect(html).toContain("img-src data:");
      const csp = /** @type {RegExpMatchArray} */ (
        html.match(/Content-Security-Policy" content="([^"]+)"/)
      )[1];
      expect(csp).not.toContain("unsafe");
      expect(html).toContain("<title>Run 3</title>");
    });

    it("titles the report deck from --title", () => {
      const out = path.join(tmp, "titled");
      buildSlideshow({
        inDir: evidence,
        outDir: out,
        deck: "report",
        title: "Run 3",
        inlineImages: false,
      });
      expect(fs.readFileSync(path.join(out, "report", "index.html"), "utf8")).toContain(
        "<title>Run 3: run report</title>",
      );
    });

    it("warns when an inlined deck exceeds 15 MB", () => {
      fs.writeFileSync(path.join(evidence, "wave-a", "01.png"), Buffer.alloc(INLINE_WARN_BYTES));
      const { warnings } = buildSlideshow({
        inDir: evidence,
        outDir: path.join(tmp, "big"),
        deck: "tutorial",
        title: undefined,
        inlineImages: true,
      });
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/^tutorial deck is 2\d\.\d MB inlined \(over 15 MB\)/);
    });

    it("runCli reports decks and warnings, and maps failures to exit codes", () => {
      /** @type {string[]} */
      const log = [];
      /** @type {string[]} */
      const err = [];
      const io = {
        log: (/** @type {string} */ m) => log.push(m),
        error: (/** @type {string} */ m) => err.push(m),
      };
      expect(
        runCli(["--in", evidence, "--out", path.join(tmp, "cli"), "--deck", "report"], io),
      ).toBe(0);
      expect(log[0]).toMatch(/^report: .*index\.html \(\d+ KB\)$/);

      fs.writeFileSync(path.join(evidence, "wave-a", "01.png"), Buffer.alloc(INLINE_WARN_BYTES));
      expect(
        runCli(
          [
            "--in",
            evidence,
            "--out",
            path.join(tmp, "cli2"),
            "--deck",
            "tutorial",
            "--inline-images",
          ],
          io,
        ),
      ).toBe(0);
      expect(err.some((m) => m.startsWith("build-slideshow: warning: tutorial deck"))).toBe(true);

      expect(runCli(["--deck", "nope"], io)).toBe(2);
      expect(err.at(-1)).toContain("Usage:");
      expect(runCli(["--in", tmp, "--out", path.join(tmp, "x"), "--deck", "both"], io)).toBe(1);
      expect(err.at(-1)).toContain("no steps.jsonl");
    });

    describe("run.json (#947)", () => {
      const reportOpts = () => ({
        inDir: evidence,
        outDir: path.join(tmp, "run"),
        deck: /** @type {const} */ ("both"),
        title: undefined,
        inlineImages: false,
        now: new Date("2026-10-03T10:00:00Z"),
      });
      const read = (/** @type {string} */ kind) =>
        fs.readFileSync(path.join(tmp, "run", kind, "index.html"), "utf8");

      it("without run.json the summary keeps the step-sum spend and has no new-issues slide", () => {
        buildSlideshow(reportOpts());
        const report = read("report");
        expect(report).toContain('<p class="spend">Spend: <strong>2,400</strong> tokens');
        expect(report).toContain("Issues checked:");
        expect(report).not.toContain("New issues filed");
        expect(report).not.toContain("slide--issues");
        expect(report).toContain("Tokens and cost per wave: attributed to steps");
        // Only waves with steps get a row.
        expect(report).not.toContain('<th scope="row">BA</th>');
      });

      it("shows the ledger total, the step sum and the remainder, and lists new issues", () => {
        fs.writeFileSync(path.join(evidence, "run.json"), JSON.stringify(runInfo()));
        buildSlideshow(reportOpts());
        const report = read("report");
        const tutorial = read("tutorial");

        expect(report).toContain(
          "Spend (ledger, <code>token_usages</code> 2026-10-03T09:00:00Z to 2026-10-03T12:00:00Z): <strong>10,000</strong> tokens · <strong>$4.32</strong>",
        );
        expect(report).toContain(
          "Attributed to steps: 2,400 tokens · $0.0100 · Unattributed: 7,600 tokens · $4.31",
        );
        expect(report).toContain("Issues checked:");
        expect(report).toMatch(/Issues checked: .*issues\/801/);
        expect(report).toMatch(
          /New issues filed \(3\): <span class="sev sev--high">High:<\/span> <a href="[^"]+\/935"[^>]*>#935<\/a> <a href="[^"]+\/936"[^>]*>#936<\/a> · <span class="sev sev--low">Low:<\/span> <a href="[^"]+\/946"/,
        );

        // Per-wave rows come from the ledger, including BA, and a wave missing from it reads "–".
        expect(report).toContain("Tokens and cost per wave: ledger");
        expect(report).toMatch(
          /<th scope="row">A<\/th>(<td>\d+<\/td>){8}<td>6,000<\/td><td>\$2\.50<\/td>/,
        );
        expect(report).toMatch(/<th scope="row">D<\/th>(<td>\d+<\/td>){8}<td>–<\/td><td>–<\/td>/);
        expect(report).toMatch(
          /<th scope="row">BA<\/th>(<td>0<\/td>){8}<td>500<\/td><td>\$0\.2800<\/td>/,
        );

        // The closing slide lists every new issue with its title, escaped, high first.
        const sections = [...report.matchAll(/<section class="slide slide--(\w+)/g)].map(
          (m) => m[1],
        );
        expect(sections.at(-1)).toBe("issues");
        expect(report).toContain("<h2>New issues filed (3)</h2>");
        expect(report).toContain("Publish &lt;b&gt;always&lt;/b&gt; 501");
        expect(report).not.toContain("<b>always</b>");
        expect(report.indexOf("High (2)")).toBeLessThan(report.indexOf("Low (1)"));
        expect(report).not.toContain("Medium (");

        // The tutorial is not a run report: none of this appears there.
        expect(tutorial).not.toContain("New issues filed");
        expect(tutorial).not.toContain("ledger");
      });

      it("shows a negative remainder when the steps claim more than the ledger", () => {
        fs.writeFileSync(
          path.join(evidence, "run.json"),
          JSON.stringify({
            ledger: { ...runInfo().ledger, tokens: 1000, costUsd: 0 },
            newIssues: [],
          }),
        );
        buildSlideshow(reportOpts());
        const report = read("report");
        expect(report).toContain("Unattributed: -1,400 tokens · -$0.0100");
        expect(report).toContain("New issues filed (0): none");
        expect(report).not.toContain("slide--issues");
      });

      it("a ledger exactly equal to the step total leaves a zero remainder, not -$0.0000", () => {
        // Re-price the fixture's three steps at 10 + 9 + 10 = 29 cents; 0.29 * 100 - 29 < 0.
        const manifest = path.join(evidence, "steps.jsonl");
        const rows = fs
          .readFileSync(manifest, "utf8")
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l));
        rows.forEach((r, i) => Object.assign(r, { tokens: 800, costCents: [10, 9, 10][i] }));
        fs.writeFileSync(manifest, jsonl(rows));
        fs.writeFileSync(
          path.join(evidence, "run.json"),
          JSON.stringify({ ledger: { ...runInfo().ledger, tokens: 2400, costUsd: 0.29 } }),
        );
        buildSlideshow(reportOpts());
        const report = read("report");
        expect(report).toContain(
          "Attributed to steps: 2,400 tokens · $0.2900 · Unattributed: 0 tokens · $0.0000",
        );
        expect(report).not.toContain("-$0.0000");
      });

      it("summarises fix verdicts beside the issues checked (#954)", () => {
        fs.writeFileSync(
          path.join(evidence, "run.json"),
          JSON.stringify({ ...runInfo(), fixes: fixesFixture() }),
        );
        buildSlideshow(reportOpts());
        const report = read("report");
        expect(report).toMatch(
          /Fixes confirmed this run \(1 of 4\): confirmed 1 · partial 1 · regressed 1 · not-exercised 1 · Close if still open: <a href="[^"]+\/939"[^>]*>#939<\/a> <a href="[^"]+\/940"/,
        );
        expect(report.indexOf("Issues checked:")).toBeLessThan(report.indexOf("Fixes confirmed"));
        expect(read("tutorial")).not.toContain("Fixes confirmed");
      });

      it("omits the close list when nothing was confirmed, and the line without fixes", () => {
        const fixes = fixesFixture().slice(1);
        fs.writeFileSync(path.join(evidence, "run.json"), JSON.stringify({ fixes }));
        buildSlideshow(reportOpts());
        expect(read("report")).toContain(
          "Fixes confirmed this run (0 of 3): confirmed 0 · partial 1 · regressed 1 · not-exercised 1</p>",
        );
        fs.writeFileSync(path.join(evidence, "run.json"), "{}");
        buildSlideshow(reportOpts());
        expect(read("report")).not.toContain("Fixes confirmed");
      });

      it("fails, writing nothing, when a verdict cites a step the manifest lacks", () => {
        const fixes = fixesFixture();
        fixes[0].evidence = "b-9-9";
        fs.writeFileSync(path.join(evidence, "run.json"), JSON.stringify({ fixes }));
        expect(() => buildSlideshow(reportOpts())).toThrow(
          'run.json fixes: PR #950 cites step "b-9-9", which steps.jsonl lacks',
        );
        expect(fs.existsSync(path.join(tmp, "run"))).toBe(false);
      });

      it("renders change-plan precision and recall per issue and output (#1042)", () => {
        fs.writeFileSync(
          path.join(evidence, "run.json"),
          JSON.stringify({ ...runInfo(), changePlanAccuracy: accuracyFixture() }),
        );
        buildSlideshow(reportOpts());
        const report = read("report");
        const sections = [...report.matchAll(/<section class="slide slide--(\w+)/g)].map(
          (m) => m[1],
        );
        // Its own slide, after the steps and before the closing new-issues slide.
        expect(sections.slice(-2)).toEqual(["accuracy", "issues"]);
        expect(report).toContain("<h2>Change-plan accuracy</h2>");
        // Rows sorted by issue, then by output in the scoring order; ratios computed from counts.
        const rows = [...report.matchAll(/<tr><th scope="row">(.*?)<\/tr>/g)]
          .map((m) => m[1])
          .filter((r) => r.includes("miniflux/v2/issues"));
        expect(rows).toHaveLength(3);
        expect(rows[0]).toMatch(/\/4336"[^>]*>#4336<\/a><\/th><td>impact<\/td><td>curated<\/td>/);
        expect(rows[1]).toMatch(/#4478<\/a><\/th><td>chat<\/td>/);
        expect(rows[2]).toMatch(/#4478<\/a><\/th><td>j2-plan<\/td>/);
        // 4336 impact: files 3 tp 1 fp 2 fn -> P 75% (3/4), R 60% (3/5); functions 0/0 named.
        expect(rows[0]).toContain(
          "<td>75% (3/4)</td><td>60% (3/5)</td><td>–</td><td>0% (0/9)</td><td>yes</td>",
        );
        // 4478 chat: migration wrong reads "no".
        expect(rows[1]).toContain("<td>100% (2/2)</td><td>67% (2/3)</td>");
        expect(rows[1]).toMatch(/<td>no<\/td>$/);
        expect(read("tutorial")).not.toContain("Change-plan accuracy");
      });

      it("omits the accuracy slide without the field or with an empty list", () => {
        fs.writeFileSync(path.join(evidence, "run.json"), JSON.stringify(runInfo()));
        buildSlideshow(reportOpts());
        expect(read("report")).not.toContain("slide--accuracy");
        fs.writeFileSync(
          path.join(evidence, "run.json"),
          JSON.stringify({ changePlanAccuracy: [] }),
        );
        buildSlideshow(reportOpts());
        expect(read("report")).not.toContain("slide--accuracy");
      });

      it("fails the build, naming the field, and writes nothing on an invalid run.json", () => {
        fs.writeFileSync(
          path.join(evidence, "run.json"),
          JSON.stringify({
            ...runInfo(),
            ledger: { ...runInfo().ledger, source: "ai_token_usages" },
          }),
        );
        expect(() => buildSlideshow(reportOpts())).toThrow(
          /invalid run\.json:\n {2}run\.json ledger: "source" must be "token_usages"/,
        );
        expect(fs.existsSync(path.join(tmp, "run"))).toBe(false);

        fs.writeFileSync(path.join(evidence, "run.json"), "{");
        expect(() => buildSlideshow(reportOpts())).toThrow("run.json: not valid JSON");
        expect(fs.existsSync(path.join(tmp, "run"))).toBe(false);
      });
    });

    it("the real CLI builds both decks (smoke)", () => {
      const out = path.join(tmp, "smoke");
      const res = spawnSync(
        process.execPath,
        [CLI, "--in", evidence, "--out", out, "--deck", "both"],
        {
          encoding: "utf8",
        },
      );
      expect(res.stderr).toBe("");
      expect(res.status).toBe(0);
      expect(res.stdout).toMatch(/tutorial: .*\n\s*report: /);
      expect(fs.existsSync(path.join(out, "tutorial", "index.html"))).toBe(true);
      expect(fs.existsSync(path.join(out, "report", "index.html"))).toBe(true);
    });
  });
});

/** Fix verdicts for the 3-step fixture: one per status, evidence pointing at its steps. */
function fixesFixture() {
  return [
    {
      pr: 950,
      issues: [939, 940],
      wave: "B",
      phase: "8",
      check: "Approval flows",
      status: "confirmed",
      evidence: "a-1",
    },
    {
      pr: 951,
      issues: [941],
      wave: "F",
      phase: "J1.4",
      check: "Invite UI",
      status: "partial",
      evidence: "a-2",
      carried: "regressed",
    },
    {
      pr: 952,
      issues: [943],
      wave: "B",
      phase: "7",
      check: "Run cost",
      status: "regressed",
      evidence: "d-s4",
    },
    { pr: 953, issues: [], wave: "D", phase: "S21", check: "Publish", status: "not-exercised" },
  ];
}

/** Change-plan scores (#1042): one issue across two outputs, another on one. */
function accuracyFixture() {
  return [
    {
      issue: 4478,
      output: "j2-plan",
      source: "curated",
      files: { tp: 1, fp: 3, fn: 2 },
      functions: { tp: 1, fp: 0, fn: 1 },
      migrationCorrect: true,
    },
    {
      issue: 4478,
      output: "chat",
      source: "curated",
      files: { tp: 2, fp: 0, fn: 1 },
      functions: { tp: 0, fp: 2, fn: 2 },
      migrationCorrect: false,
    },
    {
      issue: 4336,
      output: "impact",
      source: "curated",
      files: { tp: 3, fp: 1, fn: 2 },
      functions: { tp: 0, fp: 0, fn: 9 },
      migrationCorrect: true,
    },
  ];
}

/** A valid run.json for the 3-step fixture (waves A and D). */
function runInfo() {
  return {
    newIssues: [
      { number: 946, title: "Run 4 low-severity bundle", severity: "low" },
      { number: 936, title: "Spec Kit Publish <b>always</b> 501", severity: "high" },
      { number: 935, title: "SQL lineage edges", severity: "high" },
    ],
    ledger: {
      tokens: 10000,
      costUsd: 4.32,
      source: "token_usages",
      since: "2026-10-03T09:00:00Z",
      until: "2026-10-03T12:00:00Z",
    },
    waves: {
      A: {
        tokens: 6000,
        costUsd: 2.5,
        since: "2026-10-03T09:00:00Z",
        until: "2026-10-03T10:00:00Z",
      },
      BA: { tokens: 500, costUsd: 0.28 },
    },
  };
}

describe("run.json parsing (#947)", () => {
  it("accepts a full run.json and an empty object", () => {
    const { run, errors } = parseRunInfo(JSON.stringify(runInfo()));
    expect(errors).toEqual([]);
    expect(run?.newIssues).toHaveLength(3);
    expect(run?.ledger?.costUsd).toBe(4.32);
    expect(run?.waves?.BA).toEqual({ tokens: 500, costUsd: 0.28 });
    expect(parseRunInfo("{}")).toEqual({
      run: {
        newIssues: undefined,
        ledger: undefined,
        waves: undefined,
        metisSha: undefined,
        previousRunSha: undefined,
        fixes: undefined,
        changePlanAccuracy: undefined,
        docQuality: undefined,
        buildProof: undefined,
      },
      errors: [],
    });
  });

  it("accepts the #954 fields: METIS SHAs and fix verdicts, and wave F", () => {
    const r = /** @type {any} */ (runInfo());
    r.metisSha = "f117d406083316cc8c204399b7826cf69a7fb7a5";
    r.previousRunSha = "7cc6310d";
    r.waves.F = { tokens: 10, costUsd: 0.01 };
    r.waves.G = { tokens: 0, costUsd: 0 };
    r.fixes = fixesFixture();
    const { run, errors } = parseRunInfo(JSON.stringify(r));
    expect(errors).toEqual([]);
    expect(run?.metisSha).toBe(r.metisSha);
    expect(run?.previousRunSha).toBe("7cc6310d");
    expect(run?.fixes).toHaveLength(4);
  });

  it.each(
    /** @type {Array<[string, (r: any) => void, string]>} */ ([
      ["a non-hex metisSha", (r) => (r.metisSha = "main"), '"metisSha" must be a commit SHA'],
      [
        "a short previousRunSha",
        (r) => (r.previousRunSha = "abc"),
        '"previousRunSha" must be a commit SHA',
      ],
      ["fixes not an array", (r) => (r.fixes = {}), 'run.json: "fixes" must be an array'],
      [
        "a bad status",
        (r) => (r.fixes[0].status = "holds"),
        'fixes[0]: "status" must be one of confirmed, partial, regressed, not-exercised',
      ],
      [
        "a confirmed fix without evidence",
        (r) => delete r.fixes[0].evidence,
        'fixes[0]: "evidence" (a step id) is required when "status" is "confirmed"',
      ],
      ["an unknown fix field", (r) => (r.fixes[1].note = "x"), 'fixes[1]: unknown field "note"'],
      ["a duplicate PR", (r) => (r.fixes[1].pr = r.fixes[0].pr), "fixes[1]: duplicate PR #950"],
    ]),
  )("rejects %s", (_label, mutate, message) => {
    const r = /** @type {any} */ (runInfo());
    r.fixes = fixesFixture();
    mutate(r);
    expect(parseRunInfo(JSON.stringify(r)).errors.join("\n")).toContain(message);
  });

  it.each([
    ["not JSON", "{", "run.json: not valid JSON"],
    ["an array", "[]", "run.json: expected a JSON object"],
    ["null", "null", "run.json: expected a JSON object"],
  ])("rejects %s", (_label, text, message) => {
    expect(parseRunInfo(text)).toEqual({ run: null, errors: [message] });
  });

  /** @param {(r: any) => void} mutate */
  const errorsOf = (mutate) => {
    const r = /** @type {any} */ (runInfo());
    mutate(r);
    const { run, errors } = parseRunInfo(JSON.stringify(r));
    expect(run).toBeNull();
    return errors.join("\n");
  };

  it.each(
    /** @type {Array<[string, (r: any) => void, string]>} */ ([
      ["an unknown top-level field", (r) => (r.issues = []), 'run.json: unknown field "issues"'],
      ["newIssues not an array", (r) => (r.newIssues = {}), '"newIssues" must be an array'],
      ["a non-object issue", (r) => (r.newIssues = [7]), "newIssues[0]: expected a JSON object"],
      [
        "an unknown issue field",
        (r) => (r.newIssues[0].url = "x"),
        'newIssues[0]: unknown field "url"',
      ],
      ["a string issue number", (r) => (r.newIssues[1].number = "936"), 'newIssues[1]: "number"'],
      ["issue number 0", (r) => (r.newIssues[1].number = 0), 'newIssues[1]: "number"'],
      [
        "a duplicate issue",
        (r) => (r.newIssues[2].number = 936),
        "newIssues[2]: duplicate issue #936",
      ],
      ["a blank title", (r) => (r.newIssues[0].title = "  "), 'newIssues[0]: "title"'],
      [
        "an unknown severity",
        (r) => (r.newIssues[0].severity = "critical"),
        'newIssues[0]: "severity" must be one of high, medium, low',
      ],
      ["ledger not an object", (r) => (r.ledger = 4.32), '"ledger" must be an object'],
      [
        "an unknown ledger field",
        (r) => (r.ledger.costCents = 432),
        'ledger: unknown field "costCents"',
      ],
      ["fractional ledger tokens", (r) => (r.ledger.tokens = 1.5), 'ledger: "tokens"'],
      ["negative ledger cost", (r) => (r.ledger.costUsd = -1), 'ledger: "costUsd"'],
      ["a string ledger cost", (r) => (r.ledger.costUsd = "4.32"), 'ledger: "costUsd"'],
      ["the wrong ledger source", (r) => (r.ledger.source = "ai_token_usages"), 'ledger: "source"'],
      [
        "a missing ledger since",
        (r) => delete r.ledger.since,
        'ledger: "since" must be an ISO-8601',
      ],
      [
        "a date-only ledger until",
        (r) => (r.ledger.until = "2026-10-03"),
        'ledger: "until" must be an ISO-8601',
      ],
      [
        "since after until",
        (r) => (r.ledger.since = "2026-10-04T00:00:00Z"),
        'ledger: "since" must be before "until"',
      ],
      ["waves not an object", (r) => (r.waves = []), '"waves" must be an object keyed by wave'],
      [
        "an unknown wave",
        (r) => (r.waves.H = { tokens: 1, costUsd: 0 }),
        "waves.H: wave must be one of A, B, C, D, E, F, G, BA",
      ],
      ["a non-object wave", (r) => (r.waves.B = 3), "waves.B: expected a JSON object"],
      ["an unknown wave field", (r) => (r.waves.A.usd = 1), 'waves.A: unknown field "usd"'],
      ["missing wave tokens", (r) => delete r.waves.BA.tokens, 'waves.BA: "tokens"'],
      [
        "a bad wave since",
        (r) => (r.waves.A.since = "noon"),
        'waves.A: "since" must be an ISO-8601 timestamp when present',
      ],
    ]),
  )("rejects %s, naming the field", (_label, mutate, message) => {
    expect(errorsOf(mutate)).toContain(message);
  });

  it("reports every error at once", () => {
    const text = errorsOf((r) => {
      r.newIssues[0].severity = "x";
      r.ledger.tokens = -1;
      r.waves.Z = {};
    });
    expect(text.split("\n")).toHaveLength(3);
  });

  it("formats a signed cost", () => {
    expect(formatSignedCost(73)).toBe("$0.7300");
    expect(formatSignedCost(-1)).toBe("-$0.0100");
    expect(formatSignedCost(-250)).toBe("-$2.50");
  });

  it.each([
    [0.29, 29],
    [0.57, 57],
    [1.13, 113],
  ])(
    "a ledger of $%s equal to %s attributed cents leaves $0.0000, never -$0.0000",
    (usd, cents) => {
      // The float difference is a hair below zero; it must not decide the sign.
      expect(usd * 100 - cents).toBeLessThan(0);
      expect(formatSignedCost(usd * 100 - cents)).toBe("$0.0000");
    },
  );

  it.each([
    ["ledger", (/** @type {any} */ r) => (r.ledger.until = r.ledger.since), 'ledger: "since"'],
    [
      "waves.A",
      (/** @type {any} */ r) => (r.waves.A.until = r.waves.A.since),
      'waves.A: "since" must be before "until"',
    ],
    [
      "waves.BA",
      (/** @type {any} */ r) =>
        Object.assign(r.waves.BA, {
          since: "2026-10-03T12:00:00Z",
          until: "2026-10-03T11:00:00Z",
        }),
      'waves.BA: "since" must be before "until"',
    ],
  ])("rejects an empty or reversed %s window", (_label, mutate, message) => {
    expect(errorsOf(mutate)).toContain(message);
  });

  it("rejects ledger and wave tokens above Number.MAX_SAFE_INTEGER", () => {
    const text = errorsOf((r) => {
      r.ledger.tokens = Number.MAX_SAFE_INTEGER + 1;
      r.waves.A.tokens = 2 ** 60;
    });
    expect(text).toContain('ledger: "tokens" must be a non-negative integer no larger than');
    expect(text).toContain('waves.A: "tokens" must be a non-negative integer no larger than');
    const ok = runInfo();
    ok.ledger.tokens = Number.MAX_SAFE_INTEGER;
    expect(parseRunInfo(JSON.stringify(ok)).errors).toEqual([]);
  });
});

describe("run.json changePlanAccuracy (#1042)", () => {
  it("accepts a valid list and returns it", () => {
    const { run, errors } = parseRunInfo(JSON.stringify({ changePlanAccuracy: accuracyFixture() }));
    expect(errors).toEqual([]);
    expect(run?.changePlanAccuracy).toEqual(accuracyFixture());
  });

  /** @param {(rows: any[]) => void} mutate */
  const errorsOf = (mutate) => {
    const rows = /** @type {any[]} */ (accuracyFixture());
    mutate(rows);
    const { run, errors } = parseRunInfo(JSON.stringify({ changePlanAccuracy: rows }));
    expect(run).toBeNull();
    return errors.join("\n");
  };

  it("rejects a non-array", () => {
    expect(parseRunInfo(JSON.stringify({ changePlanAccuracy: {} })).errors).toEqual([
      'run.json: "changePlanAccuracy" must be an array',
    ]);
  });

  it.each(
    /** @type {Array<[string, (rows: any[]) => void, string]>} */ ([
      ["a non-object row", (r) => (r[0] = 3), "changePlanAccuracy[0]: expected a JSON object"],
      ["an unknown field", (r) => (r[1].ratio = 1), 'changePlanAccuracy[1]: unknown field "ratio"'],
      [
        "a string issue",
        (r) => (r[0].issue = "4478"),
        'changePlanAccuracy[0]: "issue" must be a positive issue number',
      ],
      [
        "an unknown output",
        (r) => (r[0].output = "spec"),
        'changePlanAccuracy[0]: "output" must be one of impact, chat, plan, j2-impact, j2-plan',
      ],
      [
        "an unknown source",
        (r) => (r[2].source = "upstream-ish"),
        'changePlanAccuracy[2]: "source" must be one of upstream, candidate, curated',
      ],
      [
        "ratios instead of counts",
        (r) => (r[0].files = { precision: 0.5, recall: 1 }),
        'changePlanAccuracy[0] files: unknown field "precision"',
      ],
      [
        "a missing count",
        (r) => delete r[0].functions.fn,
        'changePlanAccuracy[0] functions: "fn" must be a non-negative integer',
      ],
      [
        "a negative count",
        (r) => (r[1].files.fp = -1),
        'changePlanAccuracy[1] files: "fp" must be a non-negative integer',
      ],
      [
        "a fractional count",
        (r) => (r[1].functions.tp = 0.5),
        'changePlanAccuracy[1] functions: "tp" must be a non-negative integer',
      ],
      [
        "files not an object",
        (r) => (r[2].files = [3, 1, 2]),
        'changePlanAccuracy[2]: "files" must be an object { tp, fp, fn }',
      ],
      [
        "a string migrationCorrect",
        (r) => (r[0].migrationCorrect = "yes"),
        'changePlanAccuracy[0]: "migrationCorrect" must be true or false',
      ],
      [
        "a duplicate issue and output",
        (r) => (r[1].output = "j2-plan"),
        "changePlanAccuracy[1]: duplicate row for #4478 j2-plan",
      ],
      [
        "a change set of another size for the same issue",
        (r) => (r[1].files.fn = 5),
        "changePlanAccuracy[1]: #4478 files tp + fn is 7, but an earlier row has 3; the change set is the same for every output",
      ],
      [
        "a function change set of another size for the same issue",
        (r) => (r[1].functions.tp = 1),
        "changePlanAccuracy[1]: #4478 functions tp + fn is 3, but an earlier row has 2",
      ],
      [
        "another source for the same issue",
        (r) => (r[1].source = "upstream"),
        'changePlanAccuracy[1]: #4478 "source" is upstream, but an earlier row has curated',
      ],
    ]),
  )("rejects %s, naming the row and field", (_label, mutate, message) => {
    expect(errorsOf(mutate)).toContain(message);
  });
});

describe("argument parsing", () => {
  it("parses every option", () => {
    expect(
      parseArgs([
        "--in",
        "e",
        "--out",
        "o",
        "--deck",
        "both",
        "--title",
        "Run 3",
        "--inline-images",
      ]),
    ).toEqual({ inDir: "e", outDir: "o", deck: "both", title: "Run 3", inlineImages: true });
  });

  it.each([
    [["--out", "o", "--deck", "both"], "--in is required"],
    [["--in", "e", "--deck", "both"], "--out is required"],
    [["--in", "e", "--out", "o"], "--deck is required"],
    [["--in", "e", "--out", "o", "--deck", "slides"], "--deck must be"],
    [["--in"], "--in needs a value"],
    [["--in", "--out", "o"], "--in needs a value"],
    [["--verbose"], 'unknown argument "--verbose"'],
  ])("rejects %j", (argv, message) => {
    expect(() => parseArgs(argv)).toThrow(message);
  });
});

describe("shipped assets", () => {
  it("the deck script never closes a script element and builds nodes as text", () => {
    const { js, css } = readAssets();
    expect(js).not.toMatch(/<\/script/i);
    expect(js).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/);
    expect(css).not.toMatch(/url\(|@import/);
  });

  it("renderDeck refuses to inline a script containing a closing script tag", () => {
    expect(() =>
      renderDeck({
        kind: "report",
        title: "t",
        steps: [valid()],
        imageSrc: () => "x.png",
        inlineAssets: { css: "", js: "x='</script>'" },
      }),
    ).toThrow("</script");
  });
});

/** A valid `docQuality` (#1041): the format sample from `briefs/wave-c.md`. */
function docQualityFixture() {
  return {
    brd: {
      coverage: { hit: 11, total: 15 },
      accuracy: { correct: 10, stated: 11 },
      hallucinations: 2,
      sectionGrades: { A: 3, B: 4, C: 1, F: 0 },
    },
    architecture: {
      coverage: { hit: 9, total: 15 },
      accuracy: { correct: 9, stated: 9 },
      hallucinations: 0,
      sectionGrades: { A: 2, B: 3, C: 0, F: 0 },
    },
  };
}

describe("run.json docQuality (#1041)", () => {
  it("accepts both documents, one document, and its absence", () => {
    const r = /** @type {any} */ (runInfo());
    r.docQuality = docQualityFixture();
    const { run, errors } = parseRunInfo(JSON.stringify(r));
    expect(errors).toEqual([]);
    expect(run?.docQuality).toEqual(docQualityFixture());

    r.docQuality = { architecture: docQualityFixture().architecture };
    expect(parseRunInfo(JSON.stringify(r)).errors).toEqual([]);

    expect(parseRunInfo(JSON.stringify(runInfo())).run?.docQuality).toBeUndefined();
  });

  it("accepts a document that stated no key fact", () => {
    const r = {
      docQuality: {
        brd: {
          coverage: { hit: 0, total: 15 },
          accuracy: { correct: 0, stated: 0 },
          hallucinations: 0,
          sectionGrades: { A: 0, B: 0, C: 0, F: 1 },
        },
      },
    };
    expect(parseRunInfo(JSON.stringify(r)).errors).toEqual([]);
  });

  /** @param {(d: any) => void} mutate */
  const errorsOf = (mutate) => {
    const r = /** @type {any} */ (runInfo());
    r.docQuality = docQualityFixture();
    mutate(r.docQuality);
    const { run, errors } = parseRunInfo(JSON.stringify(r));
    expect(run).toBeNull();
    return errors.join("\n");
  };

  it.each(
    /** @type {Array<[string, (d: any) => void, string]>} */ ([
      [
        "an unknown document",
        (d) => (d.database = d.brd),
        'run.json docQuality: unknown document "database" (expected brd, architecture)',
      ],
      [
        "a non-object document",
        (d) => (d.brd = 3),
        "run.json docQuality.brd: expected a JSON object",
      ],
      [
        "an unknown document field",
        (d) => (d.brd.score = 1),
        'run.json docQuality.brd: unknown field "score"',
      ],
      [
        "a missing coverage",
        (d) => delete d.brd.coverage,
        'run.json docQuality.brd: "coverage" must be an object',
      ],
      [
        "an unknown coverage field",
        (d) => (d.brd.coverage.missed = 4),
        'run.json docQuality.brd.coverage: unknown field "missed"',
      ],
      [
        "a fractional coverage hit",
        (d) => (d.brd.coverage.hit = 1.5),
        'run.json docQuality.brd.coverage: "hit" must be a non-negative integer',
      ],
      [
        "a zero coverage total",
        (d) => (d.brd.coverage.total = 0),
        'run.json docQuality.brd.coverage: "total" must be a positive integer',
      ],
      [
        "hit above total",
        (d) => (d.architecture.coverage.hit = 16),
        'run.json docQuality.architecture.coverage: "hit" (16) must not exceed "total" (15)',
      ],
      [
        "accuracy not an object",
        (d) => (d.brd.accuracy = 0.9),
        'run.json docQuality.brd: "accuracy" must be an object',
      ],
      [
        "a negative accuracy correct",
        (d) => (d.brd.accuracy.correct = -1),
        'run.json docQuality.brd.accuracy: "correct" must be a non-negative integer',
      ],
      [
        "correct above stated",
        (d) => (d.brd.accuracy.correct = 12),
        'run.json docQuality.brd.accuracy: "correct" (12) must not exceed "stated" (11)',
      ],
      [
        "stated unequal to the coverage hit",
        (d) => (d.architecture.accuracy = { correct: 8, stated: 8 }),
        'run.json docQuality.architecture: accuracy "stated" (8) must equal coverage "hit" (9)',
      ],
      [
        "a string hallucination count",
        (d) => (d.brd.hallucinations = "2"),
        'run.json docQuality.brd: "hallucinations" must be a non-negative integer',
      ],
      [
        "a missing grade",
        (d) => delete d.brd.sectionGrades.F,
        'run.json docQuality.brd.sectionGrades: "F" must be a non-negative integer',
      ],
      [
        "an unknown grade",
        (d) => (d.brd.sectionGrades.D = 1),
        'run.json docQuality.brd.sectionGrades: unknown grade "D" (expected A, B, C, F)',
      ],
      [
        "sectionGrades as an array",
        (d) => (d.brd.sectionGrades = [3, 4, 1, 0]),
        'run.json docQuality.brd: "sectionGrades" must be an object',
      ],
    ]),
  )("rejects %s, naming the field", (_label, mutate, message) => {
    expect(errorsOf(mutate)).toContain(message);
  });

  it.each([
    ["an array", []],
    ["a number", 7],
    ["null", null],
  ])("rejects docQuality as %s", (_label, value) => {
    const r = /** @type {any} */ (runInfo());
    r.docQuality = value;
    expect(parseRunInfo(JSON.stringify(r)).errors).toEqual([
      'run.json: "docQuality" must be an object keyed by document (brd, architecture)',
    ]);
  });

  it("still rejects unknown top-level fields alongside a valid docQuality", () => {
    const r = /** @type {any} */ (runInfo());
    r.docQuality = docQualityFixture();
    r.docScore = 1;
    expect(parseRunInfo(JSON.stringify(r)).errors).toEqual(['run.json: unknown field "docScore"']);
  });

  /** @param {any} run @param {"report" | "tutorial"} [kind] */
  const deckOf = (run, kind = "report") =>
    renderDeck({
      kind,
      title: "T",
      steps: [valid()],
      imageSrc: () => "x.png",
      inlineAssets: null,
      run,
    });

  it("renders a doc-quality table on the report summary, one row per scored document", () => {
    const r = /** @type {any} */ (runInfo());
    r.docQuality = docQualityFixture();
    const report = deckOf(parseRunInfo(JSON.stringify(r)).run);
    expect(report).toContain('<table class="waves doc-quality">');
    expect(report).toContain("<caption>Doc quality against the Phase 9 answer key</caption>");
    expect(report).toContain(
      '<tr><th scope="row">BRD</th><td>11/15</td><td>10/11</td><td>2</td><td>3</td><td>4</td><td>1</td><td>0</td></tr>',
    );
    expect(report).toContain(
      '<tr><th scope="row">Architecture</th><td>9/15</td><td>9/9</td><td>0</td><td>2</td><td>3</td><td>0</td><td>0</td></tr>',
    );
    // On the summary slide, BRD first.
    const start = report.indexOf('aria-label="Summary"');
    const summary = report.slice(start, report.indexOf("</section>", start));
    expect(summary).toContain("doc-quality");
    expect(summary.indexOf(">BRD<")).toBeLessThan(summary.indexOf(">Architecture<"));
  });

  it("renders only the documents that were scored", () => {
    const { run } = parseRunInfo(
      JSON.stringify({ docQuality: { architecture: docQualityFixture().architecture } }),
    );
    const report = deckOf(run);
    expect(report).toContain('<th scope="row">Architecture</th>');
    expect(report).not.toContain('<th scope="row">BRD</th>');
  });

  it("omits the table when docQuality is absent, and from the tutorial", () => {
    expect(deckOf(parseRunInfo(JSON.stringify(runInfo())).run)).not.toContain("doc-quality");
    expect(deckOf(null)).not.toContain("doc-quality");
    const r = /** @type {any} */ (runInfo());
    r.docQuality = docQualityFixture();
    expect(deckOf(parseRunInfo(JSON.stringify(r)).run, "tutorial")).not.toContain("doc-quality");
  });
});

/** Wave G's build proof (#1043) for Miniflux #4478, whose change set is 3 files and 2 functions. */
function buildProofFixture() {
  return {
    issue: 4478,
    branch: "walkthrough/run-7-4478",
    commit: "0123456789abcdef0123456789abcdef01234567",
    builds: true,
    testsPass: false,
    tasksTotal: 8,
    tasksCorrected: 2,
    files: { tp: 2, fp: 1, fn: 1 },
    functions: { tp: 2, fp: 0, fn: 0 },
    agentCostUsd: 2.15,
    wallMinutes: 38,
  };
}

describe("run.json buildProof (#1043)", () => {
  it("accepts a valid build proof and returns it", () => {
    const r = /** @type {any} */ (runInfo());
    r.buildProof = buildProofFixture();
    const { run, errors } = parseRunInfo(JSON.stringify(r));
    expect(errors).toEqual([]);
    expect(run?.buildProof).toEqual(buildProofFixture());
  });

  it("accepts a stop before the build: builds and testsPass not reached", () => {
    const proof = { ...buildProofFixture(), builds: null, testsPass: null };
    expect(parseRunInfo(JSON.stringify({ buildProof: proof })).errors).toEqual([]);
  });

  it("accepts a proof that agrees with the issue's changePlanAccuracy change set", () => {
    const { errors } = parseRunInfo(
      JSON.stringify({ changePlanAccuracy: accuracyFixture(), buildProof: buildProofFixture() }),
    );
    expect(errors).toEqual([]);
  });

  /** @param {(p: any) => void} mutate @param {object} [extra] */
  const errorsOf = (mutate, extra = {}) => {
    const proof = /** @type {any} */ (buildProofFixture());
    mutate(proof);
    const { run, errors } = parseRunInfo(JSON.stringify({ ...extra, buildProof: proof }));
    expect(run).toBeNull();
    return errors;
  };

  it.each([[[]], [3], ["x"], [null]])("rejects a buildProof of %j", (value) => {
    expect(parseRunInfo(JSON.stringify({ buildProof: value })).errors).toEqual([
      'run.json: "buildProof" must be an object',
    ]);
  });

  it.each(
    /** @type {Array<[string, (p: any) => void, string]>} */ ([
      ["an unknown field", (p) => (p.pr = 12), 'run.json buildProof: unknown field "pr"'],
      [
        "a string issue",
        (p) => (p.issue = "4478"),
        'run.json buildProof: "issue" must be a positive issue number',
      ],
      [
        "a branch outside the walkthrough naming",
        (p) => (p.branch = "main"),
        'run.json buildProof: "branch" must be walkthrough/run-<N>-<issue>',
      ],
      [
        "a branch for another issue",
        (p) => (p.branch = "walkthrough/run-7-4336"),
        'run.json buildProof: "branch" names issue 4336, but "issue" is 4478',
      ],
      [
        "a non-SHA commit",
        (p) => (p.commit = "HEAD"),
        'run.json buildProof: "commit" must be a commit SHA (7 to 40 hex characters)',
      ],
      [
        "a string builds",
        (p) => (p.builds = "yes"),
        'run.json buildProof: "builds" must be true, false or null (not reached)',
      ],
      [
        "a missing testsPass",
        (p) => delete p.testsPass,
        'run.json buildProof: "testsPass" must be true, false or null (not reached)',
      ],
      [
        "tests passing on a failed build",
        (p) => {
          p.builds = false;
          p.testsPass = true;
        },
        'run.json buildProof: "testsPass" cannot be true when "builds" is not',
      ],
      [
        "a test result without a build",
        (p) => {
          p.builds = null;
          p.testsPass = false;
        },
        'run.json buildProof: "testsPass" must be null (not reached) when "builds" is',
      ],
      [
        "zero tasks",
        (p) => (p.tasksTotal = 0),
        'run.json buildProof: "tasksTotal" must be a positive integer',
      ],
      [
        "a fractional tasksCorrected",
        (p) => (p.tasksCorrected = 1.5),
        'run.json buildProof: "tasksCorrected" must be a non-negative integer',
      ],
      [
        "more corrected tasks than tasks",
        (p) => (p.tasksCorrected = 9),
        'run.json buildProof: "tasksCorrected" (9) must not exceed "tasksTotal" (8)',
      ],
      [
        "ratios instead of counts",
        (p) => (p.files = { precision: 1 }),
        'run.json buildProof files: unknown field "precision"',
      ],
      [
        "a negative function count",
        (p) => (p.functions.fp = -1),
        'run.json buildProof functions: "fp" must be a non-negative integer',
      ],
      [
        "a negative agent cost",
        (p) => (p.agentCostUsd = -0.5),
        'run.json buildProof: "agentCostUsd" must be a non-negative number',
      ],
      [
        "a string wall time",
        (p) => (p.wallMinutes = "38"),
        'run.json buildProof: "wallMinutes" must be a non-negative number',
      ],
    ]),
  )("rejects %s, naming the field", (_label, mutate, message) => {
    expect(errorsOf(mutate)).toContain(message);
  });

  it("rejects a change set that disagrees with changePlanAccuracy for the same issue", () => {
    expect(errorsOf((p) => (p.files.fn = 4), { changePlanAccuracy: accuracyFixture() })).toContain(
      "run.json buildProof: #4478 files tp + fn is 6, but changePlanAccuracy has 3; the change set is the same for every output",
    );
    expect(
      errorsOf((p) => (p.functions.tp = 0), { changePlanAccuracy: accuracyFixture() }),
    ).toContain(
      "run.json buildProof: #4478 functions tp + fn is 0, but changePlanAccuracy has 2; the change set is the same for every output",
    );
  });

  /** @param {any} run @param {"report" | "tutorial"} [kind] */
  const deckOf = (run, kind = "report") =>
    renderDeck({
      kind,
      title: "T",
      steps: [valid()],
      imageSrc: () => "x.png",
      inlineAssets: null,
      run,
    });

  it("renders a build-proof slide on the report, with the agent's cost kept apart", () => {
    const r = /** @type {any} */ (runInfo());
    r.changePlanAccuracy = accuracyFixture();
    r.buildProof = buildProofFixture();
    const report = deckOf(parseRunInfo(JSON.stringify(r)).run);
    const sections = [...report.matchAll(/<section class="slide slide--(\w+)/g)].map((m) => m[1]);
    // After the change-plan accuracy slide and before the closing new-issues slide.
    expect(sections.slice(-3)).toEqual(["accuracy", "build", "issues"]);
    const start = report.indexOf('aria-label="Build proof"');
    const slide = report.slice(start, report.indexOf("</section>", start));
    expect(slide).toContain("<h2>Build proof (wave G)</h2>");
    expect(slide).toContain(
      '<a href="https://github.com/miniflux/v2/issues/4478" rel="noopener noreferrer" target="_blank">#4478</a>',
    );
    expect(slide).toContain(
      '<a href="https://github.com/openzigs/flux-v2/tree/walkthrough/run-7-4478" rel="noopener noreferrer" target="_blank"><code>walkthrough/run-7-4478</code></a>',
    );
    expect(slide).toContain(
      '<a href="https://github.com/openzigs/flux-v2/commit/0123456789abcdef0123456789abcdef01234567" rel="noopener noreferrer" target="_blank"><code>01234567</code></a>',
    );
    expect(slide).toContain('<th scope="row">Builds</th><td>yes</td>');
    expect(slide).toContain('<th scope="row">Tests pass</th><td>no</td>');
    expect(slide).toContain('<th scope="row">Tasks needing correction</th><td>2 of 8</td>');
    // files 2 tp 1 fp 1 fn -> P 67% (2/3), R 67% (2/3); functions 2/2 both ways.
    expect(slide).toContain(
      '<th scope="row">Files vs reference change set</th><td>precision 67% (2/3) · recall 67% (2/3)</td>',
    );
    expect(slide).toContain(
      '<th scope="row">Functions vs reference change set</th><td>precision 100% (2/2) · recall 100% (2/2)</td>',
    );
    expect(slide).toContain('<th scope="row">Agent cost (not METIS spend)</th><td>$2.15</td>');
    expect(slide).toContain('<th scope="row">Wall time</th><td>38 min</td>');
  });

  it("shows a stop before the build as not reached", () => {
    const run = parseRunInfo(
      JSON.stringify({ buildProof: { ...buildProofFixture(), builds: null, testsPass: null } }),
    ).run;
    const report = deckOf(run);
    expect(report).toContain('<th scope="row">Builds</th><td>not reached</td>');
    expect(report).toContain('<th scope="row">Tests pass</th><td>not reached</td>');
  });

  it("omits the slide without buildProof, and from the tutorial", () => {
    expect(deckOf(parseRunInfo(JSON.stringify(runInfo())).run)).not.toContain("slide--build");
    expect(deckOf(null)).not.toContain("slide--build");
    const r = /** @type {any} */ (runInfo());
    r.buildProof = buildProofFixture();
    expect(deckOf(parseRunInfo(JSON.stringify(r)).run, "tutorial")).not.toContain("Build proof");
  });
});
