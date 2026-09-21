/**
 * #1065 — central classification of status-carrying error classes.
 *
 * Two properties are under test here:
 *
 *  1. `mapStatusCarryingError` maps the *status* of an "own-status" class
 *     through, and NEVER forwards `err.message` (the #1062 sanitisation
 *     property, made structural rather than per-route).
 *  2. The classification table stays complete: the drift guard at the bottom
 *     re-runs the #1065 sweep over `server/src` and fails if a status-carrying
 *     error class exists that nobody has classified.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  HTTP_STATUS_ERROR_CLASSES,
  genericMessageForStatus,
  mapStatusCarryingError,
  scanForStatusCarryingErrorClasses,
} from "./http-status-errors.js";

/** Build a throwaway error that mimics a real class: `name` + `status` + `code`. */
function fakeError(name: string, fields: Record<string, unknown>): Error {
  const err = new Error("internal detail: resolved to 169.254.169.254");
  err.name = name;
  Object.assign(err, fields);
  return err;
}

describe("mapStatusCarryingError — own-status classes", () => {
  it("maps a ConnectorError 404 through instead of dropping it to a 500", () => {
    const mapped = mapStatusCarryingError(
      fakeError("ConnectorError", { status: 404, code: "JIRA_CONNECTION_NOT_FOUND" }),
    );
    expect(mapped).not.toBeNull();
    expect(mapped?.statusCode).toBe(404);
    expect(mapped?.code).toBe("JIRA_CONNECTION_NOT_FOUND");
  });

  it("maps a JiraApiError 400 through", () => {
    const mapped = mapStatusCarryingError(
      fakeError("JiraApiError", { status: 400, code: "INVALID_URL" }),
    );
    expect(mapped?.statusCode).toBe(400);
    expect(mapped?.code).toBe("INVALID_URL");
  });

  it("reads `statusCode` as well as `status`", () => {
    const mapped = mapStatusCarryingError(
      fakeError("TeamsLinkError", { statusCode: 409, code: "THREAD_TAKEN" }),
    );
    expect(mapped?.statusCode).toBe(409);
  });

  it("NEVER forwards err.message — the message is derived from the status", () => {
    const mapped = mapStatusCarryingError(
      fakeError("ConnectorError", { status: 403, code: "HOST_NOT_ALLOWED" }),
    );
    expect(mapped?.message).toBe(genericMessageForStatus(403));
    expect(mapped?.message).not.toContain("169.254.169.254");
  });

  it("replaces a free-text `code` with a status-derived fallback", () => {
    // A code that is not a bare SCREAMING_SNAKE identifier could smuggle the
    // very detail the message policy strips, so it is not echoed.
    const mapped = mapStatusCarryingError(
      fakeError("ConnectorError", { status: 403, code: "blocked host 10.1.2.3" }),
    );
    expect(mapped?.code).toBe("FORBIDDEN");
  });

  it("derives a fallback code per status when the class carries none", () => {
    const codeFor = (status: number) =>
      mapStatusCarryingError(fakeError("ConnectorError", { status }))?.code;
    expect(codeFor(400)).toBe("BAD_REQUEST");
    expect(codeFor(401)).toBe("AUTH_REQUIRED");
    expect(codeFor(403)).toBe("FORBIDDEN");
    expect(codeFor(404)).toBe("NOT_FOUND");
    expect(codeFor(409)).toBe("CONFLICT");
    expect(codeFor(429)).toBe("RATE_LIMITED");
    expect(codeFor(422)).toBe("BAD_REQUEST"); // other 4xx
    expect(codeFor(502)).toBe("UPSTREAM_ERROR"); // any 5xx
  });
});

describe("mapStatusCarryingError — refusals", () => {
  it("returns null for an upstream-status class so it stays a 500", () => {
    // `SqlLineageClientError.status` is the *sidecar's* status, not ours.
    expect(mapStatusCarryingError(fakeError("SqlLineageClientError", { status: 429 }))).toBeNull();
    expect(mapStatusCarryingError(fakeError("SmitheryError", { status: 404 }))).toBeNull();
    expect(mapStatusCarryingError(fakeError("EmbeddingsClientError", { status: 401 }))).toBeNull();
  });

  it("returns null for an unclassified error name, even if it looks the part", () => {
    expect(
      mapStatusCarryingError(fakeError("TotallyNewError", { status: 418, code: "TEAPOT" })),
    ).toBeNull();
  });

  it("returns null for a plain object that merely mimics the shape", () => {
    // Guards against a JSON body being thrown/forwarded as an "error".
    expect(
      mapStatusCarryingError({ name: "ConnectorError", status: 403, code: "HOST_NOT_ALLOWED" }),
    ).toBeNull();
  });

  it("returns null for a prototype-chain name like `toString`", () => {
    expect(mapStatusCarryingError(fakeError("toString", { status: 403, code: "X" }))).toBeNull();
    expect(mapStatusCarryingError(fakeError("constructor", { status: 403, code: "X" }))).toBeNull();
  });

  it("returns null for a status outside 400–599 or a non-integer status", () => {
    expect(mapStatusCarryingError(fakeError("ConnectorError", { status: 200 }))).toBeNull();
    expect(mapStatusCarryingError(fakeError("ConnectorError", { status: 600 }))).toBeNull();
    expect(mapStatusCarryingError(fakeError("ConnectorError", { status: 404.5 }))).toBeNull();
    expect(mapStatusCarryingError(fakeError("ConnectorError", { status: "404" }))).toBeNull();
    expect(mapStatusCarryingError(fakeError("ConnectorError", {}))).toBeNull();
  });

  it("returns null for a non-error value", () => {
    expect(mapStatusCarryingError(null)).toBeNull();
    expect(mapStatusCarryingError("boom")).toBeNull();
  });
});

describe("genericMessageForStatus", () => {
  it("gives a distinct, detail-free sentence per common status", () => {
    for (const status of [400, 401, 403, 404, 409, 413, 429, 451, 500, 502, 503]) {
      const message = genericMessageForStatus(status);
      expect(message.length).toBeGreaterThan(0);
      expect(message).not.toMatch(/\d+\.\d+\.\d+\.\d+/); // no addresses
      expect(message).not.toContain("/"); // no paths
    }
    expect(genericMessageForStatus(404)).not.toBe(genericMessageForStatus(403));
  });
});

// ── Drift guard ────────────────────────────────────────────────────────────
//
// #1065's sweep is only useful if it stays done. Re-run it against the real
// source tree and fail if a status-carrying error class is unclassified.

const SERVER_SRC = fileURLToPath(new URL("..", import.meta.url));

/** Every `.ts` file under `server/src`, excluding test files. */
function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, acc);
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) acc.push(full);
  }
  return acc;
}

describe("classification drift guard (#1065)", () => {
  it("classifies every status-carrying error class in server/src", () => {
    const found = new Set<string>();
    for (const file of sourceFiles(SERVER_SRC)) {
      for (const name of scanForStatusCarryingErrorClasses(readFileSync(file, "utf8"))) {
        found.add(name);
      }
    }
    // Sanity: the sweep must actually find the classes #1065 named, otherwise a
    // broken scanner would make this guard vacuously pass.
    expect(found).toContain("ConnectorError");
    expect(found).toContain("JiraApiError");

    const unclassified = [...found]
      .filter((n) => n !== "AppError")
      .filter((n) => !Object.prototype.hasOwnProperty.call(HTTP_STATUS_ERROR_CLASSES, n))
      .sort();
    expect(unclassified).toEqual([]);
  });

  it("does not classify names that no longer exist in the source", () => {
    const found = new Set<string>();
    for (const file of sourceFiles(SERVER_SRC)) {
      for (const name of scanForStatusCarryingErrorClasses(readFileSync(file, "utf8"))) {
        found.add(name);
      }
    }
    const stale = Object.keys(HTTP_STATUS_ERROR_CLASSES)
      .filter((n) => !found.has(n))
      .sort();
    expect(stale).toEqual([]);
  });
});

describe("scanForStatusCarryingErrorClasses", () => {
  it("finds an exported class with a constructor-parameter status", () => {
    const src = [
      "export class WidgetError extends Error {",
      "  constructor(",
      "    public readonly status: number,",
      "    public readonly code: string,",
      "    message: string,",
      "  ) {",
      "    super(message);",
      "  }",
      "}",
    ].join("\n");
    expect(scanForStatusCarryingErrorClasses(src)).toEqual(["WidgetError"]);
  });

  it("finds a non-exported class with a declared statusCode field", () => {
    const src = [
      "class WidgetError extends Error {",
      "  readonly statusCode: number;",
      "  constructor() {",
      "    super('x');",
      "    this.statusCode = 500;",
      "  }",
      "}",
    ].join("\n");
    expect(scanForStatusCarryingErrorClasses(src)).toEqual(["WidgetError"]);
  });

  it("finds a class whose status is a literal initialiser, not a type annotation", () => {
    // The shape used by CostCapExceededError, GateUnmetError, BudgetExceededError
    // and four others. An earlier scanner only matched `status: number` and so
    // passed vacuously over all of them.
    const src = [
      "export class WidgetError extends Error {",
      "  readonly status = 429;",
      "  readonly code = 'CAPPED';",
      "}",
    ].join("\n");
    expect(scanForStatusCarryingErrorClasses(src)).toEqual(["WidgetError"]);
  });

  it("ignores a `status2`-style near-miss field name", () => {
    const src = ["export class WidgetError extends Error {", "  readonly status2 = 429;", "}"].join(
      "\n",
    );
    expect(scanForStatusCarryingErrorClasses(src)).toEqual([]);
  });

  it("ignores an error class with no HTTP status", () => {
    const src = "export class WidgetError extends Error {}\nexport class B extends Error {}";
    expect(scanForStatusCarryingErrorClasses(src)).toEqual([]);
  });

  it("ignores a `status` that is not a number", () => {
    const src = [
      "export class WidgetError extends Error {",
      "  readonly status: string;",
      "}",
    ].join("\n");
    expect(scanForStatusCarryingErrorClasses(src)).toEqual([]);
  });
});
