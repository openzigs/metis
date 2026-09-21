/**
 * Epic #63 (#578) — Teams ChatOps: `/metis` slash-style commands + an approval
 * button, on the EXISTING #547/#548 bot (no second app, no new bot registration).
 *
 * Two interactive surfaces, both routed through the existing functional turn
 * handler (`runFoundationTurn`, #548) alongside the inbound-ingest (#551) and
 * promote (#553) branches:
 *
 *   1. `/metis status [<projectRef>]` — the user types a status command in a
 *      channel; we reply with an Adaptive Card showing current project health.
 *      The project is resolved from the channel's thread link (#549) or, when
 *      given, an explicit project ref. Health comes from the cheap
 *      `summarizeProjectHealth` summarizer (indexed counts; <2s budget).
 *
 *      ON "EPHEMERAL": Microsoft Teams has NO Slack-style channel-ephemeral bot
 *      message — a bot reply in a channel is visible to the channel. The status
 *      card is therefore posted as a normal reply; the response carries only the
 *      requested project's non-sensitive health summary (no secrets, no other
 *      project's data), and project access is enforced before it is built, so it
 *      is safe to render in the channel. (We do not fabricate ephemerality with a
 *      channelData hack that clients ignore.)
 *
 *   2. `/metis approve <draft>` — we reply with an Adaptive Card carrying an
 *      Approve `Action.Submit` button (the #553 promote-card pattern). Pressing
 *      it delivers a `message` activity whose `value.metisAction === "approve"`,
 *      which we route to {@link handleTeamsApproveSubmit}: it invokes the EXISTING
 *      publishing-approval service (`approveDraft`, `publishing-service.ts`),
 *      which flips the draft to `approved` and writes the `publish.draft.approve`
 *      AuditLog attributed to the resolved user — we do NOT reimplement approval.
 *
 * "SLASH COMMANDS" IN TEAMS: a Teams bot does not receive Slack-style slash
 * commands; it receives the command as the message TEXT (often prefixed with the
 * bot @mention). So `/metis ...` is parsed out of the (mention-stripped) message
 * text, reusing the #551 mention-stripping approach.
 *
 * SECURITY (mirrors #553 promote + #554 governance, applied to EVERY surface):
 *   - TENANT ALLOWLIST (#554, A01): a command/approve from a non-allowlisted
 *     tenant is refused BEFORE we resolve the sender or touch any data.
 *   - INBOUND RATE LIMIT (#554, A04): the per-(workspace,conversation) cap is
 *     applied to commands too (an abusive channel cannot flood ChatOps).
 *   - IDENTITY (#549): the acting user is resolved tenant-scoped via
 *     `resolveUserFromAadObjectId`; an unmapped sender is REFUSED (never act as
 *     nobody).
 *   - AUTHZ: approval reuses the SAME role permission the REST path requires
 *     (`hasPermission(role, "issue.draft")`) AND the project-membership check
 *     (`actorCanAccessProject` on the draft's project). Status requires project
 *     access on the resolved project. Identity ≠ authorization.
 *   - All Teams input (command text, draft id in the submit value) is UNTRUSTED:
 *     it flows only into parameterized Prisma lookups / the approval service,
 *     never an executable sink. Cards never leak the allowlist, a raw error, or
 *     another project's existence (a missing/inaccessible draft → the same safe
 *     refusal).
 *
 * NON-THROWING: every handler returns an outcome for every branch and never
 * throws into the turn — a card-send failure is logged and swallowed.
 */
import type { Activity, TurnContext } from "botbuilder";
import type { PrismaClient } from "@prisma/client";
import { hasPermission, type RoleKey } from "@metis/shared";

import { createChildLogger } from "../logger.js";
import { prisma as defaultPrisma } from "../prisma.js";
import { actorCanAccessProject } from "../scheduler/project-access.js";
import { approveDraft } from "../publishing/publishing-service.js";
import { PublishError } from "../publishing/types.js";
import {
  getTeamsAadIdentityResolver,
  type TeamsAadIdentityResolver,
} from "./aad-identity-resolver.js";
import { getTeamsChannelLinkStore, type TeamsChannelLinkStore } from "./channel-link-store.js";
import { summarizeProjectHealth, type ProjectHealthSummary } from "./project-health.js";
import {
  loadTeamsTenantAllowlist,
  isTeamsTenantAllowed,
  type TeamsTenantPolicy,
} from "./tenant-allowlist.js";
import {
  checkInboundRateLimit,
  loadInboundRateLimitConfig,
  type InboundRateLimitConfig,
} from "./inbound-rate-limit.js";

const log = createChildLogger("teams-command");

const ADAPTIVE_CARD_CONTENT_TYPE = "application/vnd.microsoft.card.adaptive";

/** The `Action.Submit` discriminator for the Approve button (echoed back). */
export const APPROVE_ACTION = "approve";

/** The Adaptive Card action id for the Approve button. */
export const APPROVE_ACTION_ID = "metis.approveDraft";

/** The command prefix users type (after any bot @mention is stripped). */
export const COMMAND_PREFIX = "/metis";

// ── Command parsing ──────────────────────────────────────────────────────────

/** A parsed `/metis` ChatOps command. */
export type ParsedCommand =
  | { kind: "status"; projectRef: string | null }
  | { kind: "approve"; draftRef: string | null }
  | { kind: "unknown"; raw: string }
  | { kind: "help" };

/**
 * Strip the leading bot @mention from inbound text (same approach as #551
 * inbound sync): Teams prefixes a channel message addressed to the bot with a
 * mention entity whose `mentioned.id === recipient.id`, and its `text` (e.g.
 * `<at>METIS</at>`) appears verbatim in `activity.text`. We remove ONLY those
 * recipient-targeted mention strings so the command parses cleanly.
 */
export function stripBotMention(activity: Partial<Activity>): string {
  let text = (activity.text ?? "").trim();
  if (!text) return "";
  const botId = activity.recipient?.id ?? "";
  const entities = (activity.entities ?? []) as Array<{
    type?: string;
    text?: string;
    mentioned?: { id?: string };
  }>;
  for (const ent of entities) {
    if (ent.type === "mention" && ent.text && ent.mentioned?.id && ent.mentioned.id === botId) {
      text = text.split(ent.text).join(" ");
    }
  }
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Is this message text (already mention-stripped) a `/metis` command? Matches
 * `/metis` as the first whitespace-delimited token, case-insensitively.
 */
export function isMetisCommandText(text: string): boolean {
  const first = text.trim().split(/\s+/)[0] ?? "";
  return first.toLowerCase() === COMMAND_PREFIX;
}

/**
 * Parse a `/metis ...` command from already-mention-stripped text. Unknown
 * subcommands return `{ kind: "unknown" }`; a bare `/metis` returns `help`.
 * Refs are length-bounded defensively (they are untrusted input).
 */
export function parseMetisCommand(text: string): ParsedCommand {
  const tokens = text.trim().split(/\s+/);
  // tokens[0] is the (already verified) /metis prefix.
  const sub = (tokens[1] ?? "").toLowerCase();
  const arg = (tokens[2] ?? "").slice(0, 200);

  if (!sub) return { kind: "help" };
  if (sub === "status") return { kind: "status", projectRef: arg || null };
  if (sub === "approve") return { kind: "approve", draftRef: arg || null };
  return { kind: "unknown", raw: sub.slice(0, 60) };
}

/** The shape of an Approve `Action.Submit`'s `activity.value` (untrusted). */
interface ApproveSubmitValue {
  metisAction?: unknown;
  draftId?: unknown;
}

/** Is this activity the Approve `Action.Submit`? (a `message` with the marker). */
export function isApproveSubmit(activity: Partial<Activity> | undefined | null): boolean {
  if (!activity || activity.type !== "message") return false;
  const value = activity.value as ApproveSubmitValue | undefined;
  return !!value && value.metisAction === APPROVE_ACTION;
}

// ── Card rendering (pure) ──────────────────────────────────────────────────────

function card(
  body: Array<Record<string, unknown>>,
  actions?: Array<Record<string, unknown>>,
): {
  type: "AdaptiveCard";
  $schema: string;
  version: string;
  body: Array<Record<string, unknown>>;
  actions?: Array<Record<string, unknown>>;
} {
  return {
    type: "AdaptiveCard",
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    version: "1.4",
    body,
    ...(actions ? { actions } : {}),
  };
}

/** Wrap a card in a `message` activity. */
function cardActivity(content: Record<string, unknown>): Partial<Activity> {
  return {
    type: "message",
    attachments: [{ contentType: ADAPTIVE_CARD_CONTENT_TYPE, content }],
  };
}

/** A clear refusal/error card. `detail` is always a safe, user-facing string. */
export function buildErrorCard(title: string, detail: string): Partial<Activity> {
  return cardActivity(
    card([
      { type: "TextBlock", text: `⚠️ ${title}`, weight: "Bolder", wrap: true },
      { type: "TextBlock", text: detail, wrap: true },
    ]),
  );
}

/** The project-health card for `/metis status`. */
export function buildStatusCard(health: ProjectHealthSummary): Partial<Activity> {
  const facts = [
    { title: "Project status", value: health.status },
    { title: "Requirements", value: String(health.requirementCount) },
    {
      title: "Drafts",
      value: `${health.drafts.pending} pending · ${health.drafts.approved} approved · ${health.drafts.published} published`,
    },
    { title: "Latest analysis", value: health.latestAnalysisStatus ?? "none yet" },
    { title: "Latest publish", value: health.latestPublishStatus ?? "none yet" },
  ];
  return cardActivity(
    card([
      {
        type: "TextBlock",
        text: `📊 ${health.name}`,
        weight: "Bolder",
        size: "Medium",
        wrap: true,
      },
      { type: "FactSet", facts },
    ]),
  );
}

/** The approve-confirmation prompt card carrying the Approve `Action.Submit`. */
export function buildApprovePromptCard(draft: { id: string; title: string }): Partial<Activity> {
  return cardActivity(
    card(
      [
        { type: "TextBlock", text: "Approve draft?", weight: "Bolder", wrap: true },
        { type: "TextBlock", text: draft.title, wrap: true },
        { type: "TextBlock", text: `Draft \`${draft.id}\``, isSubtle: true, wrap: true },
      ],
      [
        {
          type: "Action.Submit",
          id: APPROVE_ACTION_ID,
          title: "Approve",
          data: { metisAction: APPROVE_ACTION, draftId: draft.id },
        },
      ],
    ),
  );
}

/** Confirmation card — the draft was approved. */
export function buildApprovedCard(draftId: string): Partial<Activity> {
  return cardActivity(
    card([
      { type: "TextBlock", text: "✅ Draft approved", weight: "Bolder", wrap: true },
      { type: "TextBlock", text: `Draft \`${draftId}\` is now approved in METIS.`, wrap: true },
    ]),
  );
}

const HELP_TEXT =
  "Available commands: `/metis status [<projectId>]` shows project health; " +
  "`/metis approve <draftId>` starts an approval for a publishing draft.";

/** Help card listing the available commands + exact invocation syntax. */
export function buildHelpCard(): Partial<Activity> {
  return cardActivity(
    card([
      { type: "TextBlock", text: "METIS ChatOps", weight: "Bolder", wrap: true },
      { type: "TextBlock", text: HELP_TEXT, wrap: true },
    ]),
  );
}

// ── Shared infra ───────────────────────────────────────────────────────────────

/** Best-effort card send — never throws into the turn. */
async function safeSend(context: TurnContext, activity: Partial<Activity>): Promise<void> {
  try {
    await context.sendActivity(activity);
  } catch (err) {
    log.warn("Failed to post ChatOps response card to Teams", {
      message: (err as Error).message,
    });
  }
}

/** Extract the AAD tenant id (channelData first, then conversation). */
function tenantIdOf(activity: Partial<Activity>): string | null {
  const fromChannelData = (activity.channelData as { tenant?: { id?: string } } | undefined)?.tenant
    ?.id;
  if (fromChannelData) return fromChannelData;
  const fromConversation = (activity.conversation as { tenantId?: string } | undefined)?.tenantId;
  return fromConversation ?? null;
}

/**
 * Resolve the acting user's effective METIS role from their `UserRole` binding,
 * exactly as login does (`auth.ts#ensureUserRow`): the first assigned role's
 * key, defaulting to the LEAST-privileged `reader` when none is assigned. We do
 * NOT fabricate a higher role for a Teams actor — authorization must be earned.
 */
async function resolveActorRole(db: PrismaClient, userId: string): Promise<RoleKey> {
  const userRole = await db.userRole.findFirst({
    where: { userId },
    include: { role: true },
  });
  return (userRole?.role.key as RoleKey | undefined) ?? "reader";
}

/** The resolver/authz collaborators every ChatOps handler shares. */
export interface CommandDeps {
  workspaceId: string;
  resolver: TeamsAadIdentityResolver;
  linkStore: TeamsChannelLinkStore;
  db: PrismaClient;
  tenantPolicy: TeamsTenantPolicy;
  rateLimitConfig: InboundRateLimitConfig;
  rateLimit: typeof checkInboundRateLimit;
  /** Project-membership guard. Defaults to `actorCanAccessProject`. */
  authorizeProject: typeof actorCanAccessProject;
  /** Approval service. Defaults to `approveDraft`. */
  approve: typeof approveDraft;
  /** Project-health summarizer. Defaults to `summarizeProjectHealth`. */
  summarize: typeof summarizeProjectHealth;
}

export interface CommandOptions {
  workspaceId: string;
  resolver?: TeamsAadIdentityResolver;
  linkStore?: TeamsChannelLinkStore;
  db?: PrismaClient;
  tenantPolicy?: TeamsTenantPolicy;
  rateLimitConfig?: InboundRateLimitConfig;
  rateLimit?: typeof checkInboundRateLimit;
  authorizeProject?: typeof actorCanAccessProject;
  approve?: typeof approveDraft;
  summarize?: typeof summarizeProjectHealth;
}

function resolveDeps(opts: CommandOptions): CommandDeps {
  return {
    workspaceId: opts.workspaceId,
    resolver: opts.resolver ?? getTeamsAadIdentityResolver(),
    linkStore: opts.linkStore ?? getTeamsChannelLinkStore(),
    db: opts.db ?? defaultPrisma,
    tenantPolicy: opts.tenantPolicy ?? loadTeamsTenantAllowlist(),
    rateLimitConfig: opts.rateLimitConfig ?? loadInboundRateLimitConfig(),
    rateLimit: opts.rateLimit ?? checkInboundRateLimit,
    authorizeProject: opts.authorizeProject ?? actorCanAccessProject,
    approve: opts.approve ?? approveDraft,
    summarize: opts.summarize ?? summarizeProjectHealth,
  };
}

/** Outcome of any ChatOps interaction — for tests + structured logs. */
export type CommandOutcome =
  | "status-shown"
  | "approve-prompted"
  | "approved"
  | "help"
  | "unknown-command"
  | "tenant-not-allowed"
  | "rate-limited"
  | "unmapped-sender"
  | "forbidden"
  | "no-project" // status: no channel link and no explicit project ref
  | "project-not-found"
  | "draft-not-found"
  | "bad-correlation" // approve submit lacked a draftId
  | "approve-failed";

export interface CommandResult {
  outcome: CommandOutcome;
  draftId?: string;
  projectId?: string;
}

/**
 * Shared pre-flight gate every ChatOps surface runs BEFORE doing work: tenant
 * allowlist → inbound rate limit → identity resolve → effective role. Returns
 * either a refusal `result` (caller returns it verbatim, a safe card already
 * sent) or the resolved actor `{ userId, role }`.
 */
async function preflight(
  context: TurnContext,
  deps: CommandDeps,
): Promise<{ ok: true; userId: string; role: RoleKey } | { ok: false; result: CommandResult }> {
  const activity = context.activity;

  // 1. TENANT ALLOWLIST (#554, A01) — refuse a non-allowlisted tenant first.
  const tenantId = tenantIdOf(activity);
  if (!isTeamsTenantAllowed(deps.tenantPolicy, tenantId)) {
    log.warn("Teams ChatOps rejected: tenant not on allowlist", {
      workspaceId: deps.workspaceId,
    });
    await safeSend(
      context,
      buildErrorCard("Not permitted", "This Teams tenant isn't permitted to use METIS ChatOps."),
    );
    return { ok: false, result: { outcome: "tenant-not-allowed" } };
  }

  // 2. INBOUND RATE LIMIT (#554, A04) — fail OPEN on a store error.
  const conversationId = activity.conversation?.id ?? "";
  try {
    const rl = await deps.rateLimit(
      { workspaceId: deps.workspaceId, conversationId },
      deps.rateLimitConfig,
    );
    if (!rl.allowed) {
      log.info("Teams ChatOps rate-limited", { workspaceId: deps.workspaceId });
      await safeSend(
        context,
        buildErrorCard("Slow down", "Too many requests in this channel. Try again shortly."),
      );
      return { ok: false, result: { outcome: "rate-limited" } };
    }
  } catch (err) {
    log.warn("Teams ChatOps rate-limit check failed (failing open)", {
      workspaceId: deps.workspaceId,
      message: (err as Error).message,
    });
  }

  // 3. IDENTITY (#549) — resolve the acting user tenant-scoped; never act as nobody.
  const aadObjectId = activity.from?.aadObjectId ?? null;
  const acting = await deps.resolver.resolveUserFromAadObjectId(tenantId, aadObjectId);
  if (!acting) {
    await safeSend(
      context,
      buildErrorCard(
        "Account not linked",
        "Your Teams account isn't linked to a METIS user. Ask a workspace admin to link it.",
      ),
    );
    return { ok: false, result: { outcome: "unmapped-sender" } };
  }

  // 4. Effective role (least-privilege default).
  const role = await resolveActorRole(deps.db, acting.userId);
  return { ok: true, userId: acting.userId, role };
}

// ── /metis status ──────────────────────────────────────────────────────────────

/**
 * Handle `/metis status [<projectRef>]`. Resolves the project from an explicit
 * ref or the channel's thread link (#549), authorizes the resolved user on that
 * project, and replies with an EPHEMERAL health card. NON-THROWING.
 */
export async function handleTeamsStatusCommand(
  context: TurnContext,
  cmd: { projectRef: string | null },
  opts: CommandOptions,
): Promise<CommandResult> {
  const deps = resolveDeps(opts);
  const pre = await preflight(context, deps);
  if (!pre.ok) return pre.result;

  // Resolve the target project: explicit ref wins; otherwise the channel's link.
  let projectId = cmd.projectRef;
  if (!projectId) {
    const conversationId = context.activity.conversation?.id ?? "";
    const link = await deps.linkStore.getByConversation(deps.workspaceId, conversationId);
    if (!link || link.status !== "active") {
      await safeSend(
        context,
        buildErrorCard(
          "No project",
          "This channel isn't linked to a METIS project. Run `/metis status <projectId>` or link the channel first.",
        ),
      );
      return { outcome: "no-project" };
    }
    projectId = link.projectId;
  }

  // AUTHORIZE — project membership (admins see all). Identity ≠ authorization.
  const allowed = await deps.authorizeProject({ id: pre.userId, role: pre.role }, projectId, {
    resource: "project",
    resourceId: projectId,
    action: "teams.chatops.status",
  });
  if (!allowed) {
    await safeSend(
      context,
      buildErrorCard("No access", "You don't have access to that project in METIS."),
    );
    return { outcome: "forbidden", projectId };
  }

  const health = await deps.summarize(projectId, deps.db);
  if (!health) {
    await safeSend(context, buildErrorCard("Not found", "That project could not be found."));
    return { outcome: "project-not-found", projectId };
  }

  await safeSend(context, buildStatusCard(health));
  return { outcome: "status-shown", projectId };
}

// ── /metis approve <draft> ───────────────────────────────────────────────────────

/**
 * Handle `/metis approve <draftRef>`. Loads the draft, authorizes the resolved
 * user (the SAME role permission the REST path requires + project membership on
 * the draft's project), and replies with an Approve `Action.Submit` card. The
 * actual approval happens on the button press ({@link handleTeamsApproveSubmit}).
 * NON-THROWING. A missing or inaccessible draft → the SAME safe refusal (a draft
 * the actor may not see must not be distinguishable from one that doesn't exist).
 */
export async function handleTeamsApproveCommand(
  context: TurnContext,
  cmd: { draftRef: string | null },
  opts: CommandOptions,
): Promise<CommandResult> {
  const deps = resolveDeps(opts);
  const pre = await preflight(context, deps);
  if (!pre.ok) return pre.result;

  const draftId = (cmd.draftRef ?? "").trim();
  if (!draftId) {
    await safeSend(context, buildErrorCard("Missing draft", "Usage: `/metis approve <draftId>`."));
    return { outcome: "bad-correlation" };
  }

  const refusal = await authorizeDraftAccess(context, deps, pre, draftId);
  if (refusal) return refusal;
  // authorizeDraftAccess returned null → the draft is loaded + authorized; reload
  // its title for the prompt (cheap, already validated to exist + be accessible).
  const draft = await deps.db.issueDraft.findFirst({
    where: { id: draftId, deletedAt: null },
    select: { id: true, title: true },
  });
  if (!draft) {
    await safeSend(context, buildErrorCard("Not found", "That draft could not be found."));
    return { outcome: "draft-not-found", draftId };
  }

  await safeSend(context, buildApprovePromptCard({ id: draft.id, title: draft.title }));
  return { outcome: "approve-prompted", draftId };
}

/**
 * Handle the Approve `Action.Submit` (delivered as a `message` with
 * `value.metisAction === "approve"`). Re-runs the FULL authz chain (the click is
 * untrusted, independent client input — never trust the earlier prompt) and then
 * invokes the EXISTING `approveDraft`, which flips the draft to `approved` and
 * writes the `publish.draft.approve` AuditLog attributed to the resolved user.
 * NON-THROWING; an approval-service failure → a safe error card, no partial state
 * (the service either fully approves or throws before the audit write).
 */
export async function handleTeamsApproveSubmit(
  context: TurnContext,
  opts: CommandOptions,
): Promise<CommandResult> {
  const deps = resolveDeps(opts);
  const value = (context.activity.value ?? {}) as ApproveSubmitValue;
  const draftId = typeof value.draftId === "string" ? value.draftId.trim() : "";
  if (!draftId) {
    await safeSend(
      context,
      buildErrorCard("Missing draft", "This action is missing its draft reference."),
    );
    return { outcome: "bad-correlation" };
  }

  const pre = await preflight(context, deps);
  if (!pre.ok) return pre.result;

  const refusal = await authorizeDraftAccess(context, deps, pre, draftId);
  if (refusal) return refusal;

  // APPROVE via the EXISTING service — attributed to the REAL resolved user.
  try {
    // `projectId: null` — there is no path project here; `authorizeDraftAccess`
    // above already resolved the draft's OWN project and authorized this actor
    // against it (the #1055 resolve-then-authorize shape). #1072 makes the
    // field required so this choice is explicit rather than inherited.
    await deps.approve({ draftId, actorId: pre.userId, projectId: null });
    log.info("Approved publishing draft from Teams", {
      workspaceId: deps.workspaceId,
      draftId,
      actorId: pre.userId,
    });
    await safeSend(context, buildApprovedCard(draftId));
    return { outcome: "approved", draftId };
  } catch (err) {
    // `approveDraft` is idempotent for already-published drafts and throws
    // `PublishError(404, DRAFT_NOT_FOUND)` for a missing one; any throw leaves no
    // partial state (the audit write only runs after the update). Surface a SAFE
    // message; internal detail is logged, never sent.
    if (err instanceof PublishError && err.code === "DRAFT_NOT_FOUND") {
      await safeSend(context, buildErrorCard("Not found", "That draft could not be found."));
      return { outcome: "draft-not-found", draftId };
    }
    log.warn("Approve-from-Teams failed", {
      workspaceId: deps.workspaceId,
      draftId,
      message: (err as Error).message,
    });
    await safeSend(
      context,
      buildErrorCard("Couldn't approve", "We couldn't approve this draft. Please try again."),
    );
    return { outcome: "approve-failed", draftId };
  }
}

/**
 * Authorize the resolved actor to act on `draftId`: they must (a) carry the
 * `issue.draft` permission (the SAME role permission the REST approve route
 * requires) AND (b) have project access to the draft's project. A missing draft
 * and a draft in an inaccessible project produce the IDENTICAL safe refusal so a
 * caller cannot probe for draft existence across projects. Returns a refusal
 * `CommandResult` (card already sent) or `null` when authorized.
 */
async function authorizeDraftAccess(
  context: TurnContext,
  deps: CommandDeps,
  actor: { userId: string; role: RoleKey },
  draftId: string,
): Promise<CommandResult | null> {
  // Role-permission gate first (cheap, no DB) — identical to `requirePermission("issue.draft")`.
  if (!hasPermission(actor.role, "issue.draft")) {
    await safeSend(
      context,
      buildErrorCard(
        "No permission",
        "You don't have permission to approve publishing drafts in METIS.",
      ),
    );
    return { outcome: "forbidden", draftId };
  }

  const draft = await deps.db.issueDraft.findFirst({
    where: { id: draftId, deletedAt: null },
    select: { id: true, projectId: true },
  });
  if (!draft) {
    await safeSend(context, buildErrorCard("Not found", "That draft could not be found."));
    return { outcome: "draft-not-found", draftId };
  }

  const allowed = await deps.authorizeProject(
    { id: actor.userId, role: actor.role },
    draft.projectId,
    {
      resource: "issue_draft",
      resourceId: draftId,
      action: "teams.chatops.approve",
    },
  );
  if (!allowed) {
    // Same card as not-found — do not reveal a draft in a project the actor
    // cannot see.
    await safeSend(context, buildErrorCard("Not found", "That draft could not be found."));
    return { outcome: "draft-not-found", draftId };
  }
  return null;
}
