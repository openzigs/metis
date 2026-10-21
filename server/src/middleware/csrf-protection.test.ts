/**
 * #913 — the CSRF guard's decision. Its wiring into `createApp` (ordering after
 * `cookieParser`, the SAML exemption, the bearer bypass) is asserted end to end
 * in `tests/app.test.ts`.
 */
import { describe, expect, it } from "vitest";
import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";
import { crossOriginReason, csrfProtection, normaliseOrigin } from "./csrf-protection.js";
import { errorHandler } from "./error-handler.js";

const trusted = new Set(["https://metis.example.com"]);
const h = (over: Record<string, string>) => ({ host: "api.example.com", ...over });

describe("crossOriginReason", () => {
  it("requires the custom header", () => {
    expect(crossOriginReason(h({}), trusted)).toMatch(/X-METIS-CSRF/);
    expect(crossOriginReason(h({ "x-metis-csrf": "  " }), trusted)).toMatch(/X-METIS-CSRF/);
  });

  it("passes same-origin and user-initiated Fetch Metadata", () => {
    for (const site of ["same-origin", "none", "SAME-ORIGIN"]) {
      expect(crossOriginReason(h({ "x-metis-csrf": "1", "sec-fetch-site": site }), trusted)).toBe(
        null,
      );
    }
  });

  it("refuses same-site and cross-site Fetch Metadata from an untrusted origin", () => {
    for (const site of ["same-site", "cross-site"]) {
      expect(
        crossOriginReason(
          h({ "x-metis-csrf": "1", "sec-fetch-site": site, origin: "https://evil.example.com" }),
          trusted,
        ),
      ).toBe(`Sec-Fetch-Site: ${site}`);
    }
  });

  it("passes a trusted origin whatever Fetch Metadata says", () => {
    expect(
      crossOriginReason(
        h({
          "x-metis-csrf": "1",
          "sec-fetch-site": "same-site",
          origin: "https://metis.example.com",
        }),
        trusted,
      ),
    ).toBe(null);
  });

  it("falls back to Origin vs Host without Fetch Metadata", () => {
    const ok = h({ "x-metis-csrf": "1", origin: "http://api.example.com" });
    expect(crossOriginReason(ok, trusted)).toBe(null);
    const bad = h({ "x-metis-csrf": "1", origin: "http://evil.example.com" });
    expect(crossOriginReason(bad, trusted)).toBe("cross-origin Origin");
    expect(crossOriginReason(h({ "x-metis-csrf": "1", origin: "null" }), trusted)).toBe(
      "opaque Origin",
    );
    expect(
      crossOriginReason({ "x-metis-csrf": "1", origin: "http://api.example.com" }, trusted),
    ).toBe("cross-origin Origin");
  });

  it("passes a request with neither Origin nor Fetch Metadata (not a browser)", () => {
    expect(crossOriginReason(h({ "x-metis-csrf": "1" }), trusted)).toBe(null);
  });

  it("reads the first value of a repeated header", () => {
    expect(crossOriginReason({ "x-metis-csrf": ["1", ""], host: "a" }, trusted)).toBe(null);
  });
});

describe("normaliseOrigin", () => {
  it("keeps http(s) origins and drops everything else", () => {
    expect(normaliseOrigin("https://a.example.com/path")).toBe("https://a.example.com");
    expect(normaliseOrigin("null")).toBe(null);
    expect(normaliseOrigin(undefined)).toBe(null);
    expect(normaliseOrigin("not a url")).toBe(null);
    expect(normaliseOrigin("file:///etc/passwd")).toBe(null);
  });
});

describe("csrfProtection", () => {
  const app = express();
  app.use(cookieParser());
  app.use(csrfProtection({ trustedOrigins: ["https://metis.example.com", "not a url"] }));
  app.all("/api/thing", (_req, res) => {
    res.json({ ok: true });
  });
  app.post("/api/auth/saml/acs", (_req, res) => {
    res.json({ ok: true });
  });
  app.use(errorHandler);

  it("refuses a cookie-authenticated POST, PUT, PATCH and DELETE without the header", async () => {
    for (const method of ["post", "put", "patch", "delete"] as const) {
      const res = await request(app)[method]("/api/thing").set("Cookie", "accessToken=t");
      expect(res.status, method).toBe(403);
      expect(res.body.error.code).toBe("CSRF_REJECTED");
    }
  });

  it("passes a request with no session cookie, or an empty one", async () => {
    expect((await request(app).post("/api/thing")).status).toBe(200);
    expect((await request(app).post("/api/thing").set("Cookie", "theme=dark")).status).toBe(200);
    expect((await request(app).post("/api/thing").set("Cookie", "accessToken=")).status).toBe(200);
  });

  it("gates the refresh cookie as well as the access cookie", async () => {
    const res = await request(app).post("/api/thing").set("Cookie", "refreshToken=r");
    expect(res.status).toBe(403);
  });

  it("does not let an empty bearer header bypass the check", async () => {
    const res = await request(app)
      .post("/api/thing")
      .set("Authorization", "Bearer   ")
      .set("Cookie", "accessToken=t");
    expect(res.status).toBe(403);
  });

  it("passes a non-empty bearer header, and safe methods", async () => {
    const bearer = await request(app)
      .post("/api/thing")
      .set("Authorization", "Bearer t")
      .set("Cookie", "accessToken=t");
    expect(bearer.status).toBe(200);
    const get = await request(app).get("/api/thing").set("Cookie", "accessToken=t");
    expect(get.status).toBe(200);
  });

  it("exempts the SAML ACS only", async () => {
    const res = await request(app)
      .post("/api/auth/saml/acs")
      .set("Cookie", "accessToken=t")
      .set("Sec-Fetch-Site", "cross-site");
    expect(res.status).toBe(200);
  });

  it("works with no options", async () => {
    const bare = express();
    bare.use(cookieParser());
    bare.use(csrfProtection());
    bare.post("/x", (_req, res) => {
      res.json({ ok: true });
    });
    bare.use(errorHandler);
    expect((await request(bare).post("/x").set("Cookie", "accessToken=t")).status).toBe(403);
  });
});
