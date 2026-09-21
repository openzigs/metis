/**
 * Tests for the E2B firewall payload builder + provider shape probe
 * (Epic #395 #414).
 */
import { describe, expect, it, beforeEach } from "vitest";
import {
  buildE2BFirewallShapes,
  type E2BFirewallShape,
} from "../../../../src/lib/sandbox/e2b/firewall.js";
import { SYSTEM_DEFAULT_EGRESS_ALLOWLIST } from "../../../../src/lib/sandbox/egress-defaults.js";
import {
  E2B_UNAVAILABLE,
  E2BSandboxProvider,
  __resetDetectedFirewallShape,
} from "../../../../src/lib/sandbox/e2b/e2b-provider.js";
import { SandboxAuditEmitter } from "../../../../src/lib/sandbox/audit/audit-emitter.js";
import type { E2BSandboxLike } from "../../../../src/lib/sandbox/e2b/e2b-sandbox.js";
import type {
  SandboxAuditEventInput,
  SandboxAuditEventRepo,
  SandboxAuditEventRow,
} from "../../../../src/lib/sandbox/repos/sandbox-audit-event.repo.js";
import type {
  SandboxSessionFinalizeInput,
  SandboxSessionRepo,
  SandboxSessionRow,
  SandboxSessionStartInput,
} from "../../../../src/lib/sandbox/repos/sandbox-session.repo.js";

class StubSessionRepo implements SandboxSessionRepo {
  rows = new Map<string, SandboxSessionRow>();
  async start(input: SandboxSessionStartInput): Promise<SandboxSessionRow> {
    const row: SandboxSessionRow = {
      id: `s-${this.rows.size + 1}`,
      projectId: input.projectId,
      userId: input.userId ?? null,
      runId: input.runId ?? null,
      provider: input.provider,
      vendorSandboxId: input.vendorSandboxId,
      templateId: input.templateId ?? null,
      vCpus: input.vCpus,
      memMiB: input.memMiB,
      createdAt: new Date(),
      destroyedAt: null,
      wallClockMs: null,
      cpuTimeMs: null,
      costMicroUsd: null,
      runId: null,
      outcome: null,
      errorMessage: null,
    };
    this.rows.set(row.id, row);
    return row;
  }
  async finalize(
    sessionId: string,
    input: SandboxSessionFinalizeInput,
  ): Promise<SandboxSessionRow> {
    const row = this.rows.get(sessionId);
    if (!row) throw new Error("not found");
    Object.assign(row, input);
    return row;
  }
  async findById(id: string): Promise<SandboxSessionRow | null> {
    return this.rows.get(id) ?? null;
  }
  async listForProject(): Promise<SandboxSessionRow[]> {
    return Array.from(this.rows.values());
  }
}

class StubAuditRepo implements SandboxAuditEventRepo {
  rows: SandboxAuditEventRow[] = [];
  async append(input: SandboxAuditEventInput): Promise<SandboxAuditEventRow> {
    const row: SandboxAuditEventRow = {
      id: `r-${this.rows.length + 1}`,
      sessionId: input.sessionId,
      eventType: input.eventType,
      payload: JSON.stringify(input.payload ?? {}),
      timestamp: new Date(),
    };
    this.rows.push(row);
    return row;
  }
  async listForSession(sessionId: string): Promise<SandboxAuditEventRow[]> {
    return this.rows.filter((r) => r.sessionId === sessionId);
  }
  async countForSession(sessionId: string): Promise<number> {
    return this.rows.filter((r) => r.sessionId === sessionId).length;
  }
}

function stubClient(): E2BSandboxLike {
  return {
    sandboxId: "vendor-1",
    async runCode() {
      return { text: "", logs: { stdout: [], stderr: [] } };
    },
    commands: {
      async run() {
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    },
    files: {
      async read() {
        return "";
      },
      async write() {
        /* no-op */
      },
    },
    async pause() {
      return "snap";
    },
    async kill() {
      /* no-op */
    },
  };
}

describe("buildE2BFirewallShapes", () => {
  it("emits a default-deny policy with the system allowlist when no caller hosts are passed", () => {
    const out = buildE2BFirewallShapes([]);
    for (const host of SYSTEM_DEFAULT_EGRESS_ALLOWLIST) {
      expect(out.hosts).toContain(host);
    }
    // Both shapes carry defaultPolicy: 'deny'.
    for (const shape of out.shapes) {
      const payload = shape.payload as Record<string, { defaultPolicy: string }>;
      const inner = payload.firewall ?? payload.network;
      expect(inner.defaultPolicy).toBe("deny");
    }
  });

  it("emits both candidate shapes in deterministic order: 'firewall' first, 'network' second", () => {
    const out = buildE2BFirewallShapes([]);
    expect(out.shapes.map((s) => s.name)).toEqual(["firewall", "network"]);
  });

  it("includes caller hosts merged with the system list", () => {
    const out = buildE2BFirewallShapes(["internal.example.com"]);
    expect(out.hosts).toContain("internal.example.com");
    expect(out.hosts).toContain("registry.npmjs.org");
  });

  it("rejects forbidden wildcards before any merge", () => {
    expect(() => buildE2BFirewallShapes(["*"])).toThrow();
    expect(() => buildE2BFirewallShapes(["0.0.0.0/0"])).toThrow();
  });
});

describe("E2BSandboxProvider firewall shape probe", () => {
  beforeEach(() => {
    __resetDetectedFirewallShape();
  });

  it("retries with the second shape when the first one is rejected by the SDK", async () => {
    const calls: string[] = [];
    const provider = new E2BSandboxProvider({
      apiKey: "key-1",
      sessionRepo: new StubSessionRepo(),
      emitter: new SandboxAuditEmitter(new StubAuditRepo()),
      clientFactory: async (opts) => {
        const payload = opts.firewallPayload;
        const which = "firewall" in payload ? "firewall" : "network";
        calls.push(which);
        if (which === "firewall") {
          throw new Error("Unknown property: firewall");
        }
        return stubClient();
      },
    });
    const sandbox = await provider.create({ projectId: "p-1" });
    expect(calls).toEqual(["firewall", "network"]);
    expect(sandbox.provider).toBe("e2b");
    await sandbox.destroy();
  });

  it("throws E2B_UNAVAILABLE when ALL shapes are rejected — never silently default-allows", async () => {
    const provider = new E2BSandboxProvider({
      apiKey: "key-1",
      sessionRepo: new StubSessionRepo(),
      emitter: new SandboxAuditEmitter(new StubAuditRepo()),
      clientFactory: async () => {
        throw new Error("Unknown property");
      },
    });
    await expect(provider.create({ projectId: "p-1" })).rejects.toMatchObject({
      code: E2B_UNAVAILABLE,
    });
  });

  it("caches the detected shape across calls so the second create skips the failed shape", async () => {
    const calls: string[] = [];
    const factory = async (opts: { firewallPayload: Record<string, unknown> }) => {
      const which = "firewall" in opts.firewallPayload ? "firewall" : "network";
      calls.push(which);
      if (which === "firewall") throw new Error("rejected");
      return stubClient();
    };
    const provider = new E2BSandboxProvider({
      apiKey: "key-1",
      sessionRepo: new StubSessionRepo(),
      emitter: new SandboxAuditEmitter(new StubAuditRepo()),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      clientFactory: factory as any,
    });
    const a = await provider.create({ projectId: "p-1" });
    await a.destroy();
    const beforeSecond = calls.length;
    const b = await provider.create({ projectId: "p-1" });
    await b.destroy();
    // Second call should try the cached 'network' shape FIRST, succeed,
    // and never invoke the rejected 'firewall' shape again.
    expect(calls.slice(beforeSecond)).toEqual(["network"]);
  });

  // Suppress unused import warning — the type is used implicitly via the
  // factory signature in the cache test above.
  void (null as unknown as E2BFirewallShape);
});
