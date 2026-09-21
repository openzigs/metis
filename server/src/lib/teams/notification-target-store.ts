/**
 * Issue #67 — Teams notification-target store.
 *
 * Persists, per workspace, the destination Teams channel for a ONE-WAY
 * notification event (`analysis-complete` | `publish-rolled-back` |
 * `budget-exceeded`). When such an event fires, {@link sendEventNotification}
 * (notification-sync.ts) looks the target up here and proactively posts a
 * rendered Adaptive Card into the stored channel via the #550 mechanism.
 *
 * Distinct from {@link TeamsChannelLinkStore} (#549): a channel LINK binds a
 * channel to a single `DiscussionThread` for BIDIRECTIONAL message mirroring; a
 * notification TARGET carries NO thread — it is just a per-event destination for
 * one-way cards. The two never collide (different table, different key).
 *
 * KEYING — one destination per event per workspace:
 *   - `(workspaceId, eventType)` is unique → re-registering the same event for a
 *     workspace UPSERTS the destination in place (an admin pointing the event at a
 *     new channel just overwrites the old one), never creating a duplicate.
 *
 * Durable relational data → a real Prisma model + migration (same choice as the
 * #548 ConversationReference store and the #549 link store, NOT the
 * crash-disposable UNLOGGED tables of #541/#542): losing a target silently stops
 * notification delivery until an admin re-registers it.
 *
 * Every read/write is keyed by `workspaceId` so one workspace can only ever route
 * to — or read — its OWN registered channel: a notification can never leak into,
 * nor a target be read from, another workspace.
 *
 * This store does NOT authorize — the route layer enforces workspace-admin access
 * BEFORE invoking it (mirroring the install/identity admin surfaces).
 */
import type { PrismaClient } from "@prisma/client";
import type { ConversationReference } from "botbuilder";

import { prisma as defaultPrisma } from "../prisma.js";

/** The notification events that route to a Teams channel today (free-form). */
export const TEAMS_NOTIFICATION_EVENT_TYPES = [
  "analysis-complete",
  "publish-rolled-back",
  "budget-exceeded",
] as const;
export type TeamsNotificationEventType = (typeof TEAMS_NOTIFICATION_EVENT_TYPES)[number];

export interface NotificationTargetInput {
  workspaceId: string;
  eventType: string;
  /** Bot Framework conversation id of the destination Teams channel. */
  conversationId: string;
  /** Bot Framework channel id — "msteams" for Teams. */
  channelId: string;
  /** The Bot Framework `ConversationReference` used for the proactive send. */
  reference: Partial<ConversationReference>;
  /** AAD tenant id of the destination channel, if known (for the #554 gate). */
  tenantId?: string | null;
  createdById?: string | null;
}

export interface NotificationTargetSummary {
  id: string;
  workspaceId: string;
  eventType: string;
  conversationId: string;
  channelId: string;
  tenantId: string | null;
  status: string;
  createdById: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** A target plus its deserialized ConversationReference (the send needs it). */
export interface ResolvedNotificationTarget extends NotificationTargetSummary {
  reference: Partial<ConversationReference>;
}

/** Domain error mapped to an HTTP contract by the route layer. */
export class TeamsNotificationTargetError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "TeamsNotificationTargetError";
  }
}

export class TeamsNotificationTargetStore {
  private readonly db: PrismaClient;

  constructor(db: PrismaClient = defaultPrisma) {
    this.db = db;
  }

  /**
   * Register (or re-point) the destination channel for an event in a workspace.
   * Idempotent on `(workspaceId, eventType)`: a second register for the same
   * event overwrites the stored channel/reference in place rather than creating a
   * duplicate. Validates required fields (400 on blanks) and that the event has a
   * usable conversation reference.
   */
  async register(input: NotificationTargetInput): Promise<NotificationTargetSummary> {
    this.requireNonEmpty(input.workspaceId, "WORKSPACE_REQUIRED", "workspaceId is required");
    this.requireNonEmpty(input.eventType, "EVENT_TYPE_REQUIRED", "eventType is required");
    this.requireNonEmpty(
      input.conversationId,
      "CONVERSATION_REQUIRED",
      "conversationId is required",
    );
    this.requireNonEmpty(input.channelId, "CHANNEL_REQUIRED", "channelId is required");

    const serialized = JSON.stringify(input.reference ?? {});

    const row = await this.db.teamsNotificationTarget.upsert({
      where: {
        workspaceId_eventType: {
          workspaceId: input.workspaceId,
          eventType: input.eventType,
        },
      },
      create: {
        workspaceId: input.workspaceId,
        eventType: input.eventType,
        conversationId: input.conversationId,
        channelId: input.channelId,
        tenantId: input.tenantId ?? null,
        reference: serialized,
        status: "active",
        createdById: input.createdById ?? null,
      },
      update: {
        conversationId: input.conversationId,
        channelId: input.channelId,
        tenantId: input.tenantId ?? null,
        reference: serialized,
        status: "active",
      },
    });
    return this.toSummary(row);
  }

  /**
   * Resolve the destination for `(workspaceId, eventType)`, with the parsed
   * ConversationReference, or null when none is registered. Used by the
   * notification-send path. An `inactive` target is treated as not-registered
   * (returns null) so disabling delivery is just a status flip.
   */
  async getByEvent(
    workspaceId: string,
    eventType: string,
  ): Promise<ResolvedNotificationTarget | null> {
    const row = await this.db.teamsNotificationTarget.findUnique({
      where: { workspaceId_eventType: { workspaceId, eventType } },
    });
    if (!row || row.status !== "active") return null;
    return {
      ...this.toSummary(row),
      reference: JSON.parse(row.reference) as Partial<ConversationReference>,
    };
  }

  /** List every notification target in a workspace (most-recent first). */
  async listByWorkspace(workspaceId: string): Promise<NotificationTargetSummary[]> {
    const rows = await this.db.teamsNotificationTarget.findMany({
      where: { workspaceId },
      orderBy: { createdAt: "desc" },
    });
    return rows.map((r) => this.toSummary(r));
  }

  /**
   * Delete the target for `(workspaceId, eventType)`. Scoping the delete by
   * workspace means a caller can never remove another workspace's target.
   * Returns true if a row was removed, false if none matched (idempotent).
   */
  async delete(workspaceId: string, eventType: string): Promise<boolean> {
    const res = await this.db.teamsNotificationTarget.deleteMany({
      where: { workspaceId, eventType },
    });
    return res.count > 0;
  }

  private requireNonEmpty(value: string, code: string, message: string): void {
    if (!value || value.trim().length === 0) {
      throw new TeamsNotificationTargetError(400, code, message);
    }
  }

  private toSummary(row: {
    id: string;
    workspaceId: string;
    eventType: string;
    conversationId: string;
    channelId: string;
    tenantId: string | null;
    status: string;
    createdById: string | null;
    createdAt: Date;
    updatedAt: Date;
  }): NotificationTargetSummary {
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      eventType: row.eventType,
      conversationId: row.conversationId,
      channelId: row.channelId,
      tenantId: row.tenantId,
      status: row.status,
      createdById: row.createdById,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}

let singleton: TeamsNotificationTargetStore | null = null;
export function getTeamsNotificationTargetStore(): TeamsNotificationTargetStore {
  if (!singleton) singleton = new TeamsNotificationTargetStore();
  return singleton;
}

/** Test helper — reset the singleton so a test can inject its own Prisma. */
export function __resetTeamsNotificationTargetStore(): void {
  singleton = null;
}
