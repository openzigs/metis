/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Tests for hook subscriptions service (#114) and model-switch service (#120).
 * Prisma + audit are mocked in-memory.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface SubRow {
  id: string;
  projectId: string;
  event: string;
  handlerKind: string;
  config: string;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}
interface SessionRow {
  id: string;
  userId: string;
  model: string;
  currentModel: string | null;
  currentReasoningEffort: string | null;
  deletedAt: Date | null;
}

const subs = new Map<string, SubRow>();
const sessions = new Map<string, SessionRow>();
let seq = 0;

function reset(): void {
  subs.clear();
  sessions.clear();
  seq = 0;
}

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    auditLog: { create: vi.fn(async () => ({})) },
    hookSubscription: {
      findMany: vi.fn(async ({ where }: any) => {
        return [...subs.values()].filter((r) => {
          if (where.projectId && r.projectId !== where.projectId) return false;
          if (where.event && r.event !== where.event) return false;
          if (where.enabled === true && !r.enabled) return false;
          return true;
        });
      }),
      findUnique: vi.fn(async ({ where }: any) => subs.get(where.id) ?? null),
      // #675 — by-id ops scope on { id, projectId }.
      findFirst: vi.fn(async ({ where }: any) => {
        const r = subs.get(where.id);
        if (!r) return null;
        if (where.projectId != null && r.projectId !== where.projectId) return null;
        return r;
      }),
      create: vi.fn(async ({ data }: any) => {
        seq++;
        const r: SubRow = {
          id: `h_${seq}`,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        };
        subs.set(r.id, r);
        return r;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const r = subs.get(where.id);
        if (!r) throw new Error("nf");
        Object.assign(r, data, { updatedAt: new Date() });
        return r;
      }),
      delete: vi.fn(async ({ where }: any) => {
        subs.delete(where.id);
        return { id: where.id };
      }),
      // #675 — project-scoped delete returns { count }.
      deleteMany: vi.fn(async ({ where }: any) => {
        const r = subs.get(where.id);
        if (!r || (where.projectId != null && r.projectId !== where.projectId)) {
          return { count: 0 };
        }
        subs.delete(where.id);
        return { count: 1 };
      }),
    },
    aISession: {
      findUnique: vi.fn(async ({ where }: any) => {
        const r = sessions.get(where.id);
        return r ? { ...r } : null;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const r = sessions.get(where.id);
        if (!r) throw new Error("nf");
        Object.assign(r, data);
        return { ...r };
      }),
    },
  },
}));

import {
  HookConfigError,
  createSubscription,
  deleteSubscription,
  listEnabledFor,
  listSubscriptions,
  updateSubscription,
  runWebhook,
} from "../src/lib/hooks/index.js";
import { ModelSwitchError, switchModel } from "../src/lib/ai/model-switch.js";

beforeEach(reset);
afterEach(reset);

describe("hook subscriptions service (#114)", () => {
  it("creates and lists subscriptions", async () => {
    const created = await createSubscription({
      projectId: "p1",
      event: "preToolUse",
      handlerKind: "webhook",
      // #675 — literal public IP exercises the egress guard without real DNS.
      config: { url: "https://93.184.216.34/h" },
    });
    expect(created.event).toBe("preToolUse");
    expect(created.config.url).toBe("https://93.184.216.34/h");
    const list = await listSubscriptions("p1");
    expect(list).toHaveLength(1);
  });

  it("rejects unsupported event", async () => {
    await expect(createSubscription({ projectId: "p1", event: "blah" as never })).rejects.toThrow(
      HookConfigError,
    );
  });

  it("rejects script handlerKind (deferred to v1.2)", async () => {
    await expect(
      createSubscription({
        projectId: "p1",
        event: "preToolUse",
        handlerKind: "script",
      }),
    ).rejects.toThrow(HookConfigError);
  });

  it("requires a https?:// url for webhook handlers", async () => {
    await expect(
      createSubscription({
        projectId: "p1",
        event: "preToolUse",
        handlerKind: "webhook",
        config: {},
      }),
    ).rejects.toThrow(HookConfigError);
    await expect(
      createSubscription({
        projectId: "p1",
        event: "preToolUse",
        handlerKind: "webhook",
        config: { url: "ftp://no" },
      }),
    ).rejects.toThrow(HookConfigError);
  });

  it("update + delete + listEnabledFor", async () => {
    const s = await createSubscription({
      projectId: "p1",
      event: "postToolUse",
      handlerKind: "webhook",
      config: { url: "https://93.184.216.34" },
    });
    // #675 — update/delete are now project-scoped: pass the owning projectId.
    const updated = await updateSubscription("p1", s.id, { enabled: false });
    expect(updated.enabled).toBe(false);
    const enabled = await listEnabledFor("p1", "postToolUse");
    expect(enabled).toHaveLength(0);
    await deleteSubscription("p1", s.id);
    expect(await listSubscriptions("p1")).toHaveLength(0);
  });

  it("update validates the merged config", async () => {
    const s = await createSubscription({
      projectId: "p1",
      event: "preToolUse",
      handlerKind: "webhook",
      config: { url: "https://93.184.216.34" },
    });
    await expect(updateSubscription("p1", s.id, { config: { url: "not-a-url" } })).rejects.toThrow(
      HookConfigError,
    );
  });

  it("runWebhook returns true on 2xx and false on failure", async () => {
    const ok = await runWebhook(
      "https://example.com",
      { ping: 1 },
      {},
      (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch,
    );
    expect(ok).toBe(true);
    const fail = await runWebhook("https://example.com", { ping: 1 }, {}, (async () => {
      throw new Error("boom");
    }) as unknown as typeof fetch);
    expect(fail).toBe(false);
    const non2xx = await runWebhook(
      "https://example.com",
      { ping: 1 },
      {},
      (async () => new Response("err", { status: 500 })) as unknown as typeof fetch,
    );
    expect(non2xx).toBe(false);
  });
});

describe("model-switch service (#120)", () => {
  function seed(id: string): SessionRow {
    const r: SessionRow = {
      id,
      userId: "u1",
      model: "claude-default",
      currentModel: null,
      currentReasoningEffort: null,
      deletedAt: null,
    };
    sessions.set(id, r);
    return r;
  }

  it("switches model and persists previous", async () => {
    seed("s1");
    const r = await switchModel({ sessionId: "s1", model: "gpt-5.3", reasoningEffort: "high" });
    expect(r.currentModel).toBe("gpt-5.3");
    expect(r.previousModel).toBe("claude-default");
    expect(r.currentReasoningEffort).toBe("high");
  });

  it("respects allowedModels", async () => {
    seed("s1");
    await expect(
      switchModel({ sessionId: "s1", model: "x", allowedModels: ["a", "b"] }),
    ).rejects.toThrow(ModelSwitchError);
  });

  it("rejects unknown session", async () => {
    await expect(switchModel({ sessionId: "nope", model: "x" })).rejects.toThrow(ModelSwitchError);
  });

  it("rejects deleted session", async () => {
    const s = seed("s1");
    s.deletedAt = new Date();
    await expect(switchModel({ sessionId: "s1", model: "x" })).rejects.toThrow(ModelSwitchError);
  });
});
