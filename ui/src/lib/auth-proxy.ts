import { NextResponse, type NextRequest } from "next/server";
import { ACCESS_COOKIE, REFRESH_COOKIE, UPSTREAM_API_BASE } from "@/lib/config";
// Cookie attributes + upstream cookie names live in edge-auth so this proxy and
// the Edge middleware mint byte-identical HttpOnly/SameSite/Secure cookies
// (single source of truth — #409).
import {
  ACCESS_OPTS,
  CLEAR_OPTS,
  REFRESH_OPTS,
  UPSTREAM_ACCESS_COOKIE,
  UPSTREAM_REFRESH_COOKIE,
} from "@/lib/edge-auth";

interface UpstreamData {
  accessToken?: string;
  refreshToken?: string;
  [k: string]: unknown;
}

interface UpstreamEnvelope {
  success?: boolean;
  data?: UpstreamData;
  error?: unknown;
}

/**
 * Proxy a request to the upstream Express auth endpoints.
 *
 * - Forwards method + body verbatim
 * - Translates the Next.js HttpOnly cookies into upstream Cookie + Bearer
 *   headers so the existing requireAuth middleware accepts the request
 * - Strips raw tokens from the JSON returned to the browser; mints fresh
 *   HttpOnly cookies on the Next.js origin instead
 */
export async function proxyAuth(
  request: NextRequest,
  // `sso/providers` (#429) is a PUBLIC, pre-auth GET — it returns no tokens, so
  // the token-stripping/cookie-minting below is a harmless no-op for it. It is
  // routed here (not the generic `[...path]` proxy) because that proxy refuses
  // every `/api/auth/*` path; the bespoke auth handlers own this namespace.
  endpoint: "login" | "logout" | "refresh" | "me" | "sso/providers",
): Promise<NextResponse> {
  const upstreamUrl = `${UPSTREAM_API_BASE}/auth/${endpoint}`;
  const headers: Record<string, string> = { Accept: "application/json" };
  let body: string | undefined;

  if (request.method !== "GET" && request.method !== "HEAD") {
    const text = await request.text();
    if (text) {
      headers["Content-Type"] = "application/json";
      body = text;
    }
  }

  const access = request.cookies.get(ACCESS_COOKIE)?.value;
  const refresh = request.cookies.get(REFRESH_COOKIE)?.value;
  const cookieParts: string[] = [];
  if (access) cookieParts.push(`${UPSTREAM_ACCESS_COOKIE}=${access}`);
  if (refresh) cookieParts.push(`${UPSTREAM_REFRESH_COOKIE}=${refresh}`);
  if (cookieParts.length) headers.Cookie = cookieParts.join("; ");
  if (access) headers.Authorization = `Bearer ${access}`;

  const upstream = await fetch(upstreamUrl, {
    method: request.method,
    headers,
    body,
  });
  const text = await upstream.text();

  let parsed: UpstreamEnvelope | null = null;
  if (text) {
    try {
      parsed = JSON.parse(text) as UpstreamEnvelope;
    } catch {
      parsed = null;
    }
  }

  // Capture token rotations BEFORE we strip them from the body.
  const newAccess = parsed?.data?.accessToken;
  const newRefresh = parsed?.data?.refreshToken;
  if (parsed?.data) {
    const cleaned: UpstreamData = { ...parsed.data };
    delete cleaned.accessToken;
    delete cleaned.refreshToken;
    parsed = { ...parsed, data: cleaned };
  }

  const response = NextResponse.json(parsed ?? { success: upstream.ok }, {
    status: upstream.status,
  });

  if (upstream.ok && newAccess) {
    response.cookies.set(ACCESS_COOKIE, newAccess, ACCESS_OPTS);
  }
  if (upstream.ok && newRefresh) {
    response.cookies.set(REFRESH_COOKIE, newRefresh, REFRESH_OPTS);
  }
  if (endpoint === "logout") {
    response.cookies.set(ACCESS_COOKIE, "", CLEAR_OPTS);
    response.cookies.set(REFRESH_COOKIE, "", CLEAR_OPTS);
  }

  return response;
}
