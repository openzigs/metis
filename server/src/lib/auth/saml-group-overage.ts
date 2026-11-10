/**
 * #1552 — SAML sign-ins that arrived with a group overage, for the admin
 * Authentication page.
 *
 * Microsoft Entra ID omits the groups claim for a user in more than 150 groups
 * and sends a Graph link instead, so no group mapping can match that user. The
 * ACS records each such sign-in as an audit event (durable and shared by every
 * replica); this reads them back for the admin warning.
 *
 * #1558 — only the last {@link SAML_GROUP_OVERAGE_WINDOW_DAYS} days count, so
 * the warning clears once the admin fixes the group claim and no new overage
 * arrives; and each sign-in carries the role it got, since an app-role mapping
 * (Entra's `role` claim is not subject to overage) can still match.
 */
import { prisma } from "../prisma.js";

/** The audit action the SAML ACS records for a sign-in with a group overage. */
export const SAML_GROUP_OVERAGE_ACTION = "sso.saml.group_overage";

/** How many days back the admin warning looks. */
export const SAML_GROUP_OVERAGE_WINDOW_DAYS = 30;

/** How many recent sign-ins the admin warning lists by name. */
const RECENT_LIMIT = 20;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface SamlGroupOverageSummary {
  /** Every overage sign-in in the window. */
  total: number;
  /** The most recent ones, newest first, with the role each got. */
  recent: Array<{ userId: string; username: string | null; role: string | null; at: string }>;
  /** The window, in days. */
  windowDays: number;
}

/** The `role` the ACS recorded in the event's metadata, or null. */
function recordedRole(metadata: string | null): string | null {
  if (!metadata) return null;
  try {
    const role = (JSON.parse(metadata) as { role?: unknown } | null)?.role;
    return typeof role === "string" ? role : null;
  } catch {
    return null;
  }
}

export async function samlGroupOverageSummary(
  now: Date = new Date(),
): Promise<SamlGroupOverageSummary> {
  const since = new Date(now.getTime() - SAML_GROUP_OVERAGE_WINDOW_DAYS * DAY_MS);
  const where = { action: SAML_GROUP_OVERAGE_ACTION, ts: { gte: since } };
  const [total, rows] = await Promise.all([
    prisma.auditLog.count({ where }),
    prisma.auditLog.findMany({
      where,
      orderBy: { ts: "desc" },
      take: RECENT_LIMIT,
      select: {
        targetId: true,
        ts: true,
        metadata: true,
        actor: { select: { username: true } },
      },
    }),
  ]);
  return {
    total,
    recent: rows.map((row) => ({
      userId: row.targetId,
      username: row.actor?.username ?? null,
      role: recordedRole(row.metadata),
      at: row.ts.toISOString(),
    })),
    windowDays: SAML_GROUP_OVERAGE_WINDOW_DAYS,
  };
}
