import { NextResponse, type NextRequest } from "next/server";
import { ACCESS_COOKIE, REFRESH_COOKIE } from "@/lib/config";
import { applyRotatedCookies, isRetryableRefreshStatus, refreshUpstream } from "@/lib/edge-auth";

const PUBLIC_PATHS = new Set(["/login"]);
// `/invites/<token>` is the workspace-invitation landing page. Its audience is
// by definition signed out, and both server routes behind it
// (`GET /api/workspaces/invites/:token` and `POST …/accept`) are deliberately
// unauthenticated — gating the page here bounced every invitee to /login.
const PUBLIC_PREFIXES = ["/_next", "/favicon", "/api/auth/", "/invites/"];

/** Served when the session refresh failed transiently; reloads itself shortly. */
const RETRY_PAGE =
  '<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="2">' +
  "<title>Reconnecting</title><p>Reconnecting to Metis…</p>";

/**
 * Auth gate. Lets authenticated requests through; for a request whose
 * short-lived access cookie has lapsed it attempts a proxy-side token refresh
 * before bouncing, and only redirects truly-unauthenticated visitors to /login
 * (preserving the originally requested path as `?next=`).
 *
 * #274 — this is Next 16's `proxy` file convention (formerly `middleware.ts`).
 * Proxy runs on the Node.js runtime; nothing here needed the Edge runtime —
 * `lib/edge-auth.ts` uses `fetch` and the NextResponse cookie API, which Node
 * provides — and a proxy file may not set `runtime` at all.
 */
export async function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;

  if (PUBLIC_PATHS.has(pathname)) return NextResponse.next();
  if (PUBLIC_PREFIXES.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  // A live access cookie → let the request through unchanged.
  if (request.cookies.get(ACCESS_COOKIE)?.value) {
    return NextResponse.next();
  }

  // #409 — the access cookie (`metis.at`, 1h) is absent/expired but the refresh
  // cookie (`metis.rt`, 7d) may still be valid. Attempt an edge-side refresh
  // BEFORE deciding to redirect, so a user who merely stepped away for >1h is
  // silently renewed instead of bounced to /login. On success we forward the
  // request and set the rotated cookies on the response (no redirect, no flash
  // of /login); only a genuine refresh failure falls through to the redirect.
  // #582 — the server rotates a refresh token exactly once, so this call is
  // single-flight per token within the process (see `refreshUpstreamTokens`):
  // parallel page requests share one refresh and set the same rotated cookies.
  const refreshValue = request.cookies.get(REFRESH_COOKIE)?.value;
  const refreshed = await refreshUpstream(refreshValue);
  if (refreshed?.tokens) {
    const response = NextResponse.next();
    applyRotatedCookies(response, refreshed.tokens);
    return response;
  }
  // #582 — a 5xx refusal (e.g. the server's 503 `REFRESH_UNAVAILABLE`, which
  // hands the refresh token back) is not an expired session: answer 503 and
  // reload shortly instead of sending the user to /login.
  if (refreshed && isRetryableRefreshStatus(refreshed.status)) {
    return new NextResponse(RETRY_PAGE, {
      status: 503,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Retry-After": refreshed.retryAfter ?? "2",
        "Cache-Control": "no-store",
      },
    });
  }

  // No (or invalid/expired) session → bounce to /login, preserving the path.
  const loginUrl = request.nextUrl.clone();
  loginUrl.pathname = "/login";
  loginUrl.search = "";
  if (pathname !== "/") {
    loginUrl.searchParams.set("next", pathname + (search ?? ""));
  }
  // #411 — if a refresh cookie WAS present but the refresh failed, the session
  // genuinely expired (vs. a never-logged-in visitor with no cookies at all), so
  // flag `reason=expired`. This is what surfaces the "Your session expired"
  // banner on a hard reload or an in-app <Link> navigation — the cases the
  // client `onRefreshFailure` handler can't see (it only fires for in-app
  // fetches). A visitor with no refresh cookie gets a bare /login?next (no banner).
  if (refreshValue) {
    loginUrl.searchParams.set("reason", "expired");
  }
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: [
    /*
     * Match every path except Next.js internals, static assets, and ALL `/api/*`
     * routes. The handler itself short-circuits the public + auth-proxy paths so
     * the redirect never fires for those.
     *
     * `/api/*` is excluded deliberately: when the proxy runs on a route, Next
     * buffers the incoming request body up to `proxyClientMaxBodySize`
     * (default 10 MB) before the route handler sees it. That truncated the
     * streaming upload proxy (`api/[...path]/route.ts`) for any .zip larger than
     * 10 MB, so busboy on the Express side failed with "Unexpected end of form"
     * (the server's own cap is 50 MiB — MAX_UPLOAD_ARCHIVE_BYTES). The proxy
     * already authenticates every call by injecting the cookie-derived Bearer
     * token and the Express server is the real authz boundary, so the proxy has
     * no job on API routes — excluding them restores true streaming with no size
     * cap beyond the server's, and an unauthenticated API call now returns a
     * 401 JSON envelope instead of a 302 redirect to the HTML login page.
     */
    "/((?!api|_next/static|_next/image|favicon.ico|.*\\.(?:png|svg|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
