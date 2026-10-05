/**
 * #713 — the Model Preferences picker lists the models the ACTIVE provider runs.
 *
 * On DeepSeek's Anthropic-compatible endpoint (`AI_PROVIDER=anthropic`,
 * `ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic`, `ANTHROPIC_MODEL=
 * deepseek-flash`) the page offered only the four `us.anthropic.claude-*` tier
 * ids, at Anthropic prices, and not `deepseek-flash` — while the recommendation
 * endpoint (#512) already named `deepseek-flash`. These tests pin the list, the
 * price source and the save validation to the provider the run uses.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("../middleware/auth.js", () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: () => void) => {
    (req as unknown as { user: unknown }).user = {
      userId: "u1",
      role: "developer",
      workspaces: ["ws-1"],
    };
    next();
  },
}));
vi.mock("../middleware/require-permission.js", () => ({
  requirePermission:
    () => (_req: express.Request, _res: express.Response, next: express.NextFunction) =>
      next(),
}));

const upsert = vi.fn();
vi.mock("../lib/prisma.js", () => ({
  prisma: {
    project: { findFirst: async () => ({ id: "proj-1", deletedAt: null }) },
    modelPreference: {
      findUnique: async () => null,
      upsert: (...a: unknown[]) => upsert(...a),
    },
  },
}));

interface FakeProvider {
  key: string;
  model: string;
  offline?: boolean;
  servesRouterModel?: (id: string) => boolean;
}
const deepSeekBaseUrl = "https://api.deepseek.com/anthropic";
const deepSeek: FakeProvider = {
  key: "anthropic",
  model: "deepseek-flash",
  servesRouterModel: () => false,
};
const claudeGateway: FakeProvider = {
  key: "bedrock-gateway",
  model: "us.anthropic.claude-sonnet-5",
  servesRouterModel: () => true,
};
let activeProvider: FakeProvider = deepSeek;
let activeConfig: Record<string, unknown> = {};

vi.mock("../lib/ai/providers/factory.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/ai/providers/factory.js")>()),
  buildProvider: () => activeProvider,
}));
vi.mock("../lib/ai/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/ai/config.js")>()),
  loadAIConfig: () => activeConfig,
}));

const { initModelPreferenceRouter } = await import("./model-preferences.js");
const { errorHandler } = await import("../middleware/error-handler.js");

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use("/projects/:projectId/model-preferences", initModelPreferenceRouter());
  app.use(errorHandler);
  return app;
}

interface AvailableModel {
  id: string;
  name: string;
  tier: string;
  price: { inputPerMTok: number; outputPerMTok: number } | null;
}

async function getPrefs(): Promise<{
  availableModels: AvailableModel[];
  servesTierModels: boolean;
}> {
  const res = await request(buildApp()).get("/projects/proj-1/model-preferences");
  expect(res.status).toBe(200);
  return res.body.data;
}

function useDeepSeek(): void {
  activeProvider = deepSeek;
  activeConfig = {
    provider: "anthropic",
    model: "deepseek-flash",
    sdkProvider: { baseUrl: deepSeekBaseUrl },
  };
}

beforeEach(() => {
  upsert.mockReset();
  upsert.mockImplementation(async ({ create }: { create: Record<string, unknown> }) => ({
    ...create,
    taskTypeOverrides: "{}",
  }));
  delete process.env.MODEL_PRICES;
  useDeepSeek();
});

describe("GET model-preferences on a provider that does not serve Claude tiers (#713)", () => {
  it("offers the provider's configured model and no Claude tier id", async () => {
    const data = await getPrefs();
    expect(data.availableModels.map((m) => m.id)).toEqual(["deepseek-flash"]);
    expect(data.availableModels[0]).toMatchObject({ name: "deepseek-flash", tier: "configured" });
    expect(JSON.stringify(data.availableModels)).not.toContain("claude");
    expect(data.servesTierModels).toBe(false);
  });

  it("quotes no Anthropic price for it: unknown unless the operator prices it", async () => {
    expect((await getPrefs()).availableModels[0].price).toBeNull();
  });

  it("quotes the operator's MODEL_PRICES entry for it when one exists", async () => {
    process.env.MODEL_PRICES = JSON.stringify({
      "anthropic:deepseek-flash": { inputPerMTok: 0.07, outputPerMTok: 0.28 },
    });
    const { price } = (await getPrefs()).availableModels[0];
    expect(price).toMatchObject({ inputPerMTok: 0.07, outputPerMTok: 0.28 });
  });
});

describe("GET model-preferences on a provider that serves Claude tiers", () => {
  it("lists the router's Claude tiers, as before", async () => {
    activeProvider = claudeGateway;
    activeConfig = { provider: "bedrock-gateway", model: claudeGateway.model };
    const data = await getPrefs();
    expect(data.availableModels.map((m) => m.id)).toEqual([
      "us.anthropic.claude-haiku-4-5-20251001-v1:0",
      "us.anthropic.claude-sonnet-5",
      "us.anthropic.claude-fable-5",
      "us.anthropic.claude-opus-4-8",
    ]);
    expect(data.servesTierModels).toBe(true);
  });

  it("keeps the tier list on the offline stub, which answers any model id", async () => {
    activeProvider = { key: "offline-stub", model: "offline-stub", offline: true };
    activeConfig = { provider: "offline-stub", model: "offline-stub" };
    const data = await getPrefs();
    expect(data.availableModels).toHaveLength(4);
    expect(data.servesTierModels).toBe(true);
  });
});

describe("PUT model-preferences default model (#713)", () => {
  async function put(defaultModel: string | null): Promise<request.Response> {
    return request(buildApp()).put("/projects/proj-1/model-preferences").send({ defaultModel });
  }

  it("accepts the provider's configured model", async () => {
    const res = await put("deepseek-flash");
    expect(res.status).toBe(200);
    expect(res.body.data.defaultModel).toBe("deepseek-flash");
  });

  it("still accepts a tier id, including the legacy Sonnet id", async () => {
    expect((await put("us.anthropic.claude-haiku-4-5-20251001-v1:0")).status).toBe(200);
    expect((await put("us.anthropic.claude-sonnet-4-6")).status).toBe(200);
  });

  it("rejects a model that is neither a tier nor the configured model", async () => {
    const res = await put("gpt-4o");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(upsert).not.toHaveBeenCalled();
  });

  it("rejects another provider's configured model", async () => {
    activeProvider = claudeGateway;
    expect((await put("deepseek-flash")).status).toBe(400);
  });
});
