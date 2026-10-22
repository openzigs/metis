/**
 * #1376 — `createServer` seeds the AUTH_OIDC_* / AUTH_SAML_* providers at boot.
 *
 * The seeder runs before `createApp`, so a half-configured provider stops the
 * boot before any router or socket exists. That makes the wiring observable
 * without starting a server: if `createServer` stopped calling the seeder, this
 * call would boot instead of throwing.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "../src/server.js";

afterEach(() => vi.unstubAllEnvs());

describe("createServer seeds SSO providers from the environment (#1376)", () => {
  it("refuses to boot on a half-configured OIDC provider, before building the app", () => {
    vi.stubEnv("AUTH_OIDC_CLIENT_ID", "metis");
    expect(() => createServer()).toThrow(/OIDC \(AUTH_OIDC_\*\) is half-configured/);
  });
});
