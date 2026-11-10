/**
 * #1558 — the group-overage warning counts only the last 30 days, and each
 * sign-in carries the role the ACS recorded. (The ACS writing the rows and the
 * admin route reading them through a real database are covered in
 * server/tests/saml-entra-1552.sqlite.test.ts.)
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const count = vi.fn();
const findMany = vi.fn();
vi.mock("../../prisma.js", () => ({ prisma: { auditLog: { count, findMany } } }));

const { SAML_GROUP_OVERAGE_ACTION, SAML_GROUP_OVERAGE_WINDOW_DAYS, samlGroupOverageSummary } =
  await import("../saml-group-overage.js");

const NOW = new Date("2026-11-10T12:00:00.000Z");
const AT = new Date("2026-11-09T12:00:00.000Z");

beforeEach(() => {
  count.mockReset().mockResolvedValue(0);
  findMany.mockReset().mockResolvedValue([]);
});

describe("samlGroupOverageSummary (#1558)", () => {
  it("counts and lists only the window's events", async () => {
    await samlGroupOverageSummary(NOW);
    const where = {
      action: SAML_GROUP_OVERAGE_ACTION,
      ts: { gte: new Date("2026-10-11T12:00:00.000Z") },
    };
    expect(SAML_GROUP_OVERAGE_WINDOW_DAYS).toBe(30);
    expect(count).toHaveBeenCalledWith({ where });
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where }));
  });

  it("reports each sign-in's recorded role, or null when the row has none", async () => {
    count.mockResolvedValue(4);
    findMany.mockResolvedValue([
      { targetId: "u1", ts: AT, metadata: '{"role":"developer"}', actor: { username: "otto" } },
      { targetId: "u2", ts: AT, metadata: null, actor: null },
      { targetId: "u3", ts: AT, metadata: "{not json", actor: null },
      { targetId: "u4", ts: AT, metadata: '{"role":7}', actor: null },
    ]);
    const summary = await samlGroupOverageSummary(NOW);
    expect(summary).toEqual({
      total: 4,
      windowDays: 30,
      recent: [
        { userId: "u1", username: "otto", role: "developer", at: AT.toISOString() },
        { userId: "u2", username: null, role: null, at: AT.toISOString() },
        { userId: "u3", username: null, role: null, at: AT.toISOString() },
        { userId: "u4", username: null, role: null, at: AT.toISOString() },
      ],
    });
  });
});
