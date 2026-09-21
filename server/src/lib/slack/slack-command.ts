/**
 * Issue #579 (epic #63) — Slack ChatOps: `/metis` slash commands + an interactive
 * Approve button. The Slack analogue of the #578 Teams ChatOps, hitting the SAME
 * approval + health services (no reimplementation).
 *
 * DESIGN: the handlers here are PURE async functions that take parsed inputs +
 * injected collaborators and RETURN a {@link SlackReply} (a `response_type` +
 * Block Kit blocks + an outcome) — they never touch the Slack client directly.
 * The thin Bolt wiring (`bolt-app.ts`) calls them and forwards the reply to
 * Slack's `respond()` / `client.chat.postEphemeral`. This makes the entire
 * security + business logic unit-testable WITHOUT Bolt or a live Slack workspace.
 *
 *   1. `/metis status [<projectRef>]` — resolves the project (explicit ref, else
 *      a defaultProjectId from the install), authorizes the resolved user on that
 *      project, and replies with an EPHEMERAL health message (only the invoker
 *      sees it; Slack ephemerals are first-class, unlike Teams).
 *
 *   2. `/metis approve <draft>` — replies with an EPHEMERAL Approve-button prompt
 *      (the #578 prompt pattern). Pressing it sends an interactive action that
 *      {@link handleSlackApproveAction} routes to the EXISTING `approveDraft`
 *      service, which flips the draft to `approved` and writes the
 *      `publish.draft.approve` AuditLog attributed to the resolved user.
 *
 * SECURITY (mirrors the #578 Teams handlers, applied to every Slack surface):
 *   - IDENTITY (#549/#579): the acting user is resolved team-scoped via the Slack
 *     identity resolver; an UNMAPPED sender is REFUSED (never act as nobody).
 *   - AUTHZ: approval reuses the SAME role permission the REST path requires
 *     (`hasPermission(role, "issue.draft")`) AND the project-membership check
 *     (`actorCanAccessProject` on the draft's project). Status requires project
 *     access on the resolved project. Identity ≠ authorization.
 *   - All Slack input (command text, draft id in the action value) is UNTRUSTED:
 *     it flows only into parameterized Prisma lookups / the approval service,
 *     never an executable sink. A missing/inaccessible draft → the SAME safe
 *     refusal (so a caller cannot probe for draft existence across projects).
 *   - The interactive action re-runs the FULL authz chain (the click is
 *     independent, untrusted input — never trust the earlier prompt).
 *
 * NON-THROWING: every handler returns a reply for every branch and never throws.
 */
import type { PrismaClient } from "@prisma/client";
import { hasPermission, type RoleKey } from "@metis/shared";

import { createChildLogger } from "../logger.js";
import { prisma as defaultPrisma } from "../prisma.js";
import { actorCanAccessProject } from "../scheduler/project-access.js";
import { approveDraft } from "../publishing/publishing-service.js";
import { PublishError } from "../publishing/types.js";
import { summarizeProjectHealth } from "../teams/project-health.js";
import { getSlackIdentityResolver, type SlackIdentityResolver } from "./slack-identity-resolver.js";
import {
  buildApprovePromptBlocks,
  buildApprovedBlocks,
  buildErrorBlocks,
  buildHelpBlocks,
  buildStatusBlocks,
  type Block,
} from "./block-kit.js";

const log = createChildLogger("slack-command");

/** The command prefix Slack delivers (the slash command name, no leading slash). */
export const COMMAND_NAME = "metis";

// ── Command parsing ──────────────────────────────────────────────────────────

/** A parsed `/metis` ChatOps command (from the slash-command `text` field). */
export type ParsedCommand =
  | { kind: "status"; projectRef: string | null }
  | { kind: "approve"; draftRef: string | null }
  | { kind: "unknown"; raw: string }
  | { kind: "help" };

/**
 * Parse the `text` portion of a `/metis` slash command (Slack strips the leading
 * `/metis` and delivers only the argument text). Unknown subcommands return
 * `{ kind: "unknown" }`; an empty text returns `help`. Refs are length-bounded
 * defensively (untrusted input).
 */
export function parseSlackCommand(text: string | undefined | null): ParsedCommand {
  const tokens = (text ?? "").trim().split(/\s+/).filter(Boolean);
  const sub = (tokens[0] ?? "").toLowerCase();
  const arg = (tokens[1] ?? "").slice(0, 200);

  if (!sub) return { kind: "help" };
  if (sub === "status") return { kind: "status", projectRef: arg || null };
  if (sub === "approve") return { kind: "approve", draftRef: arg || null };
  return { kind: "unknown", raw: sub.slice(0, 60) };
}

// ── Reply shape (pure) ──────────────────────────────────────────────────────

/** Outcome of any ChatOps interaction — for tests + structured logs. */
export type CommandOutcome =
  | "status-shown"
  | "approve-prompted"
  | "approved"
  | "help"
  | "unknown-command"
  | "unmapped-sender"
  | "forbidden"
  | "no-project"
  | "project-not-found"
  | "draft-not-found"
  | "bad-correlation"
  | "approve-failed";

/**
 * The reply the wiring forwards to Slack. `response_type: "ephemeral"` means only
 * the invoking user sees it (used for status + every refusal); `"in_channel"` is
 * reserved for the approval confirmation that the team should see.
 */
export interface SlackReply {
  outcome: CommandOutcome;
  responseType: "ephemeral" | "in_channel";
  blocks: Block[];
  draftId?: string;
  projectId?: string;
}

function ephemeral(
  outcome: CommandOutcome,
  blocks: Block[],
  extra?: Partial<SlackReply>,
): SlackReply {
  return { outcome, responseType: "ephemeral", blocks, ...extra };
}

// ── Shared collaborators / deps ──────────────────────────────────────────────

/** The actor + Slack-team context every handler receives from the verified request. */
export interface SlackActorContext {
  /** METIS workspace that owns the Slack install. */
  workspaceId: string;
  /** Slack team id (from the verified payload). */
  slackTeamId: string;
  /** Slack user id of the invoker (from the verified payload). */
  slackUserId: string;
  /**
   * Optional default project for `/metis status` with no explicit ref — e.g. the
   * workspace's single project, surfaced by the wiring. Null when none.
   */
  defaultProjectId?: string | null;
}

/** The resolver/authz collaborators every ChatOps handler shares. */
export interface SlackCommandDeps {
  resolver: SlackIdentityResolver;
  db: PrismaClient;
  /** Project-membership guard. Defaults to `actorCanAccessProject`. */
  authorizeProject: typeof actorCanAccessProject;
  /** Approval service. Defaults to `approveDraft`. */
  approve: typeof approveDraft;
  /** Project-health summarizer. Defaults to `summarizeProjectHealth`. */
  summarize: typeof summarizeProjectHealth;
}

export interface SlackCommandOptions {
  resolver?: SlackIdentityResolver;
  db?: PrismaClient;
  authorizeProject?: typeof actorCanAccessProject;
  approve?: typeof approveDraft;
  summarize?: typeof summarizeProjectHealth;
}

function resolveDeps(opts: SlackCommandOptions): SlackCommandDeps {
  return {
    resolver: opts.resolver ?? getSlackIdentityResolver(),
    db: opts.db ?? defaultPrisma,
    authorizeProject: opts.authorizeProject ?? actorCanAccessProject,
    approve: opts.approve ?? approveDraft,
    summarize: opts.summarize ?? summarizeProjectHealth,
  };
}

/**
 * Resolve the acting user's effective METIS role from their `UserRole` binding,
 * exactly as login does: the first assigned role's key, defaulting to the
 * LEAST-privileged `reader` when none is assigned. We never fabricate a higher
 * role for a Slack actor — authorization must be earned.
 */
async function resolveActorRole(db: PrismaClient, userId: string): Promise<RoleKey> {
  const userRole = await db.userRole.findFirst({ where: { userId }, include: { role: true } });
  return (userRole?.role.key as RoleKey | undefined) ?? "reader";
}

/**
 * Shared pre-flight: resolve the Slack sender to a METIS user (team-scoped) +
 * their effective role. Returns a refusal reply (unmapped sender) or the resolved
 * actor `{ userId, role }`.
 */
async function preflight(
  actor: SlackActorContext,
  deps: SlackCommandDeps,
): Promise<{ ok: true; userId: string; role: RoleKey } | { ok: false; reply: SlackReply }> {
  const resolved = await deps.resolver.resolveUserFromSlackId(actor.slackTeamId, actor.slackUserId);
  if (!resolved) {
    return {
      ok: false,
      reply: ephemeral(
        "unmapped-sender",
        buildErrorBlocks(
          "Account not linked",
          "Your Slack account isn't linked to a METIS user. Ask a workspace admin to link it.",
        ),
      ),
    };
  }
  const role = await resolveActorRole(deps.db, resolved.userId);
  return { ok: true, userId: resolved.userId, role };
}

// ── /metis status ────────────────────────────────────────────────────────────

/**
 * Handle `/metis status [<projectRef>]`. Resolves the project (explicit ref else
 * the install's default project), authorizes the resolved user on it, and returns
 * an EPHEMERAL health reply. NON-THROWING.
 */
export async function handleSlackStatusCommand(
  actor: SlackActorContext,
  cmd: { projectRef: string | null },
  opts: SlackCommandOptions = {},
): Promise<SlackReply> {
  const deps = resolveDeps(opts);
  const pre = await preflight(actor, deps);
  if (!pre.ok) return pre.reply;

  const projectId = cmd.projectRef ?? actor.defaultProjectId ?? null;
  if (!projectId) {
    return ephemeral(
      "no-project",
      buildErrorBlocks("No project", "Specify a project: `/metis status <projectId>`."),
    );
  }

  // AUTHORIZE — project membership (admins see all). Identity ≠ authorization.
  const allowed = await deps.authorizeProject({ id: pre.userId, role: pre.role }, projectId, {
    resource: "project",
    resourceId: projectId,
    action: "slack.chatops.status",
  });
  if (!allowed) {
    return ephemeral(
      "forbidden",
      buildErrorBlocks("No access", "You don't have access to that project in METIS."),
      { projectId },
    );
  }

  const health = await deps.summarize(projectId, deps.db);
  if (!health) {
    return ephemeral(
      "project-not-found",
      buildErrorBlocks("Not found", "That project could not be found."),
      { projectId },
    );
  }

  return ephemeral("status-shown", buildStatusBlocks(health), { projectId });
}

// ── /metis approve <draft> ─────────────────────────────────────────────────────

/**
 * Handle `/metis approve <draftRef>`. Loads + authorizes the draft (SAME role
 * permission the REST path requires + project membership) and returns an
 * EPHEMERAL Approve-button prompt. The actual approval happens on the button click
 * ({@link handleSlackApproveAction}). A missing/inaccessible draft → the SAME safe
 * refusal. NON-THROWING.
 */
export async function handleSlackApproveCommand(
  actor: SlackActorContext,
  cmd: { draftRef: string | null },
  opts: SlackCommandOptions = {},
): Promise<SlackReply> {
  const deps = resolveDeps(opts);
  const pre = await preflight(actor, deps);
  if (!pre.ok) return pre.reply;

  const draftId = (cmd.draftRef ?? "").trim();
  if (!draftId) {
    return ephemeral(
      "bad-correlation",
      buildErrorBlocks("Missing draft", "Usage: `/metis approve <draftId>`."),
    );
  }

  const refusal = await authorizeDraftAccess(deps, pre, draftId);
  if (refusal) return refusal;

  const draft = await deps.db.issueDraft.findFirst({
    where: { id: draftId, deletedAt: null },
    select: { id: true, title: true },
  });
  if (!draft) {
    return ephemeral(
      "draft-not-found",
      buildErrorBlocks("Not found", "That draft could not be found."),
      { draftId },
    );
  }

  return ephemeral(
    "approve-prompted",
    buildApprovePromptBlocks({ id: draft.id, title: draft.title }),
    {
      draftId,
    },
  );
}

/**
 * Handle the Approve button click (interactive action). Re-runs the FULL authz
 * chain (the click is untrusted, independent input) and invokes the EXISTING
 * `approveDraft`, which flips the draft to `approved` and writes the
 * `publish.draft.approve` AuditLog attributed to the resolved user. NON-THROWING;
 * an approval-service failure → a safe ephemeral error, no partial state.
 */
export async function handleSlackApproveAction(
  actor: SlackActorContext,
  action: { draftId: string | null | undefined },
  opts: SlackCommandOptions = {},
): Promise<SlackReply> {
  const deps = resolveDeps(opts);
  const draftId = typeof action.draftId === "string" ? action.draftId.trim() : "";
  if (!draftId) {
    return ephemeral(
      "bad-correlation",
      buildErrorBlocks("Missing draft", "This action is missing its draft reference."),
    );
  }

  const pre = await preflight(actor, deps);
  if (!pre.ok) return pre.reply;

  const refusal = await authorizeDraftAccess(deps, pre, draftId);
  if (refusal) return refusal;

  try {
    // `projectId: null` — there is no path project here; `authorizeDraftAccess`
    // above already resolved the draft's OWN project and authorized this actor
    // against it (the #1055 resolve-then-authorize shape). #1072 makes the
    // field required so this choice is explicit rather than inherited.
    await deps.approve({ draftId, actorId: pre.userId, projectId: null });
    log.info("Approved publishing draft from Slack", {
      workspaceId: actor.workspaceId,
      draftId,
      actorId: pre.userId,
    });
    // The confirmation is posted in-channel so the team sees the approval.
    return {
      outcome: "approved",
      responseType: "in_channel",
      blocks: buildApprovedBlocks(draftId),
      draftId,
    };
  } catch (err) {
    if (err instanceof PublishError && err.code === "DRAFT_NOT_FOUND") {
      return ephemeral(
        "draft-not-found",
        buildErrorBlocks("Not found", "That draft could not be found."),
        { draftId },
      );
    }
    log.warn("Approve-from-Slack failed", {
      workspaceId: actor.workspaceId,
      draftId,
      message: (err as Error).message,
    });
    return ephemeral(
      "approve-failed",
      buildErrorBlocks("Couldn't approve", "We couldn't approve this draft. Please try again."),
      { draftId },
    );
  }
}

/**
 * Authorize the resolved actor to act on `draftId`: they must (a) carry the
 * `issue.draft` permission (the SAME role permission the REST approve route
 * requires) AND (b) have project access to the draft's project. A missing draft
 * and a draft in an inaccessible project produce the IDENTICAL safe refusal so a
 * caller cannot probe for draft existence across projects. Returns a refusal
 * `SlackReply` or `null` when authorized.
 */
async function authorizeDraftAccess(
  deps: SlackCommandDeps,
  actor: { userId: string; role: RoleKey },
  draftId: string,
): Promise<SlackReply | null> {
  // Role-permission gate first (cheap, no DB) — identical to `requirePermission("issue.draft")`.
  if (!hasPermission(actor.role, "issue.draft")) {
    return ephemeral(
      "forbidden",
      buildErrorBlocks(
        "No permission",
        "You don't have permission to approve publishing drafts in METIS.",
      ),
      { draftId },
    );
  }

  const draft = await deps.db.issueDraft.findFirst({
    where: { id: draftId, deletedAt: null },
    select: { id: true, projectId: true },
  });
  if (!draft) {
    return ephemeral(
      "draft-not-found",
      buildErrorBlocks("Not found", "That draft could not be found."),
      { draftId },
    );
  }

  const allowed = await deps.authorizeProject(
    { id: actor.userId, role: actor.role },
    draft.projectId,
    {
      resource: "issue_draft",
      resourceId: draftId,
      action: "slack.chatops.approve",
    },
  );
  if (!allowed) {
    // Same refusal as not-found — do not reveal a draft in a project the actor can't see.
    return ephemeral(
      "draft-not-found",
      buildErrorBlocks("Not found", "That draft could not be found."),
      { draftId },
    );
  }
  return null;
}

/** Dispatch a parsed command to the right handler (status/approve/help/unknown). */
export async function handleSlackCommand(
  actor: SlackActorContext,
  text: string | undefined | null,
  opts: SlackCommandOptions = {},
): Promise<SlackReply> {
  const cmd = parseSlackCommand(text);
  switch (cmd.kind) {
    case "status":
      return handleSlackStatusCommand(actor, cmd, opts);
    case "approve":
      return handleSlackApproveCommand(actor, cmd, opts);
    case "unknown":
      return ephemeral(
        "unknown-command",
        buildErrorBlocks(
          "Unknown command",
          `Unrecognized command \`${cmd.raw}\`. Try \`/metis\` for help.`,
        ),
      );
    case "help":
    default:
      return ephemeral("help", buildHelpBlocks());
  }
}
