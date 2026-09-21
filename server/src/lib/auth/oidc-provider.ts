/**
 * OIDC authentication provider via openid-client v6 with PKCE.
 *
 * Epic #748, Issue #750: OIDC provider.
 * - Discovery URL config
 * - PKCE always-on
 * - Refresh-token rotation
 * - Inspects `amr` claim for MFA passthrough (#754)
 */
import * as openidClient from "openid-client";
import { createChildLogger } from "../logger.js";
import type { SSOAuthResult, OIDCConfig } from "./sso-types.js";

const log = createChildLogger("oidc-provider");

/** AMR values that indicate multi-factor authentication. */
const MFA_AMR_VALUES = ["mfa", "otp", "hwk", "swk", "sms", "pop", "fpt", "iris", "vbm"];

/** Cache of discovered OIDC configurations. */
const discoveryCache = new Map<string, openidClient.Configuration>();

/** Maximum age for replay attack window (30 seconds). */
export const MAX_AUTH_AGE_SECONDS = 30;

/** Discover the OIDC provider configuration. */
export async function discoverOIDC(config: OIDCConfig): Promise<openidClient.Configuration> {
  const cached = discoveryCache.get(config.discoveryUrl);
  if (cached) return cached;

  const discoveryUrl = new URL(config.discoveryUrl);
  const oidcConfig = await openidClient.discovery(
    discoveryUrl,
    config.clientId,
    config.clientSecret,
  );
  discoveryCache.set(config.discoveryUrl, oidcConfig);
  log.info("OIDC discovery completed", { issuer: config.discoveryUrl });
  return oidcConfig;
}

/** Generate an authorization URL with PKCE. Returns URL + code_verifier for session storage. */
export async function generateAuthorizationUrl(
  config: OIDCConfig,
): Promise<{ url: string; codeVerifier: string; state: string; nonce: string }> {
  const oidcConfig = await discoverOIDC(config);

  const codeVerifier = openidClient.randomPKCECodeVerifier();
  const codeChallenge = await openidClient.calculatePKCECodeChallenge(codeVerifier);
  const state = openidClient.randomState();
  const nonce = openidClient.randomNonce();

  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: config.scopes.join(" "),
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state,
    nonce,
  });

  const authEndpoint = oidcConfig.serverMetadata().authorization_endpoint;
  if (!authEndpoint) throw new Error("No authorization_endpoint in OIDC discovery");

  const url = `${authEndpoint}?${params.toString()}`;
  return { url, codeVerifier, state, nonce };
}

/** Exchange authorization code for tokens (with PKCE verification). */
export async function exchangeCodeForTokens(
  config: OIDCConfig,
  code: string,
  codeVerifier: string,
  nonce: string,
): Promise<
  SSOAuthResult & { tokens?: { accessToken: string; refreshToken?: string; idToken: string } }
> {
  try {
    const oidcConfig = await discoverOIDC(config);
    const currentUrl = new URL(config.redirectUri);
    currentUrl.searchParams.set("code", code);

    const tokens = await openidClient.authorizationCodeGrant(oidcConfig, currentUrl, {
      pkceCodeVerifier: codeVerifier,
      expectedNonce: nonce,
      idTokenExpected: true,
    });

    const claims = tokens.claims();
    if (!claims) {
      return { success: false, error: "No claims in ID token" };
    }

    const email = String(claims.email ?? claims.preferred_username ?? claims.sub ?? "");
    const displayName = String(claims.name ?? claims.preferred_username ?? email);
    const username = String(claims.preferred_username ?? email.split("@")[0] ?? claims.sub ?? "");

    // Extract groups from claims
    const groupClaim = claims.groups ?? claims["cognito:groups"] ?? claims.roles ?? [];
    const groups = Array.isArray(groupClaim)
      ? (groupClaim as string[])
      : typeof groupClaim === "string"
        ? [groupClaim]
        : [];

    // Check AMR claim for MFA (#754)
    const amr = claims.amr;
    const mfaPassed = Array.isArray(amr)
      ? amr.some((v) => MFA_AMR_VALUES.includes(String(v)))
      : false;

    return {
      success: true,
      user: {
        username,
        displayName,
        email,
        groups,
        mfaPassed,
        rawClaims: claims as unknown as Record<string, unknown>,
      },
      tokens: {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        idToken: tokens.id_token!,
      },
    };
  } catch (err) {
    log.error("OIDC token exchange failed", { error: err });
    return {
      success: false,
      error: err instanceof Error ? err.message : "OIDC token exchange failed",
    };
  }
}

/** Refresh tokens using the refresh token rotation flow. */
export async function refreshOIDCTokens(
  config: OIDCConfig,
  refreshToken: string,
): Promise<{ accessToken: string; refreshToken?: string; idToken?: string } | null> {
  try {
    const oidcConfig = await discoverOIDC(config);
    const tokens = await openidClient.refreshTokenGrant(oidcConfig, refreshToken);
    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      idToken: tokens.id_token,
    };
  } catch (err) {
    log.error("OIDC token refresh failed", { error: err });
    return null;
  }
}

/** Clear the discovery cache (for testing / config changes). */
export function __clearDiscoveryCache(): void {
  discoveryCache.clear();
}
