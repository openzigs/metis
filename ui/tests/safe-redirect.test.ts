import { describe, expect, it } from "vitest";
import { safeRedirectPath } from "@/lib/safe-redirect";

describe("safeRedirectPath", () => {
  it("accepts simple same-origin paths", () => {
    expect(safeRedirectPath("/projects")).toBe("/projects");
    expect(safeRedirectPath("/projects/123")).toBe("/projects/123");
    expect(safeRedirectPath("/dashboard?tab=open")).toBe("/dashboard?tab=open");
    expect(safeRedirectPath("/a#frag")).toBe("/a#frag");
  });

  it("rejects protocol-relative URLs (//evil.com)", () => {
    expect(safeRedirectPath("//evil.com")).toBe("/dashboard");
    expect(safeRedirectPath("//evil.com/path")).toBe("/dashboard");
  });

  it("rejects backslash-host tricks (/\\evil.com and /%5Cevil.com)", () => {
    expect(safeRedirectPath("/\\evil.com")).toBe("/dashboard");
    expect(safeRedirectPath("/%5cevil.com")).toBe("/dashboard");
    expect(safeRedirectPath("/%5Cevil.com")).toBe("/dashboard");
  });

  it("rejects absolute external URLs", () => {
    expect(safeRedirectPath("https://evil.com")).toBe("/dashboard");
    expect(safeRedirectPath("http://evil.com/x")).toBe("/dashboard");
    expect(safeRedirectPath("javascript:alert(1)")).toBe("/dashboard");
  });

  it("rejects non-string and empty input", () => {
    expect(safeRedirectPath(undefined)).toBe("/dashboard");
    expect(safeRedirectPath(null)).toBe("/dashboard");
    expect(safeRedirectPath("")).toBe("/dashboard");
    expect(safeRedirectPath(42)).toBe("/dashboard");
  });

  it("rejects values that don't begin with /", () => {
    expect(safeRedirectPath("projects")).toBe("/dashboard");
    expect(safeRedirectPath(" /projects")).toBe("/dashboard");
  });

  it("rejects embedded control characters", () => {
    expect(safeRedirectPath("/foo\nbar")).toBe("/dashboard");
    expect(safeRedirectPath("/foo\rbar")).toBe("/dashboard");
    expect(safeRedirectPath("/foo\u0000bar")).toBe("/dashboard");
  });

  it("honours a custom fallback", () => {
    expect(safeRedirectPath("//evil.com", "/login")).toBe("/login");
  });
});
