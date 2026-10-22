import { runtimeConfigScript } from "@/lib/socket-url";

/**
 * #1377 — runtime settings for the browser, read from the UI server's environment
 * on EVERY request rather than inlined into the bundle by `next build`.
 *
 * The root layout loads this before the app hydrates (`next/script`,
 * `beforeInteractive`), so `socket-client.ts` can read the Socket.IO URL
 * synchronously. Today it carries one value, `METIS_BROWSER_SOCKET_URL`; unset (the
 * Helm default) the browser dials its own origin, which the ingress routes to the
 * server. Public by design — it holds no secrets — and allow-listed in `proxy.ts`
 * so the login page gets a script rather than a redirect.
 */
export const dynamic = "force-dynamic";

export function GET(): Response {
  return new Response(runtimeConfigScript(process.env), {
    status: 200,
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
