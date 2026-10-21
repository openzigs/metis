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
