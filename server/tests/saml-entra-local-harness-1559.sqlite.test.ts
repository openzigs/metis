/**
 * #1559 — the local Entra mock runner (`scripts/lib/entra-idp-harness.mjs`,
 * `make entra-up`) against METIS's real routes and a real (migrated SQLite)
 * database, over loopback:
 *
 *   the runner logs in as the mock admin and PUTs the SAML provider from the
 *   mock's Federation Metadata through the admin API → METIS's AuthnRequest
 *   redirect → the mock's account picker → the picked account's Response → the
 *   ACS → the issued session.
 *
 * Each preset user lands with the role the runner's banner promises, and
 * Entra's default signing option, picked on the picker, is refused.
 */
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import request from "supertest";
import type { Application } from "express";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import {
  createMigratedSqlite,
  type MigratedSqlite,
  MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
} from "./helpers/sqlite-migrated-db.js";

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("../src/lib/prisma.js", async () => {
  const { Prisma } = await import("@prisma/client");
  return {
    get prisma() {
      return state.db;
    },
    Prisma,
  };
});

const { createApp } = await import("../src/app.js");
const { __resetProviders } = await import("../src/lib/auth/sso-config.js");
const { __resetSAMLInstances } = await import("../src/lib/auth/saml-provider.js");
const { verifyAccessToken } = await import("../src/lib/auth/jwt.js");

interface PresetAccount {
  user: { upn: string; displayName: string };
  profile?: { mfa?: boolean; groupOverage?: boolean };
  expectedRole: string;
}
interface HarnessConfig {
  port: number;
  metisApiUrl: string;
  [key: string]: unknown;
}
// A URL specifier: the scripts package ships plain `.mjs` with no declarations.
const harnessModule = new URL("../../scripts/lib/entra-idp-harness.mjs", import.meta.url);
const { PRESET_ACCOUNTS, resolveHarnessConfig, runEntraHarness } = (await import(
  harnessModule.href
)) as {
  PRESET_ACCOUNTS: readonly PresetAccount[];
  resolveHarnessConfig(env: Record<string, string>, argv: string[]): HarnessConfig;
  runEntraHarness(input: { config: HarnessConfig }): Promise<{
    idp: { ssoUrl: string; close(): Promise<void> };
    banner: string;
  }>;
};

const UI_ORIGIN = "https://metis.test";

function cookieValue(res: request.Response, name: string): string {
  const raw = (res.headers["set-cookie"] as unknown as string[] | undefined) ?? [];
  const line = raw.find((l) => l.startsWith(`${name}=`));
  if (!line) throw new Error(`cookie ${name} missing`);
  return decodeURIComponent(line.slice(line.indexOf("=") + 1, line.indexOf(";")));
}

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1559 — make entra-up's mock and seed against METIS (real SQLite)",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let app: Application;
    let server: Server;
    let idp: { ssoUrl: string; close(): Promise<void> };
    let banner: string;
    const previousCors = process.env.CORS_ORIGIN;

    beforeAll(async () => {
      sqlite = createMigratedSqlite("1559-entra-harness");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      process.env.CORS_ORIGIN = UI_ORIGIN;
      app = createApp({ corsOrigin: UI_ORIGIN });
      server = app.listen(0, "127.0.0.1");
      await new Promise((resolve) => server.once("listening", resolve));
      const api = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      ({ idp, banner } = await runEntraHarness({
        config: resolveHarnessConfig({ METIS_API_URL: api, ENTRA_IDP_PORT: "0" }, []),
      }));
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await idp?.close();
      await new Promise((resolve) => server?.close(resolve));
      __resetProviders();
      __resetSAMLInstances();
      process.env.CORS_ORIGIN = previousCors;
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    /** METIS → the mock's picker → the picked account → METIS's ACS. */
    async function signIn(account: number, signing: string) {
      const start = await request(app).get("/api/auth/saml/login");
      expect(start.status).toBe(302);
      const location = new URL(start.headers.location);
      expect(`${location.origin}${location.pathname}`).toBe(idp.ssoUrl);
      const picker = await (await fetch(location)).text();
      expect(picker).toContain("Pick an account");
      const posted = await fetch(idp.ssoUrl, {
        method: "POST",
        body: new URLSearchParams({
          SAMLRequest: location.searchParams.get("SAMLRequest") ?? "",
          account: String(account),
          signing,
        }),
      });
      expect(posted.status).toBe(200);
      const form = await posted.text();
      const samlResponse = /name="SAMLResponse" value="([^"]*)"/.exec(form)![1];
      // Post where the browser would: the auto-posting form's action, the seeded ACS URL.
      const action = new URL(
        /<form method="POST" name="hiddenform" action="([^"]*)"/.exec(form)![1],
      );
      return request(app).post(action.pathname).type("form").send({ SAMLResponse: samlResponse });
    }

    it("the seed enables the provider on the login page", async () => {
      const res = await request(app).get("/api/auth/sso/providers");
      expect(res.status).toBe(200);
      expect(res.body.data.providers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ label: "Microsoft Entra ID (mock)", type: "saml" }),
        ]),
      );
      expect(banner).toContain("button 'Microsoft Entra ID (mock)'");
    });

    it.each(PRESET_ACCOUNTS.map((a, i) => [a.user.displayName, i, a] as const))(
      "%s lands with the role the banner names, and MFA as the preset says",
      async (_name, index, account) => {
        const acs = await signIn(index, "both");
        expect(acs.status).toBe(302);
        expect(acs.headers.location).toBe(`${UI_ORIGIN}/dashboard`);
        const token = cookieValue(acs, "metis.at");
        const me = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${token}`);
        expect(me.body.data.user.role).toBe(account.expectedRole);
        expect(verifyAccessToken(token).mfaPassed).toBe(account.profile?.mfa === true);
      },
    );

    it("picking Entra's default signing option is refused, naming the option to choose", async () => {
      const acs = await signIn(0, "assertion");
      expect(acs.status).toBe(401);
      expect(acs.body.error.message).toMatch(/"Sign SAML response and assertion"/);
    });
  },
);
