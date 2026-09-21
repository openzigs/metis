/**
 * Tests for the browser_verify tool (#155).
 *
 * Mocks the Playwright driver to a scripted stub. Asserts SSRF defenses
 * by checking private IP rejection.
 */
import { describe, expect, it, beforeEach } from "vitest";
import {
  browserVerifyTool,
  __setBrowserDriverForTests,
  assertHostAllowed,
  BROWSER_VERIFY_DEFAULT_COST_CENTS,
  type BrowserDriver,
} from "../src/lib/tools/browser/browser-verify.js";

const ctx = {
  sessionId: "s1",
  userId: "u1",
};

function stubDriver(visit: BrowserDriver["visit"]): void {
  __setBrowserDriverForTests({ visit });
}

beforeEach(() => {
  __setBrowserDriverForTests(null);
  delete process.env.BROWSER_ALLOW_PRIVATE;
});

describe("browser_verify SSRF defenses", () => {
  it("rejects loopback IPv4 by default", async () => {
    await expect(assertHostAllowed("http://127.0.0.1/x")).rejects.toThrow(/private/);
  });

  it("rejects RFC1918 ranges by default", async () => {
    await expect(assertHostAllowed("http://10.0.0.1/x")).rejects.toThrow();
    await expect(assertHostAllowed("http://192.168.1.1/x")).rejects.toThrow();
  });

  it("allows public IPs", async () => {
    await expect(assertHostAllowed("http://93.184.216.34/x")).resolves.toBeUndefined();
  });

  it("allows private IPs when BROWSER_ALLOW_PRIVATE=true", async () => {
    process.env.BROWSER_ALLOW_PRIVATE = "true";
    await expect(assertHostAllowed("http://127.0.0.1/x")).resolves.toBeUndefined();
  });
});

describe("browser_verify tool exec", () => {
  it("passes when title matches expectation", async () => {
    stubDriver(async () => ({
      title: "Example Domain",
      text: "This domain is for use in illustrative examples.",
      html: "<html><body><h1>Example Domain</h1></body></html>",
    }));
    const out = await browserVerifyTool.exec(
      { url: "https://example.com/", expectations: { titleEquals: "Example Domain" } },
      ctx,
    );
    expect(out.isError).toBe(false);
    const data = out.data as { passed: boolean; observations: { titleEquals: boolean } };
    expect(data.passed).toBe(true);
    expect(data.observations.titleEquals).toBe(true);
  });

  it("fails when expected text is not contained", async () => {
    stubDriver(async () => ({
      title: "T",
      text: "Hello",
      html: "<html></html>",
    }));
    const out = await browserVerifyTool.exec(
      { url: "https://example.com/", expectations: { textContains: "Goodbye" } },
      ctx,
    );
    expect(out.isError).toBe(true);
    const data = out.data as { passed: boolean; observations: { textContains: boolean } };
    expect(data.passed).toBe(false);
    expect(data.observations.textContains).toBe(false);
  });

  it("fails when selector marker is missing", async () => {
    stubDriver(async () => ({ title: "T", text: "", html: "<html></html>" }));
    const out = await browserVerifyTool.exec(
      { url: "https://example.com/", expectations: { selectorPresent: 'id="missing"' } },
      ctx,
    );
    const data = out.data as { passed: boolean };
    expect(data.passed).toBe(false);
  });

  it("captures a screenshot when requested", async () => {
    stubDriver(async () => ({
      title: "T",
      text: "ok",
      html: "<html></html>",
      screenshotBase64: "ZmFrZQ==",
    }));
    const out = await browserVerifyTool.exec(
      { url: "https://example.com/", expectations: { captureScreenshot: true } },
      ctx,
    );
    const data = out.data as { passed: boolean; screenshotBase64?: string };
    expect(data.passed).toBe(true);
    expect(data.screenshotBase64).toBe("ZmFrZQ==");
  });

  it("rejects private-IP URLs at exec time", async () => {
    stubDriver(async () => ({ title: "T", text: "", html: "" }));
    await expect(
      browserVerifyTool.exec({ url: "http://127.0.0.1/x", expectations: {} }, ctx),
    ).rejects.toThrow(/private/);
  });

  it("includes the static cost in the result", async () => {
    stubDriver(async () => ({ title: "T", text: "", html: "" }));
    const out = await browserVerifyTool.exec(
      { url: "https://example.com/", expectations: {} },
      ctx,
    );
    const data = out.data as { costCents: number };
    expect(data.costCents).toBe(BROWSER_VERIFY_DEFAULT_COST_CENTS);
  });

  it("validates URL via zod schema (rejects non-URLs)", () => {
    const parse = browserVerifyTool.schema.safeParse({ url: "not-a-url", expectations: {} });
    expect(parse.success).toBe(false);
  });

  it("schema accepts default empty expectations", () => {
    const parse = browserVerifyTool.schema.safeParse({ url: "https://example.com" });
    expect(parse.success).toBe(true);
  });
});
