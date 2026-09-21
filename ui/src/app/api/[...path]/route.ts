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

interface RouteCtx {
  params: Promise<{ path?: string[] }>;
}

const NON_FORWARDABLE = new Set([
  "host",
  "connection",
  "content-length", // re-derived by fetch
]);

async function handle(req: NextRequest, ctx: RouteCtx): Promise<NextResponse> {
  const { path = [] } = await ctx.params;

  // Auth endpoints have their own proxy.
  if (path[0] === "auth") {
    return NextResponse.json(
      { success: false, error: { code: "NOT_FOUND", message: "Use /api/auth/*" } },
      { status: 404 },
    );
  }

  const upstreamUrl = new URL(`${UPSTREAM_API_BASE}/${path.join("/")}`);
  const search = req.nextUrl.search;
  if (search) upstreamUrl.search = search;

  const headers = new Headers();
  for (const [k, v] of req.headers.entries()) {
    if (!NON_FORWARDABLE.has(k.toLowerCase())) headers.set(k, v);
  }
  const access = req.cookies.get(ACCESS_COOKIE)?.value;
  if (access) headers.set("Authorization", `Bearer ${access}`);

  const init: RequestInit & { duplex?: "half" } = {
    method: req.method,
    headers,
  };
  if (req.method !== "GET" && req.method !== "HEAD") {
    // Pass the request body through verbatim — supports multipart uploads.
    init.body = req.body;
    init.duplex = "half";
  }

  const upstream = await fetch(upstreamUrl, init);

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
