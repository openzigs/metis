/**
 * API Token service — Epic #163, Issue #119.
 *
 * Per-user bearer tokens for the Agent Client Protocol server. Tokens are
 * generated as `metis_<32 hex chars>` so they're unambiguously identifiable
 * in logs (the `metis_` prefix is a recognized "GitHub Token Allowlist"-
 * style sentinel for downstream secret scanners). The plaintext is shown
 * ONCE at creation; the DB only stores `sha256(token)`.
 *
 * Token verification is constant-time (sha-then-equals) and updates
 * `lastUsedAt` opportunistically.
 */
import { createHash, randomBytes } from "node:crypto";
import { audit } from "../audit/audit-service.js";
import { prisma } from "../prisma.js";

export interface ApiTokenView {
  id: string;
  userId: string;
  name: string;
  prefix: string;
  scopes: string[];
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
}

export interface CreatedApiToken extends ApiTokenView {
  /** The plaintext token. Returned ONCE at creation; never persisted. */
  token: string;
}

export const TOKEN_PREFIX = "metis_";
export const TOKEN_SECRET_BYTES = 32; // → 64 hex chars

export class ApiTokenError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiTokenError";
    this.status = status;
    this.code = code;
  }
}

export interface CreateApiTokenInput {
  userId: string;
  name: string;
  scopes?: string[];
  /** Optional ISO 8601 string. */
  expiresAt?: string | null;
}

export async function createApiToken(input: CreateApiTokenInput): Promise<CreatedApiToken> {
  const name = (input.name ?? "").trim();
  if (!name) throw new ApiTokenError(400, "NAME_REQUIRED", "token name is required");
  if (name.length > 128) throw new ApiTokenError(400, "NAME_TOO_LONG", "token name too long");
  const scopes = (input.scopes ?? []).filter(
    (s) => typeof s === "string" && s.length > 0 && s.length <= 64,
  );
  const secret = randomBytes(TOKEN_SECRET_BYTES).toString("hex");
  const plaintext = `${TOKEN_PREFIX}${secret}`;
  const tokenHash = sha256Hex(plaintext);
  const prefix = plaintext.slice(0, 14); // "metis_" + 8 hex
  const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
  if (expiresAt && Number.isNaN(expiresAt.getTime())) {
    throw new ApiTokenError(400, "EXPIRES_AT_INVALID", "expiresAt must be ISO 8601");
  }
  const row = await prisma.apiToken.create({
    data: {
      userId: input.userId,
      name,
      tokenHash,
      prefix,
      scopes: JSON.stringify(scopes),
      expiresAt,
    },
  });
  audit({
    actor: { id: input.userId },
    action: "acp.token.create",
    target: { type: "api_token", id: row.id },
    metadata: { name: row.name, scopes },
  });
  return { ...toView(row, scopes), token: plaintext };
}

export async function listApiTokens(userId: string): Promise<ApiTokenView[]> {
  const rows = await prisma.apiToken.findMany({
    where: { userId },
    // Secondary `id desc` makes ordering deterministic when two rows are
    // created within the same millisecond (SQLite createdAt resolution).
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  return rows.map((r) => toView(r, parseScopes(r.scopes)));
}

export async function revokeApiToken(userId: string, id: string): Promise<ApiTokenView> {
  const row = await prisma.apiToken.findUnique({ where: { id } });
  if (!row || row.userId !== userId) {
    throw new ApiTokenError(404, "TOKEN_NOT_FOUND", "token not found");
  }
  if (row.revokedAt) return toView(row, parseScopes(row.scopes));
  const updated = await prisma.apiToken.update({
    where: { id },
    data: { revokedAt: new Date() },
  });
  audit({
    actor: { id: userId },
    action: "acp.token.revoke",
    target: { type: "api_token", id },
    metadata: { name: row.name },
  });
  return toView(updated, parseScopes(updated.scopes));
}

export interface VerifiedToken {
  tokenId: string;
  userId: string;
  scopes: string[];
}

/**
 * Verify a plaintext bearer token against the DB. Returns null on any
 * failure (unknown token, revoked, expired). Updates `lastUsedAt` on
 * success in a fire-and-forget fashion.
 */
export async function verifyApiToken(plaintext: string): Promise<VerifiedToken | null> {
  if (typeof plaintext !== "string" || !plaintext.startsWith(TOKEN_PREFIX)) return null;
  const tokenHash = sha256Hex(plaintext);
  const row = await prisma.apiToken.findUnique({ where: { tokenHash } });
  if (!row) return null;
  if (row.revokedAt) return null;
  if (row.expiresAt && row.expiresAt.getTime() < Date.now()) return null;
  // Fire-and-forget lastUsedAt bump. Errors are non-fatal for verification.
  prisma.apiToken.update({ where: { id: row.id }, data: { lastUsedAt: new Date() } }).catch(() => {
    /* ignore */
  });
  return { tokenId: row.id, userId: row.userId, scopes: parseScopes(row.scopes) };
}

function toView(
  row: {
    id: string;
    userId: string;
    name: string;
    prefix: string;
    createdAt: Date;
    lastUsedAt: Date | null;
    expiresAt: Date | null;
    revokedAt: Date | null;
  },
  scopes: string[],
): ApiTokenView {
  return {
    id: row.id,
    userId: row.userId,
    name: row.name,
    prefix: row.prefix,
    scopes,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
  };
}

function parseScopes(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter((s): s is string => typeof s === "string");
    }
  } catch {
    /* ignore */
  }
  return [];
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf-8").digest("hex");
}
