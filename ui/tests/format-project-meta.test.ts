/**
 * Issue #430 — project card meta-line assembly. The key regression: a missing
 * slug must NOT produce a stray leading "· draft".
 */
import { describe, it, expect } from "vitest";
import { formatProjectMeta, META_SEPARATOR } from "@/lib/format-project-meta";

describe("formatProjectMeta", () => {
  it("joins slug and status with the middot separator when both present", () => {
    const { tokens, text } = formatProjectMeta({ slug: "acme-migration", status: "draft" });
    expect(tokens).toEqual(["acme-migration", "draft"]);
    expect(text).toBe(`acme-migration${META_SEPARATOR}draft`);
  });

  it("drops the separator when slug is missing (no stray leading '· draft')", () => {
    const { tokens, text } = formatProjectMeta({ slug: "", status: "draft" });
    expect(tokens).toEqual(["draft"]);
    expect(text).toBe("draft");
    expect(text.startsWith(META_SEPARATOR)).toBe(false);
    expect(text.startsWith("·")).toBe(false);
  });

  it("treats undefined and null slug the same as empty (status only)", () => {
    expect(formatProjectMeta({ slug: undefined, status: "active" }).text).toBe("active");
    expect(formatProjectMeta({ slug: null, status: "active" }).text).toBe("active");
  });

  it("drops a whitespace-only slug so it never leads with a separator", () => {
    const { tokens, text } = formatProjectMeta({ slug: "   ", status: "archived" });
    expect(tokens).toEqual(["archived"]);
    expect(text).toBe("archived");
  });

  it("renders slug alone when status is missing (no trailing separator)", () => {
    const { tokens, text } = formatProjectMeta({ slug: "acme", status: undefined });
    expect(tokens).toEqual(["acme"]);
    expect(text).toBe("acme");
    expect(text.endsWith(META_SEPARATOR)).toBe(false);
  });

  it("returns empty tokens and empty text when nothing is present", () => {
    const { tokens, text } = formatProjectMeta({ slug: "", status: "" });
    expect(tokens).toEqual([]);
    expect(text).toBe("");
  });

  it("trims surrounding whitespace from present tokens", () => {
    const { tokens } = formatProjectMeta({ slug: "  acme  ", status: " draft " });
    expect(tokens).toEqual(["acme", "draft"]);
  });
});
