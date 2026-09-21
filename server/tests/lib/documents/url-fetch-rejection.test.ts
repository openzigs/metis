/**
 * Issue #1084 — the document-ingest SSRF guard must not double as a
 * reconnaissance oracle.
 *
 * `UrlFetchError` deliberately carries the resolved address / range
 * classification so operators can debug a block from the server logs. This
 * suite pins the boundary contract: everything the *caller* can observe about
 * a network-determined rejection collapses to one status, one code, one
 * message — while the detail survives in the structured log.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock("../../../src/lib/logger.js", () => ({
  createChildLogger: () => ({
    warn,
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

import {
  collapseUrlFetchRejection,
  URL_REJECTED_CODE,
  URL_REJECTED_MESSAGE,
  URL_REJECTED_STATUS,
} from "../../../src/lib/documents/url-fetch-rejection.js";
import { UrlFetchError } from "../../../src/lib/documents/url-fetcher.js";

const CONTEXT = { url: "https://internal-db.corp.local/", projectId: "proj_1" };

/** Every rejection whose outcome is decided by the target's network state. */
const NETWORK_DETERMINED: UrlFetchError[] = [
  new UrlFetchError(
    403,
    "PRIVATE_HOST_BLOCKED",
    "Host resolves to 10.1.2.3 which is in non-routable range (rfc1918)",
  ),
  new UrlFetchError(
    403,
    "PRIVATE_HOST_BLOCKED",
    "Hostname 'internal-db.corp.local' resolves to private/loopback IP 169.254.169.254",
  ),
  new UrlFetchError(
    403,
    "HOST_NOT_ALLOWED",
    "Hostname 'internal-db.corp.local' is not in INGEST_URL_ALLOWLIST",
  ),
  new UrlFetchError(
    502,
    "DNS_FAILURE",
    "DNS lookup failed for internal-db.corp.local: queryA ENOTFOUND",
  ),
  new UrlFetchError(502, "FETCH_FAILED", "URL fetch failed: connect ECONNREFUSED 10.1.2.3:443"),
];

beforeEach(() => {
  warn.mockClear();
});

describe("collapseUrlFetchRejection", () => {
  it("returns one identical status/code/message for every network-determined rejection", () => {
    const collapsed = NETWORK_DETERMINED.map((err) => collapseUrlFetchRejection(err, CONTEXT));
    for (const app of collapsed) {
      expect(app.statusCode).toBe(URL_REJECTED_STATUS);
      expect(app.code).toBe(URL_REJECTED_CODE);
      expect(app.message).toBe(URL_REJECTED_MESSAGE);
      expect(app.details).toBeUndefined();
    }
    // The point of the exercise: no caller-visible field varies with *why*.
    const shapes = new Set(
      collapsed.map((a) => JSON.stringify([a.statusCode, a.code, a.message, a.details ?? null])),
    );
    expect(shapes.size).toBe(1);
  });

  it("leaks no address, hostname, or range classification into the caller-visible message", () => {
    for (const err of NETWORK_DETERMINED) {
      const app = collapseUrlFetchRejection(err, CONTEXT);
      const visible = `${app.code} ${app.message}`;
      expect(visible).not.toMatch(/\d{1,3}(\.\d{1,3}){3}/); // no IPv4 literal
      expect(visible).not.toContain("internal-db.corp.local");
      expect(visible).not.toContain("rfc1918");
      expect(visible).not.toContain("INGEST_URL_ALLOWLIST");
      expect(visible.toLowerCase()).not.toContain("dns");
      expect(visible.toLowerCase()).not.toContain("private");
    }
  });

  it("keeps the full detail server-side in a structured log", () => {
    collapseUrlFetchRejection(NETWORK_DETERMINED[0], CONTEXT);
    expect(warn).toHaveBeenCalledTimes(1);
    const [, meta] = warn.mock.calls[0] as [string, Record<string, unknown>];
    expect(meta.code).toBe("PRIVATE_HOST_BLOCKED");
    expect(meta.status).toBe(403);
    expect(String(meta.reason)).toContain("10.1.2.3");
    expect(meta.url).toBe(CONTEXT.url);
    expect(meta.projectId).toBe("proj_1");
  });

  it("passes through rejections that carry no network detail", () => {
    const cases: Array<[number, string]> = [
      [413, "RESPONSE_TOO_LARGE"],
      [415, "MIME_NOT_ALLOWED"],
      [415, "MISSING_CONTENT_TYPE"],
      [504, "FETCH_TIMEOUT"],
      [400, "UNSUPPORTED_SCHEME"],
      [400, "URL_HAS_CREDENTIALS"],
    ];
    for (const [status, code] of cases) {
      const app = collapseUrlFetchRejection(new UrlFetchError(status, code, "detail"), CONTEXT);
      expect(app.statusCode).toBe(status);
      expect(app.code).toBe(code);
      expect(app.message).toBe("detail");
    }
    expect(warn).not.toHaveBeenCalled();
  });
});
