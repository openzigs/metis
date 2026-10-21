/**
 * #1349 — the origin lists the socket handshake trusts, and the refusal rule.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_CORS_ORIGIN,
  normaliseOrigin,
  parseCorsOrigins,
  socketTrustedOrigins,
} from "./cors-origins.js";
import { socketOriginRefusal } from "../socket/server.js";

describe("socketTrustedOrigins", () => {
  it("unions CORS_ORIGIN and METIS_TRUSTED_ORIGINS, normalised, dropping junk", () => {
    const set = socketTrustedOrigins(undefined, {
      CORS_ORIGIN: "https://ui.test/, ,http://b.test:8080",
      METIS_TRUSTED_ORIGINS: " https://c.test , not a url, *, null",
    });
    expect([...set].sort()).toEqual(["http://b.test:8080", "https://c.test", "https://ui.test"]);
  });

  it("prefers the explicit corsOrigin and defaults to the dev UI", () => {
    expect([...socketTrustedOrigins("https://x.test", { CORS_ORIGIN: "https://y.test" })]).toEqual([
      "https://x.test",
    ]);
    expect([...socketTrustedOrigins(undefined, {})]).toEqual([DEFAULT_CORS_ORIGIN]);
  });

  it("parseCorsOrigins and normaliseOrigin keep their #913 behaviour", () => {
    expect(parseCorsOrigins(" a , ,b")).toEqual(["a", "b"]);
    expect(normaliseOrigin("ftp://x.test")).toBeNull();
    expect(normaliseOrigin("null")).toBeNull();
    expect(normaliseOrigin(undefined)).toBeNull();
  });
});

describe("socketOriginRefusal", () => {
  const trusted = new Set(["https://ui.test"]);

  it("passes no Origin, a trusted one and the API's own host", () => {
    expect(socketOriginRefusal({}, trusted)).toBeNull();
    expect(socketOriginRefusal({ origin: "https://ui.test" }, trusted)).toBeNull();
    expect(socketOriginRefusal({ origin: ["https://ui.test"] }, trusted)).toBeNull();
    expect(
      socketOriginRefusal({ origin: "https://api.test", host: "API.test" }, trusted),
    ).toBeNull();
  });

  it("refuses an opaque, malformed or foreign Origin", () => {
    expect(socketOriginRefusal({ origin: "null" }, trusted)).toBe("opaque Origin");
    expect(socketOriginRefusal({ origin: "javascript:alert(1)" }, trusted)).toBe("opaque Origin");
    expect(socketOriginRefusal({ origin: "https://evil.test", host: "api.test" }, trusted)).toBe(
      "untrusted Origin",
    );
    // A different port is a different origin.
    expect(
      socketOriginRefusal({ origin: "https://api.test:8443", host: "api.test" }, trusted),
    ).toBe("untrusted Origin");
    expect(socketOriginRefusal({ origin: "https://evil.test" }, trusted)).toBe("untrusted Origin");
  });
});
