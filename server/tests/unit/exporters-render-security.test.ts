/**
 * #686 — mermaid render security for document export, asserted WITHOUT a real
 * headless Chromium (#388).
 *
 * These tests used to live in `exporters.test.ts` and called `exportDocument`
 * against a real `puppeteer.launch()`. Under the `pnpm test` monorepo fan-out
 * that Chromium spawn contended for CPU with every other package's workers and
 * timed out at 30 s. The security posture #686 establishes lives entirely on
 * OUR side of the puppeteer boundary: the diagram source must reach the page as
 * escaped TEXT, and the mermaid.initialize call we hand the page must name the
 * strict security level with HTML labels disabled. Mermaid's own DOMPurify pass
 * is the library's contract, not ours. So puppeteer is stubbed here with a
 * recorder and the tests assert on exactly what would have been sent to Chrome.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

interface Recorded {
  launches: Array<{ args?: string[] }>;
  contents: string[];
  scripts: string[];
  closed: number;
}

const rec: Recorded = { launches: [], contents: [], scripts: [], closed: 0 };
const launchBehaviour: { fail: boolean; pdfFail: boolean } = { fail: false, pdfFail: false };

function fakePage() {
  return {
    setViewport: async () => {},
    setContent: async (html: string) => {
      rec.contents.push(html);
    },
    addScriptTag: async () => {},
    evaluate: async (script: string) => {
      rec.scripts.push(script);
    },
    waitForSelector: async () => null,
    $: async () => ({ screenshot: async () => Buffer.from("PNGDATA") }),
    pdf: async () => {
      if (launchBehaviour.pdfFail) throw new Error("render crashed after launch");
      return Buffer.from("%PDF-1.4 fake");
    },
    close: async () => {},
  };
}

vi.mock("puppeteer", () => ({
  default: {
    launch: async (opts: { args?: string[] }) => {
      rec.launches.push(opts);
      if (launchBehaviour.fail) throw new Error("no chrome in this sandbox");
      return {
        newPage: async () => fakePage(),
        close: async () => {
          rec.closed++;
        },
      };
    },
  },
}));

const { exportDocument, MERMAID_RENDER_SECURITY, chromeLaunchArgs, mermaidInitScript } =
  await import("../../src/lib/docs-gen/exporters.js");

const PAYLOAD = "<img src=x onerror=alert(1)>";
const MALICIOUS = [
  "# Diagram",
  "",
  "```mermaid",
  "graph TD",
  `  A["${PAYLOAD}"] --> B[ok]`,
  "```",
  "",
].join("\n");

/** The mermaid.initialize(...) call among the scripts evaluated in the page. */
function mermaidInitScripts(): string[] {
  return rec.scripts.filter((s) => s.includes("mermaid.initialize("));
}

interface MermaidInitConfig {
  securityLevel?: string;
  htmlLabels?: boolean;
  startOnLoad?: boolean;
  theme?: string;
  flowchart?: { htmlLabels?: boolean; useMaxWidth?: boolean };
}

/**
 * The config object passed to every mermaid.initialize(...) call in `source`,
 * parsed rather than string-matched so a key order or quoting change cannot
 * hide a dropped `htmlLabels` (#447).
 */
function initConfigs(source: string): MermaidInitConfig[] {
  return [...source.matchAll(/mermaid\.initialize\((\{[^;]*\})\);/g)].map(
    (m) => JSON.parse(m[1]) as MermaidInitConfig,
  );
}

/** Asserts `config` carries the full #686 posture: strict, HTML labels off everywhere. */
function expectStrictPosture(config: MermaidInitConfig): void {
  expect(config.securityLevel).toBe("strict");
  expect(config.htmlLabels).toBe(false);
  expect(config.flowchart?.htmlLabels).toBe(false);
}

beforeEach(() => {
  rec.launches.length = 0;
  rec.contents.length = 0;
  rec.scripts.length = 0;
  rec.closed = 0;
  launchBehaviour.fail = false;
  launchBehaviour.pdfFail = false;
});

describe("mermaid render security (#686)", () => {
  it("renders diagrams under the STRICT security level with HTML labels disabled", () => {
    expect(MERMAID_RENDER_SECURITY.securityLevel).toBe("strict");
    expect(MERMAID_RENDER_SECURITY.htmlLabels).toBe(false);
  });

  describe("PDF export", () => {
    it("hands the injected node label to Chrome as escaped text, never as a live element", async () => {
      const result = await exportDocument(MALICIOUS, "xss-probe", "pdf");

      expect(result.mimeType).toBe("application/pdf");
      expect(result.filename).toBe("xss-probe.pdf");
      expect(rec.contents).toHaveLength(1);
      const html = rec.contents[0];
      // The diagram reached the page as a mermaid block (the probe is real) ...
      expect(html).toContain('<pre class="mermaid">');
      // ... whose label is inert escaped text, not an <img> that could fire onerror.
      expect(html).not.toContain(PAYLOAD);
      expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    });

    it("initialises mermaid in the page with securityLevel strict and htmlLabels false", async () => {
      await exportDocument(MALICIOUS, "xss-probe", "pdf");

      const init = mermaidInitScripts();
      expect(init).toHaveLength(1);
      const configs = initConfigs(init[0]);
      expect(configs).toHaveLength(1);
      expectStrictPosture(configs[0]);
      expect(configs[0].startOnLoad).toBe(false);
    });

    it("launches the renderer with the #686 Chrome args and always closes it", async () => {
      await exportDocument(MALICIOUS, "xss-probe", "pdf");

      expect(rec.launches).toHaveLength(1);
      expect(rec.launches[0].args).toEqual(chromeLaunchArgs());
      expect(rec.closed).toBe(1);
    });

    it("still closes the browser when rendering fails after launch (PR #442 review)", async () => {
      launchBehaviour.pdfFail = true;
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const result = await exportDocument(MALICIOUS, "xss-probe", "pdf");

        expect(result.mimeType).toBe("text/html");
        expect(result.buffer.toString("utf-8")).not.toContain(PAYLOAD);
        expect(rec.closed).toBe(1);
      } finally {
        warn.mockRestore();
        error.mockRestore();
      }
    });

    it("falls back to escaped HTML when Chrome cannot launch", async () => {
      launchBehaviour.fail = true;
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const result = await exportDocument(MALICIOUS, "xss-probe", "pdf");

        expect(result.mimeType).toBe("text/html");
        expect(result.filename).toBe("xss-probe.html");
        const html = result.buffer.toString("utf-8");
        expect(html).not.toContain(PAYLOAD);
        expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
      } finally {
        warn.mockRestore();
      }
    });

    it("initialises mermaid in the fallback HTML under the strict posture too (#447)", async () => {
      launchBehaviour.fail = true;
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const result = await exportDocument(MALICIOUS, "xss-probe", "pdf");

        const configs = initConfigs(result.buffer.toString("utf-8"));
        expect(configs).toHaveLength(1);
        expectStrictPosture(configs[0]);
        expect(configs[0].startOnLoad).toBe(true);
      } finally {
        warn.mockRestore();
      }
    });
  });

  describe("DOCX export (diagram rasterised in Chrome)", () => {
    it("hands the label to Chrome escaped and initialises mermaid strict", async () => {
      const result = await exportDocument(MALICIOUS, "xss-probe", "docx");

      expect(result.filename).toBe("xss-probe.docx");
      expect(rec.contents).toHaveLength(1);
      const html = rec.contents[0];
      expect(html).toContain('<pre class="mermaid">');
      expect(html).not.toContain(PAYLOAD);
      expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");

      const init = mermaidInitScripts();
      expect(init).toHaveLength(1);
      const configs = initConfigs(init[0]);
      expect(configs).toHaveLength(1);
      // #447 — the DOCX rasteriser used to set only securityLevel, leaving HTML labels on.
      expectStrictPosture(configs[0]);
      expect(rec.closed).toBe(1);
    });
  });

  describe("mermaidInitScript (#447)", () => {
    it("keeps the security posture when a layout supplies its own flowchart options", () => {
      const configs = initConfigs(
        mermaidInitScript({
          startOnLoad: false,
          theme: "neutral",
          flowchart: { useMaxWidth: true },
        }),
      );

      expect(configs).toHaveLength(1);
      expectStrictPosture(configs[0]);
      expect(configs[0].flowchart?.useMaxWidth).toBe(true);
      expect(configs[0].theme).toBe("neutral");
    });
  });

  describe("chromeLaunchArgs", () => {
    it("uses --no-sandbox by default so the renderer still launches in containers", () => {
      const prev = process.env.PDF_EXPORT_CHROME_SANDBOX;
      delete process.env.PDF_EXPORT_CHROME_SANDBOX;
      try {
        const args = chromeLaunchArgs();
        expect(args).toContain("--no-sandbox");
        expect(args).toContain("--disable-setuid-sandbox");
      } finally {
        if (prev !== undefined) process.env.PDF_EXPORT_CHROME_SANDBOX = prev;
      }
    });

    it("re-enables the Chrome sandbox when PDF_EXPORT_CHROME_SANDBOX=true", () => {
      const prev = process.env.PDF_EXPORT_CHROME_SANDBOX;
      process.env.PDF_EXPORT_CHROME_SANDBOX = "true";
      try {
        const args = chromeLaunchArgs();
        expect(args).not.toContain("--no-sandbox");
        expect(args).not.toContain("--disable-setuid-sandbox");
        expect(args).toContain("--disable-dev-shm-usage");
      } finally {
        if (prev === undefined) delete process.env.PDF_EXPORT_CHROME_SANDBOX;
        else process.env.PDF_EXPORT_CHROME_SANDBOX = prev;
      }
    });
  });
});

// #447 — moved from exporters.test.ts, where they launched a real Chromium under
// the fan-out. Each asserts on OUR side of the puppeteer boundary: the result we
// build from what the page hands back, and the filename we derive from the title.
describe("exportDocument through the puppeteer recorder (#447)", () => {
  it("exports to PDF: the page's bytes come back as an application/pdf result", async () => {
    const result = await exportDocument("# Test Document\n\nHello world.\n", "test-doc", "pdf");

    expect(result.mimeType).toBe("application/pdf");
    expect(result.filename).toBe("test-doc.pdf");
    expect(result.buffer.subarray(0, 4).toString()).toBe("%PDF");
    expect(rec.launches).toHaveLength(1);
    expect(rec.closed).toBe(1);
  });

  it("sanitizes the title of a PDF export", async () => {
    const result = await exportDocument("# Hi", "../../../etc/passwd", "pdf");

    expect(result.mimeType).toBe("application/pdf");
    expect(result.filename).not.toContain("/");
    expect(result.filename).not.toContain("..");
    expect(result.filename).toMatch(/\.pdf$/);
  });

  it("truncates an extremely long title to 100 characters", async () => {
    const result = await exportDocument("# Hi", "A".repeat(200), "pdf");

    expect(result.filename).toBe(`${"A".repeat(100)}.pdf`);
  });

  it("does not launch Chromium for a DOCX export with no mermaid diagram", async () => {
    const result = await exportDocument("# Plain\n\nNo diagrams.\n", "plain", "docx");

    expect(result.filename).toBe("plain.docx");
    expect(rec.launches).toHaveLength(0);
  });
});
