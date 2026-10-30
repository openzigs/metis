/**
 * #447 — the document-export tests that genuinely need a REAL headless Chromium
 * to produce a real PDF / DOCX binary. They used to live in
 * tests/unit/exporters.test.ts, where the Chromium spawn contended for CPU with
 * every other package's workers under the `pnpm test` fan-out and timed out
 * (#388). The `*.integration.test.ts` suffix keeps them out of that fan-out;
 * everything asserted on our side of the puppeteer boundary lives in
 * tests/unit/exporters-render-security.test.ts against a recorder.
 *
 * Gated like the other integration suites: runs only when
 * `RUN_INTEGRATION_TESTS=1`, i.e. via
 *
 *   pnpm --filter @metis/server test:integration exporters-real-chromium
 *
 * The exporter degrades to HTML / an image-less DOCX when Chrome cannot launch,
 * and the assertions below are unconditional, so a Chromium that cannot launch
 * fails this suite. CI runs it in the `server` job (#456).
 */
import { createSocket } from "node:dgram";
import { createServer } from "node:http";
import { createServer as createTcpServer, type AddressInfo } from "node:net";
import puppeteer from "puppeteer";
import { describe, it, expect } from "vitest";
import {
  blockExternalRequests,
  EXPORT_NETWORK_LOCKDOWN_ARGS,
  EXPORT_PAGE_CSP_META,
  chromeLaunchArgs,
  exportDocument,
  renderPdfPage,
} from "../src/lib/docs-gen/exporters.js";

const enabled = process.env.RUN_INTEGRATION_TESTS === "1";

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

describe.runIf(enabled)("document export against a real Chromium (integration)", () => {
  it("generates an actual PDF with Mermaid diagrams", async () => {
    const md = [
      "# Architecture",
      "",
      "## System Overview",
      "",
      "```mermaid",
      "graph TD",
      "    A[Client] --> B[API Gateway]",
      "    B --> C[Service]",
      "    C --> D[Database]",
      "```",
      "",
      "Some text after the diagram.",
      "",
    ].join("\n");

    const result = await exportDocument(md, "mermaid-test", "pdf");

    // Unconditional (PR #451 review): this suite exists to exercise a real
    // Chromium, so an HTML fallback must fail it rather than skip the checks.
    expect(result.mimeType).toBe("application/pdf");
    expect(result.buffer.subarray(0, 4).toString()).toBe("%PDF");
    expect(result.filename).toBe("mermaid-test.pdf");
  });

  it("generates a DOCX with Mermaid diagrams embedded as images", async () => {
    const md = [
      "# Architecture",
      "",
      "```mermaid",
      "graph LR",
      "    A --> B",
      "```",
      "",
      "## Tables",
      "",
      "| Name | Value |",
      "|------|-------|",
      "| foo  | bar   |",
      "",
    ].join("\n");

    const result = await exportDocument(md, "docx-mermaid", "docx");

    expect(result.mimeType).toBe(DOCX_MIME);
    // DOCX files are zips: PK signature.
    expect(result.buffer.subarray(0, 2).toString()).toBe("PK");
    expect(result.filename).toBe("docx-mermaid.docx");
    // It embeds the rasterised diagram, which only a real Chromium produces.
    // Size alone does not show that: an image-less DOCX with this table is
    // already over 5 KB. Zip entry names are stored uncompressed, so look for
    // the embedded image part directly.
    expect(result.buffer.includes(Buffer.from("word/media/"))).toBe(true);
  });
  // #1324 — KaTeX's stylesheet used to reach the page as a file:// <link>,
  // which Chrome refuses to about:blank, and after #1017 as inline CSS whose
  // relative font URLs resolved to nothing. Either way formulas printed in
  // fallback serif fonts. Under the exporter's full network posture, the math
  // must now be laid out in KaTeX's own font, loaded, with no request refused.
  it("renders math with KaTeX's stylesheet and fonts loaded, under the full network posture (#1324)", async () => {
    const browser = await puppeteer.launch({ headless: true, args: chromeLaunchArgs() });
    try {
      const page = await browser.newPage();
      await blockExternalRequests(page);
      const refused: string[] = [];
      page.on("requestfailed", (r) => refused.push(r.url().slice(0, 80)));
      const blocked: string[] = [];
      page.on("console", (m) => {
        if (/Content Security Policy|Failed to load/i.test(m.text()))
          blocked.push(m.text().slice(0, 160));
      });

      await renderPdfPage(page, "# Maths\n\n$$E = mc^2$$\n\nInline $a^2 + b^2$ too.\n", "maths");

      const seen = (await page.evaluate(`(async () => {
        await document.fonts.ready;
        const katexEl = document.querySelector(".math-display .katex");
        const faces = [...document.fonts].filter((f) => f.family.replace(/"/g, "") === "KaTeX_Main");
        return {
          fontFamily: katexEl ? getComputedStyle(katexEl).fontFamily : null,
          mainFaces: faces.map((f) => f.status),
          rendered: document.querySelectorAll(".katex").length,
        };
      })()`)) as { fontFamily: string | null; mainFaces: string[]; rendered: number };

      expect(seen.rendered).toBeGreaterThanOrEqual(2);
      expect(seen.fontFamily).toMatch(/^"?KaTeX_Main"?,/);
      // The regular KaTeX_Main face the formula uses was fetched and decoded.
      expect(seen.mainFaces).toContain("loaded");
      expect(seen.mainFaces).not.toContain("error");
      expect(refused).toEqual([]);
      expect(blocked).toEqual([]);
    } finally {
      await browser.close();
    }
  });

  it("embeds KaTeX's own fonts in the exported PDF (#1324)", async () => {
    const result = await exportDocument(
      "# Maths\n\n$$E = mc^2$$\n\nInline $a^2 + b^2$ too.\n",
      "maths",
      "pdf",
    );
    expect(result.mimeType).toBe("application/pdf");
    // Skia writes each embedded font's PostScript name, subset-prefixed, into an
    // uncompressed /BaseFont entry; before #1324 only fallback serif fonts appeared.
    const baseFonts =
      result.buffer.toString("latin1").match(/\/BaseFont\s*\/[A-Z]+\+[\w-]+/g) ?? [];
    expect(baseFonts.some((f) => f.endsWith("+KaTeX_Main-Regular"))).toBe(true);
    expect(baseFonts.some((f) => f.endsWith("+KaTeX_Math-Italic"))).toBe(true);
  });

  // #1571 — the run-10 BRD printed inline formulas with `\_`, `_{…}` and `\{`
  // as raw `\text{…}` (marked had rewritten them before KaTeX saw them), and
  // its citations as `^src-n`.
  it("typesets markdown-hostile inline formulas and links citations to a Sources list (#1571)", async () => {
    const browser = await puppeteer.launch({ headless: true, args: chromeLaunchArgs() });
    try {
      const page = await browser.newPage();
      await blockExternalRequests(page);
      await renderPdfPage(
        page,
        [
          "# Rules",
          "",
          String.raw`Count $\text{feed\_count}(c) = \text{coalesce}(\text{count}(f), 0)$ where $score_{final} > 0$ and $\#\{e : e.user = u\}$[^src-22].`,
          "",
          "[^src-22]: `internal/storage/user.go:41-58`",
        ].join("\n"),
        "rules",
      );
      const seen = (await page.evaluate(`(() => ({
        inline: document.querySelectorAll(".math-inline").length,
        typeset: document.querySelectorAll(".math-inline .katex").length,
        errors: document.querySelectorAll(".katex-error").length,
        text: document.body.innerText,
        ref: document.querySelector("sup.footnote-ref a")?.getAttribute("href"),
        source: document.querySelector("#fn-1")?.textContent,
      }))()`)) as {
        inline: number;
        typeset: number;
        errors: number;
        text: string;
        ref: string | null;
        source: string | null;
      };
      expect(seen.inline).toBe(3);
      expect(seen.typeset).toBe(3);
      expect(seen.errors).toBe(0);
      expect(seen.text).not.toContain("\\text");
      expect(seen.text).not.toContain("src-");
      expect(seen.ref).toBe("#fn-1");
      expect(seen.source).toBe("internal/storage/user.go:41-58");
    } finally {
      await browser.close();
    }
  });

  // #1017 — the export browser's three network guards, in a real Chromium,
  // against probe servers that record every HTTP request, WebSocket upgrade,
  // TURN-over-TCP connection and STUN (UDP) packet they receive. Content that
  // names any of them (as a sanitiser miss plus script execution would) must
  // reach nothing, while a data: image still renders.
  //
  // - Request interception (`blockExternalRequests`) runs on CDP `Fetch`: it
  //   aborts http(s) loads but never sees a WebSocket handshake or WebRTC.
  // - The page CSP (`EXPORT_PAGE_CSP_META`) refuses the WebSocket, but CSP
  //   does not govern WebRTC ICE traffic.
  // - The launch args (`EXPORT_NETWORK_LOCKDOWN_ARGS`) give the browser no
  //   network at all: a dead proxy for everything, loopback included, and no
  //   direct WebRTC UDP.
  //
  // The arms below show each guard's share (PR #1321 review), and that the
  // exporter's full posture stops every channel. (A file:// URL never becomes
  // a request: Chrome refuses local resources to the about:blank page; the
  // unit suite covers our refusal of it.)
  describe("network guards (#1017)", () => {
    const sandboxOnly = () =>
      chromeLaunchArgs().filter((a) => !EXPORT_NETWORK_LOCKDOWN_ARGS.includes(a));

    async function probe(guards: { intercept: boolean; csp: boolean; lockdown: boolean }) {
      const hits: string[] = [];
      const web = createServer((req, res) => {
        hits.push(req.url ?? "");
        res.end("");
      });
      web.on("upgrade", (req, socket) => {
        hits.push(`upgrade ${req.url ?? ""}`);
        socket.destroy();
      });
      const turn = createTcpServer((socket) => {
        hits.push("turn-tcp");
        socket.destroy();
      });
      const stun = createSocket("udp4");
      stun.on("message", () => hits.push("stun-udp"));
      await new Promise<void>((r) => web.listen(0, "127.0.0.1", r));
      await new Promise<void>((r) => turn.listen(0, "127.0.0.1", r));
      await new Promise<void>((r) => stun.bind(0, "127.0.0.1", r));
      const { port } = web.address() as AddressInfo;
      const turnPort = (turn.address() as AddressInfo).port;
      const stunPort = stun.address().port;
      const base = `http://127.0.0.1:${port}`;
      const browser = await puppeteer.launch({
        headless: true,
        args: guards.lockdown ? chromeLaunchArgs() : sandboxOnly(),
      });
      try {
        const page = await browser.newPage();
        if (guards.intercept) await blockExternalRequests(page);
        await page.setContent(
          `<html><head>${guards.csp ? EXPORT_PAGE_CSP_META : ""}
           <link rel="stylesheet" href="${base}/css"></head><body>
           <img src="${base}/img"><img src="file:///etc/hosts">
           <img id="inline" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7">
           <script src="${base}/js"></script>
           <script>
             try { new WebSocket("ws://127.0.0.1:${port}/ws"); } catch (e) {}
             try {
               const relay = new RTCPeerConnection({
                 iceServers: [{ urls: "turn:127.0.0.1:${turnPort}?transport=tcp", username: "u", credential: "p" }],
                 iceTransportPolicy: "relay",
               });
               relay.createDataChannel("x");
               relay.createOffer().then((o) => relay.setLocalDescription(o));
               const direct = new RTCPeerConnection({ iceServers: [{ urls: "stun:127.0.0.1:${stunPort}" }] });
               direct.createDataChannel("x");
               direct.createOffer().then((o) => direct.setLocalDescription(o));
             } catch (e) {}
           </script>
           </body></html>`,
          { waitUntil: "load", timeout: 15_000 },
        );
        await page.evaluate(`fetch("${base}/fetch").catch(() => {})`);
        await new Promise((r) => setTimeout(r, 2_500));
        const inlineWidth = await page.evaluate(`document.getElementById("inline").naturalWidth`);
        return { hits: [...new Set(hits)].sort(), inlineWidth };
      } finally {
        await browser.close();
        await new Promise((r) => web.close(r));
        await new Promise((r) => turn.close(r));
        stun.close();
      }
    }

    const HTTP = ["/css", "/fetch", "/img", "/js"];

    it("the exporter's posture (all three) reaches nothing and still renders data: images", async () => {
      const { hits, inlineWidth } = await probe({ intercept: true, csp: true, lockdown: true });
      expect(hits).toEqual([]);
      expect(inlineWidth).toBe(1);
    });

    it("interception alone stops http but NOT the WebSocket upgrade or WebRTC", async () => {
      const { hits } = await probe({ intercept: true, csp: false, lockdown: false });
      expect(hits).toEqual(["stun-udp", "turn-tcp", "upgrade /ws"]);
    });

    it("interception + CSP stop the WebSocket too, but NOT WebRTC", async () => {
      const { hits } = await probe({ intercept: true, csp: true, lockdown: false });
      expect(hits).toEqual(["stun-udp", "turn-tcp"]);
    });

    it("the launch args alone stop every channel, WebRTC included", async () => {
      const { hits, inlineWidth } = await probe({ intercept: false, csp: false, lockdown: true });
      expect(hits).toEqual([]);
      expect(inlineWidth).toBe(1);
    });

    it("control: with no guard the same page reaches the probes on every channel", async () => {
      const { hits } = await probe({ intercept: false, csp: false, lockdown: false });
      expect(hits).toEqual([...HTTP, "stun-udp", "turn-tcp", "upgrade /ws"].sort());
    });
  });
});
