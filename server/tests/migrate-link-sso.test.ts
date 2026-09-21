/**
 * Tests for SSO migration link utility.
 * Epic #748, Issue #758.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { linkSSOAccounts } from "../src/lib/auth/migrate-link-sso.js";

// Mock prisma
vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    user: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: "u1",
          username: "admin",
          email: "admin@corp.com",
          status: "active",
          displayName: "Admin",
        },
        {
          id: "u2",
          username: "dev1",
          email: "dev1@corp.com",
          status: "active",
          displayName: "Dev",
        },
        {
          id: "u3",
          username: "disabled",
          email: "disabled@corp.com",
          status: "disabled",
          displayName: "Disabled",
        },
      ]),
      update: vi.fn().mockResolvedValue({}),
    },
  },
}));

vi.mock("../src/lib/logger.js", () => ({
  createChildLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe("linkSSOAccounts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("links active users by email", async () => {
    const result = await linkSSOAccounts({ dryRun: true });
    expect(result.total).toBe(3);
    expect(result.linked.length).toBe(2);
    expect(result.skipped.length).toBe(1);
  });

  it("skips disabled users", async () => {
    const result = await linkSSOAccounts({ dryRun: true });
    const skipped = result.skipped.find((s) => s.username === "disabled");
    expect(skipped).toBeDefined();
    expect(skipped?.reason).toBe("inactive");
  });

  it("does not call update in dry-run mode", async () => {
    const { prisma } = await import("../src/lib/prisma.js");
    await linkSSOAccounts({ dryRun: true });
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("calls update in live mode", async () => {
    const { prisma } = await import("../src/lib/prisma.js");
    await linkSSOAccounts({ dryRun: false });
    expect(prisma.user.update).toHaveBeenCalledTimes(2);
  });
});
