/**
 * #1376 — configure the OIDC and SAML providers from the environment.
 *
 * Until now the only way to configure an SSO provider was the admin API
 * (`PUT /api/admin/auth/providers/{oidc,saml}`), and the providers live in an
 * in-memory map (`sso-config.ts`). On an OIDC- or SAML-only install that is a
 * dead end: nobody can sign in until an admin configures the provider, and
 * nobody is an admin until someone signs in. So `METIS_BOOTSTRAP_ADMINS` could
 * never fire there. The admin-API config also vanished on every restart and
 * existed on one replica only.
 *
 * The variables below seed the provider at boot, on every replica, so an SSO
 * install signs in from its first start and the bootstrap admin can be granted.
 * The admin API can still edit the provider at runtime; the environment wins
 * again at the next start, so put lasting settings (group mappings included)
 * here.
 *
 *   OIDC: AUTH_OIDC_DISCOVERY_URL, AUTH_OIDC_CLIENT_ID, AUTH_OIDC_CLIENT_SECRET,
 *         AUTH_OIDC_REDIRECT_URI (all four, or none); optional AUTH_OIDC_NAME,
 *         AUTH_OIDC_SCOPES, AUTH_OIDC_GROUP_MAPPINGS, AUTH_OIDC_DEFAULT_ROLE.
 *   SAML: AUTH_SAML_ENTITY_ID, AUTH_SAML_ACS_URL, AUTH_SAML_IDP_METADATA_XML (all
 *         three, or none); optional AUTH_SAML_NAME, AUTH_SAML_REQUIRE_SIGNED_RESPONSE
 *         (default true), AUTH_SAML_GROUP_MAPPINGS, AUTH_SAML_DEFAULT_ROLE.
 *
 * `*_GROUP_MAPPINGS` is `group=role` pairs, comma-separated
 * (`metis-admins=admin,engineers=developer`). A half-configured provider, an
 * unknown role or metadata without an SSO URL or certificate fails the boot
 * rather than producing a provider that cannot sign anyone in.
 */
import { ROLE_KEYS, type RoleKey } from "@metis/shared";
import { getStoredProviderByMode, upsertProvider, validateGroupMappings } from "./sso-config.js";
import { parseIdPMetadata } from "./saml-provider.js";
import type { GroupRoleMapping } from "./sso-types.js";

type Env = Record<string, string | undefined>;

function value(env: Env, name: string): string {
  return (env[name] ?? "").trim();
}

function isRoleKey(v: string): v is RoleKey {
  return (ROLE_KEYS as readonly string[]).includes(v);
}

function role(env: Env, name: string): RoleKey {
  const raw = value(env, name) || "reader";
  if (!isRoleKey(raw)) throw new Error(`${name}="${raw}" is not a METIS role`);
  return raw;
}

/** Parse `group=role,group=role`. Exported for its test. */
export function parseGroupMappings(raw: string, name = "group mappings"): GroupRoleMapping[] {
  const mappings: GroupRoleMapping[] = [];
  for (const pair of raw
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)) {
    const at = pair.lastIndexOf("=");
    const claimValue = pair.slice(0, at).trim();
    const mapped = pair.slice(at + 1).trim();
    if (at <= 0 || !claimValue || !isRoleKey(mapped)) {
      throw new Error(`${name}: "${pair}" is not group=role with a METIS role`);
    }
    mappings.push({ claimValue, role: mapped });
  }
  const error = validateGroupMappings(mappings);
  if (error) throw new Error(`${name}: ${error}`);
  return mappings;
}

/** Require every one of `names`, or none; returns whether they are set. */
function allOrNone(env: Env, names: readonly string[], what: string): boolean {
  const set = names.filter((n) => value(env, n));
  if (set.length === 0) return false;
  if (set.length < names.length) {
    const missing = names.filter((n) => !value(env, n));
    throw new Error(`${what} is half-configured: set ${missing.join(", ")} too, or none of them`);
  }
  return true;
}

const OIDC_REQUIRED = [
  "AUTH_OIDC_DISCOVERY_URL",
  "AUTH_OIDC_CLIENT_ID",
  "AUTH_OIDC_CLIENT_SECRET",
  "AUTH_OIDC_REDIRECT_URI",
] as const;
const SAML_REQUIRED = [
  "AUTH_SAML_ENTITY_ID",
  "AUTH_SAML_ACS_URL",
  "AUTH_SAML_IDP_METADATA_XML",
] as const;

/**
 * Seed the OIDC and/or SAML provider from `env`. Returns the modes it seeded.
 * Throws on a configuration that could not sign anyone in.
 */
export function seedSsoProvidersFromEnv(env: Env = process.env): Array<"oidc" | "saml"> {
  const seeded: Array<"oidc" | "saml"> = [];

  if (allOrNone(env, OIDC_REQUIRED, "OIDC (AUTH_OIDC_*)")) {
    const discoveryUrl = value(env, "AUTH_OIDC_DISCOVERY_URL");
    new URL(discoveryUrl); // throws on a malformed URL
    upsertProvider({
      id: getStoredProviderByMode("oidc")?.id,
      mode: "oidc",
      name: value(env, "AUTH_OIDC_NAME") || "Single sign-on",
      enabled: true,
      groupMappings: parseGroupMappings(
        value(env, "AUTH_OIDC_GROUP_MAPPINGS"),
        "AUTH_OIDC_GROUP_MAPPINGS",
      ),
      defaultRole: role(env, "AUTH_OIDC_DEFAULT_ROLE"),
      oidc: {
        discoveryUrl,
        clientId: value(env, "AUTH_OIDC_CLIENT_ID"),
        clientSecret: value(env, "AUTH_OIDC_CLIENT_SECRET"),
        redirectUri: value(env, "AUTH_OIDC_REDIRECT_URI"),
        scopes: (value(env, "AUTH_OIDC_SCOPES") || "openid profile email")
          .split(/[\s,]+/)
          .filter(Boolean),
        pkceEnabled: true,
      },
    });
    seeded.push("oidc");
  }

  if (allOrNone(env, SAML_REQUIRED, "SAML (AUTH_SAML_*)")) {
    const metadata = parseIdPMetadata(value(env, "AUTH_SAML_IDP_METADATA_XML"));
    if (!metadata.ssoUrl || metadata.certs.length === 0) {
      throw new Error(
        "AUTH_SAML_IDP_METADATA_XML has no SingleSignOnService URL or no X509 certificate",
      );
    }
    upsertProvider({
      id: getStoredProviderByMode("saml")?.id,
      mode: "saml",
      name: value(env, "AUTH_SAML_NAME") || "Single sign-on",
      enabled: true,
      groupMappings: parseGroupMappings(
        value(env, "AUTH_SAML_GROUP_MAPPINGS"),
        "AUTH_SAML_GROUP_MAPPINGS",
      ),
      defaultRole: role(env, "AUTH_SAML_DEFAULT_ROLE"),
      saml: {
        entityId: value(env, "AUTH_SAML_ENTITY_ID"),
        acsUrl: value(env, "AUTH_SAML_ACS_URL"),
        idpMetadataXml: value(env, "AUTH_SAML_IDP_METADATA_XML"),
        idpSsoUrl: metadata.ssoUrl,
        idpCerts: metadata.certs,
        idpIssuer: metadata.issuer,
        signRequests: false,
        // Secure by default, as the admin API: only an explicit "false" relaxes it.
        requireSignedResponse: value(env, "AUTH_SAML_REQUIRE_SIGNED_RESPONSE") !== "false",
      },
    });
    seeded.push("saml");
  }

  return seeded;
}
