/**
 * #1395 — the kind that may claim an unbound account is the AUTH_MODE
 * provider's; when the factory refuses (mock in production) it is NOBODY's.
 * The route-level SQLite suite cannot tell "nobody" from a wrong kind on every
 * path (round-2 adversarial panel), so the mapping is pinned here directly.
 */
import { describe, expect, it, vi } from "vitest";

const factory = vi.hoisted(() => ({ getAuthProvider: vi.fn() }));
vi.mock("../lib/auth/providers.js", () => factory);

const { primaryAuthKind } = await import("./sso.js");

describe("primaryAuthKind", () => {
  it("is the AUTH_MODE provider's name", () => {
    factory.getAuthProvider.mockReturnValue({ name: "oidc" });
    expect(primaryAuthKind()).toBe("oidc");
    factory.getAuthProvider.mockReturnValue({ name: "ldap" });
    expect(primaryAuthKind()).toBe("ldap");
  });

  it("is null — no kind at all — when the factory refuses to build a provider", () => {
    factory.getAuthProvider.mockImplementation(() => {
      throw new Error("Mock authentication is not permitted in production");
    });
    expect(primaryAuthKind()).toBeNull();
  });
});
