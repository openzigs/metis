/**
 * Regression tests for the edge auth-gate matcher.
 *
 * Guards the fix for the 10 MB upload truncation: `/api/*` must NOT be matched
 * by the middleware, otherwise Next buffers the request body up to
 * `middlewareClientMaxBodySize` (10 MB) and truncates the streaming upload
 * proxy, making >10 MB .zip uploads fail with "Unexpected end of form".
 * Page routes MUST still be matched so the unauthenticated redirect keeps
 * working.
 */
import { describe, it, expect } from "vitest";
import { config } from "@/middleware";

/** Build a JS RegExp from the (already regex-shaped) Next matcher string. */
function matcherRegex(): RegExp {
  expect(config.matcher).toHaveLength(1);
  return new RegExp(`^${config.matcher[0]}$`);
}

describe("middleware matcher", () => {
  const re = matcherRegex();

  it("does NOT match /api/* routes (so request bodies stream un-buffered)", () => {
    expect(re.test("/api/projects/abc/connectors/repos/upload")).toBe(false);
    expect(re.test("/api/auth/login")).toBe(false);
    expect(re.test("/api/projects/abc")).toBe(false);
    expect(re.test("/api")).toBe(false);
  });

  it("still matches page routes (so the unauthenticated redirect fires)", () => {
    expect(re.test("/")).toBe(true);
    expect(re.test("/login")).toBe(true);
    expect(re.test("/projects/abc")).toBe(true);
    expect(re.test("/projects/abc/connections")).toBe(true);
  });

  it("still excludes Next internals and static assets", () => {
    expect(re.test("/_next/static/chunk.js")).toBe(false);
    expect(re.test("/_next/image")).toBe(false);
    expect(re.test("/favicon.ico")).toBe(false);
    expect(re.test("/logo.png")).toBe(false);
    expect(re.test("/banner.webp")).toBe(false);
  });
});
