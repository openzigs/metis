/**
 * #2344 — which METIS user a verified remote access token is.
 *
 * A token maps to exactly one user through the identity METIS already binds
 * at OIDC sign-in: the `UserIdentity` row keyed by (provider `oidc`, issuer,
 * subject), unique in the schema. So the authorization server must be the
 * OIDC provider users sign in to METIS with (or one whose access-token `sub`
 * an administrator has linked, `link-identity-cli.ts`). A subject with no
 * such row is refused, as is one whose user is disabled or deleted; nothing is
 * matched on email or username, which a token's holder could choose.
 *
 * The tool calls then run as that user through the stdio server's own path
 * (`dispatcher.ts`): the verifier handed to it returns this user with the one
 * internal scope the tools need, and never sees the inbound token.
 */
import type { VerifiedToken } from "../../../lib/acp/api-tokens.js";
import { prisma } from "../../../lib/prisma.js";
import { INDEX_MCP_SCOPE, type TokenVerifier } from "../identity.js";
import type { VerifiedAccessToken } from "./token-verifier.js";

/** The `UserIdentity.provider` an access token's subject is looked up under. */
export const REMOTE_IDENTITY_PROVIDER = "oidc";

/** The `tokenId` the dispatcher sees for a remote call: there is no METIS API token. */
export const REMOTE_TOKEN_ID = "oauth";

export type UserMapping =
  { ok: true; userId: string } | { ok: false; reason: "unmapped" | "inactive" };

export async function mapAccessTokenToUser(token: VerifiedAccessToken): Promise<UserMapping> {
  const row = await prisma.userIdentity.findUnique({
    where: {
      provider_issuer_subject: {
        provider: REMOTE_IDENTITY_PROVIDER,
        issuer: token.issuer,
        subject: token.subject,
      },
    },
    select: { userId: true, user: { select: { status: true, deletedAt: true } } },
  });
  if (!row) return { ok: false, reason: "unmapped" };
  if (row.user.status !== "active" || row.user.deletedAt) return { ok: false, reason: "inactive" };
  return { ok: true, userId: row.userId };
}

/**
 * The verifier the dispatcher resolves its caller with on every tool call:
 * the mapped user, holding only the read scope. It ignores its argument, so
 * the dispatcher is never handed the inbound token at all.
 */
export function mappedUserVerifier(userId: string): TokenVerifier {
  const verified: VerifiedToken = { tokenId: REMOTE_TOKEN_ID, userId, scopes: [INDEX_MCP_SCOPE] };
  return async () => ({ ...verified, scopes: [...verified.scopes] });
}
