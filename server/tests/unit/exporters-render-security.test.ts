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

/** A request as the #1017 interception handler sees it, settled into `outcome`. */
interface FakeRequest {
  url: () => string;
  isInterceptResolutionHandled: () => boolean;
  continue: () => Promise<void>;
  abort: (reason?: string) => Promise<void>;
}
type RequestHandler = (request: FakeRequest) => void;

interface Recorded {
  launches: Array<{ args?: string[] }>;
  contents: string[];
  scripts: string[];
  closed: number;
  /** Per page: whether interception was on when `setContent` ran, and its handlers. */
  pages: Array<{ interceptingAtSetContent: boolean | null; handlers: RequestHandler[] }>;
  /** Every addScriptTag / addStyleTag call, in order. */
  injected: Array<{ kind: "script" | "style"; path?: string; url?: string; content?: string }>;
}

const rec: Recorded = {
  launches: [],
  contents: [],
  scripts: [],
  closed: 0,
  pages: [],
  injected: [],
};
const launchBehaviour: { fail: boolean; pdfFail: boolean } = { fail: false, pdfFail: false };

function fakePage() {
  let intercepting = false;
  const page: Recorded["pages"][number] = { interceptingAtSetContent: null, handlers: [] };
  rec.pages.push(page);
  return {
    setRequestInterception: async (on: boolean) => {
      intercepting = on;
    },
    on: (event: string, handler: RequestHandler) => {
      if (event === "request") page.handlers.push(handler);
    },
    setViewport: async () => {},
    setContent: async (html: string) => {
      page.interceptingAtSetContent = intercepting;
      rec.contents.push(html);
    },
    addScriptTag: async (opts: { path?: string; url?: string }) => {
      rec.injected.push({ kind: "script", ...opts });
    },
    addStyleTag: async (opts: { path?: string; url?: string; content?: string }) => {
      rec.injected.push({ kind: "style", ...opts });
    },
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

const {
  exportDocument,
  MERMAID_RENDER_SECURITY,
  chromeLaunchArgs,
  mermaidInitScript,
  isExportRequestAllowed,
  EXPORT_PAGE_CSP,
  EXPORT_PAGE_CSP_META,
  EXPORT_NETWORK_LOCKDOWN_ARGS,
  katexStylesheet,
} = await import("../../src/lib/docs-gen/exporters.js");

/** The directives of a CSP string, as a name -> sources map. */
function cspDirectives(csp: string): Map<string, string[]> {
  return new Map(
    csp
      .split(";")
      .map((d) => d.trim().split(/\s+/))
      .filter((parts) => parts[0])
      .map(([name, ...sources]) => [name!, sources]),
  );
}

/** Asserts `html` opens its <head> with the export CSP and links nothing external. */
function expectLockedDownHtml(html: string): void {
  const head = html.slice(html.indexOf("<head>"), html.indexOf("</head>"));
  expect(head.trimStart().startsWith(`<head>`)).toBe(true);
  // The CSP is the first element in <head>, so nothing above it can load first.
  expect(head.replace("<head>", "").trimStart().startsWith(EXPORT_PAGE_CSP_META)).toBe(true);
  expect(html).not.toMatch(/<link\b/i);
  expect(html).not.toMatch(/cdn\.jsdelivr|https?:\/\/(?!www\.w3\.org)/i);
}

/**
 * Drive `url` through every request handler a page registered and report what
 * happened to it: `continue`, `abort:<reason>`, or `unhandled` (which in a real
 * Chrome with interception on is a request that hangs).
 */
function settle(page: Recorded["pages"][number], url: string): string {
  let outcome = "unhandled";
  const request: FakeRequest = {
    url: () => url,
    isInterceptResolutionHandled: () => outcome !== "unhandled",
    continue: async () => {
      outcome = "continue";
    },
    abort: async (reason) => {
      outcome = `abort:${reason ?? ""}`;
    },
  };
  for (const handler of page.handlers) handler(request);
  return outcome;
}

/** Every kind of request a sanitiser miss could make the export page issue. */
const BLOCKED_URLS = [
  "http://169.254.169.254/latest/meta-data/",
  "https://attacker.example/beacon.png",
  "http://localhost:4000/api/projects",
  "file:///etc/passwd",
  "ftp://attacker.example/x",
  "ws://attacker.example/socket",
  "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js",
];

/** Asserts a page intercepted before any content loaded, blocking all but data: and about:blank. */
function expectExternalRequestsBlocked(page: Recorded["pages"][number]): void {
  expect(page.interceptingAtSetContent).toBe(true);
  expect(page.handlers).toHaveLength(1);
  for (const url of BLOCKED_URLS) expect(settle(page, url), url).toBe("abort:blockedbyclient");
  expect(settle(page, "data:image/png;base64,iVBORw0KGgo=")).toBe("continue");
  expect(settle(page, "about:blank")).toBe("continue");
}

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
  rec.pages.length = 0;
  rec.injected.length = 0;
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

  describe("request interception (#1017)", () => {
    it("PDF: intercepts before setContent and aborts every non-data: request", async () => {
      await exportDocument(MALICIOUS, "xss-probe", "pdf");

      expect(rec.pages).toHaveLength(1);
      expectExternalRequestsBlocked(rec.pages[0]!);
    });

    it("DOCX: the diagram rasteriser's page is held to the same rule", async () => {
      await exportDocument(MALICIOUS, "xss-probe", "docx");

      expect(rec.pages).toHaveLength(1);
      expectExternalRequestsBlocked(rec.pages[0]!);
    });

    it("leaves a request another handler already settled alone", async () => {
      await exportDocument("# Hi", "t", "pdf");
      const handler = rec.pages[0]!.handlers[0]!;
      const calls: string[] = [];
      handler({
        url: () => "https://attacker.example/",
        isInterceptResolutionHandled: () => true,
        continue: async () => void calls.push("continue"),
        abort: async () => void calls.push("abort"),
      });
      expect(calls).toEqual([]);
    });

    it("swallows a settle that rejects because the page already closed", async () => {
      await exportDocument("# Hi", "t", "pdf");
      const handler = rec.pages[0]!.handlers[0]!;
      const unhandled = vi.fn();
      process.on("unhandledRejection", unhandled);
      try {
        handler({
          url: () => "https://attacker.example/",
          isInterceptResolutionHandled: () => false,
          continue: async () => {},
          abort: () => Promise.reject(new Error("Target closed")),
        });
        await new Promise((r) => setTimeout(r, 0));
        expect(unhandled).not.toHaveBeenCalled();
      } finally {
        process.off("unhandledRejection", unhandled);
      }
    });

    // PR #1321 review — interception never sees a WebSocket handshake, so the CSP must refuse it.
    it("the export CSP refuses every connect channel, frame and base, and allows data: images only", () => {
      const d = cspDirectives(EXPORT_PAGE_CSP);
      expect(d.get("default-src")).toEqual(["'none'"]);
      expect(d.get("connect-src")).toEqual(["'none'"]);
      expect(d.get("frame-src")).toEqual(["'none'"]);
      expect(d.get("object-src")).toEqual(["'none'"]);
      expect(d.get("base-uri")).toEqual(["'none'"]);
      expect(d.get("form-action")).toEqual(["'none'"]);
      expect(d.get("img-src")).toEqual(["data:"]);
      expect(d.get("font-src")).toEqual(["data:"]);
      // Injected bundles are inline elements; no source list names a host or scheme beyond data:.
      expect(d.get("script-src")).toEqual(["'unsafe-inline'"]);
      expect(d.get("style-src")).toEqual(["'unsafe-inline'"]);
    });

    it("PDF: the page HTML starts with the CSP and links no stylesheet or CDN", async () => {
      await exportDocument("# Maths\n\n$$x^2$$\n\nText.\n", "t", "pdf");
      expect(rec.contents).toHaveLength(1);
      expectLockedDownHtml(rec.contents[0]!);
    });

    it("DOCX: the diagram page HTML starts with the CSP too", async () => {
      await exportDocument(MALICIOUS, "xss-probe", "docx");
      expect(rec.contents).toHaveLength(1);
      expectLockedDownHtml(rec.contents[0]!);
    });

    it("injects mermaid and KaTeX from local paths and KaTeX's stylesheet inline, never a URL", async () => {
      await exportDocument("# Maths\n\n$$x^2$$\n", "t", "pdf");
      expect(rec.injected.filter((i) => i.url !== undefined)).toEqual([]);
      const paths = rec.injected.map(
        (i) => `${i.kind}:${i.content !== undefined ? "inline" : i.path?.split(/[\\/]/).pop()}`,
      );
      expect(paths).toEqual([
        "script:mermaid.min.js",
        "style:inline",
        "script:katex.min.js",
        "script:auto-render.min.js",
      ]);
      // #1324 — the inline text is the font-inlined stylesheet, not the raw file.
      expect(rec.injected[1]!.content).toBe(katexStylesheet());
    });

    // #1324 — KaTeX's relative font URLs resolve to nothing on about:blank and
    // would be requests the page may not make; each face carries its woff2 inline.
    describe("katexStylesheet", () => {
      const css = katexStylesheet()!;
      const faces = css.match(/@font-face\{[^}]*\}/g) ?? [];

      it("keeps every @font-face, each with exactly one source: an inline woff2", () => {
        expect(faces).toHaveLength(20);
        for (const face of faces) {
          const urls = face.match(/url\([^)]*\)/g) ?? [];
          expect(urls, face.slice(0, 80)).toHaveLength(1);
          expect(urls[0]).toMatch(/^url\(data:font\/woff2;base64,[A-Za-z0-9+/]+=*\)$/);
          expect(face).toContain('format("woff2")');
        }
      });

      it("refers to nothing outside itself: every url() in the sheet is a data: URL", () => {
        const urls = css.match(/url\([^)]*\)/g) ?? [];
        expect(urls.length).toBe(faces.length);
        expect(urls.filter((u) => !u.startsWith("url(data:"))).toEqual([]);
        expect(css).not.toMatch(/fonts\//);
      });

      it("inlines the real font bytes: each data: URL decodes to a WOFF2 file", () => {
        for (const face of faces) {
          const b64 = /base64,([^)]*)\)/.exec(face)![1]!;
          const bytes = Buffer.from(b64, "base64");
          expect(bytes.subarray(0, 4).toString("latin1")).toBe("wOF2");
          expect(bytes.length).toBeGreaterThan(1000);
        }
      });

      it("keeps the rest of KaTeX's rules", () => {
        expect(css).toMatch(/\.katex\{[^}]*font:normal 1\.21em KaTeX_Main/);
      });
    });

    // PR #1321 review — without the CDN fallback a missing mermaid must not throw in the page.
    it("the PDF diagram script returns quietly when mermaid is not loaded", async () => {
      await exportDocument(MALICIOUS, "xss-probe", "pdf");
      const script = mermaidInitScripts()[0]!;
      const { runInNewContext } = await import("node:vm");
      // No `mermaid` and no `document`: the guard must return before touching either.
      await expect(runInNewContext(script, {})).resolves.toBeUndefined();
    });

    it("isExportRequestAllowed admits only data: URLs and about:blank", () => {
      expect(isExportRequestAllowed("DATA:text/plain,x")).toBe(true);
      expect(isExportRequestAllowed("about:blank")).toBe(true);
      expect(isExportRequestAllowed("about:srcdoc")).toBe(false);
      expect(isExportRequestAllowed("blob:null/1234")).toBe(false);
      expect(isExportRequestAllowed("javascript:alert(1)")).toBe(false);
      expect(isExportRequestAllowed(" data:text/plain,x")).toBe(false);
      for (const url of BLOCKED_URLS) expect(isExportRequestAllowed(url), url).toBe(false);
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

    it("always cuts the browser off the network: dead proxy, loopback proxied, no direct WebRTC UDP (#1017)", () => {
      const prev = process.env.PDF_EXPORT_CHROME_SANDBOX;
      try {
        for (const sandbox of [undefined, "true"]) {
          if (sandbox === undefined) delete process.env.PDF_EXPORT_CHROME_SANDBOX;
          else process.env.PDF_EXPORT_CHROME_SANDBOX = sandbox;
          const args = chromeLaunchArgs();
          expect(args).toEqual(expect.arrayContaining([...EXPORT_NETWORK_LOCKDOWN_ARGS]));
          expect(args).toContain("--proxy-bypass-list=<-loopback>");
          expect(args).toContain("--webrtc-ip-handling-policy=disable_non_proxied_udp");
          expect(args.some((a) => a.startsWith("--proxy-server="))).toBe(true);
        }
      } finally {
        if (prev === undefined) delete process.env.PDF_EXPORT_CHROME_SANDBOX;
        else process.env.PDF_EXPORT_CHROME_SANDBOX = prev;
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
