/**
 * #274 — Next 16 renamed the `middleware` file convention to `proxy`. With
 * `src/middleware.ts` every `next dev` and `next build` printed a deprecation
 * notice, and a tree holding BOTH files fails the build outright. Proxy runs on
 * the Node.js runtime, and setting `runtime` in a proxy file is an error, so the
 * file must not export one.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as proxyModule from "@/proxy";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");

describe("the auth gate uses Next 16's proxy convention (#274)", () => {
  it("lives in src/proxy.ts, and src/middleware.ts is gone", () => {
    expect(existsSync(path.join(SRC, "proxy.ts"))).toBe(true);
    expect(existsSync(path.join(SRC, "middleware.ts"))).toBe(false);
    expect(existsSync(path.join(SRC, "middleware.js"))).toBe(false);
  });

  it("exports a function named `proxy` and a matcher config", () => {
    expect(typeof proxyModule.proxy).toBe("function");
    expect(Object.keys(proxyModule).sort()).toEqual(["config", "proxy"]);
    expect(proxyModule.config.matcher.length).toBeGreaterThan(0);
  });

  it("does not set a runtime (proxy is Node.js-only; setting one throws)", () => {
    const source = readFileSync(path.join(SRC, "proxy.ts"), "utf8");
    expect(source).not.toMatch(/export\s+const\s+runtime\b/);
  });
});
