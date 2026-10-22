/**
 * #1395 — which local user a sign-in is.
 *
 * Both login paths used to upsert the user on `username`, across providers, so
 * an OIDC user whose `preferred_username` matched an LDAP user's name signed in
 * as that LDAP account: its roles, workspaces and data. The same held between
 * two SSO providers.
 *
 * A sign-in now carries an {@link ExternalIdentity} — (provider, issuer,
 * subject) — and is resolved in this order:
 *
 *   1. the user bound to that identity (`user_identities`), whatever its
 *      username is today;
 *   2. no user with the username: a new user, bound to the identity;
 *   3. a user with the username and no identity yet (created before #1395, by
 *      SCIM, or by the seed): claimed and bound, but only by the provider kind
 *      it belongs to (`users.authSource`) — or, for a legacy row whose kind is
 *      unknown, by the deployment's AUTH_MODE provider;
 *   4. anything else — the username belongs to another provider's identity, or
 *      to another subject of the same provider — is REFUSED with
 *      `409 ACCOUNT_LINK_REQUIRED`. An administrator links the two on purpose
 *      with `pnpm --filter @metis/server auth:link-identity` (docs/auth/README.md).
 */
import { audit } from "../audit/audit-service.js";
import { prisma } from "../prisma.js";
import { AppError } from "../../middleware/error-handler.js";

/** The provider kinds that sign users in. */
export type LoginProviderKind = "mock" | "ldap" | "oidc" | "saml";

export const LOGIN_PROVIDER_KINDS: readonly LoginProviderKind[] = ["mock", "ldap", "oidc", "saml"];

export function isLoginProviderKind(value: string): value is LoginProviderKind {
  return (LOGIN_PROVIDER_KINDS as readonly string[]).includes(value);
}

/** The key a provider vouches for. Unique across all users. */
export interface ExternalIdentity {
  provider: LoginProviderKind;
  /** The OIDC `iss`, the SAML IdP entity ID, or the kind itself for the one directory. */
  issuer: string;
  /** The OIDC `sub`, the SAML NameID, or the directory account name. */
  subject: string;
}

export interface LoginProfile {
  username: string;
  displayName: string;
  email: string;
}

export interface LoginUserRow {
  id: string;
  username: string;
  authRolesInitializedAt: Date | null;
}

export const ACCOUNT_LINK_REQUIRED = "ACCOUNT_LINK_REQUIRED";

/** Why a username match was refused. */
export type IdentityConflict = "other_provider" | "other_subject";

const TRANSIENT_NAME_ID = "urn:oasis:names:tc:SAML:2.0:nameid-format:transient";

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/**
 * The directory providers (mock, LDAP): one directory per deployment, keyed by
 * its account name — the name the directory was searched for and bound as.
 */
export function directoryIdentity(provider: "mock" | "ldap", username: string): ExternalIdentity {
  return { provider, issuer: provider, subject: username };
}

/**
 * OIDC: `iss` + `sub`, the pair the spec makes stable and unique. Never
 * `preferred_username`, which the spec says not to rely on. Null when the ID
 * token lacks either (openid-client requires both, so this is defensive).
 */
export function oidcIdentity(claims: Record<string, unknown>): ExternalIdentity | null {
  const issuer = nonEmpty(claims.iss);
  const subject = nonEmpty(claims.sub);
  return issuer && subject ? { provider: "oidc", issuer, subject } : null;
}

/**
 * SAML: the assertion's Issuer (else the configured IdP entity ID) + its
 * NameID. A transient NameID changes on every login, so it cannot key an
 * account: the asserted username stands in for it, as it always has.
 */
export function samlIdentity(
  profile: Record<string, unknown>,
  configuredIssuer: string,
  username: string,
): ExternalIdentity | null {
  const issuer = nonEmpty(profile.issuer) ?? nonEmpty(configuredIssuer);
  const nameId = nonEmpty(profile.nameID);
  const subject = nameId && profile.nameIDFormat !== TRANSIENT_NAME_ID ? nameId : username;
  return issuer && nonEmpty(subject) ? { provider: "saml", issuer, subject } : null;
}

/**
 * Whether a sign-in may take the existing user that holds its username.
 * Pure: the whole policy for step 3/4 of the module comment.
 */
export function usernameClaimVerdict(
  existing: {
    authSource: string | null;
    identities: readonly { provider: string; issuer: string }[];
  },
  identity: ExternalIdentity,
  primaryKind: string | null,
): "claim" | IdentityConflict {
  if (existing.identities.length > 0) {
    // The lookup by full key missed, so a same-provider binding is another subject.
    return existing.identities.some(
      (bound) => bound.provider === identity.provider && bound.issuer === identity.issuer,
    )
      ? "other_subject"
      : "other_provider";
  }
  if (existing.authSource !== null) {
    return existing.authSource === identity.provider ? "claim" : "other_provider";
  }
  return identity.provider === primaryKind ? "claim" : "other_provider";
}

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "P2002";
}

const USER_SELECT = { id: true, username: true, authRolesInitializedAt: true } as const;

function refuse(
  reason: IdentityConflict | "unique_conflict",
  identity: ExternalIdentity,
  profile: LoginProfile,
  userId: string | null,
): never {
  // The admin who links the accounts needs the exact key, so it is recorded.
  audit({
    actor: null,
    action: "user.login.failed",
    target: { type: "user", id: userId ?? profile.username },
    metadata: {
      reason: `identity_conflict:${reason}`,
      username: profile.username,
      provider: identity.provider,
      issuer: identity.issuer,
      subject: identity.subject,
    },
  });
  const message =
    reason === "unique_conflict"
      ? "This sign-in's username or e-mail address already belongs to another METIS " +
        "account. Ask an administrator to link the accounts."
      : `The username "${profile.username}" already belongs to an account that signs in ` +
        "with a different identity provider or identity. Ask an administrator to link " +
        "the accounts.";
  throw new AppError(409, ACCOUNT_LINK_REQUIRED, message, { reason });
}

async function resolveOnce(
  identity: ExternalIdentity,
  profile: LoginProfile,
  primaryKind: string | null,
): Promise<LoginUserRow> {
  const now = new Date();
  const key = {
    provider_issuer_subject: {
      provider: identity.provider,
      issuer: identity.issuer,
      subject: identity.subject,
    },
  };

  const bound = await prisma.userIdentity.findUnique({
    where: key,
    select: { id: true, userId: true },
  });
  if (bound) {
    await prisma.userIdentity.update({ where: { id: bound.id }, data: { lastLoginAt: now } });
    return prisma.user.update({
      where: { id: bound.userId },
      data: { displayName: profile.displayName, email: profile.email, lastLoginAt: now },
      select: USER_SELECT,
    });
  }

  const existing = await prisma.user.findUnique({
    where: { username: profile.username },
    select: {
      id: true,
      authSource: true,
      identities: { select: { provider: true, issuer: true } },
    },
  });
  if (!existing) {
    // `create`, never `upsert`: a row that appeared since the read above is a
    // unique violation, and the retry judges it like any other existing row.
    return prisma.user.create({
      data: {
        username: profile.username,
        displayName: profile.displayName,
        email: profile.email,
        status: "active",
        lastLoginAt: now,
        authRolesInitializedAt: null,
        authSource: identity.provider,
        identities: { create: { ...identity, lastLoginAt: now } },
      },
      select: USER_SELECT,
    });
  }

  const verdict = usernameClaimVerdict(existing, identity, primaryKind);
  if (verdict !== "claim") refuse(verdict, identity, profile, existing.id);

  // Claim only the row as it was judged: still unbound, still the same kind.
  const claimed = await prisma.user.updateMany({
    where: { id: existing.id, authSource: existing.authSource, identities: { none: {} } },
    data: {
      authSource: identity.provider,
      displayName: profile.displayName,
      email: profile.email,
      lastLoginAt: now,
    },
  });
  if (claimed.count !== 1) throw Object.assign(new Error("claim raced"), { code: "P2002" });
  await prisma.userIdentity.create({
    data: { ...identity, userId: existing.id, lastLoginAt: now },
  });
  return prisma.user.findUniqueOrThrow({ where: { id: existing.id }, select: USER_SELECT });
}

/**
 * Resolve (create, claim or find) the local user for a sign-in, or refuse it
 * with `409 ACCOUNT_LINK_REQUIRED`. `primaryKind` is the AUTH_MODE provider's
 * name — the only kind that may claim a legacy row of unknown provenance.
 */
export async function resolveLoginUser(input: {
  identity: ExternalIdentity;
  profile: LoginProfile;
  primaryKind: string | null;
}): Promise<LoginUserRow> {
  const { identity, profile, primaryKind } = input;
  try {
    return await resolveOnce(identity, profile, primaryKind);
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
  }
  // A concurrent first sign-in won the race (or the e-mail is taken): judge again.
  try {
    return await resolveOnce(identity, profile, primaryKind);
  } catch (error) {
    if (isUniqueViolation(error)) refuse("unique_conflict", identity, profile, null);
    throw error;
  }
}
