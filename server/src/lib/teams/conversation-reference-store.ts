/**
 * Epic #547 (Phase 0, #548) — ConversationReference store.
 *
 * Persists Bot Framework `ConversationReference`s so later phases can send
 * PROACTIVE messages into a Teams channel (outbound mirror #550) without an
 * inbound activity to reply to. A reference is captured on install / first
 * interaction and refreshed on every subsequent activity (serviceUrl can rotate).
 *
 * Why a Prisma model and NOT the UNLOGGED ephemeral tables used for the
 * rate-limit/SSO-state stores (#541/#542): a ConversationReference is DURABLE
 * relational data — losing it silently breaks proactive delivery for that
 * channel until the next inbound message re-captures it. The #541/#542 tables
 * hold crash-disposable counters/nonces where loss just resets a window. So this
 * lives in `schema.prisma` with a real migration, replicated and crash-safe.
 *
 * The store reuses the shared Prisma client (and thus the shared Postgres in a
 * multi-replica deploy, via the #539 scheme-selected adapter), so a reference
 * saved by one replica is immediately visible to every other — exactly the
 * multi-instance guarantee the #541/#542 stores provide.
 *
 * Keying: every operation is scoped by `workspaceId` (tenant isolation) plus the
 * Bot Framework `conversationId` — the `(workspaceId, conversationId)` unique
 * key. A caller can NEVER read or mutate another workspace's references.
 */
import type { PrismaClient } from "@prisma/client";
import type { ConversationReference } from "botbuilder";

import { prisma as defaultPrisma } from "../prisma.js";

/** A stored reference plus the METIS routing metadata extracted from it. */
export interface StoredConversationReference {
  installationId: string;
  workspaceId: string;
  conversationId: string;
  serviceUrl: string;
  tenantId: string | null;
  channelId: string;
  aadObjectId: string | null;
  userId: string | null;
  reference: Partial<ConversationReference>;
}

/**
 * Pull the conversation id out of a (partial) ConversationReference. Bot
 * Framework guarantees `conversation.id` on any reference derived from a real
 * activity; we treat a missing id as a programming error (never persist a
 * reference we cannot key).
 */
export function conversationIdOf(ref: Partial<ConversationReference>): string {
  const id = ref.conversation?.id;
  if (!id || id.trim().length === 0) {
    throw new Error("ConversationReference has no conversation.id — cannot key the store");
  }
  return id;
}

export class ConversationReferenceStore {
  private readonly db: PrismaClient;

  constructor(db: PrismaClient = defaultPrisma) {
    this.db = db;
  }

  /**
   * Upsert a reference for `(workspaceId, conversationId)`. Idempotent: the same
   * conversation seen again updates the stored serviceUrl/user/JSON in place
   * (serviceUrl rotates), never creating a duplicate.
   */
  async save(
    installationId: string,
    workspaceId: string,
    ref: Partial<ConversationReference>,
  ): Promise<StoredConversationReference> {
    const conversationId = conversationIdOf(ref);
    const serviceUrl = ref.serviceUrl ?? "";
    const channelId = ref.channelId ?? "";
    const tenantId = ref.conversation?.tenantId ?? null;
    // `aadObjectId` is the stable AAD identity used by later phases for AAD→METIS
    // user mapping; `user.id` is the channel-specific account id.
    const aadObjectId = (ref.user as { aadObjectId?: string } | undefined)?.aadObjectId ?? null;
    const userId = ref.user?.id ?? null;
    const serialized = JSON.stringify(ref);

    const row = await this.db.teamsConversationReference.upsert({
      where: { workspaceId_conversationId: { workspaceId, conversationId } },
      create: {
        installationId,
        workspaceId,
        conversationId,
        serviceUrl,
        tenantId,
        channelId,
        aadObjectId,
        userId,
        reference: serialized,
      },
      update: {
        // installationId may change if the workspace re-installed under a new app.
        installationId,
        serviceUrl,
        tenantId,
        channelId,
        aadObjectId,
        userId,
        reference: serialized,
      },
    });
    return this.toStored(row);
  }

  /** Fetch the reference for `(workspaceId, conversationId)`, or null. */
  async get(
    workspaceId: string,
    conversationId: string,
  ): Promise<StoredConversationReference | null> {
    const row = await this.db.teamsConversationReference.findUnique({
      where: { workspaceId_conversationId: { workspaceId, conversationId } },
    });
    return row ? this.toStored(row) : null;
  }

  /** List every reference for a workspace (used by fan-out in later phases). */
  async listByWorkspace(workspaceId: string): Promise<StoredConversationReference[]> {
    const rows = await this.db.teamsConversationReference.findMany({
      where: { workspaceId },
      orderBy: { createdAt: "asc" },
    });
    return rows.map((r) => this.toStored(r));
  }

  /**
   * Delete the reference for `(workspaceId, conversationId)`. Returns true if a
   * row was removed, false if none existed (idempotent delete).
   */
  async delete(workspaceId: string, conversationId: string): Promise<boolean> {
    const res = await this.db.teamsConversationReference.deleteMany({
      where: { workspaceId, conversationId },
    });
    return res.count > 0;
  }

  private toStored(row: {
    installationId: string;
    workspaceId: string;
    conversationId: string;
    serviceUrl: string;
    tenantId: string | null;
    channelId: string;
    aadObjectId: string | null;
    userId: string | null;
    reference: string;
  }): StoredConversationReference {
    return {
      installationId: row.installationId,
      workspaceId: row.workspaceId,
      conversationId: row.conversationId,
      serviceUrl: row.serviceUrl,
      tenantId: row.tenantId,
      channelId: row.channelId,
      aadObjectId: row.aadObjectId,
      userId: row.userId,
      reference: JSON.parse(row.reference) as Partial<ConversationReference>,
    };
  }
}

let singleton: ConversationReferenceStore | null = null;
export function getConversationReferenceStore(): ConversationReferenceStore {
  if (!singleton) singleton = new ConversationReferenceStore();
  return singleton;
}

/** Test helper — reset the singleton so a test can inject its own Prisma. */
export function __resetConversationReferenceStore(): void {
  singleton = null;
}
