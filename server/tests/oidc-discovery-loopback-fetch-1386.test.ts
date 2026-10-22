/**
 * #1386 (#1393 review) — when discovery lifts openid-client's HTTPS rule for a
 * loopback IdP, it must also install `loopbackOnlyHttpFetch`, or the token and
 * JWKS endpoints the discovery document names could be plain HTTP anywhere.
 * This pins the WIRING; `sso-landing-and-http-idp-1386.test.ts` pins the fetch.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const discovery = vi.hoisted(() => vi.fn(async () => ({ serverMetadata: () => ({}) })));
vi.mock("openid-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openid-client")>()),
  discovery,
}));

import * as openidClient from "openid-client";
import {
  __clearDiscoveryCache,
  discoverOIDC,
  loopbackOnlyHttpFetch,
} from "../src/lib/auth/oidc-provider.js";

afterEach(() => {
  __clearDiscoveryCache();
  discovery.mockClear();
  vi.unstubAllEnvs();
});

const config = (discoveryUrl: string) => ({
  discoveryUrl,
  clientId: "c",
  clientSecret: "s",
  redirectUri: "http://127.0.0.1/cb",
  scopes: ["openid"],
  pkceEnabled: true,
});

describe("discoverOIDC wiring (#1386)", () => {
  it("a loopback HTTP IdP gets allowInsecureRequests AND the loopback-only fetch", async () => {
    vi.stubEnv("NODE_ENV", "development");
    await discoverOIDC(config("http://127.0.0.1:4600/.well-known/openid-configuration"));
    const options = (discovery.mock.calls[0] as unknown[])[4] as Record<string | symbol, unknown>;
    expect(options.execute).toEqual([openidClient.allowInsecureRequests]);
    expect(options[openidClient.customFetch]).toBe(loopbackOnlyHttpFetch);
  });

  it("an HTTPS IdP gets neither", async () => {
    await discoverOIDC(config("https://idp.example.test/.well-known/openid-configuration"));
    expect((discovery.mock.calls[0] as unknown[])[4]).toBeUndefined();
  });
});
