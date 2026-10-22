/**
 * Generic upstream proxy for non-auth API routes.
 *
 * Matches everything under `/api/*` that does NOT have a more specific
 * route (Next.js prefers exact matches, so `/api/auth/*` continues to use
 * its bespoke proxy). Forwards method, query string, body, and Content-Type
 * verbatim to the Express server while injecting the user's HttpOnly
 * `metis.at` cookie as a `Bearer` Authorization header.
 *
 * Streaming bodies (multipart uploads) are passed through without
 * buffering thanks to `request.body`. The upstream JSON response is
 * forwarded as-is — there's no envelope rewriting because non-auth
 * endpoints don't return tokens.
 */
import { NextResponse, type NextRequest } from "next/server";
import { ACCESS_COOKIE, UPSTREAM_API_BASE } from "@/lib/config";
import { isUnsafeProxySegment, pathBelowUpstreamBase } from "@/lib/proxy-upstream";
import { CSRF_HEADER, rejectCrossOrigin } from "@/lib/csrf-guard";
import { CLIENT_ADDRESS_HEADER, CLIENT_ADDRESS_SIGNATURE_HEADER } from "@/lib/client-address";
import {
  isSpecKitCommandRequest,
  specKitCommandFetch,
  type UpstreamFetch,
  type UpstreamRequestInit,
} from "@/lib/spec-kit-proxy-timeout";

interface RouteCtx {
  params: Promise<{ path?: string[] }>;
}

const NON_FORWARDABLE = new Set([
  "host",
  "connection",
  "content-length", // re-derived by fetch
  // #1385 — only the auth proxy vouches for a client address; a browser's own
  // copy (replayed, say) never reaches the API through here.
  CLIENT_ADDRESS_HEADER,
  CLIENT_ADDRESS_SIGNATURE_HEADER,
]);

const invalidPath = (): NextResponse =>
  NextResponse.json(
    { success: false, error: { code: "BAD_REQUEST", message: "Invalid request path" } },
    { status: 400 },
  );

async function handle(req: NextRequest, ctx: RouteCtx): Promise<NextResponse> {
  const { path = [] } = await ctx.params;

  // #1069 — Next decodes each catch-all segment, so one element can hold `/`,
  // `\` or `?`, and `new URL` would normalise it to another upstream route.
  // Refuse those, then decide everything below from the RESOLVED path.
  if (path.some(isUnsafeProxySegment)) return invalidPath();

  const upstreamUrl = new URL(`${UPSTREAM_API_BASE}/${path.join("/")}`);
  // Never leave the upstream API: `/api/` with the default base.
  const upstreamPath = pathBelowUpstreamBase(upstreamUrl, UPSTREAM_API_BASE);
  if (upstreamPath === null) return invalidPath();

  // #913 — the SAML ACS is served by the API, never through this proxy, and
  // its identity provider posts cross-origin. Say so plainly, ahead of the
  // CSRF refusal an IdP pointed here would otherwise get.
  if (upstreamPath === "auth/saml/acs") {
    return NextResponse.json(
      {
        success: false,
        error: {
          code: "SAML_ACS_WRONG_ORIGIN",
          message:
            "The SAML Assertion Consumer Service is served by the METIS API, not the web app. Point the identity provider's ACS URL at <API origin>/api/auth/saml/acs.",
        },
      },
      { status: 404 },
    );
  }

  // Auth endpoints have their own proxy.
  if (upstreamPath.split("/")[0] === "auth") {
    return NextResponse.json(
      { success: false, error: { code: "NOT_FOUND", message: "Use /api/auth/*" } },
      { status: 404 },
    );
  }

  // #913 — the session cookie becomes a bearer token below, so a forged
  // cross-origin write must be refused here, before it is forwarded.
  const refused = rejectCrossOrigin(req);
  if (refused) return refused;

  const search = req.nextUrl.search;
  if (search) upstreamUrl.search = search;

  const headers = new Headers();
  for (const [k, v] of req.headers.entries()) {
    if (!NON_FORWARDABLE.has(k.toLowerCase())) headers.set(k, v);
  }
  const access = req.cookies.get(ACCESS_COOKIE)?.value;
  if (access) headers.set("Authorization", `Bearer ${access}`);
  // #913 — the request passed the same-origin check above; vouch for it to the
  // API, which demands this header on a cookie-authenticated write.
  headers.set(CSRF_HEADER, "1");

  const init: UpstreamRequestInit = {
    method: req.method,
    headers,
    // Abort the upstream request when the client goes away: an abandoned Spec
    // Kit command would otherwise hold its socket for the whole long timeout.
    signal: req.signal,
  };
  if (req.method !== "GET" && req.method !== "HEAD") {
    // Pass the request body through verbatim — supports multipart uploads.
    init.body = req.body;
    init.duplex = "half";
  }

  // #1069 — a Spec Kit command holds the request open for a whole model call,
  // longer than fetch's default 300 s wait for headers. Only those routes get
  // the longer timeout.
  const send: UpstreamFetch = isSpecKitCommandRequest(req.method, upstreamPath)
    ? specKitCommandFetch()
    : fetch;
  const upstream = await send(upstreamUrl, init);

  const responseHeaders = new Headers();
  upstream.headers.forEach((v, k) => {
    // Strip hop-by-hop headers; Next.js handles its own connection mgmt.
    if (k === "transfer-encoding" || k === "connection") return;
    // undici's fetch transparently decompresses the upstream body, so the
    // bytes we re-emit are NOT compressed. Forwarding the upstream's
    // `content-encoding` (e.g. gzip/br) tricks the browser into trying to
    // decompress an already-decompressed body and fails with
    // ERR_CONTENT_DECODING_FAILED. Drop the encoding marker and the now-
    // stale Content-Length so the response matches the body we send.
    if (k === "content-encoding" || k === "content-length") return;
    responseHeaders.set(k, v);
  });

  return new NextResponse(upstream.body, {
    status: upstream.status,
    headers: responseHeaders,
  });
}

export async function GET(req: NextRequest, ctx: RouteCtx): Promise<NextResponse> {
  return handle(req, ctx);
}
export async function POST(req: NextRequest, ctx: RouteCtx): Promise<NextResponse> {
  return handle(req, ctx);
}
export async function PATCH(req: NextRequest, ctx: RouteCtx): Promise<NextResponse> {
  return handle(req, ctx);
}
export async function PUT(req: NextRequest, ctx: RouteCtx): Promise<NextResponse> {
  return handle(req, ctx);
}
export async function DELETE(req: NextRequest, ctx: RouteCtx): Promise<NextResponse> {
  return handle(req, ctx);
}
