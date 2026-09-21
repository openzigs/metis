/**
 * Epic #547 (Phase 1, #549) — Teams thread↔channel link store.
 *
 * Persists the mapping between a METIS `DiscussionThread` and a specific Teams
 * channel within a workspace, so later phases know which thread a channel
 * mirrors:
 *   - #550 outbound: given a new `DiscussionMessage`, find the linked channel(s).
 *   - #551 inbound:  given a Teams channel activity, find the target thread.
 *
 * CARDINALITY — one channel ↔ one thread per workspace:
 *   - `(workspaceId, conversationId)` is unique → a channel links to at most one
 *     thread.
 *   - `threadId` is globally unique → a thread links to at most one channel.
 * A violation surfaces as a {@link TeamsLinkError} `LINK_CONFLICT` (409), never a
 * raw Prisma error.
 *
 * Durable relational data → a real Prisma model + migration (same choice as the
 * #548 ConversationReference store, NOT the crash-disposable UNLOGGED tables of
 * #541/#542). Every read/write is keyed by `workspaceId` so one workspace's links
 * are never visible to another.
 *
 * This store does NOT authorize — the caller (route layer) enforces member-only
 * access via `server/src/lib/discussions/access.ts` BEFORE invoking it.
 */
import type { PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "../prisma.js";

export interface ChannelLinkInput {
  workspaceId: string;
  threadId: string;
  /** Denormalized project id of the thread (used by member-only authz). */
  projectId: string;
  /** Bot Framework conversation id of the Teams channel. */
  conversationId: string;
  /** Bot Framework channel id — "msteams" for Teams. */
  channelId: string;
  /** AAD tenant id of the channel, if known. */
  tenantId?: string | null;
  createdById?: string | null;
}

export interface ChannelLinkSummary {
  id: string;
  workspaceId: string;
  threadId: string;
  projectId: string;
  conversationId: string;
  channelId: string;
  tenantId: string | null;
  status: string;
  createdById: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Domain error mapped to an HTTP contract by the route layer. */
export class TeamsLinkError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "TeamsLinkError";
  }
}

/** Prisma unique-constraint violation code. */
const PRISMA_UNIQUE_VIOLATION = "P2002";

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: string }).code === PRISMA_UNIQUE_VIOLATION
  );
}

export class TeamsChannelLinkStore {
  private readonly db: PrismaClient;

  constructor(db: PrismaClient = defaultPrisma) {
    this.db = db;
  }

  /**
   * Create a link between a thread and a Teams channel. Rejects with a 409
   * `LINK_CONFLICT` when the thread is already linked to a channel OR the channel
   * is already linked to another thread (the one-to-one cardinality).
   */
  async create(input: ChannelLinkInput): Promise<ChannelLinkSummary> {
    this.requireNonEmpty(input.workspaceId, "WORKSPACE_REQUIRED", "workspaceId is required");
    this.requireNonEmpty(input.threadId, "THREAD_REQUIRED", "threadId is required");
    this.requireNonEmpty(input.projectId, "PROJECT_REQUIRED", "projectId is required");
    this.requireNonEmpty(
      input.conversationId,
      "CONVERSATION_REQUIRED",
      "conversationId is required",
    );
    this.requireNonEmpty(input.channelId, "CHANNEL_REQUIRED", "channelId is required");

    try {
      const row = await this.db.teamsChannelLink.create({
        data: {
          workspaceId: input.workspaceId,
          threadId: input.threadId,
          projectId: input.projectId,
          conversationId: input.conversationId,
          channelId: input.channelId,
          tenantId: input.tenantId ?? null,
          status: "active",
          createdById: input.createdById ?? null,
        },
      });
      return this.toSummary(row);
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new TeamsLinkError(
          409,
          "LINK_CONFLICT",
          "This thread or channel is already linked. A channel maps to at most one thread and vice-versa.",
        );
      }
      throw err;
    }
  }

  /** Fetch the link for a thread (scoped by workspace), or null. */
  async getByThread(workspaceId: string, threadId: string): Promise<ChannelLinkSummary | null> {
    const row = await this.db.teamsChannelLink.findFirst({
      where: { workspaceId, threadId },
    });
    return row ? this.toSummary(row) : null;
  }

  /**
   * Fetch the link for a Teams channel `(workspace, conversation)`, or null.
   * Used by inbound sync (#551) to route a channel activity to its thread.
   */
  async getByConversation(
    workspaceId: string,
    conversationId: string,
  ): Promise<ChannelLinkSummary | null> {
    const row = await this.db.teamsChannelLink.findUnique({
      where: { workspaceId_conversationId: { workspaceId, conversationId } },
    });
    return row ? this.toSummary(row) : null;
  }

  /** List every link in a workspace (most-recent first). */
  async listByWorkspace(workspaceId: string): Promise<ChannelLinkSummary[]> {
    const rows = await this.db.teamsChannelLink.findMany({
      where: { workspaceId },
      orderBy: { createdAt: "desc" },
    });
    return rows.map((r) => this.toSummary(r));
  }

  /**
   * Delete the link with `id` IFF it belongs to `workspaceId`. Scoping the
   * delete by workspace (not id alone) means a caller can never unlink another
   * workspace's mapping even with a guessed id. Returns true if a row was
   * removed, false if none matched (idempotent).
   */
  async delete(workspaceId: string, id: string): Promise<boolean> {
    const res = await this.db.teamsChannelLink.deleteMany({
      where: { id, workspaceId },
    });
    return res.count > 0;
  }

  private requireNonEmpty(value: string, code: string, message: string): void {
    if (!value || value.trim().length === 0) {
      throw new TeamsLinkError(400, code, message);
    }
  }

  private toSummary(row: {
    id: string;
    workspaceId: string;
    threadId: string;
    projectId: string;
    conversationId: string;
    channelId: string;
    tenantId: string | null;
    status: string;
    createdById: string | null;
    createdAt: Date;
    updatedAt: Date;
  }): ChannelLinkSummary {
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      threadId: row.threadId,
      projectId: row.projectId,
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

let singleton: TeamsChannelLinkStore | null = null;
export function getTeamsChannelLinkStore(): TeamsChannelLinkStore {
  if (!singleton) singleton = new TeamsChannelLinkStore();
  return singleton;
}

/** Test helper — reset the singleton so a test can inject its own Prisma. */
export function __resetTeamsChannelLinkStore(): void {
  singleton = null;
}
