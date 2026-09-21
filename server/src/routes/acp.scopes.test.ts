/**
 * Issue #676 — `POST /api/acp/tokens` clamps the minted scopes so a token can
 * never carry more authority than the platform grants. `createApiToken` is
 * stubbed to capture the scopes the route hands it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("../middleware/auth.js", () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: () => void) => {
    (req as unknown as { user: { userId: string } }).user = { userId: "u-1" };
    next();
  },
}));

const createApiToken = vi.fn(async () => ({ id: "tok-1", token: "metis_x" }));
vi.mock("../lib/acp/api-tokens.js", () => ({
  ApiTokenError: class ApiTokenError extends Error {
    status = 400;
    code = "X";
  },
  createApiToken: (...a: unknown[]) => createApiToken(...a),
  listApiTokens: vi.fn(),
  revokeApiToken: vi.fn(),
}));

const { acpRouter } = await import("./acp.js");
const { errorHandler } = await import("../middleware/error-handler.js");

function createApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/acp", acpRouter());
  app.use(errorHandler);
  return app;
}

let app: ReturnType<typeof createApp>;
beforeEach(() => {
  vi.clearAllMocks();
  app = createApp();
});

describe("POST /api/acp/tokens — scope clamping", () => {
  it("drops unknown / over-privileged scopes before minting", async () => {
    const res = await request(app)
      .post("/api/acp/tokens")
      .send({ name: "t", scopes: ["acp:read", "acp:admin", "role.manage"] });
    expect(res.status).toBe(201);
    expect(createApiToken).toHaveBeenCalledWith(expect.objectContaining({ scopes: ["acp:read"] }));
  });

  it("defaults to the full grantable set when no scopes are requested", async () => {
    const res = await request(app).post("/api/acp/tokens").send({ name: "t" });
    expect(res.status).toBe(201);
    expect(createApiToken).toHaveBeenCalledWith(
      expect.objectContaining({ scopes: ["acp:read", "acp:run"] }),
    );
  });

  it("expands a requested wildcard into concrete scopes — never persists acp:*", async () => {
    const res = await request(app)
      .post("/api/acp/tokens")
      .send({ name: "t", scopes: ["acp:*"] });
    expect(res.status).toBe(201);
    const minted = createApiToken.mock.calls[0]?.[0] as { scopes: string[] };
    expect(minted.scopes).not.toContain("acp:*");
    expect(new Set(minted.scopes)).toEqual(new Set(["acp:read", "acp:run"]));
  });
});
