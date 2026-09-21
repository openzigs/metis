/**
 * Epic #547 — Teams activity handler.
 *
 * On every turn the handler:
 *
 *   1. Captures/refreshes the `ConversationReference` for the conversation (keyed
 *      by workspace + conversation) so proactive (outbound, #550) sends work.
 *   2. On a `message` activity, INGESTS it into the linked discussion thread
 *      (Phase 2 inbound, #551): resolve channel→thread link, resolve the sender,
 *      authorize, and create a human `DiscussionMessage` with `origin="teams"`.
 *      Ingestion is fully delegated to {@link ingestTeamsActivity}, which owns
 *      the loop guard, the unmapped-sender hint, and member/tenant enforcement.
 *
 * Before #551 a `message` activity was simply echoed back. That echo is removed:
 * echoing the bot's own proactive sends would collide with the inbound loop
 * guard, and ingestion is the real behaviour now. The AI participant (#552) runs
 * INSIDE {@link ingestTeamsActivity} after a human message is ingested (an `@AI`
 * mention triggers the existing responder); promote-to-requirement (#553) remains
 * de-scoped.
 *
 * Persisting the reference is best-effort relative to ingestion: a reference
 * store failure is logged but must not block ingesting the message. Ingestion
 * errors are handled inside {@link ingestTeamsActivity} (expected skips) or
 * surface to the adapter's `onTurnError` (unexpected) — never to the channel as
 * internal detail.
 */
import { ActivityTypes, TurnContext, type ConversationReference } from "botbuilder";

import { createChildLogger } from "../logger.js";
import type { ConversationReferenceStore } from "./conversation-reference-store.js";
import { ingestTeamsActivity, type InboundResult } from "./inbound-sync.js";
import { isPromoteSubmit, handleTeamsPromoteSubmit } from "./teams-promote.js";
import {
  isApproveSubmit,
  isMetisCommandText,
  stripBotMention,
  parseMetisCommand,
  handleTeamsApproveSubmit,
  handleTeamsApproveCommand,
  handleTeamsStatusCommand,
  buildHelpCard,
  buildErrorCard,
  type CommandResult,
} from "./teams-command.js";

const log = createChildLogger("teams-handler");

export interface FoundationHandlerDeps {
  workspaceId: string;
  installationId: string;
  store: ConversationReferenceStore;
  /** Inbound ingestion seam — injectable so the turn can be unit-tested. */
  ingest?: typeof ingestTeamsActivity;
  /** Promote-from-Teams seam (#553) — injectable so the turn can be unit-tested. */
  promote?: typeof handleTeamsPromoteSubmit;
  /** ChatOps handlers (#578) — injectable so the turn can be unit-tested. */
  chatops?: {
    approveSubmit?: typeof handleTeamsApproveSubmit;
    approveCommand?: typeof handleTeamsApproveCommand;
    statusCommand?: typeof handleTeamsStatusCommand;
  };
}

/**
 * Run the turn logic against a TurnContext. Used as the `logic` callback passed
 * to `adapter.process(req, res, logic)`.
 */
export async function runFoundationTurn(
  context: TurnContext,
  deps: FoundationHandlerDeps,
): Promise<void> {
  const reference: Partial<ConversationReference> = TurnContext.getConversationReference(
    context.activity,
  );

  try {
    await deps.store.save(deps.installationId, deps.workspaceId, reference);
  } catch (err) {
    log.warn("Failed to persist Teams conversation reference", {
      workspaceId: deps.workspaceId,
      message: (err as Error).message,
    });
  }

  if (context.activity.type === ActivityTypes.Message) {
    // #553: a "Promote to requirement" Adaptive Card Action.Submit arrives as a
    // `message` activity carrying `activity.value`. Intercept it BEFORE inbound
    // ingestion — it is an action, not a chat message, and (text-less) would
    // otherwise be skipped as `empty-text` and do nothing.
    if (isPromoteSubmit(context.activity)) {
      const promote = deps.promote ?? handleTeamsPromoteSubmit;
      const result = await promote(context, { workspaceId: deps.workspaceId });
      log.debug("Teams promote-to-requirement outcome", {
        workspaceId: deps.workspaceId,
        outcome: result.outcome,
      });
      return;
    }

    // #578: the Approve `Action.Submit` from a `/metis approve` card likewise
    // arrives as a `message` activity carrying `activity.value` — intercept it
    // BEFORE ingestion for the same reason as promote.
    if (isApproveSubmit(context.activity)) {
      const approveSubmit = deps.chatops?.approveSubmit ?? handleTeamsApproveSubmit;
      const result = await approveSubmit(context, { workspaceId: deps.workspaceId });
      log.debug("Teams ChatOps approve-submit outcome", {
        workspaceId: deps.workspaceId,
        outcome: result.outcome,
      });
      return;
    }

    // #578: a `/metis ...` ChatOps command arrives as message TEXT (Teams has no
    // Slack-style slash commands). Parse it from the mention-stripped text and
    // dispatch; a non-command message falls through to inbound ingestion (#551).
    const commandText = stripBotMention(context.activity);
    if (isMetisCommandText(commandText)) {
      await dispatchCommand(context, deps, commandText);
      return;
    }

    const ingest = deps.ingest ?? ingestTeamsActivity;
    const result: InboundResult = await ingest(context, { workspaceId: deps.workspaceId });
    log.debug("Teams inbound ingestion outcome", {
      workspaceId: deps.workspaceId,
      outcome: result.outcome,
    });
  }
}

/** Parse + dispatch a `/metis` ChatOps command (#578). NON-THROWING. */
async function dispatchCommand(
  context: TurnContext,
  deps: FoundationHandlerDeps,
  commandText: string,
): Promise<void> {
  const cmd = parseMetisCommand(commandText);
  const opts = { workspaceId: deps.workspaceId };
  let result: CommandResult | null = null;

  if (cmd.kind === "status") {
    const handler = deps.chatops?.statusCommand ?? handleTeamsStatusCommand;
    result = await handler(context, { projectRef: cmd.projectRef }, opts);
  } else if (cmd.kind === "approve") {
    const handler = deps.chatops?.approveCommand ?? handleTeamsApproveCommand;
    result = await handler(context, { draftRef: cmd.draftRef }, opts);
  } else if (cmd.kind === "help") {
    await safeSendCard(context, buildHelpCard());
  } else {
    await safeSendCard(
      context,
      buildErrorCard(
        "Unknown command",
        "I didn't recognise that command. Try `/metis status` or `/metis approve <draftId>`.",
      ),
    );
  }

  log.debug("Teams ChatOps command outcome", {
    workspaceId: deps.workspaceId,
    kind: cmd.kind,
    outcome: result?.outcome,
  });
}

/** Best-effort card send from the turn (help/unknown only — handlers send their own). */
async function safeSendCard(
  context: TurnContext,
  activity: ReturnType<typeof buildHelpCard>,
): Promise<void> {
  try {
    await context.sendActivity(activity);
  } catch (err) {
    log.warn("Failed to post ChatOps help/unknown card to Teams", {
      message: (err as Error).message,
    });
  }
}
