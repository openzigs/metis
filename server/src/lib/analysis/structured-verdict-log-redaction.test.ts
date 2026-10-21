/**
 * #1081 review — `requestStructuredVerdict` now serves steps that read the
 * user's own documents (elicitation, completeness, contradictions, clarifying
 * questions, grounding). A malformed reply is logged by length, a short hash
 * and — for a schema failure — the zod paths. Never the body, and never a JSON
 * parser message, which quotes the text it failed on.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const warn = vi.fn();
vi.mock("../logger.js", () => ({
  createChildLogger: () => ({ warn, info: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

const { describeMalformedReply, requestStructuredVerdict, StructuredVerdictMetrics } =
  await import("./structured-verdict.js");

const SECRET = "Customer ACME pays invoice 4471 to account GB29NWBK60161331926819";

function provider(reply: string) {
  return {
    key: "offline-stub",
    model: "stub",
    offline: true,
    chat: vi.fn(async () => ({
      content: reply,
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    })),
  } as never;
}

beforeEach(() => warn.mockClear());

describe("structured-verdict logging redaction", () => {
  it.each([
    ["unparseable", `Sure! ${SECRET} {not json`],
    ["schema-invalid", JSON.stringify({ wrong: SECRET })],
  ])("never logs the reply body or the parser message (%s)", async (_label, reply) => {
    await requestStructuredVerdict(provider(reply), {
      label: "redaction",
      schema: z.object({ gaps: z.array(z.unknown()) }),
      schemaName: "x",
      expectedShape: "{}",
      messages: [{ role: "user", content: "q" }],
      metrics: new StructuredVerdictMetrics(),
    });
    expect(warn).toHaveBeenCalledTimes(2);
    for (const [, fields] of warn.mock.calls) {
      const logged = JSON.stringify(fields);
      expect(logged).not.toContain("ACME");
      expect(logged).not.toContain("GB29");
      expect(fields).toMatchObject({ contentLength: reply.length });
      expect(String((fields as { contentSha256: string }).contentSha256)).toMatch(/^[0-9a-f]{16}$/);
    }
  });

  it("keeps the zod paths for a schema failure", () => {
    expect(
      describeMalformedReply("{}", { reason: "schema-invalid", detail: "gaps: Invalid input" }),
    ).toMatchObject({ reason: "schema-invalid", issues: "gaps: Invalid input" });
    expect(
      describeMalformedReply("x", {
        reason: "unparseable",
        detail: `Unexpected token in "${SECRET}"`,
      }),
    ).not.toHaveProperty("issues");
  });
});
