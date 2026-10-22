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
 *      username is today — if that user is active and not deleted;
 *   2. no user with the username: a new user, bound to the identity;
 *   3. an active user with the username and no identity yet (created before
 *      #1395, by SCIM, or by the seed): claimed and bound, but only by the
 *      provider kind it belongs to (`users.authSource`). A legacy row whose kind
 *      is unknown (NULL) is claimable only by the deployment's AUTH_MODE
 *      provider — and, when that provider is SSO, only if the IdP asserts a
 *      VERIFIED e-mail equal to the row's e-mail (the seed's `admin` row must not
 *      go to whoever an IdP calls "admin");
 *   4. anything else — the username belongs to another provider's identity, or
 *      to another subject of the same provider, or the e-mail is unverified — is
 *      REFUSED with `409 ACCOUNT_LINK_REQUIRED`. An administrator links the two
 *      on purpose with `link-identity-cli.ts` (docs/auth/README.md).
 *
 * A disabled or soft-deleted account is never written on the login path: its
 * sign-in is refused with `403 ACCOUNT_DISABLED`.
 */
import { audit } from "../audit/audit-service.js";
import { prisma } from "../prisma.js";
import { AppError } from "../../middleware/error-handler.js";
import { foldIdentity, isNfkcStable } from "./bootstrap-admins.js";
import { directoryNameSubject } from "./identity-subject.js";

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
  /** The OIDC `sub`, the SAML NameID, or the directory's canonical id. */
  subject: string;
}

export interface LoginProfile {
  username: string;
  displayName: string;
  email: string;
  /**
   * An e-mail the IdP asserts as VERIFIED (OIDC `email` with
   * `email_verified: true`). Null when it asserts none — SAML has no such claim.
   * Only consulted when an SSO sign-in would claim a legacy (NULL-kind) row.
   */
  verifiedEmail?: string | null;
}

export interface LoginUserRow {
  id: string;
  username: string;
  authRolesInitializedAt: Date | null;
}

export const ACCOUNT_LINK_REQUIRED = "ACCOUNT_LINK_REQUIRED";
export const ACCOUNT_DISABLED = "ACCOUNT_DISABLED";

/** Why a username match was refused. */
export type IdentityConflict = "other_provider" | "other_subject" | "unverified_email";

const TRANSIENT_NAME_ID = "urn:oasis:names:tc:SAML:2.0:nameid-format:transient";

/**
 * Prefix of the subject that stands in for a transient NameID. A URN no IdP
 * issues as a NameID, so it cannot collide with a persistent or e-mail NameID.
 */
export const SAML_TRANSIENT_SUBJECT_PREFIX = "urn:metis:saml:transient-username:";

const SSO_KINDS: readonly string[] = ["oidc", "saml"];

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

export { directoryNameSubject };

/**
 * The directory providers (mock, LDAP): one directory per deployment. The
 * subject is the directory's canonical id when it returned one (LDAP
 * `entryUUID` / `objectGUID`, see `ldap-provider.ts`), else the folded account
 * name.
 */
export function directoryIdentity(
  provider: "mock" | "ldap",
  user: { username: string; subject?: string | null },
): ExternalIdentity {
  return {
    provider,
    issuer: provider,
    subject: nonEmpty(user.subject) ?? directoryNameSubject(user.username),
  };
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
 * account: the asserted username stands in for it, under a prefix of its own.
 */
export function samlIdentity(
  profile: Record<string, unknown>,
  configuredIssuer: string,
  username: string,
): ExternalIdentity | null {
  const issuer = nonEmpty(profile.issuer) ?? nonEmpty(configuredIssuer);
  const nameId = nonEmpty(profile.nameID);
  const subject =
    nameId && profile.nameIDFormat !== TRANSIENT_NAME_ID
      ? nameId
      : nonEmpty(username) && `${SAML_TRANSIENT_SUBJECT_PREFIX}${username}`;
  return issuer && subject ? { provider: "saml", issuer, subject } : null;
}

/** Whether a verified e-mail is the row's own, compared as `bootstrap-admins.ts` does. */
export function verifiedEmailMatches(
  verified: string | null | undefined,
  rowEmail: string,
): boolean {
  return (
    typeof verified === "string" &&
    verified.trim() !== "" &&
    isNfkcStable(verified) &&
    foldIdentity(verified) === foldIdentity(rowEmail)
  );
}

/**
 * Whether a sign-in may take the existing user that holds its username.
 * Pure: the whole policy for step 3/4 of the module comment.
 */
export function usernameClaimVerdict(
  existing: {
    authSource: string | null;
    email: string;
    identities: readonly { provider: string; issuer: string }[];
  },
  identity: ExternalIdentity,
  primaryKind: string | null,
  verifiedEmail: string | null = null,
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
  if (identity.provider !== primaryKind) return "other_provider";
  if (
    SSO_KINDS.includes(identity.provider) &&
    !verifiedEmailMatches(verifiedEmail, existing.email)
  ) {
    return "unverified_email";
  }
  return "claim";
}

/**
 * A lost race: a unique violation (P2002) or a serialization failure (P2034).
 * Either way the row changed under this sign-in, so it is judged again.
 */
function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "P2002" || code === "P2034";
}

/** Only an active, undeleted account is ever written on the login path. */
const ACTIVE = { deletedAt: null, status: "active" } as const;

function isActive(row: { deletedAt?: Date | null; status?: string | null }): boolean {
  return row.deletedAt == null && (row.status ?? "active") === "active";
}

/** The row a claim may take: the one it judged, active, still unbound, still that kind. */
export const CLAIMABLE = (id: string, authSource: string | null) => ({
  id,
  authSource,
  ...ACTIVE,
  identities: { none: {} },
});

const USER_SELECT = { id: true, username: true, authRolesInitializedAt: true } as const;

function auditRefusal(
  reason: string,
  identity: ExternalIdentity,
  profile: LoginProfile,
  userId: string | null,
): void {
  // The admin who links the accounts needs the exact key, so it is recorded.
  audit({
    actor: null,
    action: "user.login.failed",
    target: { type: "user", id: userId ?? profile.username },
    metadata: {
      reason,
      username: profile.username,
      provider: identity.provider,
      issuer: identity.issuer,
      subject: identity.subject,
    },
  });
}

function refuse(
  reason: IdentityConflict | "unique_conflict",
  identity: ExternalIdentity,
  profile: LoginProfile,
  userId: string | null,
): never {
  auditRefusal(`identity_conflict:${reason}`, identity, profile, userId);
  const message =
    reason === "unique_conflict"
      ? "This sign-in's username or e-mail address already belongs to another METIS " +
        "account. Ask an administrator to link the accounts."
      : `The username "${profile.username}" already belongs to an account that signs in ` +
        "with a different identity provider or identity. Ask an administrator to link " +
        "the accounts.";
  throw new AppError(409, ACCOUNT_LINK_REQUIRED, message, { reason });
}

function refuseInactive(identity: ExternalIdentity, profile: LoginProfile, userId: string): never {
  auditRefusal("account_inactive", identity, profile, userId);
  throw new AppError(403, ACCOUNT_DISABLED, "This account is disabled.");
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
    select: { id: true, userId: true, user: { select: { status: true, deletedAt: true } } },
  });
  if (bound) {
    if (!isActive(bound.user)) refuseInactive(identity, profile, bound.userId);
    let row: LoginUserRow;
    try {
      // Conditional on the account still being active: a disable or delete that
      // lands after the read above is never overwritten by a login.
      row = await prisma.user.update({
        where: { id: bound.userId, ...ACTIVE },
        data: { displayName: profile.displayName, email: profile.email, lastLoginAt: now },
        select: USER_SELECT,
      });
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code === "P2025") {
        refuseInactive(identity, profile, bound.userId);
      }
      throw error;
    }
    await prisma.userIdentity.update({ where: { id: bound.id }, data: { lastLoginAt: now } });
    return row;
  }

  const existing = await prisma.user.findUnique({
    where: { username: profile.username },
    select: {
      id: true,
      email: true,
      status: true,
      deletedAt: true,
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

  if (!isActive(existing)) refuseInactive(identity, profile, existing.id);
  const verdict = usernameClaimVerdict(
    existing,
    identity,
    primaryKind,
    profile.verifiedEmail ?? null,
  );
  if (verdict !== "claim") refuse(verdict, identity, profile, existing.id);

  // Claim only the row as it was judged — active, still unbound, still the same
  // kind — and bind it in the same serializable transaction, so two concurrent
  // claims of one row cannot both bind (Postgres aborts one with a serialization
  // failure; the retry then sees the winner's identity and refuses).
  await prisma.$transaction(
    async (tx) => {
      const claimed = await tx.user.updateMany({
        where: CLAIMABLE(existing.id, existing.authSource),
        data: {
          authSource: identity.provider,
          displayName: profile.displayName,
          email: profile.email,
          lastLoginAt: now,
        },
      });
      if (claimed.count !== 1) throw Object.assign(new Error("claim raced"), { code: "P2002" });
      await tx.userIdentity.create({
        data: { ...identity, userId: existing.id, lastLoginAt: now },
      });
    },
    { isolationLevel: "Serializable" },
  );
  return prisma.user.findUniqueOrThrow({ where: { id: existing.id }, select: USER_SELECT });
}

/**
 * Resolve (create, claim or find) the local user for a sign-in, or refuse it
 * with `409 ACCOUNT_LINK_REQUIRED` / `403 ACCOUNT_DISABLED`. `primaryKind` is
 * the AUTH_MODE provider's name — the only kind that may claim a legacy row of
 * unknown provenance.
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
