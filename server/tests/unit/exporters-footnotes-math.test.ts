/**
 * #1571 — the BRD's PDF printed 737 citation markers raw (`^src-n`) and 7
 * inline formulas as raw `\text{…}`; its Word file printed 927 markers and
 * every formula as raw LaTeX (`$$` × 60). Exports now render citations as
 * numbered references with a Sources list, typeset formulas in the PDF, and
 * print them as readable text in Word.
 *
 * No real Chromium (#447): puppeteer is a recorder, and the assertions read the
 * HTML handed to the page and the DOCX's own XML.
 */
import { describe, expect, it, vi } from "vitest";
import JSZip from "jszip";

const contents: string[] = [];
const scripts: string[] = [];
vi.mock("puppeteer", () => ({
  default: {
    launch: async () => ({
      newPage: async () => ({
        setRequestInterception: async () => {},
        on: () => {},
        setViewport: async () => {},
        setContent: async (html: string) => void contents.push(html),
        addScriptTag: async () => {},
        addStyleTag: async () => {},
        evaluate: async (script: string) => void scripts.push(String(script)),
        waitForSelector: async () => null,
        pdf: async () => Buffer.from("PDF"),
      }),
      close: async () => {},
    }),
  },
}));

const { exportDocument } = await import("../../src/lib/docs-gen/exporters.js");

/** A cut-down BRD in the generator's own shape (run-10 walkthrough). */
const BRD = [
  "# Business Requirements",
  "",
  "## Calculations & Formulas[^src-3]",
  "",
  String.raw`The next check time is always $\text{now} + \text{interval}$[^src-68].`,
  "",
  String.raw`**Feed count** — $\text{feed\_count}(c) = \text{coalesce}(\text{count}(f), 0)$ over feeds where $f.user\_id = u$[^src-22].`,
  "",
  "$$",
  String.raw`\text{interval} = \frac{7 \times 24\,\text{h}}{\text{weeklyCount} \times \text{factor}}`,
  "$$",
  "",
  String.raw`$$\text{halfWidth} = \frac{\text{window.innerWidth}}{2}$$`,
  "",
  String.raw`$$E = mc^2$$ where $E$ is energy[^src-22].`,
  "",
  "> Quoted rule[^src-68] with $x_{i}$.",
  "",
  "| Rule | Formula |",
  "|------|---------|",
  String.raw`| Score[^src-3] | $score_{final} = s \times d$ |`,
  "",
  "- Listed[^src-22] item",
  "",
  String.raw`Next page when \(\text{total} - \text{offset} > n\).`,
  "",
  "Prices stay prose: $5 and $10. Code stays code: `$x$` and `[^src-3]`.",
  "",
  "[^src-3]: `internal/reader/sanitizer` (module facts)",
  "[^src-22]: `internal/storage/user.go:41-58`",
  "[^src-68]: `internal/model/feed.go` (retrieved excerpt)",
  "[^src-99]: `never/cited.go`",
].join("\n");

async function pdfHtml(md: string): Promise<string> {
  contents.length = 0;
  scripts.length = 0;
  await exportDocument(md, "BRD", "pdf");
  return contents[0] ?? "";
}

async function docx(md: string): Promise<{ xml: string; text: string }> {
  const out = await exportDocument(md, "BRD", "docx");
  const zip = await JSZip.loadAsync(out.buffer);
  const xml = (await zip.file("word/document.xml")?.async("string")) ?? "";
  // The document's text is the content of its `w:t` runs.
  const text = [...xml.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]).join("");
  return { xml, text };
}

/** The XML of each `w:r` run whose text is exactly `text`. */
function runsWithText(xml: string, text: string): string[] {
  return [...xml.matchAll(/<w:r>(?:(?!<\/w:r>)[\s\S])*<\/w:r>/g)]
    .map((m) => m[0])
    .filter((run) => new RegExp(`<w:t(?:\\s[^>]*)?>${text}</w:t>`).test(run));
}

describe("PDF export (#1571)", () => {
  it("prints no citation marker raw, in either form", async () => {
    // The one `[^src-3]` left is the code span the BRD quotes on purpose.
    const html = (await pdfHtml(BRD)).replace("<code>[^src-3]</code>", "");
    expect(html).not.toContain("[^src-");
    expect(html).not.toContain("^src-");
  });

  it("numbers citations in order of first use, as linked superscripts", async () => {
    const html = await pdfHtml(BRD);
    expect(html).toContain(
      'Calculations &amp; Formulas<sup class="footnote-ref"><a href="#fn-1">1</a></sup>',
    );
    expect(html).toContain('</span><sup class="footnote-ref"><a href="#fn-2">2</a></sup>.');
    // src-3: the heading and the table; src-68: prose and the quote; src-22: three times.
    expect(html.match(/<a href="#fn-1">1<\/a>/g)).toHaveLength(2);
    expect(html.match(/<a href="#fn-2">2<\/a>/g)).toHaveLength(2);
    expect(html.match(/<a href="#fn-3">3<\/a>/g)).toHaveLength(3);
  });

  it("lists each cited source once, in number order, under Sources", async () => {
    const html = await pdfHtml(BRD);
    const section = html.slice(html.indexOf('<section class="footnotes">'));
    expect(section).toMatch(/^<section class="footnotes"><h2>Sources<\/h2><ol>/);
    expect(section).toContain(
      '<li id="fn-1"><code>internal/reader/sanitizer</code> (module facts)</li>',
    );
    expect(section).toContain(
      '<li id="fn-2"><code>internal/model/feed.go</code> (retrieved excerpt)</li>',
    );
    expect(section).toContain('<li id="fn-3"><code>internal/storage/user.go:41-58</code></li>');
    expect(section).not.toContain("never/cited.go");
    expect(section.indexOf('id="fn-1"')).toBeLessThan(section.indexOf('id="fn-2"'));
  });

  it("adds no Sources list to a document without citations", async () => {
    const html = await pdfHtml("# Plain\n\nNo citations here.");
    expect(html).not.toContain('<section class="footnotes">');
    expect(html).not.toContain('<sup class="footnote-ref"');
  });

  it("hands inline formulas to KaTeX untouched by markdown", async () => {
    const html = await pdfHtml(BRD);
    expect(html).toContain(
      String.raw`<span class="math-inline" data-formula="\text{feed\_count}(c) = \text{coalesce}(\text{count}(f), 0)">`,
    );
    expect(html).toContain(String.raw`data-formula="f.user\_id = u"`);
    expect(html).toContain(String.raw`data-formula="score_{final} = s \times d"`);
    expect(html).toContain(String.raw`data-formula="\text{total} - \text{offset} &gt; n"`);
    // Marked never saw `_{…}` or `\_`: no emphasis, no lost backslash.
    expect(html).not.toMatch(/data-formula="[^"]*<em>/);
    expect(html).not.toContain("feed_count}(c)");
  });

  it("seeds each inline formula with readable text, for a page without KaTeX", async () => {
    const html = await pdfHtml(BRD);
    expect(html).toContain(
      String.raw`<span class="math-inline" data-formula="\text{now} + \text{interval}">now + interval</span>`,
    );
  });

  it("renders the inline formulas with KaTeX in the page", async () => {
    await pdfHtml(BRD);
    const katexScript = scripts.find((s) => s.includes(".math-inline[data-formula]")) ?? "";
    expect(katexScript).toMatch(
      /\.math-inline\[data-formula\][\s\S]*katex\.renderToString\(formula, \{ displayMode: false, throwOnError: false \}\)/,
    );
  });

  it("leaves prices and code alone", async () => {
    const html = await pdfHtml(BRD);
    expect(html).toContain("Prices stay prose: $5 and $10.");
    expect(html).toContain("<code>$x$</code>");
    expect(html).toContain("<code>[^src-3]</code>");
  });

  it("keeps a citation's source text from injecting html", async () => {
    const html = await pdfHtml(
      "A[^x] b[^y].\n\n[^x]: <img src=x onerror=alert(1)>\n[^y]: [go](javascript:alert(1))",
    );
    expect(html).not.toMatch(/<img\s/i);
    expect(html).not.toMatch(/javascript:/i);
    expect(html).toContain('<li id="fn-1">&lt;img src=x onerror=alert(1)&gt;</li>');
    expect(html).toContain('<li id="fn-2">go</li>');
  });

  it("keeps an inline formula's text from injecting html", async () => {
    const html = await pdfHtml('Danger $"><img src=x onerror=alert(1)>$ here.');
    expect(html).not.toMatch(/<img\s/i);
    expect(html).toContain('data-formula="&quot;&gt;&lt;img src=x onerror=alert(1)&gt;"');
  });
});

describe("Word export (#1571)", () => {
  /** The text, less the code spans the BRD quotes `$x$` and `[^src-3]` in on purpose. */
  const proseText = async () =>
    (await docx(BRD)).text.replace("Code stays code: $x$ and [^src-3].", "");

  it("prints no citation marker raw", async () => {
    const text = await proseText();
    expect(text).not.toContain("[^src-");
    expect(text).not.toContain("^src-");
  });

  it("prints each citation as a superscript number", async () => {
    const { xml } = await docx(BRD);
    for (const n of ["1", "2", "3"]) {
      const runs = runsWithText(xml, n);
      expect(runs.length, `citation ${n}`).toBeGreaterThan(0);
      for (const run of runs) expect(run).toContain('<w:vertAlign w:val="superscript"/>');
    }
  });

  it("cites from headings, quotes, tables and lists too", async () => {
    const { xml } = await docx(BRD);
    // src-3 is cited from the heading and the table: twice; src-68 from prose and the quote.
    expect(runsWithText(xml, "1")).toHaveLength(2);
    expect(runsWithText(xml, "2")).toHaveLength(2);
    // src-22: two prose sentences and the list item.
    expect(runsWithText(xml, "3")).toHaveLength(3);
  });

  it("ends with the cited sources, once each, in number order", async () => {
    const { text } = await docx(BRD);
    const sources = text.slice(text.lastIndexOf("Sources"));
    expect(sources).toBe(
      "Sources" +
        "1. internal/reader/sanitizer (module facts)" +
        "2. internal/model/feed.go (retrieved excerpt)" +
        "3. internal/storage/user.go:41-58",
    );
  });

  it("adds no Sources heading to a document without citations", async () => {
    const { text } = await docx("# Plain\n\nNo citations here.");
    expect(text).not.toContain("Sources");
  });

  it("prints no formula as raw LaTeX", async () => {
    const text = await proseText();
    expect(text).not.toContain("$$");
    expect(text).not.toMatch(/\\(text|frac|times)/);
    expect(text).not.toMatch(/\$\\|\$[a-zA-Z]/);
  });

  it("prints formulas as readable text in Cambria Math", async () => {
    const { xml, text } = await docx(BRD);
    expect(text).toContain("interval = (7 × 24 h) / (weeklyCount × factor)");
    expect(text).toContain("halfWidth = window.innerWidth / 2");
    expect(text).toContain("The next check time is always now + interval");
    expect(text).toContain("feed_count(c) = coalesce(count(f), 0)");
    expect(text).toContain("E = mc^2 where E is energy");
    expect(text).toContain("score_final = s × d");
    expect(text).toContain("Quoted rule");
    expect(text).toContain("x_i");
    expect(text).toContain("Next page when total - offset &gt; n.");
    const [formula] = runsWithText(xml, "interval = \\(7 × 24 h\\) / \\(weeklyCount × factor\\)");
    expect(formula).toContain('w:ascii="Cambria Math"');
  });

  it("reads citations and formulas in a table's header row, keeping it bold", async () => {
    const { xml, text } = await docx(
      "| Term $x_{i}$[^a] | B |\n|---|---|\n| 1 | 2 |\n\n[^a]: `src.go`",
    );
    expect(text).toContain("Term x_i1B");
    const [citation] = runsWithText(xml, "1").filter((r) => r.includes("superscript"));
    expect(citation).toContain("<w:b/>");
  });

  it("keeps a quote italic and blue around its citation and formula", async () => {
    const { xml } = await docx("> Quoted[^a] with $x_{i}$ here.\n\n[^a]: `src.go`");
    for (const text of ["Quoted", "1", "x_i", " here."]) {
      const [run] = runsWithText(xml, text);
      expect(run, text).toContain("<w:i/>");
      expect(run, text).toContain('<w:color w:val="1e40af"/>');
    }
  });

  it("keeps a quote's bold, italic and link runs in the quote's style", async () => {
    const { xml } = await docx("> A **bold** and *slanted* [link](https://example.com) end");
    const [bold] = runsWithText(xml, "bold");
    expect(bold).toContain("<w:b/>");
    expect(bold).toContain("<w:i/>");
    const [slanted] = runsWithText(xml, "slanted");
    expect(slanted).toContain("<w:i/>");
    const [link] = runsWithText(xml, "link");
    expect(link).toContain("<w:i/>");
    expect(link).toContain('<w:color w:val="2563eb"/>');
  });

  it("sets a display formula on its own centred line", async () => {
    const { xml } = await docx("Before.\n\n$$\n\\frac{a}{b}\n$$\n\nAfter.");
    const paragraph = [...xml.matchAll(/<w:p>(?:(?!<\/w:p>)[\s\S])*<\/w:p>/g)]
      .map((m) => m[0])
      .find((p) => p.includes(">a / b<"));
    expect(paragraph).toContain('<w:jc w:val="center"/>');
  });

  it("takes an unterminated display formula to the end of the document", async () => {
    const { text } = await docx("Before.\n\n$$\nx + 1");
    expect(text).toBe("BRDBefore.x + 1");
  });

  it("leaves prices and code alone", async () => {
    const { text } = await docx(BRD);
    expect(text).toContain("Prices stay prose: $5 and $10.");
    expect(text).toContain("$x$");
    expect(text).toContain("[^src-3]");
  });
});
