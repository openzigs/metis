/**
 * #1518 — the audit row builder maps the system actor to `actorId: null` with an
 * `actorType: "system"` marker, for the queued path and for the callers that
 * persist through `tx.auditLog.create({ data: buildAuditLogData(...) })`.
 * The foreign-key consequence is proved against real SQLite in
 * `system-actor-audit-1518.sqlite.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { buildAuditLogData, SYSTEM_ACTOR_ID } from "../src/lib/audit/audit-service.js";

const base = { action: "connector.repo.test", targetType: "repo_connector", targetId: "c1" };

describe("buildAuditLogData — system actor (#1518)", () => {
  it("writes the system actor as a null actor id with an actorType marker", () => {
    const data = buildAuditLogData({ ...base, actorId: SYSTEM_ACTOR_ID });
    expect(data.actorId).toBeNull();
    expect(JSON.parse(data.metadata!)).toEqual({ actorType: "system" });
  });

  it("keeps the caller's metadata alongside the marker, and the marker wins", () => {
    const data = buildAuditLogData({
      ...base,
      actorId: SYSTEM_ACTOR_ID,
      metadata: { projectId: "p1", actorType: "user" },
    });
    expect(JSON.parse(data.metadata!)).toEqual({ projectId: "p1", actorType: "system" });
  });

  it("passes a user id through unchanged, with no marker", () => {
    const data = buildAuditLogData({ ...base, actorId: "u-123", metadata: { projectId: "p1" } });
    expect(data.actorId).toBe("u-123");
    expect(JSON.parse(data.metadata!)).toEqual({ projectId: "p1" });
  });

  it("leaves an already-null actor null and adds no marker", () => {
    expect(buildAuditLogData({ ...base, actorId: null })).toMatchObject({
      actorId: null,
      metadata: null,
    });
    expect(buildAuditLogData(base)).toMatchObject({ actorId: null, metadata: null });
  });

  it("matches the system id exactly, not by case or prefix", () => {
    expect(buildAuditLogData({ ...base, actorId: "System" }).actorId).toBe("System");
    expect(buildAuditLogData({ ...base, actorId: "system-user" }).actorId).toBe("system-user");
  });
});
