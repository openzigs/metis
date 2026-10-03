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
  groupChapters,
  orderSteps,
  parseArgs,
  parseManifest,
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
    ["wave", "F"],
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
