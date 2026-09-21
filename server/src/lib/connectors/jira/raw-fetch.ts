/**
 * SSRF-hardened raw-resource fetch for the Jira connector — Issue #1054.
 *
 * `JiraClient.fetchRaw` is reachable from
 * `GET /api/jira/connections/:id/attachment-proxy?url=…`, so the URL is
 * attacker-controlled while the request carries the connection's Jira
 * credential (`Basic base64(email:apiToken)` on Cloud, `Bearer <PAT>` on Data
 * Center). The original guard was a bare prefix check —
 * `absoluteUrl.startsWith(baseUrl)` — which is not an origin check:
 * `https://jira.example.com.attacker.com/collect` and
 * `https://jira.example.com@attacker.com/collect` both satisfy it, and the
 * second one's real host is `attacker.com`.
 *
 * The hardened pipeline, in order:
 *
 *   1. Parse the URL. A parse failure is a rejection (`JiraApiError` 400), not
 *      an escaping `TypeError`.
 *   2. `http:` / `https:` only, and no embedded userinfo — `https://x@host/`
 *      shares an origin with `https://host/`, so the origin check alone would
 *      let credentials-in-URL through.
 *   3. Parsed-**origin equality** against the connection `baseUrl` (scheme +
 *      host + port), replacing the prefix check.
 *   4. `resolveAndAssertConnectorHost(host, "jira")` — the SAME allow-list +
 *      private-range policy `buildClient` already applies to the connection
 *      `baseUrl`, which this path used to bypass entirely. It returns the
 *      validated address, which is pinned into the socket via
 *      `makePinnedDispatcher` so a hostile low-TTL record cannot swap in a
 *      private address between validation and `connect()`.
 *   5. Redirects are followed manually, and steps 1–4 run again on every hop.
 *      The credential is attached **only** when the hop's origin equals the
 *      Jira origin, so a 302 to an attacker host gets an unauthenticated
 *      request. (Jira Cloud legitimately redirects attachment content to a
 *      signed media URL, so hard-refusing redirects would break the feature.)
 *   6. The response size is bounded — up-front from `Content-Length` and again
 *      by a streaming byte counter, since `Content-Length` is upstream-controlled.
 *   7. The reflected `Content-Type` is restricted to an inline-safe allow-list;
 *      everything else is served as `application/octet-stream` with
 *      `Content-Disposition: attachment` so the proxy can never render
 *      attacker-supplied HTML/SVG in the METIS origin.
 */
import { createChildLogger } from "../../logger.js";
import {
  makePinnedDispatcher,
  resolveAndAssertConnectorHost,
  type DnsLookupAllFn,
  type PinnedHost,
} from "../network-allowlist.js";
import type { DispatcherLike } from "../../net/safe-fetch.js";
import { JiraApiError } from "./jira-errors.js";

const log = createChildLogger("jira-raw-fetch");

/**
 * Hard ceiling on a proxied attachment (25 MB). This is a denial-of-service
 * bound on an unauthenticated-upstream stream, not a product policy — the
 * ingest-side extractor applies its own, stricter 5 MB rule
 * (`MAX_ATTACHMENT_SIZE` in `attachment-extractor.ts`).
 */
export const DEFAULT_MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/** Maximum redirect hops followed before giving up. */
export const DEFAULT_MAX_REDIRECTS = 3;

/**
 * Content types the proxy is willing to reflect and render inline. Deliberately
 * raster-only: `image/svg+xml`, `text/html` and friends are scriptable and
 * would give an attacker who controls an attachment body script execution in
 * the METIS origin.
 */
const INLINE_SAFE_CONTENT_TYPES: ReadonlySet<string> = new Set([
  "image/apng",
  "image/avif",
  "image/bmp",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

export interface AttachmentDisposition {
  /** The `Content-Type` that is safe to send to the browser. */
  contentType: string;
  /** How the browser should treat the body. */
  contentDisposition: "inline" | "attachment";
}

/**
 * Decide what the proxy may tell the browser about an upstream body.
 *
 * Pure and exported so both the client and the route agree, and so the policy
 * is directly unit-testable.
 */
export function resolveAttachmentDisposition(
  rawContentType: string | null | undefined,
): AttachmentDisposition {
  const essence = (rawContentType ?? "").split(";")[0].trim().toLowerCase();
  if (INLINE_SAFE_CONTENT_TYPES.has(essence)) {
    return { contentType: essence, contentDisposition: "inline" };
  }
  return { contentType: "application/octet-stream", contentDisposition: "attachment" };
}

export interface JiraRawResource {
  body: ReadableStream<Uint8Array>;
  /** Sanitized per {@link resolveAttachmentDisposition} — never the raw upstream value. */
  contentType: string;
  contentLength: number | null;
  contentDisposition: "inline" | "attachment";
}

export interface JiraRawFetchParams {
  /** The connection's configured Jira base URL — the only permitted origin. */
  baseUrl: string;
  /** Authorization header value. Sent ONLY to `baseUrl`'s origin. */
  authorization: string;
  /** Override `globalThis.fetch` (test injection). */
  fetchFn?: typeof fetch;
  /** Override DNS resolution (test injection). */
  lookup?: DnsLookupAllFn;
  /** Override the pinned-dispatcher factory (test injection). */
  dispatcherFactory?: (pinned: PinnedHost) => Promise<DispatcherLike>;
  /** Response size ceiling. Defaults to {@link DEFAULT_MAX_ATTACHMENT_BYTES}. */
  maxBytes?: number;
  /** Redirect hop ceiling. Defaults to {@link DEFAULT_MAX_REDIRECTS}. */
  maxRedirects?: number;
}

// ---- URL validation --------------------------------------------------------

/** Parse the admin-configured base URL. A broken value is a server-side fault. */
function parseBaseOrigin(baseUrl: string): string {
  try {
    return new URL(baseUrl).origin;
  } catch {
    throw new JiraApiError(
      500,
      "JIRA_BASE_URL_INVALID",
      "The Jira connection has an unparseable base URL",
    );
  }
}

/**
 * Parse an attacker-influenced URL, rejecting anything that is not a plain
 * credential-free `http(s)` URL. `relativeTo` is supplied when resolving a
 * redirect `Location`, which may legitimately be relative.
 */
function parseHttpUrl(raw: string, relativeTo?: URL): URL {
  let parsed: URL;
  try {
    parsed = relativeTo ? new URL(raw, relativeTo) : new URL(raw);
  } catch {
    throw new JiraApiError(400, "INVALID_URL", "url is not a valid absolute URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new JiraApiError(
      400,
      "INVALID_URL_SCHEME",
      `scheme '${parsed.protocol.replace(/:$/, "")}' is not supported — only http and https`,
    );
  }
  // `https://user@host/` has the same origin as `https://host/`, so the origin
  // check below cannot catch userinfo on its own.
  if (parsed.username !== "" || parsed.password !== "") {
    throw new JiraApiError(400, "INVALID_URL", "url must not contain embedded credentials");
  }
  return parsed;
}

function parseContentLength(raw: string | null): number | null {
  if (raw == null || !/^\d+$/.test(raw.trim())) return null;
  const n = Number(raw.trim());
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * Discard a response body we are not going to return, so the pooled socket is
 * released. Cancellation failures are irrelevant — the connection is being torn
 * down either way.
 */
async function discardBody(response: Response): Promise<void> {
  if (!response.body) return;
  try {
    await response.body.cancel();
  } catch {
    /* best-effort */
  }
}

async function discardReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  reason?: unknown,
): Promise<void> {
  try {
    await reader.cancel(reason);
  } catch {
    /* best-effort */
  }
}

/**
 * Wrap `source` in a stream that fails once more than `maxBytes` have flowed.
 * `Content-Length` is upstream-controlled, so the counter — not the header — is
 * the real bound. `onSettled` releases the pinned dispatcher when the consumer
 * finishes, errors, or cancels.
 */
function capStream(
  source: ReadableStream<Uint8Array>,
  maxBytes: number,
  onSettled: () => Promise<void>,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let seen = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        await onSettled();
        controller.close();
        return;
      }
      seen += value.byteLength;
      if (seen > maxBytes) {
        await discardReader(reader);
        await onSettled();
        controller.error(
          new JiraApiError(
            413,
            "ATTACHMENT_TOO_LARGE",
            `Attachment exceeds the ${maxBytes}-byte proxy limit`,
          ),
        );
        return;
      }
      controller.enqueue(value);
    },
    async cancel(reason) {
      await discardReader(reader, reason);
      await onSettled();
    },
  });
}

// ---- Main entry point ------------------------------------------------------

/**
 * Fetch a raw Jira resource (attachment / inline image) with full SSRF and
 * credential-scoping protection. See the module header for the pipeline.
 */
export async function fetchJiraRaw(
  absoluteUrl: string,
  params: JiraRawFetchParams,
): Promise<JiraRawResource> {
  const fetchFn = params.fetchFn ?? globalThis.fetch;
  const dispatcherFactory = params.dispatcherFactory ?? makePinnedDispatcher;
  const maxBytes = params.maxBytes ?? DEFAULT_MAX_ATTACHMENT_BYTES;
  const maxRedirects = params.maxRedirects ?? DEFAULT_MAX_REDIRECTS;

  const baseOrigin = parseBaseOrigin(params.baseUrl);
  let current = parseHttpUrl(absoluteUrl);
  if (current.origin !== baseOrigin) {
    log.warn("Rejected attachment URL from a foreign origin", {
      requestedOrigin: current.origin,
    });
    throw new JiraApiError(400, "INVALID_URL", "URL does not belong to this Jira instance");
  }

  for (let hop = 0; ; hop += 1) {
    const sameOrigin = current.origin === baseOrigin;

    // Allow-list + private-range policy + the address the socket must use.
    const pinned = await resolveAndAssertConnectorHost(current.hostname, "jira", params.lookup);
    const dispatcher = await dispatcherFactory(pinned);
    let pendingRelease: DispatcherLike | null = dispatcher;
    const release = async (): Promise<void> => {
      const d = pendingRelease;
      pendingRelease = null;
      if (!d) return;
      try {
        await d.close?.();
      } catch {
        /* best-effort cleanup */
      }
    };

    let response: Response;
    try {
      const headers: Record<string, string> = {};
      // The load-bearing line: the credential never leaves the Jira origin.
      if (sameOrigin) headers.Authorization = params.authorization;
      const init: Record<string, unknown> = {
        method: "GET",
        headers,
        // Manual, so every hop goes back through the checks above.
        redirect: "manual",
        // undici-only RequestInit extension that forces the pinned address.
        dispatcher,
      };
      response = await fetchFn(current.toString(), init as RequestInit);
    } catch (err) {
      await release();
      throw new JiraApiError(
        502,
        "JIRA_FETCH_ERROR",
        `Failed to fetch attachment: ${(err as Error).message}`,
      );
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      await discardBody(response);
      try {
        if (!location) {
          throw new JiraApiError(
            502,
            "JIRA_FETCH_ERROR",
            `Jira returned ${response.status} without a Location header`,
          );
        }
        if (hop >= maxRedirects) {
          throw new JiraApiError(
            502,
            "TOO_MANY_REDIRECTS",
            `Attachment redirect chain exceeded ${maxRedirects} hops`,
          );
        }
        const next = parseHttpUrl(location, current);
        if (next.origin !== current.origin) {
          log.info("Following off-origin attachment redirect without credentials", {
            from: current.origin,
            to: next.origin,
          });
        }
        current = next;
      } finally {
        await release();
      }
      continue;
    }

    try {
      if (!response.ok) {
        await discardBody(response);
        throw new JiraApiError(
          response.status,
          "JIRA_FETCH_ERROR",
          `Failed to fetch: ${response.status}`,
        );
      }
      if (!response.body) {
        throw new JiraApiError(502, "EMPTY_BODY", "Jira returned an empty response body");
      }
      const contentLength = parseContentLength(response.headers.get("content-length"));
      if (contentLength != null && contentLength > maxBytes) {
        await discardBody(response);
        throw new JiraApiError(
          413,
          "ATTACHMENT_TOO_LARGE",
          `Attachment exceeds the ${maxBytes}-byte proxy limit`,
        );
      }
      const { contentType, contentDisposition } = resolveAttachmentDisposition(
        response.headers.get("content-type"),
      );
      return {
        // `release` is handed to the stream — the dispatcher outlives this
        // function because the body is still being read from it.
        body: capStream(response.body as ReadableStream<Uint8Array>, maxBytes, release),
        contentType,
        contentLength,
        contentDisposition,
      };
    } catch (err) {
      await release();
      throw err;
    }
  }
}
