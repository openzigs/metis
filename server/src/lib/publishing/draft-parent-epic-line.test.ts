/**
 * #1255 — the published issue's "Parent epic" line holds the epic title on one
 * line. Titles come from the model or the requirements PATCH route, whose
 * schema accepts newlines; unflattened, `\n\n# Heading` escaped the quote and
 * rendered as free markdown in the published issue.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../prisma.js", () => ({ prisma: {} }));

const { renderFeatureBody } = await import("./draft-generator.js").then((m) => m.__testing);

const render = (parentTitle: string): string =>
  renderFeatureBody({
    project: { id: "proj_abcdefgh", name: "Shop" },
    analysis: { id: "an_abcdefgh" },
    requirement: {
      id: "req_1",
      title: "Block refunds after 30 days",
      body: "Refunds must be rejected once the order is older than 30 days.",
      type: "feature",
      priority: "high",
    },
    parentTitle,
  });

describe("the Parent epic line (#1255)", () => {
  it("keeps a title with newlines on one quoted line, with no heading injected", () => {
    const body = render("[Epic] Shop\n\n# Injected heading\r\n");
    const lines = body.split("\n");

    expect(lines[0]).toBe("> Parent epic: **[Epic] Shop # Injected heading**");
    expect(lines.some((l) => /^#\s*Injected heading/.test(l.trim()))).toBe(false);
    expect(body).not.toContain("\r");
  });

  it("collapses runs of spaces and tabs and trims the ends", () => {
    expect(render("  [Epic]\t\tShop   refunds  ").split("\n")[0]).toBe(
      "> Parent epic: **[Epic] Shop refunds**",
    );
  });

  it("leaves an ordinary title as it was", () => {
    expect(render("[Epic] Shop").split("\n")[0]).toBe("> Parent epic: **[Epic] Shop**");
  });
});
