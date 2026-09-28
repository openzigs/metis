/**
 * #272 — the on-demand loaders' failure paths and the theme-colour bridge.
 * A chunk that fails to load (offline, a deploy mid-session) must not poison
 * later attempts.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.resetModules();
  vi.doUnmock("mermaid");
  vi.doUnmock("katex/dist/katex.min.css");
  document.documentElement.style.removeProperty("--info");
});

describe("loadMermaid", () => {
  it("retries after a failed load instead of caching the failure", async () => {
    let attempts = 0;
    vi.doMock("mermaid", () => {
      attempts += 1;
      if (attempts === 1) throw new Error("chunk failed");
      return { default: { render: vi.fn() } };
    });
    const { loadMermaid } = await import("@/lib/mermaid");
    await expect(loadMermaid()).rejects.toThrow();
    // Same module instance: the rejected promise must not be cached.
    await expect(loadMermaid()).resolves.toHaveProperty("render");
    expect(attempts).toBe(2);
  });

  it("shares one import between callers", async () => {
    vi.doMock("mermaid", () => ({ default: { id: "m" } }));
    const { loadMermaid } = await import("@/lib/mermaid");
    const [a, b] = await Promise.all([loadMermaid(), loadMermaid()]);
    expect(a).toBe(b);
  });
});

describe("themeTokenColor", () => {
  it("turns an `H S% L%` token into a colour mermaid can parse", async () => {
    const { themeTokenColor } = await import("@/lib/mermaid");
    document.documentElement.style.setProperty("--info", "221 83% 40%");
    expect(themeTokenColor("info")).toBe("hsl(221, 83%, 40%)");
  });

  it("is undefined for a token the stylesheet does not define", async () => {
    const { themeTokenColor } = await import("@/lib/mermaid");
    expect(themeTokenColor("no-such-token")).toBeUndefined();
  });
});

describe("KaTeX stylesheet loader", () => {
  it("detects inline and block math, not plain prose", async () => {
    const { hasMath } = await import("@/lib/katex-css");
    expect(hasMath("Energy $E = mc^2$")).toBe(true);
    expect(hasMath("$$\n\\int x\\,dx\n$$")).toBe(true);
    expect(hasMath("No math here, and a lone $ sign.")).toBe(false);
  });

  it("requests the stylesheet once, and again after a failed load", async () => {
    let loads = 0;
    vi.doMock("katex/dist/katex.min.css", () => {
      loads += 1;
      if (loads === 1) throw new Error("chunk failed");
      return {};
    });
    const { ensureKatexCss } = await import("@/lib/katex-css");
    ensureKatexCss();
    await vi.waitFor(() => expect(loads).toBe(1));
    await new Promise((r) => setTimeout(r, 0));
    ensureKatexCss();
    ensureKatexCss();
    await vi.waitFor(() => expect(loads).toBe(2));
  });
});
