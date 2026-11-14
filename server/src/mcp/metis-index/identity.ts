/**
 * #2331 — who is calling `metis-index-mcp`.
 *
 * The credential is the caller's OWN METIS API token (`metis_…`, minted on the
 * ACP tokens page, `lib/acp/api-tokens.ts`), never a shared service secret: a
 * token resolves to exactly one METIS user, and everything the tools read is
 * read as that user (project access, per-document ACLs). A string that is not
 * an issued token (a static shared secret, a revoked or expired token) maps to
 * no user and is refused before any read.
 *
 * It is resolved on EVERY call, not once at boot: revoking the token, disabling
 * the user or removing them from a workspace applies to the very next call.
 *
 * The token must carry `acp:read` (or the legacy `acp:*`): the index is read
 * through the same token scopes as ACP's other read methods (`ACP_SCOPES`).
 */
import type { AuthPayload } from "@metis/shared";
import { prisma } from "../../lib/prisma.js";
import { verifyApiToken, type VerifiedToken } from "../../lib/acp/api-tokens.js";
import { ACP_SCOPES, resolveAcpActor, tokenHasScope } from "../../lib/acp/authz.js";

/** The token scope every `metis_*` tool requires. */
export const INDEX_MCP_SCOPE = ACP_SCOPES.READ;

export type TokenVerifier = (token: string) => Promise<VerifiedToken | null>;

/** The METIS user a call runs as. */
export interface McpCaller {
  userId: string;
  tokenId: string;
  /** Role and workspace memberships, for the project-access checks. */
  actor: AuthPayload;
}

/** Why a credential was refused. Logged and audited; never shown beyond {@link REFUSED_MESSAGE}. */
export type McpAuthReason = "missing" | "invalid" | "scope" | "inactive";

/**
 * The one message every refusal answers with, so the reply does not say
 * whether a token exists, was revoked, or belongs to a disabled user.
 */
export const REFUSED_MESSAGE =
  "METIS refused the credential. Set METIS_API_TOKEN to your own METIS API token " +
  "(metis_…, with the acp:read scope); a shared or revoked token is not accepted.";

export class McpAuthError extends Error {
  constructor(readonly reason: McpAuthReason) {
    super(REFUSED_MESSAGE);
    this.name = "McpAuthError";
  }
}

/**
 * Resolve `credential` to the METIS user it was issued to, or throw
 * {@link McpAuthError}. A token whose user is disabled or deleted is refused
 * too: `verifyApiToken` checks the token row only.
 */
export async function resolveMcpCaller(
  credential: string,
  verify: TokenVerifier = verifyApiToken,
): Promise<McpCaller> {
  if (!credential) throw new McpAuthError("missing");
  const verified = await verify(credential);
  if (!verified) throw new McpAuthError("invalid");
  if (!tokenHasScope(verified.scopes, INDEX_MCP_SCOPE)) throw new McpAuthError("scope");
  const user = await prisma.user.findUnique({
    where: { id: verified.userId },
    select: { status: true, deletedAt: true },
  });
  if (!user || user.status !== "active" || user.deletedAt) throw new McpAuthError("inactive");
  return {
    userId: verified.userId,
    tokenId: verified.tokenId,
    actor: await resolveAcpActor(verified),
  };
}
