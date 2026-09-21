/**
 * Test-management auth helpers — Epic #856 / Issue #871.
 *
 * Pure header builders for the three supported providers plus the Xray Cloud
 * JWT exchange. No network I/O happens here except in `authenticateXray` (and
 * even there it goes through an injected `fetch`-shaped function so unit tests
 * can drive it without real HTTP).
 */
import { ConnectorError } from "../types.js";

type FetchLike = (
  input: string | URL,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  text: () => Promise<string>;
}>;

/** Build the HTTP Basic `Authorization` header value for TestRail. */
export function buildBasicAuthHeader(email: string, apiKey: string): string {
  if (!email || !apiKey) {
    throw new ConnectorError(400, "TESTMGMT_AUTH_INCOMPLETE", "email and apiKey are required");
  }
  const token = Buffer.from(`${email}:${apiKey}`, "utf8").toString("base64");
  return `Basic ${token}`;
}

/** Build the HTTP Bearer `Authorization` header value for Zephyr / Xray. */
export function buildBearerHeader(token: string): string {
  if (!token) {
    throw new ConnectorError(400, "TESTMGMT_AUTH_INCOMPLETE", "bearer token is required");
  }
  return `Bearer ${token}`;
}

/**
 * Exchange Xray Cloud client credentials for a short-lived JWT.
 *
 * POST {baseUrl}/api/v2/authenticate
 *   body: {"client_id": "...", "client_secret": "..."}
 *   response: a JSON-quoted string, e.g. `"eyJhbGciOi..."`.
 *
 * The Xray server quotes the JWT inside JSON; we strip those wrapping quotes so
 * callers get a raw bearer value.
 */
export async function authenticateXray(
  baseUrl: string,
  clientId: string,
  clientSecret: string,
  fetchFn: FetchLike,
  signal?: AbortSignal,
): Promise<string> {
  if (!baseUrl || !clientId || !clientSecret) {
    throw new ConnectorError(
      400,
      "TESTMGMT_AUTH_INCOMPLETE",
      "baseUrl, clientId and clientSecret are required for Xray authentication",
    );
  }
  const url = `${baseUrl.replace(/\/+$/, "")}/api/v2/authenticate`;
  const res = await fetchFn(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret }),
    signal,
  });
  const body = await res.text();
  if (!res.ok) {
    throw new ConnectorError(
      502,
      "TESTMGMT_XRAY_AUTH_FAILED",
      `Xray authentication failed (HTTP ${res.status})`,
    );
  }
  // The API returns the JWT as a JSON-quoted string; some self-hosted variants
  // return a plain string. Accept both.
  const trimmed = body.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}
