import { NextResponse, type NextRequest } from "next/server";
import { ACCESS_COOKIE, REFRESH_COOKIE } from "@/lib/config";
import { applyRotatedCookies, refreshUpstreamTokens } from "@/lib/edge-auth";

const PUBLIC_PATHS = new Set(["/login"]);
// `/invites/<token>` is the workspace-invitation landing page. Its audience is
// by definition signed out, and both server routes behind it
// (`GET /api/workspaces/invites/:token` and `POST …/accept`) are deliberately
// unauthenticated — gating the page here bounced every invitee to /login.
const PUBLIC_PREFIXES = ["/_next", "/favicon", "/api/auth/", "/invites/"];

/**
 * Edge auth gate. Lets authenticated requests through; for a request whose
 * short-lived access cookie has lapsed it attempts an edge-side token refresh
 * before bouncing, and only redirects truly-unauthenticated visitors to /login
 * (preserving the originally requested path as `?next=`).
 */
export async function middleware(request: NextRequest) {
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
  const refreshValue = request.cookies.get(REFRESH_COOKIE)?.value;
  const rotated = await refreshUpstreamTokens(refreshValue);
  if (rotated) {
    const response = NextResponse.next();
    applyRotatedCookies(response, rotated);
    return response;
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
     * `/api/*` is excluded deliberately: when middleware runs on a route, Next
     * buffers the incoming request body up to `middlewareClientMaxBodySize`
     * (default 10 MB) before the route handler sees it. That truncated the
     * streaming upload proxy (`api/[...path]/route.ts`) for any .zip larger than
     * 10 MB, so busboy on the Express side failed with "Unexpected end of form"
     * (the server's own cap is 50 MiB — MAX_UPLOAD_ARCHIVE_BYTES). The proxy
     * already authenticates every call by injecting the cookie-derived Bearer
     * token and the Express server is the real authz boundary, so middleware has
     * no job on API routes — excluding them restores true streaming with no size
     * cap beyond the server's, and an unauthenticated API call now returns a
     * 401 JSON envelope instead of a 302 redirect to the HTML login page.
     */
    "/((?!api|_next/static|_next/image|favicon.ico|.*\\.(?:png|svg|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
