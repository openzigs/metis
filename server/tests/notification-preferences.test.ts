/**
 * Issue #611 (epic #608) — NotificationPreference default matrix + resolution.
 * Issue #614 — dispatch-time enforcement helper (`shouldNotify`) + exemptions.
 *
 * The preference model has "absent row = default" semantics: existing users
 * have zero rows and must resolve to the documented default matrix without
 * any backfill. Stored rows override the default per (channel, event) cell.
 *
 * `shouldNotify` is consumed by fire-and-forget dispatch paths, so it must
 * NEVER throw and must fail OPEN (send) on any internal failure — a bug here
 * would silently suppress notifications.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { prefFindMany, userFindFirst, userFindMany, userQueryRaw, dbProvider, logDebug, logWarn } =
  vi.hoisted(() => ({
    prefFindMany: vi.fn(),
    userFindFirst: vi.fn(),
    userFindMany: vi.fn(),
    userQueryRaw: vi.fn(),
    dbProvider: vi.fn(() => "sqlite"),
    logDebug: vi.fn(),
    logWarn: vi.fn(),
  }));

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    notificationPreference: { findMany: prefFindMany },
    user: { findFirst: userFindFirst, findMany: userFindMany },
    $queryRaw: userQueryRaw,
  },
  resolveDatabaseProvider: dbProvider,
  // Minimal `Prisma.sql` stand-in: the mocked `$queryRaw` ignores its argument,
  // so the tag only needs to be callable.
  Prisma: { sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }) },
}));

vi.mock("../src/lib/logger.js", () => ({
  createChildLogger: () => ({
    debug: logDebug,
    warn: logWarn,
    info: vi.fn(),
    error: vi.fn(),
  }),
}));

import {
  NOTIFICATION_CHANNELS,
  NOTIFICATION_EVENTS,
  isNotificationChannel,
  isNotificationEvent,
} from "@metis/shared";
import {
  NOTIFICATION_PREFERENCE_EXEMPTIONS,
  getDefaultEnabled,
  getDefaultPreferences,
  resolvePreference,
  resolvePreferences,
  shouldNotify,
  shouldNotifyEmailRecipient,
} from "../src/lib/notifications/preferences.js";

describe("shared notification vocabulary", () => {
  it("covers the required channels", () => {
    expect(NOTIFICATION_CHANNELS).toEqual(
      expect.arrayContaining(["email", "inApp", "webhook", "teams"]),
    );
  });

  it("covers the required events", () => {
    expect(NOTIFICATION_EVENTS).toEqual(
      expect.arrayContaining([
        "analysisCompleted",
        "requirementsApproved",
        "issuesPublished",
        "systemAlerts",
        "mention",
        "slaDeadline",
      ]),
    );
  });

  it("isNotificationChannel narrows correctly", () => {
    expect(isNotificationChannel("email")).toBe(true);
    expect(isNotificationChannel("teams")).toBe(true);
    expect(isNotificationChannel("carrier-pigeon")).toBe(false);
    expect(isNotificationChannel(42)).toBe(false);
    expect(isNotificationChannel(null)).toBe(false);
  });

  it("isNotificationEvent narrows correctly", () => {
    expect(isNotificationEvent("mention")).toBe(true);
    expect(isNotificationEvent("slaDeadline")).toBe(true);
    expect(isNotificationEvent("bogus")).toBe(false);
    expect(isNotificationEvent(undefined)).toBe(false);
  });
});

describe("getDefaultPreferences", () => {
  it("returns a full channel × event matrix", () => {
    const matrix = getDefaultPreferences();
    for (const channel of NOTIFICATION_CHANNELS) {
      for (const event of NOTIFICATION_EVENTS) {
        expect(typeof matrix[channel][event]).toBe("boolean");
      }
    }
  });

  it("defaults email, inApp and teams on, webhook off (matches current dispatch behavior + UI defaults)", () => {
    const matrix = getDefaultPreferences();
    for (const event of NOTIFICATION_EVENTS) {
      expect(matrix.email[event]).toBe(true);
      expect(matrix.inApp[event]).toBe(true);
      expect(matrix.teams[event]).toBe(true);
      expect(matrix.webhook[event]).toBe(false);
    }
  });

  it("returns a fresh copy each call (callers cannot corrupt the defaults)", () => {
    const a = getDefaultPreferences();
    a.email.mention = false;
    expect(getDefaultPreferences().email.mention).toBe(true);
  });
});

describe("getDefaultEnabled", () => {
  it("agrees with the default matrix for every cell", () => {
    const matrix = getDefaultPreferences();
    for (const channel of NOTIFICATION_CHANNELS) {
      for (const event of NOTIFICATION_EVENTS) {
        expect(getDefaultEnabled(channel, event)).toBe(matrix[channel][event]);
      }
    }
  });
});

describe("resolvePreference", () => {
  it("resolves to the default when no row matches (absent row = default)", () => {
    expect(resolvePreference([], "email", "mention")).toBe(true);
    expect(resolvePreference([], "webhook", "systemAlerts")).toBe(false);
  });

  it("honors a stored row that disables a default-on cell", () => {
    const rows = [{ channel: "email", event: "mention", enabled: false }];
    expect(resolvePreference(rows, "email", "mention")).toBe(false);
  });

  it("honors a stored row that enables a default-off cell", () => {
    const rows = [{ channel: "webhook", event: "issuesPublished", enabled: true }];
    expect(resolvePreference(rows, "webhook", "issuesPublished")).toBe(true);
  });

  it("only the exact (channel, event) row applies — other cells stay default", () => {
    const rows = [{ channel: "email", event: "mention", enabled: false }];
    expect(resolvePreference(rows, "email", "slaDeadline")).toBe(true);
    expect(resolvePreference(rows, "inApp", "mention")).toBe(true);
  });
});

describe("resolvePreferences", () => {
  it("returns the default matrix for a user with no stored rows", () => {
    expect(resolvePreferences([])).toEqual(getDefaultPreferences());
  });

  it("overlays stored rows on the defaults", () => {
    const matrix = resolvePreferences([
      { channel: "inApp", event: "analysisCompleted", enabled: false },
      { channel: "webhook", event: "systemAlerts", enabled: true },
    ]);
    expect(matrix.inApp.analysisCompleted).toBe(false);
    expect(matrix.webhook.systemAlerts).toBe(true);
    // Untouched cells stay at their defaults.
    expect(matrix.inApp.mention).toBe(true);
    expect(matrix.webhook.mention).toBe(false);
  });

  it("ignores rows with unknown channel or event values (forward-compat with retired vocabulary)", () => {
    const matrix = resolvePreferences([
      { channel: "fax", event: "mention", enabled: false },
      { channel: "email", event: "retiredEvent", enabled: false },
    ]);
    expect(matrix).toEqual(getDefaultPreferences());
  });

  it("does not mutate the shared default matrix", () => {
    resolvePreferences([{ channel: "email", event: "mention", enabled: false }]);
    expect(getDefaultPreferences().email.mention).toBe(true);
  });
});

describe("shouldNotify (#614 — dispatch-time enforcement)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prefFindMany.mockResolvedValue([]);
  });

  it("sends (true) when the user has no stored rows and the cell defaults on", async () => {
    await expect(shouldNotify("u1", "inApp", "mention")).resolves.toBe(true);
    expect(prefFindMany).toHaveBeenCalledWith({
      where: { userId: "u1", channel: "inApp", event: "mention" },
    });
  });

  it("suppresses (false) when the user disabled the (channel, event) cell", async () => {
    prefFindMany.mockResolvedValue([{ channel: "inApp", event: "mention", enabled: false }]);
    await expect(shouldNotify("u1", "inApp", "mention")).resolves.toBe(false);
  });

  it("sends (true) when the user explicitly enabled a default-off cell", async () => {
    prefFindMany.mockResolvedValue([{ channel: "webhook", event: "systemAlerts", enabled: true }]);
    await expect(shouldNotify("u1", "webhook", "systemAlerts")).resolves.toBe(true);
  });

  it("suppresses a default-off cell with no stored rows (webhook opt-in)", async () => {
    await expect(shouldNotify("u1", "webhook", "systemAlerts")).resolves.toBe(false);
  });

  it("logs a suppressed send at debug with ONLY {userId, channel, event} — no content", async () => {
    prefFindMany.mockResolvedValue([{ channel: "email", event: "systemAlerts", enabled: false }]);
    await shouldNotify("u1", "email", "systemAlerts");
    expect(logDebug).toHaveBeenCalledTimes(1);
    const [, meta] = logDebug.mock.calls[0];
    expect(meta).toEqual({ userId: "u1", channel: "email", event: "systemAlerts" });
  });

  it("does not debug-log when the send is allowed", async () => {
    await shouldNotify("u1", "inApp", "mention");
    expect(logDebug).not.toHaveBeenCalled();
  });

  it("FAILS OPEN (true) and warns when the preference lookup throws — never throws", async () => {
    prefFindMany.mockRejectedValue(new Error("db down"));
    await expect(shouldNotify("u1", "inApp", "mention")).resolves.toBe(true);
    expect(logWarn).toHaveBeenCalledTimes(1);
  });
});

describe("shouldNotifyEmailRecipient (#614 — FinOps email targets)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prefFindMany.mockResolvedValue([]);
    userFindFirst.mockResolvedValue(null);
    userFindMany.mockResolvedValue([]);
    userQueryRaw.mockResolvedValue([]);
    dbProvider.mockReturnValue("sqlite");
  });

  it("sends (true) when the recipient does not map to a METIS user (exempt) without querying preferences", async () => {
    await expect(shouldNotifyEmailRecipient("ops-list@acme.test", "systemAlerts")).resolves.toBe(
      true,
    );
    expect(prefFindMany).not.toHaveBeenCalled();
  });

  it("sends (true) for a blank target without any lookup", async () => {
    await expect(shouldNotifyEmailRecipient("  ", "systemAlerts")).resolves.toBe(true);
    expect(userFindFirst).not.toHaveBeenCalled();
  });

  it("suppresses (false) when the recipient maps to a user who disabled email×systemAlerts", async () => {
    userFindFirst.mockResolvedValue({ id: "u9" });
    prefFindMany.mockResolvedValue([{ channel: "email", event: "systemAlerts", enabled: false }]);
    await expect(shouldNotifyEmailRecipient("bob@acme.test", "systemAlerts")).resolves.toBe(false);
    expect(prefFindMany).toHaveBeenCalledWith({
      where: { userId: "u9", channel: "email", event: "systemAlerts" },
    });
  });

  it("sends (true) when the mapped user has no stored rows (email defaults on)", async () => {
    userFindFirst.mockResolvedValue({ id: "u9" });
    await expect(shouldNotifyEmailRecipient("bob@acme.test", "systemAlerts")).resolves.toBe(true);
  });

  it("matches the user email case-insensitively (SSO email-match parity)", async () => {
    userFindFirst.mockResolvedValue(null);
    userFindMany.mockResolvedValue([{ id: "u9", email: "Bob@Acme.test" }]);
    prefFindMany.mockResolvedValue([{ channel: "email", event: "systemAlerts", enabled: false }]);
    await expect(shouldNotifyEmailRecipient("BOB@ACME.TEST", "systemAlerts")).resolves.toBe(false);
  });

  it("FAILS OPEN (true) and warns when the user lookup throws — never throws", async () => {
    userFindFirst.mockRejectedValue(new Error("db down"));
    await expect(shouldNotifyEmailRecipient("bob@acme.test", "systemAlerts")).resolves.toBe(true);
    expect(logWarn).toHaveBeenCalledTimes(1);
  });

  it("SQLite: an exact email match never triggers the fallback table scan", async () => {
    userFindFirst.mockResolvedValue({ id: "u9" });
    prefFindMany.mockResolvedValue([{ channel: "email", event: "systemAlerts", enabled: false }]);
    await expect(shouldNotifyEmailRecipient("bob@acme.test", "systemAlerts")).resolves.toBe(false);
    expect(userFindMany).not.toHaveBeenCalled();
  });

  // #634 — on Postgres (prod) the recipient must be resolved in a single
  // case-insensitive DB query. A non-user recipient (dist list / shared mailbox,
  // the common FinOps case) must NOT load the whole active-User table into memory.
  it("Postgres: resolves the recipient case-insensitively in one query, never scanning the User table", async () => {
    dbProvider.mockReturnValue("postgresql");
    userQueryRaw.mockResolvedValue([{ id: "u9" }]);
    prefFindMany.mockResolvedValue([{ channel: "email", event: "systemAlerts", enabled: false }]);
    await expect(shouldNotifyEmailRecipient("BOB@ACME.TEST", "systemAlerts")).resolves.toBe(false);
    expect(userQueryRaw).toHaveBeenCalledTimes(1);
    expect(userFindMany).not.toHaveBeenCalled();
    expect(userFindFirst).not.toHaveBeenCalled();
  });

  it("Postgres: a non-user recipient sends (true) without loading the User table or querying preferences", async () => {
    dbProvider.mockReturnValue("postgresql");
    userQueryRaw.mockResolvedValue([]);
    await expect(shouldNotifyEmailRecipient("ops-list@acme.test", "systemAlerts")).resolves.toBe(
      true,
    );
    expect(userFindMany).not.toHaveBeenCalled();
    expect(userFindFirst).not.toHaveBeenCalled();
    expect(prefFindMany).not.toHaveBeenCalled();
  });

  it("Postgres: FAILS OPEN (true) and warns when the case-insensitive query throws", async () => {
    dbProvider.mockReturnValue("postgresql");
    userQueryRaw.mockRejectedValue(new Error("db down"));
    await expect(shouldNotifyEmailRecipient("bob@acme.test", "systemAlerts")).resolves.toBe(true);
    expect(logWarn).toHaveBeenCalledTimes(1);
  });
});

describe("NOTIFICATION_PREFERENCE_EXEMPTIONS (#614 — ops-critical exemption policy)", () => {
  it("exempts the PagerDuty ops-alerting path by design", () => {
    const pd = NOTIFICATION_PREFERENCE_EXEMPTIONS.find((e) => e.id === "pagerduty-ops-alerting");
    expect(pd).toBeDefined();
    expect(pd?.path).toContain("pagerduty/alerting-hooks.ts");
  });

  it("exempts workspace-broadcast Teams cards (incl. all budget-exceeded cards)", () => {
    const teams = NOTIFICATION_PREFERENCE_EXEMPTIONS.find(
      (e) => e.id === "teams-workspace-broadcast-cards",
    );
    expect(teams).toBeDefined();
    expect(teams?.path).toContain("teams/notification-hooks.ts");
    expect(teams?.scope).toContain("budget-exceeded");
  });

  it("exempts FinOps alert channels whose recipient is not a METIS user", () => {
    const finops = NOTIFICATION_PREFERENCE_EXEMPTIONS.find(
      (e) => e.id === "finops-non-user-recipients",
    );
    expect(finops).toBeDefined();
    expect(finops?.path).toContain("finops/channels/dispatcher.ts");
  });

  it("is frozen — the exemption list cannot be mutated at runtime", () => {
    expect(Object.isFrozen(NOTIFICATION_PREFERENCE_EXEMPTIONS)).toBe(true);
    for (const entry of NOTIFICATION_PREFERENCE_EXEMPTIONS) {
      expect(Object.isFrozen(entry)).toBe(true);
    }
  });
});
