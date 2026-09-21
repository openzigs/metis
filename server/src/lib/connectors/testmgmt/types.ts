/**
 * Test management connector — Epic #856 / Issue #871.
 *
 * Internal types for the connection-service layer. The on-disk shape stored in
 * `TestManagementConnection.authConfigJson` uses `${vault:label}` refs only;
 * the `Resolved*Auth` types here are the plaintext shape returned by the
 * `loadResolvedConnection()` helper for in-process use (and immediately
 * discarded).
 */

export const TEST_MANAGEMENT_KINDS = ["xray", "zephyr", "testrail"] as const;
export type TestManagementKind = (typeof TEST_MANAGEMENT_KINDS)[number];

// ---- Persisted auth-config shapes (refs only) -----------------------------

export interface XrayAuthConfigRefs {
  clientIdRef: string;
  clientSecretRef: string;
}

export interface ZephyrAuthConfigRefs {
  bearerTokenRef: string;
}

export interface TestRailAuthConfigRefs {
  email: string;
  apiKeyRef: string;
}

export type TestManagementAuthConfigRefs =
  | ({ kind: "xray" } & XrayAuthConfigRefs)
  | ({ kind: "zephyr" } & ZephyrAuthConfigRefs)
  | ({ kind: "testrail" } & TestRailAuthConfigRefs);

// ---- Resolved auth-config (plaintext, in-process only) --------------------

export interface ResolvedXrayAuth {
  kind: "xray";
  clientId: string;
  clientSecret: string;
}

export interface ResolvedZephyrAuth {
  kind: "zephyr";
  bearerToken: string;
}

export interface ResolvedTestRailAuth {
  kind: "testrail";
  email: string;
  apiKey: string;
}

export type ResolvedAuthConfig = ResolvedXrayAuth | ResolvedZephyrAuth | ResolvedTestRailAuth;

// ---- Proxy / TLS ----------------------------------------------------------

export interface PersistedProxyConfig {
  url: string;
}

export interface PersistedTlsConfig {
  rejectUnauthorized?: boolean;
  caCertRef?: string | null;
}

export interface ResolvedTlsConfig {
  rejectUnauthorized: boolean;
  caCert: string | null;
}
