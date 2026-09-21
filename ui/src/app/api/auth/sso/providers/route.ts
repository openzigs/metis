import type { NextRequest } from "next/server";
import { proxyAuth } from "@/lib/auth-proxy";

/**
 * Public SSO providers list for the login page (#429).
 *
 * The generic `/api/[...path]` proxy refuses every `/api/auth/*` path ("Use
 * /api/auth/*"), so the configured-providers call from `sso-buttons.tsx` 404'd
 * at the Next layer and never reached the Express route (which itself returns
 * the correct safe `{ id, label, type, loginUrl }` projection). This bespoke
 * handler forwards the request upstream like the other `/api/auth/*` handlers.
 * Pre-auth + token-free, so no cookie/envelope handling is needed.
 */
export async function GET(request: NextRequest) {
  return proxyAuth(request, "sso/providers");
}
