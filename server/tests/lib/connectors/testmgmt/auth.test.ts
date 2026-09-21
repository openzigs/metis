/**
 * Tests for the test-management auth header builders + Xray JWT exchange
 * (Epic #856 / Issue #871).
 */
import { describe, expect, it, vi } from "vitest";
import {
  authenticateXray,
  buildBasicAuthHeader,
  buildBearerHeader,
} from "../../../../src/lib/connectors/testmgmt/auth.js";
import { ConnectorError } from "../../../../src/lib/connectors/types.js";

describe("buildBasicAuthHeader", () => {
  it("encodes email:apiKey as base64 with Basic prefix", () => {
    const h = buildBasicAuthHeader("qa@example.com", "secret-123");
    expect(h.startsWith("Basic ")).toBe(true);
    const decoded = Buffer.from(h.slice("Basic ".length), "base64").toString("utf8");
    expect(decoded).toBe("qa@example.com:secret-123");
  });

  it("throws when email or apiKey is empty", () => {
    expect(() => buildBasicAuthHeader("", "k")).toThrow(ConnectorError);
    expect(() => buildBasicAuthHeader("e@x.com", "")).toThrow(ConnectorError);
  });
});

describe("buildBearerHeader", () => {
  it("prefixes Bearer", () => {
    expect(buildBearerHeader("jwt.abc.def")).toBe("Bearer jwt.abc.def");
  });

  it("throws on empty token", () => {
    expect(() => buildBearerHeader("")).toThrow(ConnectorError);
  });
});

describe("authenticateXray", () => {
  it("POSTs JSON client_id + client_secret to /api/v2/authenticate and strips JSON quotes", async () => {
    const fetchFn = vi.fn(async (_url: string | URL, _init?: unknown) => ({
      ok: true,
      status: 200,
      text: async () => '"eyJhbGciOiJIUzI1NiJ9.payload.sig"',
    }));
    const token = await authenticateXray(
      "https://xray.cloud.getxray.app",
      "cid",
      "csecret",
      fetchFn,
    );
    expect(token).toBe("eyJhbGciOiJIUzI1NiJ9.payload.sig");
    expect(fetchFn).toHaveBeenCalledOnce();
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(String(url)).toBe("https://xray.cloud.getxray.app/api/v2/authenticate");
    expect((init as { method?: string }).method).toBe("POST");
    expect((init as { headers?: Record<string, string> }).headers?.["Content-Type"]).toBe(
      "application/json",
    );
    expect(JSON.parse((init as { body: string }).body)).toEqual({
      client_id: "cid",
      client_secret: "csecret",
    });
  });

  it("accepts an unquoted plain JWT response", async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => "plain.jwt.value",
    }));
    const token = await authenticateXray("https://x", "a", "b", fetchFn);
    expect(token).toBe("plain.jwt.value");
  });

  it("strips a trailing slash from baseUrl before appending the path", async () => {
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200, text: async () => '"t"' }));
    await authenticateXray("https://xray.example.com/", "a", "b", fetchFn);
    expect(String(fetchFn.mock.calls[0]![0])).toBe("https://xray.example.com/api/v2/authenticate");
  });

  it("wraps non-2xx responses in a ConnectorError", async () => {
    const fetchFn = vi.fn(async () => ({
      ok: false,
      status: 401,
      text: async () => "bad credentials",
    }));
    await expect(authenticateXray("https://x", "a", "b", fetchFn)).rejects.toBeInstanceOf(
      ConnectorError,
    );
  });

  it("throws when baseUrl, clientId or clientSecret is empty", async () => {
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200, text: async () => "" }));
    await expect(authenticateXray("", "a", "b", fetchFn)).rejects.toBeInstanceOf(ConnectorError);
    await expect(authenticateXray("https://x", "", "b", fetchFn)).rejects.toBeInstanceOf(
      ConnectorError,
    );
    await expect(authenticateXray("https://x", "a", "", fetchFn)).rejects.toBeInstanceOf(
      ConnectorError,
    );
  });
});
