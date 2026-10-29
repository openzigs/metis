/**
 * #1552 — SAML sign-ins that arrived with a group overage, for the admin
 * Authentication page.
 *
 * Microsoft Entra ID omits the groups claim for a user in more than 150 groups
 * and sends a Graph link instead, so METIS gives that user the provider's
 * default role. The ACS records each such sign-in as an audit event (durable
 * and shared by every replica); this reads them back for the admin warning.
 */
import { prisma } from "../prisma.js";

/** The audit action the SAML ACS records for a sign-in with a group overage. */
export const SAML_GROUP_OVERAGE_ACTION = "sso.saml.group_overage";

/** How many recent sign-ins the admin warning lists by name. */
const RECENT_LIMIT = 20;

export interface SamlGroupOverageSummary {
  /** Every recorded overage sign-in. */
  total: number;
  /** The most recent ones, newest first. */
  recent: Array<{ userId: string; username: string | null; at: string }>;
}

export async function samlGroupOverageSummary(): Promise<SamlGroupOverageSummary> {
  const where = { action: SAML_GROUP_OVERAGE_ACTION };
  const [total, rows] = await Promise.all([
    prisma.auditLog.count({ where }),
    prisma.auditLog.findMany({
      where,
      orderBy: { ts: "desc" },
      take: RECENT_LIMIT,
      select: { targetId: true, ts: true, actor: { select: { username: true } } },
    }),
  ]);
  return {
    total,
    recent: rows.map((row) => ({
      userId: row.targetId,
      username: row.actor?.username ?? null,
      at: row.ts.toISOString(),
    })),
  };
}
