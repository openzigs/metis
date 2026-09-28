/**
 * #309 — the validation contract API clients see, pinned across the zod 3 → 4
 * upgrade. Written and run green on zod 3 BEFORE the bump.
 *
 * Three client-visible surfaces:
 *   1. the global `errorHandler`'s friendly `VALIDATION_ERROR` envelope for a
 *      raw `ZodError` (#426) — status, code, top-level message AND every
 *      `{ field, message }` pair are our own text, so all of it is pinned;
 *   2. routes that answer `{ issues: error.flatten() }` — status, code and the
 *      set of offending fields are pinned; the per-field message strings are
 *      zod's own default text, which zod 4 rewrote (see the PR);
 *   3. parse SEMANTICS a client depends on: defaults applied, coerced query
 *      params, and optional `z.unknown()` keys that may be omitted.
 */
import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import {
  createImportSourceSchema,
  importPreviewRequestSchema,
  retrieveQuerySchema,
} from "@metis/shared";

vi.mock("./auth.js", () => ({
  requireAuth: (req: { user?: unknown }, _res: unknown, next: () => void) => {
    req.user = { userId: "user-1", role: "admin" };
    next();
  },
}));

const { errorHandler } = await import("./error-handler.js");
const { onlineEvalRouter } = await import("../routes/eval-online.js");
const { agentsRouter } = await import("../routes/agents.js");
const { configRouter } = await import("../routes/admin/config.js");
const { workspacesRouter } = await import("../routes/workspaces.js");
const { reconciliationSchema } = await import("../lib/auth/role-reconciliation.js");

/** A route that parses the body with a REAL shared schema and lets a ZodError escape. */
function parsingApp(schema: { parse: (v: unknown) => unknown }) {
  const app = express();
  app.use(express.json());
  app.post("/parse", (req, res) => {
    res.json({ success: true, data: schema.parse(req.body ?? {}) });
  });
  app.use(errorHandler);
  return app;
}

function withoutCorrelation(body: Record<string, unknown>) {
  const { correlationId: _c, ...rest } = body;
  return rest;
}

describe("friendly VALIDATION_ERROR envelope (raw ZodError → 400)", () => {
  const app = parsingApp(createImportSourceSchema);

  it.each([
    [
      "a missing required string",
      { source: "github" },
      {
        message: "label is required",
        fields: [{ field: "label", message: "label is required" }],
      },
    ],
    [
      "an empty required string",
      { source: "github", label: "" },
      {
        message: "label is required",
        fields: [{ field: "label", message: "label is required" }],
      },
    ],
    [
      "a string over its max",
      { source: "github", label: "x".repeat(201) },
      {
        message: "label is too long",
        fields: [{ field: "label", message: "label is too long" }],
      },
    ],
    [
      "a value outside an enum",
      { source: "gitlab", label: "ok" },
      {
        message: "source is invalid",
        fields: [{ field: "source", message: "source is invalid" }],
      },
    ],
    [
      "the wrong primitive type",
      { source: "github", label: 42 },
      {
        message: "label is invalid",
        fields: [{ field: "label", message: "label is invalid" }],
      },
    ],
    [
      "a number under its min",
      { source: "github", label: "ok", syncIntervalMinutes: 0 },
      {
        message: "syncIntervalMinutes is too short",
        fields: [{ field: "syncIntervalMinutes", message: "syncIntervalMinutes is too short" }],
      },
    ],
    [
      "a non-integer",
      { source: "github", label: "ok", syncIntervalMinutes: 60.5 },
      {
        message: "syncIntervalMinutes is invalid",
        fields: [{ field: "syncIntervalMinutes", message: "syncIntervalMinutes is invalid" }],
      },
    ],
    [
      "a malformed URL",
      { source: "github", label: "ok", baseUrl: "not a url" },
      {
        message: "baseUrl is invalid",
        fields: [{ field: "baseUrl", message: "baseUrl is invalid" }],
      },
    ],
    [
      "an omitted required enum field",
      { label: "ok" },
      {
        message: "source is required",
        fields: [{ field: "source", message: "source is required" }],
      },
    ],
    [
      "every required field omitted",
      {},
      {
        message: "Some fields need your attention before you can continue.",
        fields: [
          { field: "source", message: "source is required" },
          { field: "label", message: "label is required" },
        ],
      },
    ],
    [
      "several fields at once",
      { source: "nope" },
      {
        message: "Some fields need your attention before you can continue.",
        fields: [
          { field: "source", message: "source is invalid" },
          { field: "label", message: "label is required" },
        ],
      },
    ],
    [
      "a non-object body",
      [],
      {
        message: "This field is invalid",
        fields: [{ field: "(form)", message: "This field is invalid" }],
      },
    ],
  ])("%s → 400 VALIDATION_ERROR with the pinned body", async (_label, body, expected) => {
    const res = await request(app).post("/parse").send(body);
    expect(res.status).toBe(400);
    expect(withoutCorrelation(res.body)).toEqual({
      success: false,
      error: {
        code: "VALIDATION_ERROR",
        message: expected.message,
        details: { fields: expected.fields },
      },
    });
  });

  it("applies defaults and admits an omitted optional z.unknown() key", async () => {
    const res = await request(app).post("/parse").send({ source: "github", label: "ok" });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      source: "github",
      label: "ok",
      syncEnabled: false,
      syncIntervalMinutes: expect.any(Number),
    });
    expect("filter" in res.body.data).toBe(false);
  });

  it("a preview body with no filter key still parses", async () => {
    const res = await request(parsingApp(importPreviewRequestSchema))
      .post("/parse")
      .send({ source: "linear" });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ source: "linear" });
  });
});

describe("{ issues: flatten() } 400s", () => {
  function evalApp() {
    const app = express();
    app.use("/api/eval/online", onlineEvalRouter({ resultsDir: "/nonexistent-zod4-pin" }));
    app.use(errorHandler);
    return app;
  }

  it.each([["abc"], ["0"], ["366"], ["1.5"]])(
    "GET /windows?days=%s → 400 VALIDATION_ERROR naming `days`",
    async (days) => {
      const res = await request(evalApp()).get(`/api/eval/online/windows?days=${days}`);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
      expect(res.body.error.message).toBe("Invalid query");
      const issues = res.body.error.details.issues;
      expect(issues.formErrors).toEqual([]);
      expect(Object.keys(issues.fieldErrors)).toEqual(["days"]);
      expect(issues.fieldErrors.days).toHaveLength(1);
      expect(typeof issues.fieldErrors.days[0]).toBe("string");
    },
  );

  it("GET /windows with no days applies the default and coerces a numeric string", async () => {
    for (const q of ["", "?days=30"]) {
      const res = await request(evalApp()).get(`/api/eval/online/windows${q}`);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ windows: [] });
    }
  });

  function agentsApp() {
    const app = express();
    app.use(express.json());
    app.use("/api/agents", agentsRouter());
    app.use(errorHandler);
    return app;
  }

  it.each([
    ["source too short and key malformed", { source: "ab", key: "-bad" }, ["source", "key"]],
    ["source missing", {}, ["source"]],
    ["wrong types", { source: 5, defaultSkillKeys: "x" }, ["source", "defaultSkillKeys"]],
  ])("POST /api/agents with %s → 400 naming exactly those fields", async (_l, body, fields) => {
    const res = await request(agentsApp()).post("/api/agents").send(body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(res.body.error.message).toBe("Invalid agent payload");
    const issues = res.body.error.details.issues;
    expect(issues.formErrors).toEqual([]);
    expect(Object.keys(issues.fieldErrors).sort()).toEqual([...fields].sort());
    for (const f of fields) expect(issues.fieldErrors[f].length).toBeGreaterThan(0);
  });

  it("a non-object agent body → 400 with a form-level error", async () => {
    const res = await request(agentsApp())
      .post("/api/agents")
      .set("content-type", "application/json")
      .send("[1]");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    const issues = res.body.error.details.issues;
    expect(issues.fieldErrors).toEqual({});
    expect(issues.formErrors).toHaveLength(1);
  });
});

describe("more 400 shapes and parse semantics", () => {
  function mounted(prefix: string, router: express.Router) {
    const app = express();
    app.use(express.json());
    app.use(prefix, router);
    app.use(errorHandler);
    return app;
  }

  it("PUT /api/admin/config/:key with no value → 400 INVALID_BODY, `value is required`", async () => {
    const res = await request(mounted("/api/admin/config", configRouter()))
      .put("/api/admin/config/SCHEDULER_TICK_INTERVAL_MS")
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_BODY");
    expect(res.body.error.details.issues).toEqual({
      formErrors: [],
      fieldErrors: { value: ["value is required"] },
    });
  });

  it("POST /api/workspaces with a bad body → 400 VALIDATION_ERROR with an issues ARRAY", async () => {
    const res = await request(mounted("/api/workspaces", workspacesRouter()))
      .post("/api/workspaces")
      .send({ name: "" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    const issues = res.body.error.details.issues as Array<{
      path: string[];
      code: string;
      message: string;
    }>;
    expect(Array.isArray(issues)).toBe(true);
    expect(issues.map((i) => i.path.join(".")).sort()).toEqual(["name", "slug"]);
    for (const i of issues) {
      expect(typeof i.code).toBe("string");
      expect(typeof i.message).toBe("string");
    }
  });

  it("a retrieve body without k leaves k undefined (no default fires)", () => {
    const parsed = retrieveQuerySchema.parse({ query: "rates" });
    expect(parsed).toEqual({ query: "rates" });
    expect(parsed.k).toBeUndefined();
  });

  it("a reconciliation requestId keeps accepting any UUID-shaped key", () => {
    const base = {
      targetId: "u-1",
      username: "someone",
      expectedFingerprint: "a".repeat(64),
      decision: "keep-explicit",
      reason: "reviewed by the operator",
    };
    // Version nibble 9 and variant nibble c: not RFC 9562, UUID-shaped all the same.
    for (const requestId of [
      "123e4567-e89b-12d3-a456-426614174000",
      "123e4567-e89b-92d3-c456-426614174000",
    ]) {
      expect(reconciliationSchema.safeParse({ ...base, requestId }).success).toBe(true);
    }
    expect(reconciliationSchema.safeParse({ ...base, requestId: "not-a-uuid" }).success).toBe(
      false,
    );
  });
});
