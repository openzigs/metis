/**
 * #1615 / #1636 — the React key of a code citation carries every part of its
 * identity the server's gap-report dedupe keeps apart: repo, locator and
 * symbol. Two citations that survive that dedupe must not share a key.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api-client", () => ({ apiFetch: vi.fn() }));

const { codeCitationKey } = await import("../src/lib/analysis-api");

const at = { filePath: "src/auth.ts", startLine: 1, endLine: 5 };

describe("codeCitationKey", () => {
  it("tells two symbols at one locator in one repo apart", () => {
    expect(codeCitationKey({ ...at, repoConnectionId: "rc-A", symbolId: "s-1" })).not.toBe(
      codeCitationKey({ ...at, repoConnectionId: "rc-A", symbolId: "s-2" }),
    );
  });

  it("tells one locator in two repos apart", () => {
    expect(codeCitationKey({ ...at, repoConnectionId: "rc-A" })).not.toBe(
      codeCitationKey({ ...at, repoConnectionId: "rc-B" }),
    );
  });

  it("is stable for the same citation", () => {
    expect(codeCitationKey({ ...at, symbolId: "s-1" })).toBe(
      codeCitationKey({ ...at, symbolId: "s-1" }),
    );
  });
});
