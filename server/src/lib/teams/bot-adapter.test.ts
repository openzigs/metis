/**
 * Epic #547 (Phase 0, #548) — bot adapter factory tests.
 *
 * The real Bot Framework JWT validation lives inside the SDK CloudAdapter and is
 * exercised end-to-end only against a live channel (documented manual step). Here
 * we assert the seam contract:
 *   - `buildCloudAdapter` constructs a real CloudAdapter from resolved creds
 *     (which is what performs inbound JWT validation);
 *   - the factory override seam lets tests substitute a stub adapter and is
 *     restorable to the real factory.
 */
import { createRequire } from "node:module";

import { afterEach, describe, expect, it } from "vitest";
import { CloudAdapter } from "botbuilder";

import {
  buildCloudAdapter,
  buildCredentialsFactory,
  getBotAdapterFactory,
  setBotAdapterFactoryForTests,
  type BotAdapterLike,
} from "./bot-adapter.js";

const CREDS = {
  appId: "11111111-2222-3333-4444-555555555555",
  appPassword: "bot-password",
  appType: "MultiTenant",
  tenantId: null,
};

describe("bot adapter factory (#548)", () => {
  afterEach(() => {
    setBotAdapterFactoryForTests(null);
  });

  it("buildCloudAdapter returns a real CloudAdapter (the JWT-validating adapter)", () => {
    const adapter = buildCloudAdapter(CREDS);
    expect(adapter).toBeInstanceOf(CloudAdapter);
    // A turn-error handler is wired so a bad turn never crashes the process.
    expect(typeof adapter.onTurnError).toBe("function");
  });

  it("onTurnError sends a generic message and never leaks internal detail", async () => {
    const adapter = buildCloudAdapter(CREDS);
    const sent: string[] = [];
    const fakeContext = {
      sendActivity: async (text: string) => {
        sent.push(text);
        return { id: "r" };
      },
    } as never;
    await adapter.onTurnError(fakeContext, new Error("stack trace with secrets"));
    expect(sent).toHaveLength(1);
    expect(sent[0]).not.toContain("secrets");
  });

  it("onTurnError swallows a send failure (channel gone)", async () => {
    const adapter = buildCloudAdapter(CREDS);
    const fakeContext = {
      sendActivity: async () => {
        throw new Error("channel gone");
      },
    } as never;
    await expect(adapter.onTurnError(fakeContext, new Error("boom"))).resolves.toBeUndefined();
  });

  it("builds a SingleTenant adapter when a tenantId is supplied", () => {
    const adapter = buildCloudAdapter({
      ...CREDS,
      appType: "SingleTenant",
      tenantId: "tenant-1",
    });
    expect(adapter).toBeInstanceOf(CloudAdapter);
  });

  it("defaults to the real factory and honours a test override", () => {
    expect(getBotAdapterFactory()).toBe(buildCloudAdapter);

    const stub: BotAdapterLike = { process: async () => undefined };
    setBotAdapterFactoryForTests(() => stub);
    expect(getBotAdapterFactory()(CREDS)).toBe(stub);

    setBotAdapterFactoryForTests(null);
    expect(getBotAdapterFactory()).toBe(buildCloudAdapter);
  });
});

/**
 * #1466 — botbuilder chooses the auth path from `MicrosoftAppType`. These build
 * the credentials botbuilder would use for an outbound call and assert which
 * kind they are, through its public `createCredentials`.
 */
describe("Bot Framework auth path by app type (#1466)", () => {
  // botframework-connector is botbuilder's dependency, not the server's: load it
  // the way botbuilder does at runtime.
  const connector = createRequire(createRequire(import.meta.url).resolve("botbuilder"))(
    "botframework-connector",
  ) as {
    ManagedIdentityAppCredentials: new (...args: never[]) => unknown;
    MicrosoftAppCredentials: new (...args: never[]) => unknown;
  };
  const AUDIENCE = "https://api.botframework.com";
  const LOGIN = "https://login.microsoftonline.com/botframework.com";
  const MSI_CREDS = {
    appId: "99999999-8888-7777-6666-555555555555",
    appPassword: "",
    appType: "UserAssignedMsi",
    tenantId: "tenant-1",
  };

  it("a UserAssignedMsi installation authenticates as the managed identity, not MultiTenant", async () => {
    const factory = buildCredentialsFactory(MSI_CREDS);
    const credentials = await factory.createCredentials(MSI_CREDS.appId, AUDIENCE, LOGIN, true);
    expect(credentials).toBeInstanceOf(connector.ManagedIdentityAppCredentials);
    expect(credentials).not.toBeInstanceOf(connector.MicrosoftAppCredentials);
    expect(await factory.isAuthenticationDisabled()).toBe(false);
    // And the full adapter builds on it: botbuilder's MSI assertions (tenant set,
    // no password) all pass.
    expect(buildCloudAdapter(MSI_CREDS)).toBeInstanceOf(CloudAdapter);
  });

  it("the pre-#1466 spelling `UserAssignedMSID` is what fell through to MultiTenant", async () => {
    // Raw, unnormalised: botbuilder does not recognise it and builds app-password
    // credentials. The store maps this spelling on read so it never gets here.
    const legacy = { ...MSI_CREDS, appType: "UserAssignedMSID", appPassword: "pw" };
    const credentials = await buildCredentialsFactory(legacy).createCredentials(
      legacy.appId,
      AUDIENCE,
      LOGIN,
      true,
    );
    expect(credentials).toBeInstanceOf(connector.MicrosoftAppCredentials);
    expect(credentials).not.toBeInstanceOf(connector.ManagedIdentityAppCredentials);
  });

  it("a MultiTenant installation still authenticates with its app password", async () => {
    const credentials = await buildCredentialsFactory(CREDS).createCredentials(
      CREDS.appId,
      AUDIENCE,
      LOGIN,
      true,
    );
    expect(credentials).toBeInstanceOf(connector.MicrosoftAppCredentials);
  });
});
