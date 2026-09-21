/**
 * Issue #611 (epic #608) — notification-preference default matrix + resolution.
 *
 * The `NotificationPreference` Prisma model stores per-user, per-channel ×
 * per-event toggles with "absent row = default" semantics: a user with zero
 * rows resolves to the matrix below, so existing users need no backfill and
 * current dispatch behavior is preserved until a user explicitly opts out.
 *
 * Defaults rationale:
 * - `email`, `inApp` — on, matching the Settings → Notifications UI defaults
 *   (ui/src/app/(authed)/settings/notifications/page.tsx) and the fact that
 *   in-app mention/slaDeadline notifications fire unconditionally today.
 * - `teams` — on: Teams notification cards (#67) fire unconditionally today,
 *   so the default must preserve that behavior.
 * - `webhook` — off, matching the UI default (opt-in channel).
 */
import {
  NOTIFICATION_CHANNELS,
  NOTIFICATION_EVENTS,
  isNotificationChannel,
  isNotificationEvent,
  type NotificationChannel,
  type NotificationEvent,
  type NotificationPreferenceEntry,
  type NotificationPreferenceMatrix,
} from "@metis/shared";
import { createChildLogger } from "../logger.js";
import { Prisma, prisma, resolveDatabaseProvider } from "../prisma.js";

const log = createChildLogger("notification-preferences");

/** Per-channel default; applies uniformly to every event on that channel. */
const CHANNEL_DEFAULTS: Record<NotificationChannel, boolean> = {
  email: true,
  inApp: true,
  webhook: false,
  teams: true,
};

/**
 * Minimal shape of a stored `NotificationPreference` row. `channel`/`event`
 * are plain strings in the database; rows whose values fall outside the
 * shared vocabulary are ignored during resolution.
 */
export interface StoredPreferenceRow {
  channel: string;
  event: string;
  enabled: boolean;
}

/** Default enabled state for one (channel, event) cell. */
export function getDefaultEnabled(
  channel: NotificationChannel,
  _event: NotificationEvent,
): boolean {
  return CHANNEL_DEFAULTS[channel];
}

/** Full default channel × event matrix. Returns a fresh copy on every call. */
export function getDefaultPreferences(): NotificationPreferenceMatrix {
  const matrix = {} as NotificationPreferenceMatrix;
  for (const channel of NOTIFICATION_CHANNELS) {
    const events = {} as Record<NotificationEvent, boolean>;
    for (const event of NOTIFICATION_EVENTS) {
      events[event] = getDefaultEnabled(channel, event);
    }
    matrix[channel] = events;
  }
  return matrix;
}

/**
 * Resolve one (channel, event) cell from a user's stored rows.
 * Absent row → default; present row wins.
 */
export function resolvePreference(
  rows: readonly StoredPreferenceRow[],
  channel: NotificationChannel,
  event: NotificationEvent,
): boolean {
  const row = rows.find((r) => r.channel === channel && r.event === event);
  return row ? row.enabled : getDefaultEnabled(channel, event);
}

/**
 * Resolve a user's full preference matrix: defaults overlaid with their
 * stored rows. Rows with unknown channel/event values (e.g. vocabulary
 * retired in a later release) are ignored rather than rejected.
 */
export function resolvePreferences(
  rows: readonly StoredPreferenceRow[],
): NotificationPreferenceMatrix {
  const matrix = getDefaultPreferences();
  for (const row of rows) {
    if (isNotificationChannel(row.channel) && isNotificationEvent(row.event)) {
      matrix[row.channel][row.event] = row.enabled;
    }
  }
  return matrix;
}

/**
 * One resolved channel × event cell as served by the preferences API
 * (issue #612): the effective toggle plus whether it came from a stored row
 * (`isDefault: false`) or the default matrix (`isDefault: true`).
 */
export interface ResolvedPreferenceEntry extends NotificationPreferenceEntry {
  isDefault: boolean;
}

/**
 * Flatten a user's stored rows into the full resolved channel × event list.
 * Every cell is present exactly once; rows with unknown channel/event values
 * are ignored (same policy as {@link resolvePreferences}).
 */
export function resolvePreferenceEntries(
  rows: readonly StoredPreferenceRow[],
): ResolvedPreferenceEntry[] {
  const entries: ResolvedPreferenceEntry[] = [];
  for (const channel of NOTIFICATION_CHANNELS) {
    for (const event of NOTIFICATION_EVENTS) {
      const row = rows.find((r) => r.channel === channel && r.event === event);
      entries.push({
        channel,
        event,
        enabled: row ? row.enabled : getDefaultEnabled(channel, event),
        isDefault: row === undefined,
      });
    }
  }
  return entries;
}

/** Load and resolve the full preference list for one user. */
export async function getResolvedPreferencesForUser(
  userId: string,
): Promise<ResolvedPreferenceEntry[]> {
  const rows = await prisma.notificationPreference.findMany({ where: { userId } });
  return resolvePreferenceEntries(rows);
}

/**
 * Upsert preference toggles for one user. Duplicate (channel, event) pairs in
 * `entries` collapse last-wins; writes run in a single transaction so a
 * partial payload never half-applies.
 */
export async function upsertNotificationPreferences(
  userId: string,
  entries: readonly NotificationPreferenceEntry[],
): Promise<void> {
  const deduped = new Map<string, NotificationPreferenceEntry>();
  for (const entry of entries) {
    deduped.set(`${entry.channel}:${entry.event}`, entry);
  }
  if (deduped.size === 0) return;

  await prisma.$transaction(
    [...deduped.values()].map(({ channel, event, enabled }) =>
      prisma.notificationPreference.upsert({
        where: { userId_channel_event: { userId, channel, event } },
        create: { userId, channel, event, enabled },
        update: { enabled },
      }),
    ),
  );
}

// ---------------------------------------------------------------------------
// Issue #614 — dispatch-time enforcement + ops-critical exemption policy
// ---------------------------------------------------------------------------

/** One entry of the ops-critical exemption policy (issue #614). */
export interface NotificationPreferenceExemption {
  /** Stable identifier, referenced from code comments at the exempt path. */
  id: string;
  /** Repo-relative dispatch path the exemption applies to. */
  path: string;
  /** Which sends within that path are exempt. */
  scope: string;
  /** Why the exemption exists. */
  reason: string;
}

/**
 * OPS-CRITICAL EXEMPTION POLICY (#614).
 *
 * Dispatch paths enumerated here are NEVER suppressed by per-user notification
 * preferences — deliberately, not by omission. A wrongly-applied preference on
 * one of these paths would silently drop a sev-1 page or a workspace-level
 * budget/system alert, so the policy is: when in doubt, SEND.
 *
 * Also documented in docs/ARCHITECTURE.md ("Notification preferences —
 * enforcement & exemptions"). Any new exemption must be added to BOTH.
 */
export const NOTIFICATION_PREFERENCE_EXEMPTIONS: readonly NotificationPreferenceExemption[] =
  Object.freeze(
    [
      {
        id: "pagerduty-ops-alerting",
        path: "server/src/lib/pagerduty/alerting-hooks.ts (all hooks) + server/src/lib/finops/channels/dispatcher.ts (pagerduty channel branch)",
        scope:
          "every PagerDuty severity path: publish rollback, vault rotation failure, provider down/recovered, and FinOps pagerduty alert channels",
        reason:
          "sev-1 ops paging must never be suppressible by a user preference — a bug here would silently drop pages. The recipient is an on-call rotation, not a METIS user.",
      },
      {
        id: "teams-workspace-broadcast-cards",
        path: "server/src/lib/teams/notification-hooks.ts",
        scope:
          "ALL budget-exceeded cards (always workspace-level), and analysis-complete / publish-rolled-back cards sent without a targetUserId (workspace broadcast)",
        reason:
          "workspace-broadcast cards have no identifiable per-user recipient, and workspace-level budget/system alerts are ops-critical. Per-user preferences apply only when a card targets one identifiable METIS user.",
      },
      {
        id: "finops-non-user-recipients",
        path: "server/src/lib/finops/channels/dispatcher.ts",
        scope:
          "webhook + slack alert channels (shared endpoints, never a user), and email alert channels whose target address does not match an active METIS user (distribution lists, shared ops mailboxes)",
        reason:
          "the recipient is a shared endpoint rather than an individual user, so no user's preference may gate a workspace-level budget alert to it.",
      },
    ].map((entry) => Object.freeze(entry)),
  );

/**
 * Dispatch-time preference check (#614): should a notification for `event` be
 * sent to `userId` over `channel`?
 *
 * Contract (dispatch paths are fire-and-forget/non-throwing — see
 * `discussions/notify.ts` and `teams/notification-hooks.ts`):
 *   - NEVER throws. Any internal failure (DB down, etc.) FAILS OPEN — returns
 *     true (send) and logs a warn. Losing a notification is worse than sending
 *     one the user opted out of.
 *   - A suppressed send is logged at debug with `{userId, channel, event}`
 *     only — never any notification content.
 *   - Ops-critical paths must NOT call this — see
 *     {@link NOTIFICATION_PREFERENCE_EXEMPTIONS}.
 */
export async function shouldNotify(
  userId: string,
  channel: NotificationChannel,
  event: NotificationEvent,
): Promise<boolean> {
  try {
    const rows = await prisma.notificationPreference.findMany({
      where: { userId, channel, event },
    });
    const enabled = resolvePreference(rows, channel, event);
    if (!enabled) {
      log.debug("notification suppressed by user preference", { userId, channel, event });
    }
    return enabled;
  } catch (err) {
    log.warn("shouldNotify preference lookup failed — failing open (send)", {
      userId,
      channel,
      event,
      err,
    });
    return true;
  }
}

/**
 * Resolve an already-normalized (trimmed, lowercased) email to the id of an
 * active, non-deleted METIS user — case-insensitively — WITHOUT loading the
 * whole `User` table on the hot path.
 *
 * Issue #634: the FinOps email dispatch path (#50) is dominated by non-user
 * recipients (distribution lists, shared mailboxes) that never exact-match, so
 * the previous unconditional "load all active users + scan in JS" fallback paid
 * an O(active users) table transfer per alert email. The resolution is now
 * split by the runtime Prisma adapter (the same `DATABASE_URL`-scheme selection
 * `prisma.ts` uses to pick the driver):
 *
 *   - Postgres (prod): a single parameterised, case-insensitive query. The
 *     `email` is a bound parameter (never interpolated), and at most one row is
 *     returned — no full-table transfer. `mode: "insensitive"` is not available
 *     on the SQLite-generated client type, so the case-fold is expressed in raw
 *     SQL via `Prisma.sql`.
 *   - SQLite (unit tests): exact match first (fast when emails are stored
 *     lowercase), then the bounded case-insensitive fallback scan. Test datasets
 *     are tiny, so this is not a hot path, and the observable result is
 *     identical to Postgres.
 *
 * Returns `null` for a non-user recipient. Callers own the try/catch — this may
 * throw (the caller fails open).
 */
async function resolveActiveUserIdByEmail(normalizedEmail: string): Promise<string | null> {
  if (resolveDatabaseProvider() === "postgresql") {
    const rows = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id" FROM "users"
      WHERE lower("email") = ${normalizedEmail}
        AND "deletedAt" IS NULL
        AND "status" = 'active'
      LIMIT 1
    `);
    return rows[0]?.id ?? null;
  }

  const exact = await prisma.user.findFirst({
    where: { email: { equals: normalizedEmail }, deletedAt: null, status: "active" },
    select: { id: true },
  });
  if (exact) return exact.id;

  const all = await prisma.user.findMany({
    where: { deletedAt: null, status: "active" },
    select: { id: true, email: true },
  });
  return all.find((u) => u.email.toLowerCase() === normalizedEmail)?.id ?? null;
}

/**
 * Email-recipient variant of {@link shouldNotify} for dispatch paths whose
 * recipient is an email address rather than a userId (FinOps alert email
 * channels, #50). When the address maps to an active METIS user (the same
 * case-insensitive match SSO/AAD identity linking uses), that user's
 * `email × event` preference governs the send. A non-user recipient (shared
 * mailbox, distribution list) is preference-exempt — see
 * {@link NOTIFICATION_PREFERENCE_EXEMPTIONS} ("finops-non-user-recipients").
 *
 * Same fail-open, never-throws contract as {@link shouldNotify}.
 */
export async function shouldNotifyEmailRecipient(
  recipientEmail: string,
  event: NotificationEvent,
): Promise<boolean> {
  try {
    const email = recipientEmail.trim().toLowerCase();
    if (!email) return true;

    const userId = await resolveActiveUserIdByEmail(email);
    if (!userId) return true; // non-user recipient → exempt (send)

    return await shouldNotify(userId, "email", event);
  } catch (err) {
    // Never log the recipient address — only the event.
    log.warn("shouldNotifyEmailRecipient user lookup failed — failing open (send)", {
      event,
      err,
    });
    return true;
  }
}
