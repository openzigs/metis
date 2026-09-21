/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Epic #396 (MVP-8) — gate model tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const featureArtifactRows = new Map<string, any>();
const auditCalls: any[] = [];

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    auditLog: { create: vi.fn(async () => ({})) },
    specKitFeatureArtifact: {
      findUnique: vi.fn(async ({ where }: any) => {
        if (where.featureId_key) {
          for (const r of featureArtifactRows.values()) {
            if (r.featureId === where.featureId_key.featureId && r.key === where.featureId_key.key)
              return r;
          }
        }
        return null;
      }),
      findMany: vi.fn(async ({ where }: any) =>
        [...featureArtifactRows.values()].filter((r) => r.featureId === where.featureId),
      ),
      create: vi.fn(async ({ data }: any) => {
        const id = `fa_${featureArtifactRows.size + 1}`;
        const row = {
          id,
          createdAt: new Date(),
          updatedAt: new Date(),
          version: data.version ?? 1,
          updatedById: data.updatedById ?? null,
          ...data,
        };
        featureArtifactRows.set(id, row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const r = featureArtifactRows.get(where.id);
        Object.assign(r, data, { updatedAt: new Date() });
        return r;
      }),
      delete: vi.fn(async ({ where }: any) => {
        featureArtifactRows.delete(where.id);
      }),
    },
  },
}));

vi.mock("../src/lib/audit/audit-service.js", () => ({
  audit: vi.fn((entry: any) => {
    auditCalls.push(entry);
  }),
}));

import {
  computeStatus,
  requireGate,
  GateUnmetError,
  statusJsonBody,
} from "../src/lib/spec-kit/gates.js";
import { writeFeatureArtifact } from "../src/lib/spec-kit/feature-artifacts.js";

beforeEach(() => {
  featureArtifactRows.clear();
  auditCalls.length = 0;
});
afterEach(() => vi.clearAllMocks());

describe("computeStatus", () => {
  it("returns all-false for empty feature", async () => {
    const s = await computeStatus("f1");
    expect(s).toMatchObject({
      specGate: false,
      planGate: false,
      tasksGate: false,
      implementGate: false,
    });
  });

  it("specGate flips true when spec.md exists", async () => {
    await writeFeatureArtifact({ featureId: "f1", key: "spec.md", content: "Body" });
    const s = await computeStatus("f1");
    expect(s.specGate).toBe(true);
    expect(s.planGate).toBe(false);
  });

  it("planGate requires both spec and plan", async () => {
    await writeFeatureArtifact({ featureId: "f1", key: "plan.md", content: "Plan" });
    let s = await computeStatus("f1");
    expect(s.planGate).toBe(false);
    await writeFeatureArtifact({ featureId: "f1", key: "spec.md", content: "Spec" });
    s = await computeStatus("f1");
    expect(s.planGate).toBe(true);
  });

  it("tasksGate cascades through plan + spec", async () => {
    await writeFeatureArtifact({ featureId: "f1", key: "spec.md", content: "Spec" });
    await writeFeatureArtifact({ featureId: "f1", key: "plan.md", content: "Plan" });
    await writeFeatureArtifact({ featureId: "f1", key: "tasks.md", content: "Tasks" });
    const s = await computeStatus("f1");
    expect(s.tasksGate).toBe(true);
    expect(s.implementGate).toBe(true);
  });

  it("treats whitespace-only artifacts as missing", async () => {
    await writeFeatureArtifact({ featureId: "f1", key: "spec.md", content: "    " });
    const s = await computeStatus("f1");
    expect(s.specGate).toBe(false);
  });
});

describe("requireGate", () => {
  it("throws GateUnmetError when gate is unmet", async () => {
    await expect(
      requireGate({ featureId: "f1", gate: "specGate", actorId: "u1" }),
    ).rejects.toBeInstanceOf(GateUnmetError);
    await expect(
      requireGate({ featureId: "f1", gate: "specGate", actorId: "u1" }),
    ).rejects.toMatchObject({ status: 412, code: "SPECKIT_GATE_UNMET", required: "specGate" });
  });

  it("returns the status when gate is met", async () => {
    await writeFeatureArtifact({ featureId: "f1", key: "spec.md", content: "Spec" });
    const s = await requireGate({ featureId: "f1", gate: "specGate" });
    expect(s.specGate).toBe(true);
  });

  it("force=true bypasses the gate and emits high-severity audit", async () => {
    auditCalls.length = 0;
    const s = await requireGate({
      featureId: "f1",
      gate: "specGate",
      force: true,
      actorId: "u1",
      command: "speckit.plan",
    });
    expect(s.specGate).toBe(false);
    const forced = auditCalls.find((c) => c.action === "speckit.gate.forced");
    expect(forced).toBeTruthy();
    expect(forced.metadata.severity).toBe("high");
    expect(forced.metadata.command).toBe("speckit.plan");
  });
});

describe("statusJsonBody", () => {
  it("serializes status as pretty JSON", () => {
    const body = statusJsonBody({
      specGate: true,
      planGate: false,
      tasksGate: false,
      implementGate: false,
      lastUpdated: "2026-04-30T00:00:00.000Z",
    });
    expect(body).toContain('"specGate": true');
    expect(body.endsWith("\n")).toBe(true);
  });
});
