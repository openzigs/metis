/**
 * Issue #579 (epic #63) — Slack OAuth v2 install flow.
 *
 * The "Add to Slack" install round-trip:
 *   1. The admin is redirected to Slack's authorize URL ({@link buildAuthorizeUrl})
 *      carrying our client id, requested scopes, and a signed `state` (CSRF).
 *   2. Slack redirects back to our callback with a `code` + the same `state`.
 *   3. We exchange the `code` for a bot token via `oauth.v2.access`
 *      ({@link completeSlackOAuth}) and persist it ENCRYPTED in the vault via the
 *      installation store — the plaintext `xoxb-...` token never touches a log,
 *      response, or the installation row (only a `${vault:label}` ref).
 *
 * SECURITY:
 *   - `state` is an HMAC-signed, time-bounded token binding the install to a
 *     workspace (CSRF / install-fixation protection). A forged/expired/foreign
 *     state is rejected before any token exchange.
 *   - The bot token is stored encrypted (OWASP A02) by the installation store.
 *   - The token-exchange transport is INJECTED so this is unit-tested without a
 *     live Slack call.
 */
import crypto from "node:crypto";

import { createChildLogger } from "../logger.js";
import {
  getSlackInstallationStore,
  type SlackInstallationStore,
  type SlackInstallationSummary,
} from "./installation-store.js";

const log = createChildLogger("slack-oauth");

/** Lifetime of a signed OAuth `state` token — 10 minutes. */
export const STATE_TTL_SECONDS = 60 * 10;

const AUTHORIZE_URL = "https://slack.com/oauth/v2/authorize";

/** The fields we encode into the signed `state`. */
interface StatePayload {
  /** The METIS workspace the install is for. */
  workspaceId: string;
  /** The METIS user who initiated the install (audit/provenance). */
  userId: string | null;
  /** Issued-at unix seconds (for TTL enforcement). */
  iat: number;
}

/** Sign a `state` payload as `base64url(json).hex(hmac)` (CSRF-resistant). */
export function signOAuthState(
  payload: { workspaceId: string; userId?: string | null },
  stateSecret: string,
  nowMs: number = Date.now(),
): string {
  const body: StatePayload = {
    workspaceId: payload.workspaceId,
    userId: payload.userId ?? null,
    iat: Math.floor(nowMs / 1000),
  };
  const encoded = Buffer.from(JSON.stringify(body), "utf8").toString("base64url");
  const sig = crypto.createHmac("sha256", stateSecret).update(encoded).digest("hex");
  return `${encoded}.${sig}`;
}

/**
 * Verify + decode a signed `state`. Returns the payload or null when the
 * signature is invalid, the token is malformed, or it has expired. Constant-time
 * signature compare; never throws on malformed input.
 */
export function verifyOAuthState(
  state: string | undefined | null,
  stateSecret: string,
  nowMs: number = Date.now(),
): StatePayload | null {
  const raw = (state ?? "").trim();
  const dot = raw.indexOf(".");
  if (dot <= 0) return null;
  const encoded = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);

  const expected = crypto.createHmac("sha256", stateSecret).update(encoded).digest("hex");
  if (
    sig.length !== expected.length ||
    !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
  ) {
    return null;
  }

  let payload: StatePayload;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as StatePayload;
  } catch {
    return null;
  }
  if (!payload || typeof payload.workspaceId !== "string" || typeof payload.iat !== "number") {
    return null;
  }
  if (Math.floor(nowMs / 1000) - payload.iat > STATE_TTL_SECONDS) return null;
  return payload;
}

/** Build the Slack authorize URL the admin is redirected to. */
export function buildAuthorizeUrl(params: {
  clientId: string;
  scopes: string[];
  state: string;
  redirectUri?: string | null;
}): string {
  const u = new URL(AUTHORIZE_URL);
  u.searchParams.set("client_id", params.clientId);
  u.searchParams.set("scope", params.scopes.join(","));
  u.searchParams.set("state", params.state);
  if (params.redirectUri) u.searchParams.set("redirect_uri", params.redirectUri);
  return u.toString();
}

/** The (subset of the) `oauth.v2.access` response we consume. */
export interface OAuthAccessResult {
  ok: boolean;
  access_token?: string; // the bot token (xoxb-...)
  bot_user_id?: string;
  team?: { id?: string; name?: string };
  error?: string;
}

/** Injectable transport that performs the `code`→token exchange. */
export type SlackTokenExchange = (params: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri?: string | null;
}) => Promise<OAuthAccessResult>;

export class SlackOAuthError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SlackOAuthError";
  }
}

export interface CompleteOAuthParams {
  clientId: string;
  clientSecret: string;
  stateSecret: string;
  code: string;
  state: string;
  redirectUri?: string | null;
  /** Injected token exchange (defaults to the real `@slack/web-api` call). */
  exchange?: SlackTokenExchange;
  store?: SlackInstallationStore;
  nowMs?: number;
}

/**
 * Complete the OAuth round-trip: verify `state`, exchange `code` for a bot token,
 * and persist it ENCRYPTED via the installation store. Returns the secret-free
 * installation summary. Throws {@link SlackOAuthError} (never leaks the token) on
 * any failure.
 */
export async function completeSlackOAuth(
  params: CompleteOAuthParams,
): Promise<SlackInstallationSummary> {
  const payload = verifyOAuthState(params.state, params.stateSecret, params.nowMs);
  if (!payload) {
    throw new SlackOAuthError(400, "INVALID_STATE", "OAuth state is invalid or expired");
  }
  const code = (params.code ?? "").trim();
  if (!code) {
    throw new SlackOAuthError(400, "MISSING_CODE", "OAuth code is required");
  }

  const exchange = params.exchange ?? defaultExchange;
  let result: OAuthAccessResult;
  try {
    result = await exchange({
      clientId: params.clientId,
      clientSecret: params.clientSecret,
      code,
      redirectUri: params.redirectUri ?? null,
    });
  } catch (err) {
    log.warn("Slack token exchange threw", { message: (err as Error).message });
    throw new SlackOAuthError(502, "EXCHANGE_FAILED", "Slack token exchange failed");
  }

  if (!result.ok || !result.access_token || !result.team?.id) {
    log.warn("Slack token exchange returned an error", { error: result.error });
    throw new SlackOAuthError(502, "EXCHANGE_FAILED", "Slack token exchange failed");
  }

  const store = params.store ?? getSlackInstallationStore();
  return store.install({
    workspaceId: payload.workspaceId,
    slackTeamId: result.team.id,
    slackTeamName: result.team.name ?? null,
    botUserId: result.bot_user_id ?? null,
    botToken: result.access_token,
    createdById: payload.userId,
  });
}

/** The real `oauth.v2.access` transport (lazy-imports `@slack/web-api`). */
const defaultExchange: SlackTokenExchange = async (params) => {
  const { WebClient } = await import("@slack/web-api");
  const client = new WebClient();
  const res = await client.oauth.v2.access({
    client_id: params.clientId,
    client_secret: params.clientSecret,
    code: params.code,
    ...(params.redirectUri ? { redirect_uri: params.redirectUri } : {}),
  });
  return res as unknown as OAuthAccessResult;
};
