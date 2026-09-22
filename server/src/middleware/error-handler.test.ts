/**
 * Global error handler — AppError, ZodError → friendly 400 (#426), and the
 * 500 fallback. The ZodError mapping is the OWASP A09 (info-leak) guard: a raw
 * `ZodError` escaping any route MUST surface as a friendly 400 envelope, never
 * a 500 with the raw issues array.
 */
import { Writable } from "node:stream";
import express from "express";
import winston from "winston";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { z } from "zod";
// Real classes, deliberately only the dependency-light ones: this stays a unit
// test of the middleware. The full classification table is exercised against
// the source tree by http-status-errors.test.ts.
import { SqlLineageClientError } from "../lib/code-graph/sql-lineage-client.js";
import { JiraApiError } from "../lib/connectors/jira/jira-errors.js";
import { ConnectorError } from "../lib/connectors/types.js";
import { logger } from "../lib/logger.js";
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

describe("errorHandler — malformed JSON request body → 400 (#21)", () => {
  function jsonApp() {
    const app = express();
    app.use(express.json());
    app.post(["/echo", "/auth/login"], (req, res) => {
      res.json({ success: true, data: req.body });
    });
    app.get("/syntax", () => {
      // A SyntaxError the SERVER raised (e.g. JSON.parse of stored data) is
      // not the client's fault and must stay a 500.
      JSON.parse("{not json");
    });
    app.use(errorHandler);
    return app;
  }

  it("maps a truncated JSON body to 400 INVALID_JSON", async () => {
    const res = await request(jsonApp())
      .post("/echo")
      .set("Content-Type", "application/json")
      .send('{"reviewStatus":');
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      success: false,
      error: { code: "INVALID_JSON", message: "Request body is not valid JSON" },
    });
  });

  it("maps a double-encoded body (a top-level JSON string) to 400 — the #14 shape", async () => {
    const res = await request(jsonApp())
      .post("/echo")
      .set("Content-Type", "application/json")
      .send(JSON.stringify(JSON.stringify({ reviewStatus: "approved" })));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_JSON");
  });

  it("does not echo any fragment of the rejected body back to the client", async () => {
    const res = await request(jsonApp())
      .post("/echo")
      .set("Content-Type", "application/json")
      .send('{"n": s3cr3t}');
    expect(JSON.stringify(res.body)).not.toContain("s3cr3t");
  });

  it("does not write any fragment of the rejected body to the server log", async () => {
    const lines: string[] = [];
    const transport = new winston.transports.Stream({
      stream: new Writable({
        write(chunk, _enc, cb) {
          lines.push(String(chunk));
          cb();
        },
      }),
    });
    logger.add(transport);
    try {
      const res = await request(jsonApp())
        .post("/auth/login")
        .set("Content-Type", "application/json")
        .send('{"p": hunter2}');
      expect(res.status).toBe(400);
    } finally {
      logger.remove(transport);
    }
    const logged = lines.join("");
    expect(logged).toContain("Malformed JSON request body");
    expect(logged).not.toContain("hunter2");
  });

  it("leaves a server-side SyntaxError as a 500", async () => {
    const res = await request(jsonApp()).get("/syntax");
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe("INTERNAL_ERROR");
  });

  it("still accepts a well-formed body", async () => {
    const res = await request(jsonApp()).post("/echo").send({ a: 1 });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ a: 1 });
  });
});

describe("errorHandler — body-parser client errors → 4xx (#35)", () => {
  /** A tiny app with deliberately small parser limits so each error is cheap to provoke. */
  function parserApp() {
    const app = express();
    app.use(express.json({ limit: "10b" }));
    app.use(express.urlencoded({ extended: true, parameterLimit: 2, depth: 1 }));
    app.post("/echo", (req, res) => {
      res.json({ success: true, data: req.body });
    });
    app.use(errorHandler);
    return app;
  }

  /** An `http-errors`-shaped error, as raw-body raises for aborted / short bodies. */
  function bodyParserError(type: string, status: number, message: string) {
    return Object.assign(new Error(message), { type, status, statusCode: status, expose: true });
  }

  it("maps an over-limit JSON body to 413 PAYLOAD_TOO_LARGE, not a 500", async () => {
    const res = await request(parserApp())
      .post("/echo")
      .set("Content-Type", "application/json")
      .send('{"note":"twenty bytes!!"}');
    expect(res.status).toBe(413);
    expect(res.body).toMatchObject({
      success: false,
      error: { code: "PAYLOAD_TOO_LARGE", message: "Request body is too large" },
    });
    expect(JSON.stringify(res.body)).not.toContain("twenty bytes");
  });

  it("maps an unsupported Content-Encoding to 415 UNSUPPORTED_CONTENT_ENCODING", async () => {
    const res = await request(parserApp())
      .post("/echo")
      .set("Content-Type", "application/json")
      .set("Content-Encoding", "x-made-up")
      .send("{}");
    expect(res.status).toBe(415);
    expect(res.body.error.code).toBe("UNSUPPORTED_CONTENT_ENCODING");
    // body-parser's own message quotes the client's header; it is not forwarded.
    expect(JSON.stringify(res.body)).not.toContain("x-made-up");
  });

  it("maps an unsupported charset to 415 UNSUPPORTED_CHARSET without echoing it", async () => {
    const res = await request(parserApp())
      .post("/echo")
      .set("Content-Type", "application/json; charset=koi8-r")
      .send("{}");
    expect(res.status).toBe(415);
    expect(res.body.error.code).toBe("UNSUPPORTED_CHARSET");
    expect(JSON.stringify(res.body).toLowerCase()).not.toContain("koi8");
  });

  it("maps too many form parameters to 413 TOO_MANY_PARAMETERS", async () => {
    const res = await request(parserApp()).post("/echo").type("form").send("a=1&b=2&c=3");
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe("TOO_MANY_PARAMETERS");
  });

  it("maps a form body nested past the depth limit to 400 FORM_BODY_TOO_DEEP", async () => {
    const res = await request(parserApp()).post("/echo").type("form").send("a[b][c][d]=1");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("FORM_BODY_TOO_DEEP");
  });

  it.each([
    ["request.aborted", 400, "REQUEST_ABORTED"],
    ["request.size.invalid", 400, "REQUEST_SIZE_MISMATCH"],
  ])("maps %s to %i %s", async (type, status, code) => {
    const res = await request(appThatThrows(bodyParserError(type, status, "raw detail"))).get(
      "/boom",
    );
    expect(res.status).toBe(status);
    expect(res.body.error.code).toBe(code);
    expect(JSON.stringify(res.body)).not.toContain("raw detail");
  });

  it("keeps an error whose type matches but whose status does not on the 500 fallback", async () => {
    const res = await request(
      appThatThrows(bodyParserError("entity.too.large", 500, "not from body-parser")),
    ).get("/boom");
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe("INTERNAL_ERROR");
  });

  it("logs the rejection as a client error without the body", async () => {
    const lines: string[] = [];
    const transport = new winston.transports.Stream({
      stream: new Writable({
        write(chunk, _enc, cb) {
          lines.push(String(chunk));
          cb();
        },
      }),
    });
    logger.add(transport);
    try {
      const res = await request(parserApp())
        .post("/echo")
        .set("Content-Type", "application/json")
        .send('{"p":"hunter2hunter2"}');
      expect(res.status).toBe(413);
    } finally {
      logger.remove(transport);
    }
    const logged = lines.join("");
    expect(logged).toContain("Rejected request body");
    expect(logged).toContain("entity.too.large");
    expect(logged).not.toContain("Unexpected error");
    expect(logged).not.toContain("hunter2");
  });
});
