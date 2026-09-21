/**
 * Global error handler — AppError, ZodError → friendly 400 (#426), and the
 * 500 fallback. The ZodError mapping is the OWASP A09 (info-leak) guard: a raw
 * `ZodError` escaping any route MUST surface as a friendly 400 envelope, never
 * a 500 with the raw issues array.
 */
import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { z } from "zod";
// Real classes, deliberately only the dependency-light ones: this stays a unit
// test of the middleware. The full classification table is exercised against
// the source tree by http-status-errors.test.ts.
import { SqlLineageClientError } from "../lib/code-graph/sql-lineage-client.js";
import { JiraApiError } from "../lib/connectors/jira/jira-errors.js";
import { ConnectorError } from "../lib/connectors/types.js";
import { AppError, errorHandler, zodErrorToFriendly } from "./error-handler.js";
import { genericMessageForStatus } from "./http-status-errors.js";

/** Build a tiny app whose single route throws `thrown`, behind the handler. */
function appThatThrows(thrown: unknown) {
  const app = express();
  app.use(express.json());
  app.get("/boom", (_req, _res) => {
    throw thrown;
  });
  app.use(errorHandler);
  return app;
}

const schema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  state: z.enum(["open", "closed", "all"]).default("open"),
});

/** Capture the ZodError produced by parsing an invalid payload. */
function zodErrorFor(input: unknown): z.ZodError {
  try {
    schema.parse(input);
  } catch (err) {
    return err as z.ZodError;
  }
  throw new Error("expected schema.parse to throw");
}

describe("errorHandler — ZodError → friendly 400 (#426)", () => {
  it("maps a raw ZodError to a 400 (never a 500)", async () => {
    const res = await request(appThatThrows(zodErrorFor({ owner: "", repo: "" }))).get("/boom");
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("returns a safe { field, message } summary under details.fields", async () => {
    const res = await request(appThatThrows(zodErrorFor({ owner: "", repo: "" }))).get("/boom");
    const fields = res.body.error.details.fields as Array<{ field: string; message: string }>;
    expect(fields).toEqual(
      expect.arrayContaining([
        { field: "owner", message: "owner is required" },
        { field: "repo", message: "repo is required" },
      ]),
    );
  });

  it("leaks NO raw Zod tokens in the client-facing payload (A09)", async () => {
    const res = await request(appThatThrows(zodErrorFor({ owner: "", repo: "" }))).get("/boom");
    const serialized = JSON.stringify(res.body);
    // The exact tokens the #426 walkthrough saw leaked must NOT appear. Note the
    // friendly envelope legitimately carries a top-level `error.code` of
    // VALIDATION_ERROR, so we assert the raw Zod *issue* shapes, not the bare
    // word "code".
    expect(serialized).not.toContain("too_small");
    expect(serialized).not.toContain("invalid_type");
    expect(serialized).not.toContain('"path":');
    expect(serialized).not.toContain("minimum");
    expect(serialized).not.toContain("ZodError");
    // No raw issue object (which would carry its own nested `"code":"too_..."`).
    expect(serialized).not.toMatch(/"code":"(too_|invalid_)/);
  });

  it("uses the single field message as the top-level message when only one field fails", async () => {
    const res = await request(appThatThrows(zodErrorFor({ owner: "ok", repo: "" }))).get("/boom");
    expect(res.body.error.message).toBe("repo is required");
  });

  it("uses a generic top-level message when multiple fields fail", async () => {
    const res = await request(appThatThrows(zodErrorFor({ owner: "", repo: "" }))).get("/boom");
    expect(res.body.error.message).toMatch(/some fields need your attention/i);
  });

  it("deduplicates multiple issues on the same field", () => {
    const err = zodErrorFor({ owner: 123, repo: "" });
    const friendly = zodErrorToFriendly(err);
    const ownerEntries = friendly.fields.filter((f) => f.field === "owner");
    expect(ownerEntries).toHaveLength(1);
  });

  it("labels a too-long field as too long", () => {
    const longSchema = z.object({ name: z.string().max(2) });
    const friendly = zodErrorToFriendly(zodErrorFor2(longSchema, { name: "toolong" }));
    expect(friendly.fields[0]).toEqual({ field: "name", message: "name is too long" });
  });

  it("labels a too-short (min>1) field as too short", () => {
    const minSchema = z.object({ name: z.string().min(5) });
    const friendly = zodErrorToFriendly(zodErrorFor2(minSchema, { name: "ab" }));
    expect(friendly.fields[0]).toEqual({ field: "name", message: "name is too short" });
  });

  it("treats a missing (undefined) required field as required", () => {
    const reqSchema = z.object({ name: z.string() });
    const friendly = zodErrorToFriendly(zodErrorFor2(reqSchema, {}));
    expect(friendly.fields[0]).toEqual({ field: "name", message: "name is required" });
  });

  it("labels an out-of-set enum value as invalid", () => {
    const enumSchema = z.object({ state: z.enum(["open", "closed"]) });
    const friendly = zodErrorToFriendly(zodErrorFor2(enumSchema, { state: "weird" }));
    expect(friendly.fields[0]).toEqual({ field: "state", message: "state is invalid" });
  });

  it("labels a wrong-type field as invalid", () => {
    const typeSchema = z.object({ count: z.number() });
    const friendly = zodErrorToFriendly(zodErrorFor2(typeSchema, { count: "x" }));
    expect(friendly.fields[0]).toEqual({ field: "count", message: "count is invalid" });
  });

  it("uses a (form) field + generic label for a root-level (path-less) issue", () => {
    // A refinement on the object root produces an issue with an empty path.
    const rootSchema = z
      .object({ a: z.string().optional(), b: z.string().optional() })
      .refine((v) => v.a !== undefined || v.b !== undefined, { message: "need one" });
    const friendly = zodErrorToFriendly(zodErrorFor2(rootSchema, {}));
    expect(friendly.fields[0]).toEqual({ field: "(form)", message: "This field is invalid" });
  });
});

/** Parse `input` against `schema`, returning the thrown ZodError. */
function zodErrorFor2(schema: z.ZodTypeAny, input: unknown): z.ZodError {
  try {
    schema.parse(input);
  } catch (err) {
    return err as z.ZodError;
  }
  throw new Error("expected schema.parse to throw");
}

describe("errorHandler — AppError + fallback", () => {
  it("renders an AppError with its status, code, message and details", async () => {
    const res = await request(
      appThatThrows(new AppError(403, "FORBIDDEN", "nope", { reason: "x" })),
    ).get("/boom");
    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({
      code: "FORBIDDEN",
      message: "nope",
      details: { reason: "x" },
    });
  });

  it("falls back to a 500 INTERNAL_ERROR for an unknown error", async () => {
    const res = await request(appThatThrows(new Error("kaboom"))).get("/boom");
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe("INTERNAL_ERROR");
  });
});

describe("errorHandler — status-carrying error classes (#1065)", () => {
  it("surfaces a ConnectorError 404 as a 404, not a 500 (#1055)", async () => {
    const res = await request(
      appThatThrows(
        new ConnectorError(404, "JIRA_CONNECTION_NOT_FOUND", "Jira connection not found"),
      ),
    ).get("/boom");
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe("JIRA_CONNECTION_NOT_FOUND");
  });

  it("surfaces a JiraApiError 400 as a 400, not a 500 (#1054)", async () => {
    const res = await request(
      appThatThrows(new JiraApiError(400, "INVALID_URL", "url is not a valid absolute URL")),
    ).get("/boom");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_URL");
  });

  it("does NOT echo a message that embeds a resolved private address (#1062)", async () => {
    // The SSRF allow-list rejection message names the address it resolved to;
    // echoing it would turn the error channel into an internal-network oracle.
    const res = await request(
      appThatThrows(
        new ConnectorError(
          403,
          "HOST_NOT_ALLOWED",
          "jira host metadata.internal resolves to private/loopback address 169.254.169.254 — not on allow-list",
        ),
      ),
    ).get("/boom");
    expect(res.status).toBe(403);
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain("169.254.169.254");
    expect(serialized).not.toContain("metadata.internal");
    expect(res.body.error.message).toBe(genericMessageForStatus(403));
  });

  it("does NOT echo a message that embeds a connection string", async () => {
    const res = await request(
      appThatThrows(
        new ConnectorError(
          500,
          "INTERNAL",
          "connect failed: postgres://metis:hunter2@db.internal:5432/metis",
        ),
      ),
    ).get("/boom");
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain("hunter2");
    expect(serialized).not.toContain("postgres:");
  });

  it("does NOT echo a message that embeds an absolute filesystem path", async () => {
    const res = await request(
      appThatThrows(
        new ConnectorError(404, "REPO_NOT_FOUND", "no checkout at /srv/metis/data/repos/acme"),
      ),
    ).get("/boom");
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain("/srv/metis");
  });

  it("keeps an upstream-status class on the 500 fallback", async () => {
    // `SqlLineageClientError.status` is the sidecar's status, not ours — a 429
    // from the sidecar must not be reported to the caller as their rate limit.
    const res = await request(
      appThatThrows(new SqlLineageClientError("sidecar refused", 429, true)),
    ).get("/boom");
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe("INTERNAL_ERROR");
  });

  it("keeps an unclassified error class on the 500 fallback", async () => {
    class BrandNewError extends Error {
      constructor(
        readonly status: number,
        readonly code: string,
      ) {
        super("nope");
        this.name = "BrandNewError";
      }
    }
    const res = await request(appThatThrows(new BrandNewError(418, "TEAPOT"))).get("/boom");
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe("INTERNAL_ERROR");
  });

  it("echoes the correlation id alongside a mapped status", async () => {
    const app = express();
    app.get("/boom", (req, _res) => {
      (req as unknown as { correlationId?: string }).correlationId = "corr-1";
      throw new ConnectorError(403, "PROJECT_FORBIDDEN", "no");
    });
    app.use(errorHandler);
    const res = await request(app).get("/boom");
    expect(res.status).toBe(403);
    expect(res.body.correlationId).toBe("corr-1");
  });
});
