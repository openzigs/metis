/**
 * Epic #547 (Phase 4, #554) — tenant allowlist tests.
 *
 * The allowlist is the second authenticity gate on inbound bridge traffic: even
 * after the Bot Framework JWT proves an activity is genuinely from the channel
 * service (#548), an operator may want only specific Azure AD tenant(s) to be
 * able to drive the bridge. These tests pin the parsing + decision contract and
 * the documented default (empty config = allow-all, loudly documented).
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  loadTeamsTenantAllowlist,
  isTeamsTenantAllowed,
  assertTeamsTenantAllowed,
  TeamsTenantNotAllowedError,
} from "./tenant-allowlist.js";

afterEach(() => {
  delete process.env.TEAMS_ALLOWED_TENANTS;
});

describe("loadTeamsTenantAllowlist", () => {
  it("returns an empty (allow-all) policy when the env is unset", () => {
    const policy = loadTeamsTenantAllowlist({});
    expect(policy.mode).toBe("allow-all");
    expect(policy.tenants).toEqual([]);
  });

  it("returns an empty (allow-all) policy when the env is blank/whitespace", () => {
    expect(loadTeamsTenantAllowlist({ TEAMS_ALLOWED_TENANTS: "   " }).mode).toBe("allow-all");
    expect(loadTeamsTenantAllowlist({ TEAMS_ALLOWED_TENANTS: "" }).mode).toBe("allow-all");
  });

  it("parses a comma-separated list into a normalized, deduped allowlist", () => {
    const policy = loadTeamsTenantAllowlist({
      TEAMS_ALLOWED_TENANTS: " Tenant-A , tenant-b ,TENANT-A,, tenant-c ",
    });
    expect(policy.mode).toBe("allowlist");
    // Lower-cased, trimmed, blanks dropped, deduped.
    expect(policy.tenants).toEqual(["tenant-a", "tenant-b", "tenant-c"]);
  });
});

describe("isTeamsTenantAllowed", () => {
  it("allows any tenant (even a blank one) under allow-all", () => {
    const policy = loadTeamsTenantAllowlist({});
    expect(isTeamsTenantAllowed(policy, "anything")).toBe(true);
    expect(isTeamsTenantAllowed(policy, null)).toBe(true);
    expect(isTeamsTenantAllowed(policy, "")).toBe(true);
  });

  it("allows only listed tenants (case-insensitive) under an allowlist", () => {
    const policy = loadTeamsTenantAllowlist({ TEAMS_ALLOWED_TENANTS: "tenant-a,tenant-b" });
    expect(isTeamsTenantAllowed(policy, "tenant-a")).toBe(true);
    expect(isTeamsTenantAllowed(policy, "TENANT-B")).toBe(true);
    expect(isTeamsTenantAllowed(policy, " tenant-a ")).toBe(true);
  });

  it("rejects an unlisted tenant under an allowlist", () => {
    const policy = loadTeamsTenantAllowlist({ TEAMS_ALLOWED_TENANTS: "tenant-a" });
    expect(isTeamsTenantAllowed(policy, "tenant-evil")).toBe(false);
  });

  it("rejects a tenant-less sender under an allowlist (cannot prove tenant)", () => {
    const policy = loadTeamsTenantAllowlist({ TEAMS_ALLOWED_TENANTS: "tenant-a" });
    expect(isTeamsTenantAllowed(policy, null)).toBe(false);
    expect(isTeamsTenantAllowed(policy, undefined)).toBe(false);
    expect(isTeamsTenantAllowed(policy, "")).toBe(false);
    expect(isTeamsTenantAllowed(policy, "   ")).toBe(false);
  });
});

describe("assertTeamsTenantAllowed", () => {
  it("is a no-op when the tenant is allowed", () => {
    const policy = loadTeamsTenantAllowlist({ TEAMS_ALLOWED_TENANTS: "tenant-a" });
    expect(() => assertTeamsTenantAllowed(policy, "tenant-a")).not.toThrow();
  });

  it("throws a TeamsTenantNotAllowedError when the tenant is rejected", () => {
    const policy = loadTeamsTenantAllowlist({ TEAMS_ALLOWED_TENANTS: "tenant-a" });
    try {
      assertTeamsTenantAllowed(policy, "tenant-evil");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(TeamsTenantNotAllowedError);
      // Never leak the full allowlist in the error message.
      expect((err as Error).message).not.toContain("tenant-a");
    }
  });

  it("reads from process.env by default", () => {
    process.env.TEAMS_ALLOWED_TENANTS = "tenant-a";
    const policy = loadTeamsTenantAllowlist();
    expect(isTeamsTenantAllowed(policy, "tenant-a")).toBe(true);
    expect(isTeamsTenantAllowed(policy, "tenant-z")).toBe(false);
  });
});
