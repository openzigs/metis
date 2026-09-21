/**
 * Issue #422 — DB-level immutability of `sandbox_audit_events`.
 *
 * The application-layer fence in #421 (`SandboxAuditEventRepo` omits
 * update/delete) is the immediate guarantee. This test asserts the
 * SOC-2 hardening fence: even raw `prisma.sandboxAuditEvent.{update,
 * delete}` calls MUST fail with a Postgres permission error when the
 * application role is the documented `metis` role.
 *
 * Gated on `RUN_INTEGRATION_TESTS=1` and a `DATABASE_URL` pointing at a
 * Postgres instance that has had migration
 * `20260501000000_sandbox_audit_immutable` applied. SQLite dev mode
 * does NOT enforce this — the SECURITY.md §9.6 design note explains
 * why: prod is the only environment that holds the SOC-2 obligation.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";

const RUN = process.env.RUN_INTEGRATION_TESTS === "1";
const dbUrl = process.env.DATABASE_URL ?? "";
const POSTGRES = /^postgres(?:ql)?:\/\//i.test(dbUrl);
const ENABLED = RUN && POSTGRES;
const describeMaybe = ENABLED ? describe : describe.skip;

describeMaybe("Issue #422 — sandbox audit DB-level immutability", () => {
  let prisma: PrismaClient;
  let seededId: string | null = null;

  beforeAll(async () => {
    prisma = new PrismaClient();
    const session = await prisma.sandboxSession.create({
      data: {
        projectId: "test-proj-422",
        provider: "noop",
        vendorSandboxId: "vendor-422",
        vCpus: 1,
        memMiB: 256,
      },
    });
    const evt = await prisma.sandboxAuditEvent.create({
      data: {
        sessionId: session.id,
        eventType: "create",
        payload: JSON.stringify({ test: "issue-422" }),
      },
    });
    seededId = evt.id;
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  it("INSERT succeeds (audit emitter still writes)", () => {
    expect(seededId).toBeTruthy();
  });

  it("UPDATE on sandbox_audit_events fails with a Postgres permission error", async () => {
    expect(seededId).toBeTruthy();
    await expect(
      prisma.sandboxAuditEvent.update({
        where: { id: seededId! },
        data: { eventType: "tampered" },
      }),
    ).rejects.toThrow(/permission denied|insufficient privilege/i);
  });

  it("DELETE on sandbox_audit_events fails with a Postgres permission error", async () => {
    expect(seededId).toBeTruthy();
    await expect(prisma.sandboxAuditEvent.delete({ where: { id: seededId! } })).rejects.toThrow(
      /permission denied|insufficient privilege/i,
    );
  });
});
