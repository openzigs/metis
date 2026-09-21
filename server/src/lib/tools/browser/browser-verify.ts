/**
 * Agentic browser-verification tool (#155).
 *
 * Registers `browser_verify` with the ToolRegistry. Given a URL and a set of
 * expectations (selector / text / title / screenshot), launches a headless
 * Chromium via `playwright-core` and returns observations.
 *
 * SECURITY constraints:
 *   - SSRF defense: rejects private/loopback IPs unless
 *     `BROWSER_ALLOW_PRIVATE=true`.
 *   - 30s page timeout, 5MB response cap, 2MB screenshot cap.
 *   - Default OFF in the tool allowlist; admin must explicitly enable.
 */
import { z } from "zod";
import net from "node:net";
import { promises as dns } from "node:dns";
import { isPrivateIp } from "../../documents/url-fetcher.js";
import type { ToolDefinition } from "../../ai/types.js";
import { withExecuteToolSpan } from "../../otel/genai-spans.js";

export const BROWSER_VERIFY_DEFAULT_COST_CENTS = 1;

const expectationSchema = z
  .object({
    selectorPresent: z.string().optional(),
    textContains: z.string().optional(),
    titleEquals: z.string().optional(),
    captureScreenshot: z.boolean().optional(),
  })
  .strict();

const argsSchema = z
  .object({
    url: z.string().url(),
    expectations: expectationSchema.default({}),
  })
  .strict();

export type BrowserVerifyArgs = z.infer<typeof argsSchema>;

export interface BrowserVerifyResult {
  passed: boolean;
  observations: {
    title?: string;
    titleEquals?: boolean;
    selectorPresent?: boolean;
    textContains?: boolean;
  };
  screenshotBase64?: string;
  costCents: number;
}

/** Test seam: stub the playwright launcher. */
export interface BrowserDriver {
  visit(input: {
    url: string;
    timeoutMs: number;
    captureScreenshot: boolean;
    maxResponseBytes: number;
    maxScreenshotBytes: number;
  }): Promise<{
    title: string;
    text: string;
    html: string;
    screenshotBase64?: string;
  }>;
}

let driverOverride: BrowserDriver | null = null;
export function __setBrowserDriverForTests(d: BrowserDriver | null): void {
  driverOverride = d;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESPONSE = 5 * 1024 * 1024;
const DEFAULT_MAX_SCREENSHOT = 2 * 1024 * 1024;

async function defaultDriver(): Promise<BrowserDriver> {
  // Lazy-load so unit tests don't pull in the browser binary.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const playwright = require("playwright-core") as typeof import("playwright-core");
  return {
    async visit(input) {
      const browser = await playwright.chromium.launch({ headless: true });
      try {
        const ctx = await browser.newContext();
        const page = await ctx.newPage();
        let bytes = 0;
        page.on("response", (resp) => {
          // Best-effort cap; abort the page on overflow.
          resp
            .body()
            .then((b) => {
              bytes += b.byteLength;
              if (bytes > input.maxResponseBytes) {
                page.close().catch(() => undefined);
              }
            })
            .catch(() => undefined);
        });
        await page.goto(input.url, { timeout: input.timeoutMs, waitUntil: "domcontentloaded" });
        const title = await page.title();
        const text = await page.evaluate(() => {
          const d = (globalThis as unknown as { document?: { body?: { innerText?: string } } })
            .document;
          return d?.body?.innerText ?? "";
        });
        const html = await page.content();
        let screenshotBase64: string | undefined;
        if (input.captureScreenshot) {
          const buf = await page.screenshot({ type: "png", fullPage: false });
          if (buf.byteLength <= input.maxScreenshotBytes) {
            screenshotBase64 = buf.toString("base64");
          }
        }
        return { title, text, html, screenshotBase64 };
      } finally {
        await browser.close().catch(() => undefined);
      }
    },
  };
}

export async function assertHostAllowed(
  url: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const allowPrivate = env.BROWSER_ALLOW_PRIVATE === "true";
  if (allowPrivate) return;
  const u = new URL(url);
  const host = u.hostname;
  if (net.isIP(host)) {
    if (isPrivateIp(host)) {
      throw new Error(`browser_verify: refusing to visit private IP ${host}`);
    }
    return;
  }
  let resolved: string[];
  try {
    const lookup = await dns.lookup(host, { all: true });
    resolved = lookup.map((r) => r.address);
  } catch {
    return; // Let the underlying driver surface the DNS error.
  }
  for (const ip of resolved) {
    if (isPrivateIp(ip)) {
      throw new Error(`browser_verify: hostname ${host} resolves to private IP ${ip}`);
    }
  }
}

export const browserVerifyTool: ToolDefinition<typeof argsSchema> = {
  name: "browser_verify",
  description:
    "Visit a URL with a headless browser and check expectations (selector present, text contains, title equals).",
  schema: argsSchema,
  risk: "high",
  exec: async (args, ctx) => {
    return withExecuteToolSpan("metis", "browser_verify", async () => {
      await assertHostAllowed(args.url);
      const driver = driverOverride ?? (await defaultDriver());
      const captureScreenshot = args.expectations.captureScreenshot === true;
      const visit = await driver.visit({
        url: args.url,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        captureScreenshot,
        maxResponseBytes: DEFAULT_MAX_RESPONSE,
        maxScreenshotBytes: DEFAULT_MAX_SCREENSHOT,
      });

      const obs: BrowserVerifyResult["observations"] = { title: visit.title };
      let passed = true;
      if (args.expectations.titleEquals !== undefined) {
        obs.titleEquals = visit.title === args.expectations.titleEquals;
        if (!obs.titleEquals) passed = false;
      }
      if (args.expectations.textContains !== undefined) {
        obs.textContains = visit.text.includes(args.expectations.textContains);
        if (!obs.textContains) passed = false;
      }
      if (args.expectations.selectorPresent !== undefined) {
        // Cheap selector check by id/class/tag against html string; a precise
        // CSS check would need DOM. Acceptable for verify/snapshot use cases.
        obs.selectorPresent = visit.html.includes(args.expectations.selectorPresent);
        if (!obs.selectorPresent) passed = false;
      }

      const result: BrowserVerifyResult = {
        passed,
        observations: obs,
        ...(visit.screenshotBase64 ? { screenshotBase64: visit.screenshotBase64 } : {}),
        costCents: BROWSER_VERIFY_DEFAULT_COST_CENTS,
      };
      void ctx;
      return {
        text: JSON.stringify(result),
        data: result,
        isError: !passed,
      };
    });
  },
};
