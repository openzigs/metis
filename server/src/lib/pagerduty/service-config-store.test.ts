/**
 * Issue #580 — PagerDuty service-config store tests.
 *
 * The store persists per-(workspace, serviceKey) PagerDuty routing keys. The
 * routing key is encrypted in the vault; only a `${vault:label}` reference is ever
 * stored on the row. Tests use an in-memory Prisma double + a fake vault to prove
 * the row never carries plaintext, register/list/delete behave, and resolution
 * decrypts correctly.
 */
import { beforeEach, describe, expect, it } from "vitest";

import {
  PagerDutyServiceConfigStore,
  PagerDutyServiceConfigError,
} from "./service-config-store.js";

// ── In-memory doubles ───────────────────────────────────────────────────────

interface ConfigRow {
  id: string;
  workspaceId: string;
  serviceKey: string;
  routingKeyRef: string;
  label: string | null;
  status: string;
  createdById: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function makePrisma() {
  const rows: ConfigRow[] = [];
  let seq = 0;
  return {
    rows,
    pagerDutyServiceConfig: {
      async upsert(args: {
        where: { workspaceId_serviceKey: { workspaceId: string; serviceKey: string } };
        create: Omit<ConfigRow, "id" | "createdAt" | "updatedAt">;
        update: Partial<ConfigRow>;
      }) {
        const { workspaceId, serviceKey } = args.where.workspaceId_serviceKey;
        const existing = rows.find(
          (r) => r.workspaceId === workspaceId && r.serviceKey === serviceKey,
        );
        if (existing) {
          Object.assign(existing, args.update, { updatedAt: new Date() });
          return existing;
        }
        const row: ConfigRow = {
          id: `cfg-${++seq}`,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...args.create,
        } as ConfigRow;
        rows.push(row);
        return row;
      },
      async findUnique(args: {
        where: { workspaceId_serviceKey: { workspaceId: string; serviceKey: string } };
      }) {
        const { workspaceId, serviceKey } = args.where.workspaceId_serviceKey;
        return (
          rows.find((r) => r.workspaceId === workspaceId && r.serviceKey === serviceKey) ?? null
        );
      },
      async findMany(args: { where: { workspaceId: string } }) {
        return rows.filter((r) => r.workspaceId === args.where.workspaceId);
      },
      async deleteMany(args: { where: { workspaceId: string; serviceKey: string } }) {
        const before = rows.length;
        for (let i = rows.length - 1; i >= 0; i--) {
          if (
            rows[i].workspaceId === args.where.workspaceId &&
            rows[i].serviceKey === args.where.serviceKey
          ) {
            rows.splice(i, 1);
          }
        }
        return { count: before - rows.length };
      },
    },
    secret: {
      async findFirst(args: { where: { name: string; deletedAt: null } }) {
        const s = secrets.find((x) => x.name === args.where.name && !x.deletedAt);
        return s ? { id: s.id } : null;
      },
    },
  };
}

interface SecretRow {
  id: string;
  name: string;
  plaintext: string;
  deletedAt: Date | null;
}
let secrets: SecretRow[] = [];

function makeVault() {
  let seq = 0;
  return {
    async create(
      label: string,
      plaintext: string,
      _scope: string,
      _opts: unknown,
    ): Promise<{ id: string }> {
      const id = `sec-${++seq}`;
      secrets.push({ id, name: `project:${label}`, plaintext, deletedAt: null });
      return { id };
    },
    async rotate(id: string, plaintext: string) {
      const s = secrets.find((x) => x.id === id);
      if (s) s.plaintext = plaintext;
      return { id };
    },
    async read(id: string) {
      const s = secrets.find((x) => x.id === id && !x.deletedAt);
      if (!s) throw new Error(`secret ${id} not found`);
      return { plaintext: s.plaintext };
    },
    async delete(id: string) {
      const s = secrets.find((x) => x.id === id);
      if (s) s.deletedAt = new Date();
    },
  };
}

function newStore() {
  const db = makePrisma();
  const vault = makeVault();
  const store = new PagerDutyServiceConfigStore(db as never, vault as never);
  return { store, db, vault };
}

describe("PagerDutyServiceConfigStore", () => {
  beforeEach(() => {
    secrets = [];
  });

  it("registers a config, encrypting the routing key into the vault (no plaintext on the row)", async () => {
    const { store, db } = newStore();
    const summary = await store.register({
      workspaceId: "ws-1",
      serviceKey: "default",
      routingKey: "R0UT1NG-SECRET",
      createdById: "u-1",
    });

    expect(summary.workspaceId).toBe("ws-1");
    expect(summary.serviceKey).toBe("default");
    // The stored row holds only a ${vault:...} reference — never the plaintext.
    const row = db.rows[0];
    expect(row.routingKeyRef).toMatch(/^\$\{vault:pagerduty-routing-key:ws-1:default\}$/);
    expect(JSON.stringify(row)).not.toContain("R0UT1NG-SECRET");
    // The summary surface never exposes the routing key either.
    expect(JSON.stringify(summary)).not.toContain("R0UT1NG-SECRET");
    expect("routingKey" in summary).toBe(false);
  });

  it("defaults serviceKey to 'default' when omitted", async () => {
    const { store } = newStore();
    const summary = await store.register({
      workspaceId: "ws-1",
      routingKey: "rk",
    });
    expect(summary.serviceKey).toBe("default");
  });

  it("re-registering the same (workspace, service) rotates the secret in place", async () => {
    const { store, db } = newStore();
    await store.register({ workspaceId: "ws-1", serviceKey: "default", routingKey: "first" });
    await store.register({ workspaceId: "ws-1", serviceKey: "default", routingKey: "second" });
    expect(db.rows.length).toBe(1);
    expect(secrets.length).toBe(1);
    expect(secrets[0].plaintext).toBe("second");
  });

  it("resolveRoutingKey decrypts the stored secret", async () => {
    const { store } = newStore();
    await store.register({ workspaceId: "ws-1", serviceKey: "infra", routingKey: "RK-INFRA" });
    const rk = await store.resolveRoutingKey("ws-1", "infra");
    expect(rk).toBe("RK-INFRA");
  });

  it("resolveRoutingKey returns null when no config exists", async () => {
    const { store } = newStore();
    expect(await store.resolveRoutingKey("ws-x", "default")).toBeNull();
  });

  it("resolveRoutingKey returns null for an inactive config (delivery disabled)", async () => {
    const { store, db } = newStore();
    await store.register({ workspaceId: "ws-1", serviceKey: "default", routingKey: "rk" });
    db.rows[0].status = "inactive";
    expect(await store.resolveRoutingKey("ws-1", "default")).toBeNull();
  });

  it("isolates workspaces — ws-2 cannot resolve ws-1's key", async () => {
    const { store } = newStore();
    await store.register({ workspaceId: "ws-1", serviceKey: "default", routingKey: "ws1-rk" });
    expect(await store.resolveRoutingKey("ws-2", "default")).toBeNull();
  });

  it("lists configs for a workspace without leaking the routing key", async () => {
    const { store } = newStore();
    await store.register({ workspaceId: "ws-1", serviceKey: "default", routingKey: "a" });
    await store.register({ workspaceId: "ws-1", serviceKey: "infra", routingKey: "b" });
    await store.register({ workspaceId: "ws-2", serviceKey: "default", routingKey: "c" });
    const list = await store.listByWorkspace("ws-1");
    expect(list.length).toBe(2);
    expect(JSON.stringify(list)).not.toMatch(/"a"|"b"|"c"/);
  });

  it("deletes a config and soft-deletes its vault secret (idempotent)", async () => {
    const { store } = newStore();
    await store.register({ workspaceId: "ws-1", serviceKey: "default", routingKey: "rk" });
    const removed = await store.delete("ws-1", "default");
    expect(removed).toBe(true);
    expect(secrets[0].deletedAt).not.toBeNull();
    // Second delete is a no-op.
    expect(await store.delete("ws-1", "default")).toBe(false);
  });

  it("rejects a blank serviceKey", async () => {
    const { store } = newStore();
    await expect(
      store.register({ workspaceId: "ws-1", serviceKey: "   ", routingKey: "rk" }),
    ).rejects.toBeInstanceOf(PagerDutyServiceConfigError);
  });

  it("resolveRoutingKey returns null when the vault secret was deleted out from under the ref", async () => {
    const { store } = newStore();
    await store.register({ workspaceId: "ws-1", serviceKey: "default", routingKey: "rk" });
    secrets[0].deletedAt = new Date(); // secret gone but row still references it
    expect(await store.resolveRoutingKey("ws-1", "default")).toBeNull();
  });

  it("throws VAULT_REF_INVALID when the stored ref is malformed", async () => {
    const { store, db } = newStore();
    await store.register({ workspaceId: "ws-1", serviceKey: "default", routingKey: "rk" });
    db.rows[0].routingKeyRef = "not-a-vault-ref";
    await expect(store.resolveRoutingKey("ws-1", "default")).rejects.toBeInstanceOf(
      PagerDutyServiceConfigError,
    );
  });

  it("delete is a no-op (returns false) for a workspace that owns no such config", async () => {
    const { store } = newStore();
    expect(await store.delete("ws-x", "default")).toBe(false);
  });

  it("rejects a blank workspaceId / routingKey", async () => {
    const { store } = newStore();
    await expect(store.register({ workspaceId: "", routingKey: "rk" })).rejects.toBeInstanceOf(
      PagerDutyServiceConfigError,
    );
    await expect(store.register({ workspaceId: "ws-1", routingKey: "  " })).rejects.toBeInstanceOf(
      PagerDutyServiceConfigError,
    );
  });
});
