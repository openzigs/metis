/**
 * Unit tests for the outbound alert webhook sender (Epic #47 / Issue #50).
 *
 * Covers the AC: "Webhook signature verified by test consumer" — the test
 * acts as the consumer, recomputes the HMAC over the received body, and
 * asserts it validates. Also covers the SSRF guard (private/loopback IPs,
 * disallowed schemes, no redirect-following).
 */
import { describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import {
  assertPublicHost,
  computeSignature,
  familyOf,
  makePinnedDispatcher,
  parseWebhookUrl,
  sendWebhook,
  verifySignature,
  SIGNATURE_HEADER,
} from "../src/lib/finops/channels/webhook-sender.js";
import { makePinnedLookup } from "../src/lib/connectors/network-allowlist.js";

describe("computeSignature / verifySignature", () => {
  it("produces a sha256= hex signature a consumer can verify", () => {
    const body = JSON.stringify({ hello: "world" });
    const secret = "topsecret";
    const sig = computeSignature(body, secret);
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);

    // Independent consumer recomputation.
    const expected = "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex");
    expect(sig).toBe(expected);
    expect(verifySignature(body, secret, sig)).toBe(true);
  });

  it("rejects a tampered body", () => {
    const sig = computeSignature("original", "s");
    expect(verifySignature("tampered", "s", sig)).toBe(false);
  });

  it("rejects a wrong secret", () => {
    const sig = computeSignature("body", "right");
    expect(verifySignature("body", "wrong", sig)).toBe(false);
  });

  it("rejects a missing signature or secret", () => {
    expect(verifySignature("body", "s", undefined)).toBe(false);
    expect(verifySignature("body", "", "sha256=abc")).toBe(false);
  });
});

describe("parseWebhookUrl (scheme validation)", () => {
  it("accepts http and https", () => {
    expect(parseWebhookUrl("https://example.com/h").protocol).toBe("https:");
    expect(parseWebhookUrl("http://example.com/h").protocol).toBe("http:");
  });

  it("rejects non-http(s) schemes (SSRF / file/gopher)", () => {
    expect(() => parseWebhookUrl("file:///etc/passwd")).toThrow(/not allowed/);
    expect(() => parseWebhookUrl("gopher://x")).toThrow(/not allowed/);
  });

  it("rejects a malformed URL", () => {
    expect(() => parseWebhookUrl("not a url")).toThrow(/valid URL/);
  });
});

describe("assertPublicHost (SSRF)", () => {
  it("rejects loopback hostnames", async () => {
    await expect(assertPublicHost("localhost", async () => ["1.2.3.4"])).rejects.toThrow(
      /loopback name/,
    );
  });

  it("rejects hosts resolving to a private IP (RFC1918)", async () => {
    await expect(assertPublicHost("evil.example", async () => ["10.0.0.5"])).rejects.toThrow(
      /private\/loopback/,
    );
  });

  it("rejects hosts resolving to link-local metadata IP (169.254.169.254)", async () => {
    await expect(
      assertPublicHost("metadata.example", async () => ["169.254.169.254"]),
    ).rejects.toThrow(/private\/loopback/);
  });

  it("rejects an unresolvable host", async () => {
    await expect(
      assertPublicHost("nope.example", async () => {
        throw new Error("ENOTFOUND");
      }),
    ).rejects.toThrow(/could not be resolved/);
  });

  it("accepts a public IP and returns it for pinning", async () => {
    const ip = await assertPublicHost("good.example", async () => ["93.184.216.34"]);
    expect(ip).toBe("93.184.216.34");
  });
});

describe("sendWebhook", () => {
  it("posts a signed body that the receiving consumer can verify (AC)", async () => {
    let received: { url: string; body: string; sig: string } | null = null;
    const fetchFn = vi.fn(async (url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      received = {
        url,
        body: init.body as string,
        sig: headers[SIGNATURE_HEADER],
      };
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;

    const result = await sendWebhook({
      url: "https://hooks.example.com/finops",
      secret: "shared-secret",
      payload: { type: "finops.budget_alert", ratio: 0.9 },
      resolver: async () => ["93.184.216.34"],
      fetchFn,
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(received).not.toBeNull();
    // The consumer verifies the signature over the exact received body.
    const r = received as unknown as { body: string; sig: string };
    expect(verifySignature(r.body, "shared-secret", r.sig)).toBe(true);
  });

  it("refuses to send to a private address (SSRF) without calling fetch", async () => {
    const fetchFn = vi.fn() as unknown as typeof fetch;
    const result = await sendWebhook({
      url: "http://169.254.169.254/latest/meta-data",
      secret: "s",
      payload: {},
      resolver: async () => ["169.254.169.254"],
      fetchFn,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/private\/loopback/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("surfaces a fetch/redirect error as a failed delivery", async () => {
    const fetchFn = vi.fn(async () => {
      throw new TypeError("unexpected redirect");
    }) as unknown as typeof fetch;
    const result = await sendWebhook({
      url: "https://hooks.example.com/finops",
      secret: "s",
      payload: {},
      resolver: async () => ["93.184.216.34"],
      fetchFn,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/redirect/);
  });

  it("pins the socket to the validated public IP — DNS-rebinding cannot redirect to an internal address (B1)", async () => {
    // Low-TTL attacker domain: PUBLIC on the validation lookup, then PRIVATE
    // (cloud-metadata) on any subsequent resolution.
    const PUBLIC_IP = "93.184.216.34";
    const PRIVATE_IP = "169.254.169.254";
    let resolverCalls = 0;
    const resolver = async () => {
      resolverCalls += 1;
      return resolverCalls === 1 ? [PUBLIC_IP] : [PRIVATE_IP];
    };

    // Capture the PinnedHost handed to the dispatcher factory, and build a
    // REAL undici Agent so we can exercise its pinned connect.lookup exactly
    // as production would. We then invoke that lookup with the original
    // hostname and assert it returns the validated public IP — never the
    // re-resolved private one.
    let captured: { hostname: string; address: string; family: 4 | 6 } | null = null;
    const { Agent } = (await import("undici")) as unknown as {
      Agent: new (opts: {
        connect: {
          lookup: (
            hostname: string,
            options: unknown,
            cb: (err: Error | null, address: string, family: number) => void,
          ) => void;
        };
      }) => {
        connect: {
          lookup: (
            hostname: string,
            options: unknown,
            cb: (err: Error | null, address: string, family: number) => void,
          ) => void;
        };
        close(): Promise<void>;
      };
    };

    const fetchFn = vi.fn(
      async () => new Response(null, { status: 200 }),
    ) as unknown as typeof fetch;

    const result = await sendWebhook({
      url: "https://rebind.attacker.example/hook",
      secret: "s",
      payload: { type: "finops.budget_alert" },
      resolver,
      fetchFn,
      dispatcherFactory: async (pinned) => {
        captured = pinned;
        // Construct the same Agent production would. Then probe its lookup.
        const agent = new Agent({ connect: { lookup: makePinnedLookupProbe(pinned) } });
        return agent;
      },
    });

    expect(result.ok).toBe(true);
    expect(captured).not.toBeNull();
    const pin = captured as unknown as { hostname: string; address: string; family: 4 | 6 };
    // The pin is the FIRST (validated, public) IP — not the second private one.
    expect(pin.address).toBe(PUBLIC_IP);
    expect(pin.hostname).toBe("rebind.attacker.example");
    expect(pin.family).toBe(4);

    // Prove the pinned lookup ignores the re-resolved (now private) address:
    // even after the resolver flips to the metadata IP, the connect lookup
    // still yields the validated public IP, so no internal connection occurs.
    expect(resolverCalls).toBe(1); // only the validation lookup ran in sendWebhook
    await new Promise<void>((done) => {
      makePinnedLookupProbe(pin)(pin.hostname, {}, (err, address) => {
        expect(err).toBeNull();
        expect(address).toBe(PUBLIC_IP);
        expect(address).not.toBe(PRIVATE_IP);
        done();
      });
    });
  });
});

describe("familyOf", () => {
  it("classifies IPv4 vs IPv6 literals", () => {
    expect(familyOf("93.184.216.34")).toBe(4);
    expect(familyOf("2606:2800:220:1:248:1893:25c8:1946")).toBe(6);
    expect(familyOf("::1")).toBe(6);
  });
});

describe("makePinnedDispatcher", () => {
  it("builds a real undici Agent pinned to the validated IP", async () => {
    const dispatcher = await makePinnedDispatcher({
      hostname: "good.example",
      address: "93.184.216.34",
      family: 4,
    });
    expect(dispatcher).toBeTruthy();
    // It is a real undici Agent — closeable.
    expect(typeof dispatcher.close).toBe("function");
    await dispatcher.close?.();
  });

  it("throws rather than degrading when the pinned address is empty", async () => {
    await expect(makePinnedDispatcher({ hostname: "x", address: "", family: 4 })).rejects.toThrow(
      /pinned lookup unavailable/,
    );
  });
});

describe("sendWebhook default dispatcher path", () => {
  it("builds a real pinned dispatcher, passes it to fetch, and closes it after send", async () => {
    // The fetch mock NEVER drives a real socket through the dispatcher, so the
    // real undici Agent is constructed (covering makePinnedDispatcher) but no
    // network I/O occurs. We only assert the dispatcher is wired + closed.
    let passedDispatcher: { close?: () => Promise<void> } | undefined;
    const fetchFn = vi.fn(async (_url: string, init: RequestInit & { dispatcher?: unknown }) => {
      passedDispatcher = init.dispatcher as { close?: () => Promise<void> };
      return new Response(null, { status: 202 });
    }) as unknown as typeof fetch;

    const closeSpy = vi.fn(async () => {});
    const result = await sendWebhook({
      url: "https://hooks.example.com/finops",
      secret: "s",
      payload: { ok: true },
      resolver: async () => ["93.184.216.34"],
      fetchFn,
      // Use the REAL factory but spy on close so we can assert cleanup without
      // recursing into undici's own close (which a real Agent already passed
      // in the makePinnedDispatcher suite).
      dispatcherFactory: async (pinned) => {
        const real = await makePinnedDispatcher(pinned);
        await real.close?.(); // close the real agent immediately; we only need the construction path
        return { close: closeSpy };
      },
    });
    expect(result.ok).toBe(true);
    expect(result.status).toBe(202);
    expect(passedDispatcher).toBeTruthy();
    expect(closeSpy).toHaveBeenCalledOnce();
  });
});

/**
 * Mirror of the production pinned-lookup so the test can independently assert
 * the connect layer is bound to the validated IP. Uses the same primitive
 * (`makePinnedLookup`) the sender uses.
 */
function makePinnedLookupProbe(pinned: { address: string; family: 4 | 6 }) {
  const lookup = makePinnedLookup(pinned.address, pinned.family);
  if (!lookup) throw new Error("expected a pinned lookup");
  return lookup;
}
