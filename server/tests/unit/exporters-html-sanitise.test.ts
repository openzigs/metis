/**
 * #991 review — the HTML handed to headless Chrome must not carry live author
 * HTML, script-scheme links or images, however the markdown is arranged. The
 * payloads below are the ones that slipped past requirements-scope's regex
 * neutraliser when rendered through the real marked.
 */
import { describe, it, expect, vi } from "vitest";

const contents: string[] = [];
vi.mock("puppeteer", () => ({
  default: {
    launch: async () => ({
      newPage: async () => ({
        setViewport: async () => {},
        setContent: async (html: string) => void contents.push(html),
        addScriptTag: async () => {},
        evaluate: async () => {},
        waitForSelector: async () => null,
        pdf: async () => Buffer.from("PDF"),
      }),
      close: async () => {},
    }),
  },
}));

import { exportDocument } from "../../src/lib/docs-gen/exporters.js";

async function render(md: string): Promise<string> {
  contents.length = 0;
  await exportDocument(md, "t", "pdf");
  return contents[0] ?? "";
}

describe("PDF html is sanitised after marked", () => {
  it.each([
    ["escaped backtick", "\\`<img src=x onerror=alert(1)>`"],
    ["tilde fence around backtick fence", "~~~\n```\n~~~\n<img src=x onerror=alert(1)>\n```"],
    ["raw iframe", '<iframe src="http://169.254.169.254/"></iframe>'],
    ["inline html", "text <script>alert(1)</script> more"],
  ])("does not emit live html: %s", async (_n, md) => {
    const html = await render(md);
    expect(html).not.toMatch(/<img\s/i);
    expect(html).not.toMatch(/<iframe/i);
    expect(html).not.toMatch(/<script>alert/i);
  });

  it("drops script-scheme links but keeps their text", async () => {
    const html = await render("[click](javascript:alert(1)) and [ok](https://example.com/a)");
    expect(html).not.toMatch(/javascript:/i);
    expect(html).toContain("click");
    expect(html).toContain('<a href="https://example.com/a">ok</a>');
  });

  it("renders images as alt text, never an img element", async () => {
    const html = await render("![diagram](http://169.254.169.254/latest)");
    expect(html).not.toMatch(/<img\s/i);
    expect(html).not.toContain("169.254.169.254");
    expect(html).toContain("diagram");
  });

  it("keeps link titles escaped", async () => {
    const html = await render('[a](https://e.com "x\\" onmouseover=\\"y")');
    expect(html).not.toMatch(/" onmouseover=/);
    expect(html).toContain("&quot; onmouseover=");
  });

  it("still restores math and mermaid placeholders", async () => {
    const html = await render("$$x^2$$\n\n```mermaid\ngraph TD; A-->B\n```");
    expect(html).toContain('class="math-display"');
    expect(html).toContain('class="mermaid"');
  });
});
