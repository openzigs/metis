/**
 * Issue #1054 — Jira attachment proxy SSRF + credential exfiltration.
 *
 * `fetchRaw` used to validate the caller-supplied URL with a bare
 * `absoluteUrl.startsWith(baseUrl)` prefix check and then attach the Jira
 * credential. A prefix is not an origin, so both
 * `https://jira.example.com.attacker.com/…` and
 * `https://jira.example.com@attacker.com/…` slipped through and the server
 * shipped `Authorization: Basic …` to the attacker.
 *
 * These tests pin the hardened behaviour:
 *   - parsed-origin equality (not prefix) at the entry point;
 *   - the connector allow-list + DNS pinning on every hop;
 *   - `http(s)` only;
 *   - redirects re-validated per hop, and the credential NEVER leaves the
 *     Jira origin;
 *   - the response size is bounded;
 *   - the reflected upstream `Content-Type` is restricted so the proxy can
 *     never serve attacker-controlled HTML inline.
 *
 * The positive case ("a legitimate same-origin attachment still succeeds",
 * plus the on-prem allow-listed private Jira host) is deliberately covered —
 * a fix that rejected everything would satisfy every negative test above.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_MAX_ATTACHMENT_BYTES,
  fetchJiraRaw,
  resolveAttachmentDisposition,
  type JiraRawFetchParams,
} from "../src/lib/connectors/jira/raw-fetch.js";
import { JiraApiError } from "../src/lib/connectors/jira/jira-errors.js";
import {
  __resetAllowlistForTests,
  type DnsLookupAddress,
  type PinnedHost,
} from "../src/lib/connectors/network-allowlist.js";
import { ConnectorError } from "../src/lib/connectors/types.js";
import { __resetConfigSingleton } from "../src/lib/config/index.js";

const BASE_URL = "https://jira.example.com";
const AUTHORIZATION = "Basic dXNlckBleGFtcGxlLmNvbTp0b2tlbg==";

/** A genuinely routable address — TEST-NET ranges classify as non-routable. */
const PUBLIC_V4 = "93.184.216.34";

// ---- Harness ---------------------------------------------------------------

interface RecordedCall {
  url: string;
  headers: Record<string, string>;
}

interface Harness {
  calls: RecordedCall[];
  dispatchers: Array<{ pinned: PinnedHost; closed: boolean }>;
  params: JiraRawFetchParams;
}

function streamOf(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/**
 * Build a harness whose `fetchFn` records every outbound request (URL +
 * headers) so a test can assert what the credential was — and was not —
 * attached to.
 */
function harness(
  responses: Array<() => Response>,
  opts: {
    lookup?: (host: string) => Promise<DnsLookupAddress[]>;
    maxBytes?: number;
    maxRedirects?: number;
    baseUrl?: string;
  } = {},
): Harness {
  const calls: RecordedCall[] = [];
  const dispatchers: Array<{ pinned: PinnedHost; closed: boolean }> = [];
  let idx = 0;

  const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const headers = ((init?.headers ?? {}) as Record<string, string>) ?? {};
    calls.push({ url: String(url), headers: { ...headers } });
    const make = responses[Math.min(idx, responses.length - 1)];
    idx += 1;
    return make();
  }) as unknown as typeof fetch;

  return {
    calls,
    dispatchers,
    params: {
      baseUrl: opts.baseUrl ?? BASE_URL,
      authorization: AUTHORIZATION,
      fetchFn,
      lookup: opts.lookup ?? (async () => [{ address: PUBLIC_V4, family: 4 }]),
      dispatcherFactory: async (pinned: PinnedHost) => {
        const entry = { pinned, closed: false };
        dispatchers.push(entry);
        return {
          close: async () => {
            entry.closed = true;
          },
        };
      },
      maxBytes: opts.maxBytes,
      maxRedirects: opts.maxRedirects,
    },
  };
}

function okResponse(body: string, contentType = "application/octet-stream"): Response {
  return new Response(streamOf(new Uint8Array(Buffer.from(body))), {
    status: 200,
    headers: { "content-type": contentType, "content-length": String(Buffer.byteLength(body)) },
  });
}

function redirectTo(location: string, status = 302): Response {
  return new Response(null, { status, headers: { location } });
}

/** Every recorded request whose origin is not the Jira origin. */
function offOriginCalls(h: Harness): RecordedCall[] {
  const baseOrigin = new URL(BASE_URL).origin;
  return h.calls.filter((c) => new URL(c.url).origin !== baseOrigin);
}

function authOf(call: RecordedCall): string | undefined {
  const key = Object.keys(call.headers).find((k) => k.toLowerCase() === "authorization");
  return key ? call.headers[key] : undefined;
}

const ORIG_ENV = { ...process.env };

beforeEach(() => {
  delete process.env.JIRA_ALLOWED_HOSTS;
  delete process.env.CONNECTOR_ALLOW_LOOPBACK;
  __resetConfigSingleton();
  __resetAllowlistForTests();
});

afterEach(() => {
  process.env = { ...ORIG_ENV };
  __resetConfigSingleton();
  __resetAllowlistForTests();
  vi.clearAllMocks();
});

// ---- Entry-point origin validation -----------------------------------------

describe("fetchJiraRaw — origin validation (the #1054 bypass)", () => {
  it("rejects the `.attacker.com` suffix bypass without issuing a request", async () => {
    const h = harness([() => okResponse("stolen")]);
    await expect(
      fetchJiraRaw("https://jira.example.com.attacker.com/collect", h.params),
    ).rejects.toMatchObject({ status: 400, code: "INVALID_URL" });
    expect(h.calls).toHaveLength(0);
  });

  it("rejects the `@attacker.com` userinfo bypass without issuing a request", async () => {
    const h = harness([() => okResponse("stolen")]);
    await expect(
      fetchJiraRaw("https://jira.example.com@attacker.com/collect", h.params),
    ).rejects.toBeInstanceOf(JiraApiError);
    expect(h.calls).toHaveLength(0);
  });

  it("rejects the metadata-endpoint variant of the userinfo bypass", async () => {
    const h = harness([() => okResponse("iam-creds")]);
    await expect(
      fetchJiraRaw("https://jira.example.com@169.254.169.254/latest/meta-data/", h.params),
    ).rejects.toBeInstanceOf(JiraApiError);
    expect(h.calls).toHaveLength(0);
  });

  it("rejects embedded credentials even when the host itself matches", async () => {
    const h = harness([() => okResponse("ok")]);
    await expect(
      fetchJiraRaw("https://evil:pw@jira.example.com/secure/attachment/1/a.png", h.params),
    ).rejects.toMatchObject({ status: 400 });
    expect(h.calls).toHaveLength(0);
  });

  it("rejects a scheme downgrade (origin includes the scheme)", async () => {
    const h = harness([() => okResponse("ok")]);
    await expect(
      fetchJiraRaw("http://jira.example.com/secure/attachment/1/a.png", h.params),
    ).rejects.toMatchObject({ status: 400, code: "INVALID_URL" });
    expect(h.calls).toHaveLength(0);
  });

  it("rejects a port mismatch (origin includes the port)", async () => {
    const h = harness([() => okResponse("ok")]);
    await expect(
      fetchJiraRaw("https://jira.example.com:8443/secure/attachment/1/a.png", h.params),
    ).rejects.toMatchObject({ status: 400, code: "INVALID_URL" });
    expect(h.calls).toHaveLength(0);
  });

  it("rejects non-http(s) schemes explicitly", async () => {
    const h = harness([() => okResponse("ok")]);
    for (const url of ["file:///etc/passwd", "ftp://jira.example.com/x", "gopher://x/1"]) {
      await expect(fetchJiraRaw(url, h.params)).rejects.toMatchObject({
        status: 400,
        code: "INVALID_URL_SCHEME",
      });
    }
    expect(h.calls).toHaveLength(0);
  });

  it("rejects an unparseable URL as a 400, not an escaping TypeError", async () => {
    const h = harness([() => okResponse("ok")]);
    const err = await fetchJiraRaw("not a url at all", h.params).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JiraApiError);
    expect((err as JiraApiError).status).toBe(400);
    expect(h.calls).toHaveLength(0);
  });

  it("tolerates a trailing slash on the configured baseUrl", async () => {
    const h = harness([() => okResponse("bytes")], { baseUrl: "https://jira.example.com/" });
    const res = await fetchJiraRaw("https://jira.example.com/secure/attachment/1/a.png", h.params);
    expect((await drain(res.body)).toString()).toBe("bytes");
  });
});

// ---- Allow-list + DNS pinning ----------------------------------------------

describe("fetchJiraRaw — connector allow-list and DNS pinning", () => {
  it("rejects a same-origin host that resolves to the cloud metadata address", async () => {
    const h = harness([() => okResponse("iam-creds")], {
      lookup: async () => [{ address: "169.254.169.254", family: 4 }],
    });
    await expect(
      fetchJiraRaw("https://jira.example.com/secure/attachment/1/a.png", h.params),
    ).rejects.toBeInstanceOf(ConnectorError);
    expect(h.calls).toHaveLength(0);
  });

  it("rejects a same-origin host that resolves to an RFC1918 address", async () => {
    const h = harness([() => okResponse("internal")], {
      lookup: async () => [{ address: "10.1.2.3", family: 4 }],
    });
    await expect(
      fetchJiraRaw("https://jira.example.com/secure/attachment/1/a.png", h.params),
    ).rejects.toMatchObject({ code: "HOST_NOT_ALLOWED" });
    expect(h.calls).toHaveLength(0);
  });

  it("rejects when ANY resolved address is non-routable", async () => {
    const h = harness([() => okResponse("internal")], {
      lookup: async () => [
        { address: PUBLIC_V4, family: 4 },
        { address: "169.254.169.254", family: 4 },
      ],
    });
    await expect(
      fetchJiraRaw("https://jira.example.com/secure/attachment/1/a.png", h.params),
    ).rejects.toBeInstanceOf(ConnectorError);
    expect(h.calls).toHaveLength(0);
  });

  it("pins the socket to the validated address", async () => {
    const h = harness([() => okResponse("bytes")]);
    await fetchJiraRaw("https://jira.example.com/secure/attachment/1/a.png", h.params);
    expect(h.dispatchers).toHaveLength(1);
    expect(h.dispatchers[0].pinned.address).toBe(PUBLIC_V4);
  });

  it("still allows an on-prem Jira on a private address via JIRA_ALLOWED_HOSTS", async () => {
    process.env.JIRA_ALLOWED_HOSTS = "jira.corp.net";
    __resetConfigSingleton();
    __resetAllowlistForTests();
    const h = harness([() => okResponse("on-prem bytes")], {
      baseUrl: "https://jira.corp.net",
      lookup: async () => [{ address: "10.1.2.3", family: 4 }],
    });
    const res = await fetchJiraRaw("https://jira.corp.net/secure/attachment/1/a.png", h.params);
    expect((await drain(res.body)).toString()).toBe("on-prem bytes");
    expect(h.dispatchers[0].pinned.address).toBe("10.1.2.3");
  });
});

// ---- Happy path ------------------------------------------------------------

describe("fetchJiraRaw — legitimate same-origin attachment", () => {
  it("fetches the attachment and forwards the credential to the Jira origin", async () => {
    const h = harness([() => okResponse("PNGDATA", "image/png")]);
    const res = await fetchJiraRaw("https://jira.example.com/secure/attachment/1/a.png", h.params);

    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].url).toBe("https://jira.example.com/secure/attachment/1/a.png");
    expect(authOf(h.calls[0])).toBe(AUTHORIZATION);
    expect(res.contentType).toBe("image/png");
    expect(res.contentDisposition).toBe("inline");
    expect(res.contentLength).toBe(7);
    expect((await drain(res.body)).toString()).toBe("PNGDATA");
  });

  it("preserves query strings and encoded paths", async () => {
    const h = harness([() => okResponse("bytes")]);
    const url = "https://jira.example.com/rest/api/3/attachment/content/10000?redirect=false";
    await fetchJiraRaw(url, h.params);
    expect(h.calls[0].url).toBe(url);
  });

  it("maps a non-2xx upstream status onto a JiraApiError", async () => {
    const h = harness([() => new Response("nope", { status: 404 })]);
    await expect(
      fetchJiraRaw("https://jira.example.com/secure/attachment/1/a.png", h.params),
    ).rejects.toMatchObject({ status: 404, code: "JIRA_FETCH_ERROR" });
  });

  it("rejects an empty upstream body", async () => {
    const h = harness([() => new Response(null, { status: 200 })]);
    await expect(
      fetchJiraRaw("https://jira.example.com/secure/attachment/1/a.png", h.params),
    ).rejects.toMatchObject({ status: 502, code: "EMPTY_BODY" });
  });

  it("maps a transport failure onto a 502 rather than leaking the raw error", async () => {
    const h = harness([() => okResponse("x")]);
    h.params.fetchFn = vi.fn(async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    await expect(
      fetchJiraRaw("https://jira.example.com/secure/attachment/1/a.png", h.params),
    ).rejects.toMatchObject({ status: 502, code: "JIRA_FETCH_ERROR" });
  });

  it("rejects an unparseable connection baseUrl as a server-side fault", async () => {
    const h = harness([() => okResponse("x")], { baseUrl: "not-a-url" });
    await expect(
      fetchJiraRaw("https://jira.example.com/secure/attachment/1/a.png", h.params),
    ).rejects.toMatchObject({ status: 500, code: "JIRA_BASE_URL_INVALID" });
    expect(h.calls).toHaveLength(0);
  });

  it("ignores a nonsensical Content-Length instead of trusting it", async () => {
    const h = harness([
      () =>
        new Response(streamOf(new Uint8Array(Buffer.from("body"))), {
          status: 200,
          headers: { "content-type": "image/png", "content-length": "not-a-number" },
        }),
    ]);
    const res = await fetchJiraRaw("https://jira.example.com/secure/attachment/1/a.png", h.params);
    expect(res.contentLength).toBeNull();
    expect((await drain(res.body)).toString()).toBe("body");
  });

  it("releases the pinned dispatcher once the body is fully read", async () => {
    const h = harness([() => okResponse("bytes")]);
    const res = await fetchJiraRaw("https://jira.example.com/secure/attachment/1/a.bin", h.params);
    expect(h.dispatchers[0].closed).toBe(false);
    await drain(res.body);
    expect(h.dispatchers[0].closed).toBe(true);
  });

  it("releases the pinned dispatcher when the consumer cancels early", async () => {
    const h = harness([() => okResponse("bytes")]);
    const res = await fetchJiraRaw("https://jira.example.com/secure/attachment/1/a.bin", h.params);
    await res.body.cancel();
    expect(h.dispatchers[0].closed).toBe(true);
  });

  it("releases every dispatcher built while following a redirect", async () => {
    const h = harness([
      () => redirectTo("https://media.example.net/signed/abc"),
      () => okResponse("media"),
    ]);
    const res = await fetchJiraRaw("https://jira.example.com/rest/api/3/attachment/1", h.params);
    expect(h.dispatchers).toHaveLength(2);
    expect(h.dispatchers[0].closed).toBe(true);
    await drain(res.body);
    expect(h.dispatchers[1].closed).toBe(true);
  });

  it("releases the dispatcher when the request is rejected before streaming", async () => {
    const h = harness([() => new Response("nope", { status: 500 })]);
    await expect(
      fetchJiraRaw("https://jira.example.com/secure/attachment/1/a.bin", h.params),
    ).rejects.toBeInstanceOf(JiraApiError);
    expect(h.dispatchers[0].closed).toBe(true);
  });
});

// ---- Redirects -------------------------------------------------------------

describe("fetchJiraRaw — redirect handling", () => {
  it("never carries the Authorization header to an off-origin redirect target", async () => {
    // Jira Cloud legitimately 302s attachment content to a signed media URL.
    const h = harness([
      () => redirectTo("https://media.example.net/signed/abc"),
      () => okResponse("media bytes"),
    ]);
    const res = await fetchJiraRaw(
      "https://jira.example.com/rest/api/3/attachment/content/10000",
      h.params,
    );

    expect(h.calls).toHaveLength(2);
    expect(authOf(h.calls[0])).toBe(AUTHORIZATION);
    expect(authOf(h.calls[1])).toBeUndefined();
    // The hard invariant: no request to a non-Jira origin ever carried a credential.
    for (const call of offOriginCalls(h)) {
      expect(authOf(call)).toBeUndefined();
    }
    expect((await drain(res.body)).toString()).toBe("media bytes");
  });

  it("re-validates the host on every hop — a redirect to a private address is refused", async () => {
    const h = harness(
      [() => redirectTo("https://internal.example.net/steal"), () => okResponse("internal")],
      {
        lookup: async (host) =>
          host === "internal.example.net"
            ? [{ address: "10.0.0.5", family: 4 }]
            : [{ address: PUBLIC_V4, family: 4 }],
      },
    );
    await expect(
      fetchJiraRaw("https://jira.example.com/rest/api/3/attachment/content/1", h.params),
    ).rejects.toBeInstanceOf(ConnectorError);
    // The redirect target was never contacted.
    expect(h.calls).toHaveLength(1);
  });

  it("refuses a redirect to the metadata endpoint", async () => {
    const h = harness([
      () => redirectTo("http://169.254.169.254/latest/meta-data/iam/"),
      () => okResponse("creds"),
    ]);
    await expect(
      fetchJiraRaw("https://jira.example.com/rest/api/3/attachment/content/1", h.params),
    ).rejects.toBeInstanceOf(ConnectorError);
    expect(h.calls).toHaveLength(1);
  });

  it("refuses a redirect to a non-http(s) scheme", async () => {
    const h = harness([() => redirectTo("file:///etc/passwd"), () => okResponse("x")]);
    await expect(
      fetchJiraRaw("https://jira.example.com/rest/api/3/attachment/content/1", h.params),
    ).rejects.toMatchObject({ code: "INVALID_URL_SCHEME" });
    expect(h.calls).toHaveLength(1);
  });

  it("re-attaches the credential when a redirect stays on the Jira origin", async () => {
    const h = harness([
      () => redirectTo("https://jira.example.com/secure/attachment/1/final.png"),
      () => okResponse("bytes"),
    ]);
    await fetchJiraRaw("https://jira.example.com/rest/api/3/attachment/content/1", h.params);
    expect(h.calls).toHaveLength(2);
    expect(authOf(h.calls[1])).toBe(AUTHORIZATION);
  });

  it("resolves a relative Location against the current hop", async () => {
    const h = harness([() => redirectTo("/secure/attachment/1/final.png"), () => okResponse("b")]);
    await fetchJiraRaw("https://jira.example.com/rest/api/3/attachment/content/1", h.params);
    expect(h.calls[1].url).toBe("https://jira.example.com/secure/attachment/1/final.png");
  });

  it("caps the redirect chain", async () => {
    const h = harness([() => redirectTo("https://media.example.net/loop")], { maxRedirects: 2 });
    await expect(
      fetchJiraRaw("https://jira.example.com/rest/api/3/attachment/content/1", h.params),
    ).rejects.toMatchObject({ code: "TOO_MANY_REDIRECTS" });
    expect(h.calls.length).toBeLessThanOrEqual(3);
  });

  it("treats a 3xx with no Location as an upstream failure", async () => {
    const h = harness([() => new Response(null, { status: 302 })]);
    await expect(
      fetchJiraRaw("https://jira.example.com/rest/api/3/attachment/content/1", h.params),
    ).rejects.toMatchObject({ status: 502 });
  });
});

// ---- Size bound ------------------------------------------------------------

describe("fetchJiraRaw — response size bound", () => {
  it("has a non-trivial default cap", () => {
    expect(DEFAULT_MAX_ATTACHMENT_BYTES).toBeGreaterThan(1024 * 1024);
  });

  it("refuses up-front when Content-Length exceeds the cap", async () => {
    const h = harness(
      [
        () =>
          new Response(streamOf(new Uint8Array(16)), {
            status: 200,
            headers: { "content-type": "application/pdf", "content-length": "999999" },
          }),
      ],
      { maxBytes: 16 },
    );
    await expect(
      fetchJiraRaw("https://jira.example.com/secure/attachment/1/a.pdf", h.params),
    ).rejects.toMatchObject({ status: 413, code: "ATTACHMENT_TOO_LARGE" });
  });

  it("errors the stream when a body without Content-Length overruns the cap", async () => {
    const h = harness(
      [
        () =>
          new Response(
            streamOf(new Uint8Array(Buffer.from("aaaa")), new Uint8Array(Buffer.from("bbbb"))),
            { status: 200, headers: { "content-type": "application/octet-stream" } },
          ),
      ],
      { maxBytes: 5 },
    );
    const res = await fetchJiraRaw("https://jira.example.com/secure/attachment/1/a.bin", h.params);
    await expect(drain(res.body)).rejects.toMatchObject({ code: "ATTACHMENT_TOO_LARGE" });
  });

  it("streams a body that fits under the cap", async () => {
    const h = harness([() => okResponse("small")], { maxBytes: 1024 });
    const res = await fetchJiraRaw("https://jira.example.com/secure/attachment/1/a.bin", h.params);
    expect((await drain(res.body)).toString()).toBe("small");
  });
});

// ---- Content-Type / Content-Disposition ------------------------------------

describe("resolveAttachmentDisposition", () => {
  it("serves raster images inline with their own type", () => {
    for (const t of ["image/png", "image/jpeg", "image/gif", "image/webp"]) {
      expect(resolveAttachmentDisposition(t)).toEqual({
        contentType: t,
        contentDisposition: "inline",
      });
    }
  });

  it("strips parameters and normalizes case", () => {
    expect(resolveAttachmentDisposition("IMAGE/PNG; charset=utf-8")).toEqual({
      contentType: "image/png",
      contentDisposition: "inline",
    });
  });

  it("forces a download for scriptable types", () => {
    for (const t of [
      "text/html",
      "application/xhtml+xml",
      "image/svg+xml",
      "text/xml",
      "application/javascript",
      "text/html; charset=utf-8",
    ]) {
      expect(resolveAttachmentDisposition(t)).toEqual({
        contentType: "application/octet-stream",
        contentDisposition: "attachment",
      });
    }
  });

  it("forces a download for anything unrecognized or missing", () => {
    for (const t of ["application/pdf", "application/zip", "", null, "garbage"]) {
      expect(resolveAttachmentDisposition(t)).toEqual({
        contentType: "application/octet-stream",
        contentDisposition: "attachment",
      });
    }
  });

  it("never reflects an untrusted type verbatim", () => {
    const evil = 'text/html; x="<script>alert(1)</script>"';
    const out = resolveAttachmentDisposition(evil);
    expect(out.contentType).toBe("application/octet-stream");
    expect(out.contentDisposition).toBe("attachment");
  });
});
