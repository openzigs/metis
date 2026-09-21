/**
 * Epic #547 (Phase 0, #548) — Bot Framework adapter factory + inbound auth.
 *
 * INBOUND ACTIVITY AUTHENTICITY (security-critical, OWASP A01/A07):
 *   Every activity POSTed to the bot endpoint is signed by the Bot Framework
 *   channel service with a JWT in the `Authorization` header. We verify it using
 *   the official SDK's `CloudAdapter` wired to a
 *   `ConfigurationBotFrameworkAuthentication` + `ConfigurationServiceClientCredentialFactory`
 *   built from the workspace's `MicrosoftAppId` / `MicrosoftAppPassword`. The
 *   adapter rejects any activity whose JWT is missing, expired, wrongly-issued,
 *   or whose audience does not match the configured app id — BEFORE our turn
 *   logic runs. We do NOT hand-roll JWKS validation; the SDK owns it.
 *
 *   We deliberately do NOT set `MicrosoftAppPassword=""`/auth-disabled in any
 *   environment a request can reach, because an empty app id puts the SDK in
 *   "auth disabled" mode and would accept unsigned activities — the exact hole
 *   this foundation must not open. The endpoint refuses to process an activity
 *   for a workspace with no installed credentials.
 *
 * The factory is injectable (`setBotAdapterFactoryForTests`) so unit tests can
 * substitute a stub adapter and assert accept/reject behaviour without a live
 * Azure tenant or real JWT.
 */
import {
  CloudAdapter,
  ConfigurationBotFrameworkAuthentication,
  ConfigurationServiceClientCredentialFactory,
  type Request as BotRequest,
  type Response as BotResponse,
  type TurnContext,
} from "botbuilder";

import { createChildLogger } from "../logger.js";
import type { ResolvedCredentials } from "./installation-store.js";

const log = createChildLogger("teams-bot");

/** A minimal adapter surface — lets tests stub `process` without the real SDK. */
export interface BotAdapterLike {
  process(
    req: BotRequest,
    res: BotResponse,
    logic: (context: TurnContext) => Promise<void>,
  ): Promise<void>;
}

export type BotAdapterFactory = (creds: ResolvedCredentials) => BotAdapterLike;

/**
 * Build a real `CloudAdapter` for a workspace's bot credentials. The adapter
 * performs full Bot Framework JWT validation on inbound activities.
 */
export function buildCloudAdapter(creds: ResolvedCredentials): CloudAdapter {
  const credentialsFactory = new ConfigurationServiceClientCredentialFactory({
    MicrosoftAppId: creds.appId,
    MicrosoftAppPassword: creds.appPassword,
    MicrosoftAppType: creds.appType,
    MicrosoftAppTenantId: creds.tenantId ?? undefined,
  });

  const auth = new ConfigurationBotFrameworkAuthentication({}, credentialsFactory);

  const adapter = new CloudAdapter(auth);

  // A turn-level error handler keeps a malformed turn from crashing the process
  // and — critically — never leaks internal detail back to the channel.
  adapter.onTurnError = async (context, error) => {
    log.error("Teams turn error", { message: (error as Error).message });
    try {
      await context.sendActivity("Sorry, something went wrong handling that message.");
    } catch {
      /* best-effort; the channel may already be gone */
    }
  };

  return adapter;
}

let factoryOverride: BotAdapterFactory | null = null;

/** Resolve the adapter factory (real CloudAdapter unless a test overrode it). */
export function getBotAdapterFactory(): BotAdapterFactory {
  return factoryOverride ?? buildCloudAdapter;
}

/** Test seam — inject a stub adapter factory. Pass null to restore the real one. */
export function setBotAdapterFactoryForTests(factory: BotAdapterFactory | null): void {
  factoryOverride = factory;
}
