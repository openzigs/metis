/**
 * URL fetcher SSRF + size + content-type tests (issue #132).
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  assertHostnameAllowed,
  assertResolvesToPublic,
  fetchUrlForIngest,
  isPrivateIp,
  parseUrl,
  UrlFetchError,
} from "../src/lib/documents/url-fetcher.js";

const ORIGINAL_ALLOWLIST = process.env.INGEST_URL_ALLOWLIST;

beforeEach(() => {
  delete process.env.INGEST_URL_ALLOWLIST;
});

afterEach(() => {
  if (ORIGINAL_ALLOWLIST == null) delete process.env.INGEST_URL_ALLOWLIST;
  else process.env.INGEST_URL_ALLOWLIST = ORIGINAL_ALLOWLIST;
});

describe("isPrivateIp", () => {
  it.each([
    "10.0.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.5.5",
    "172.31.255.254",
    "192.168.1.1",
    "0.0.0.0",
    "224.0.0.1",
    "255.255.255.255",
    "::1",
    "::",
    "fe80::1",
    "fd12:3456:789a::1",
    "::ffff:127.0.0.1",
    "::ffff:10.0.0.1",
  ])("classifies %s as private", (ip) => {
    expect(isPrivateIp(ip)).toBe(true);
  });

  it.each(["8.8.8.8", "1.1.1.1", "172.15.0.1", "172.32.0.1", "2606:4700:4700::1111"])(
    "classifies %s as public",
    (ip) => {
      expect(isPrivateIp(ip)).toBe(false);
    },
  );

  it("returns false for non-IPs", () => {
    expect(isPrivateIp("example.com")).toBe(false);
  });
});

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(UrlFetchError);
    expect((err as UrlFetchError).code).toBe(code);
    return;
  }
  throw new Error(`Expected fn to throw with code ${code}`);
}

async function expectAsyncCode(p: Promise<unknown>, code: string): Promise<void> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(UrlFetchError);
    expect((err as UrlFetchError).code).toBe(code);
    return;
  }
  throw new Error(`Expected promise to reject with code ${code}`);
}

describe("parseUrl", () => {
  it("rejects unsupported schemes", () => {
    expectCode(() => parseUrl("ftp://example.com/x"), "UNSUPPORTED_SCHEME");
    expectCode(() => parseUrl("file:///etc/passwd"), "UNSUPPORTED_SCHEME");
  });

  it("rejects URLs with credentials", () => {
    expectCode(() => parseUrl("https://user:pass@example.com/"), "URL_HAS_CREDENTIALS");
  });

  it("rejects malformed URLs", () => {
    expectCode(() => parseUrl("not a url"), "INVALID_URL");
  });

  it("accepts plain http and https", () => {
    expect(parseUrl("https://example.com/").hostname).toBe("example.com");
    expect(parseUrl("http://example.com/").hostname).toBe("example.com");
  });
});

describe("assertHostnameAllowed", () => {
  it("is a no-op when allowlist is null", () => {
    expect(() => assertHostnameAllowed("anything.example", null)).not.toThrow();
  });

  it("throws when host does not match any pattern", () => {
    expectCode(() => assertHostnameAllowed("evil.example", [/^docs\./]), "HOST_NOT_ALLOWED");
  });

  it("passes when at least one pattern matches", () => {
    expect(() => assertHostnameAllowed("docs.example.com", [/^docs\./])).not.toThrow();
  });
});

describe("assertResolvesToPublic", () => {
  it("rejects IP literals in private ranges", async () => {
    await expectAsyncCode(
      assertResolvesToPublic("127.0.0.1", async () => ["127.0.0.1"]),
      "PRIVATE_HOST_BLOCKED",
    );
  });

  it("rejects hostnames whose DNS lookup returns a private IP", async () => {
    await expectAsyncCode(
      assertResolvesToPublic("evil.example", async () => ["8.8.8.8", "169.254.169.254"]),
      "PRIVATE_HOST_BLOCKED",
    );
  });

  it("passes for hostnames that resolve only to public IPs", async () => {
    await expect(
      assertResolvesToPublic("ok.example", async () => ["8.8.8.8", "1.1.1.1"]),
    ).resolves.toBeUndefined();
  });

  it("rejects on DNS lookup failure", async () => {
    await expectAsyncCode(
      assertResolvesToPublic("nx.example", async () => {
        throw new Error("ENOTFOUND");
      }),
      "DNS_FAILURE",
    );
  });
});

describe("fetchUrlForIngest (integration)", () => {
  function mockFetch(handler: (url: string) => Response | Promise<Response>): typeof fetch {
    return ((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      return Promise.resolve(handler(url));
    }) as typeof fetch;
  }

  function publicResolver(): (host: string) => Promise<string[]> {
    return async () => ["8.8.8.8"];
  }

  it("rejects URLs whose hostname resolves to private IPs before any HTTP", async () => {
    await expectAsyncCode(
      fetchUrlForIngest("https://evil.example/", {
        resolver: async () => ["10.0.0.1"],
        fetchImpl: mockFetch(() => new Response("never")),
      }),
      "PRIVATE_HOST_BLOCKED",
    );
  });

  it("rejects responses whose content-type is not in the upload allowlist", async () => {
    await expectAsyncCode(
      fetchUrlForIngest("https://docs.example/page", {
        resolver: publicResolver(),
        fetchImpl: mockFetch(
          () =>
            new Response("<svg/>", {
              status: 200,
              headers: { "content-type": "image/svg+xml" },
            }),
        ),
      }),
      "MIME_NOT_ALLOWED",
    );
  });

  it("rejects responses whose Content-Length exceeds the cap", async () => {
    const big = "x".repeat(11 * 1024 * 1024);
    await expectAsyncCode(
      fetchUrlForIngest("https://docs.example/big", {
        resolver: publicResolver(),
        fetchImpl: mockFetch(
          () =>
            new Response(big, {
              status: 200,
              headers: {
                "content-type": "text/markdown",
                "content-length": String(big.length),
              },
            }),
        ),
      }),
      "RESPONSE_TOO_LARGE",
    );
  });

  it("rejects responses whose streamed body exceeds the cap (no Content-Length)", async () => {
    const small = 256;
    await expectAsyncCode(
      fetchUrlForIngest("https://docs.example/streamed", {
        maxBytes: small,
        resolver: publicResolver(),
        fetchImpl: mockFetch(
          () =>
            new Response("y".repeat(small * 4), {
              status: 200,
              headers: { "content-type": "text/markdown" },
            }),
        ),
      }),
      "RESPONSE_TOO_LARGE",
    );
  });

  it("returns the buffer + content-type + filename for a happy-path fetch", async () => {
    const body = "# hello\n\nbody";
    const result = await fetchUrlForIngest("https://docs.example/notes.md", {
      resolver: publicResolver(),
      fetchImpl: mockFetch(
        () =>
          new Response(body, {
            status: 200,
            headers: { "content-type": "text/markdown; charset=utf-8" },
          }),
      ),
    });
    expect(result.contentType).toBe("text/markdown");
    expect(result.buffer.toString()).toBe(body);
    expect(result.filename).toBe("notes.md");
  });

  it("derives a filename + extension when the URL has no path", async () => {
    const body = "# root";
    const result = await fetchUrlForIngest("https://docs.example/", {
      resolver: publicResolver(),
      fetchImpl: mockFetch(
        () =>
          new Response(body, {
            status: 200,
            headers: { "content-type": "text/markdown" },
          }),
      ),
    });
    expect(result.filename.endsWith(".md")).toBe(true);
  });

  it("propagates 4xx upstream as 404 / 502 errors", async () => {
    await expectAsyncCode(
      fetchUrlForIngest("https://docs.example/missing", {
        resolver: publicResolver(),
        fetchImpl: mockFetch(
          () => new Response("nope", { status: 404, headers: { "content-type": "text/plain" } }),
        ),
      }),
      "FETCH_BAD_STATUS",
    );
  });

  it("rejects when the allowlist regex fails", async () => {
    process.env.INGEST_URL_ALLOWLIST = "^docs\\.example$";
    await expectAsyncCode(
      fetchUrlForIngest("https://blog.example/", {
        resolver: publicResolver(),
        fetchImpl: mockFetch(
          () => new Response("x", { status: 200, headers: { "content-type": "text/markdown" } }),
        ),
      }),
      "HOST_NOT_ALLOWED",
    );
  });

  it("permits a host that matches the allowlist regex", async () => {
    process.env.INGEST_URL_ALLOWLIST = "^docs\\.example$";
    const result = await fetchUrlForIngest("https://docs.example/x.md", {
      resolver: publicResolver(),
      fetchImpl: mockFetch(
        () => new Response("x", { status: 200, headers: { "content-type": "text/markdown" } }),
      ),
    });
    expect(result.filename).toBe("x.md");
  });

  it("follows a public-to-public redirect", async () => {
    let calls = 0;
    const result = await fetchUrlForIngest("https://docs.example/start", {
      resolver: publicResolver(),
      fetchImpl: mockFetch((url) => {
        calls += 1;
        if (url.endsWith("/start")) {
          return new Response(null, {
            status: 302,
            headers: { location: "https://docs.example/end.md" },
          });
        }
        return new Response("# end", { status: 200, headers: { "content-type": "text/markdown" } });
      }),
    });
    expect(calls).toBe(2);
    expect(result.filename).toBe("end.md");
  });

  it("blocks a redirect that lands on a private host", async () => {
    const resolver = async (host: string) => {
      if (host === "docs.example") return ["8.8.8.8"];
      return ["10.0.0.1"];
    };
    await expectAsyncCode(
      fetchUrlForIngest("https://docs.example/start", {
        resolver,
        fetchImpl: mockFetch((url) => {
          if (url.endsWith("/start")) {
            return new Response(null, {
              status: 302,
              headers: { location: "https://internal.example/" },
            });
          }
          return new Response("ok", { status: 200, headers: { "content-type": "text/markdown" } });
        }),
      }),
      "PRIVATE_HOST_BLOCKED",
    );
  });
});
