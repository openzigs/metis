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
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import puppeteer from "puppeteer";
import { describe, it, expect } from "vitest";
import {
  blockExternalRequests,
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

  // #1017 — the export page's request guard, in a real Chromium: content that
  // names an http URL (as a sanitiser miss would) reaches no server, while a
  // data: image still renders. (A file:// URL never becomes a request here at
  // all: Chrome refuses local resources to the about:blank page before
  // interception sees them; the unit suite covers our refusal of it.) The
  // unguarded control proves the probe would see the requests if they went.
  describe("request interception (#1017)", () => {
    async function probe(guarded: boolean) {
      const hits: string[] = [];
      const server = createServer((req, res) => {
        hits.push(req.url ?? "");
        res.end("");
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      const { port } = server.address() as AddressInfo;
      const base = `http://127.0.0.1:${port}`;
      const browser = await puppeteer.launch({ headless: true, args: chromeLaunchArgs() });
      const failed: Array<{ url: string; error: string }> = [];
      try {
        const page = await browser.newPage();
        if (guarded) await blockExternalRequests(page);
        page.on("requestfailed", (r) =>
          failed.push({ url: r.url(), error: r.failure()?.errorText ?? "" }),
        );
        await page.setContent(
          `<html><head><link rel="stylesheet" href="${base}/css"></head><body>
           <img src="${base}/img"><img src="file:///etc/hosts">
           <img id="inline" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7">
           <script src="${base}/js"></script></body></html>`,
          { waitUntil: "load", timeout: 15_000 },
        );
        await page.evaluate(`fetch("${base}/fetch").catch(() => {})`);
        await new Promise((r) => setTimeout(r, 300));
        const inlineWidth = await page.evaluate(`document.getElementById("inline").naturalWidth`);
        return { hits, failed, inlineWidth };
      } finally {
        await browser.close();
        await new Promise((r) => server.close(r));
      }
    }

    it("aborts every http request the page makes and still renders data: images", async () => {
      const { hits, failed, inlineWidth } = await probe(true);
      expect(hits).toEqual([]);
      // Chrome reports a client abort as ERR_BLOCKED_BY_CLIENT (with an `.Inspector` suffix).
      const blocked = failed.filter((f) => f.error.startsWith("net::ERR_BLOCKED_BY_CLIENT"));
      expect(blocked.map((f) => new URL(f.url).pathname)).toEqual(
        expect.arrayContaining(["/css", "/img", "/js", "/fetch"]),
      );
      expect(inlineWidth).toBe(1);
    });

    it("control: without the guard the same page reaches the server", async () => {
      const { hits } = await probe(false);
      expect(hits).toEqual(expect.arrayContaining(["/css", "/img", "/js", "/fetch"]));
    });
  });
});
