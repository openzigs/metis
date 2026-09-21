/**
 * Issue #579 (epic #63) — Slack Bolt receiver wiring.
 *
 * This is the thin SDK-adapter layer that mounts a Slack Bolt `App` on the
 * EXISTING Express server (NOT a separate process) via Bolt's `ExpressReceiver`,
 * and registers the `/metis` slash command + Approve-button action listeners that
 * delegate to the pure, fully-unit-tested handlers in `slack-command.ts`.
 *
 * WHY THIS FILE IS THIN (and coverage-excluded, like the SSO providers): it is
 * the boundary to the Slack SDK — all business logic + security decisions live in
 * the injectable, tested modules (`signature.ts`, `slack-command.ts`, `oauth.ts`,
 * `installation-store.ts`, `slack-identity-resolver.ts`). This file only:
 *   1. constructs the receiver WITH the signing secret so Bolt enforces request
 *      signature + timestamp (replay) verification on EVERY inbound request — the
 *      receiver is mounted ahead of the global JSON body parser so it owns the raw
 *      body it needs to verify (see `mountSlackReceiver`);
 *   2. resolves the per-request `(workspaceId, slackTeamId, slackUserId)` context
 *      from the verified payload + the install store;
 *   3. forwards to a handler and posts the returned reply via `respond()`.
 *
 * The receiver is mounted ONLY when `SLACK_SIGNING_SECRET` is configured
 * (`isSlackEnabled`) — a deployment without it never exposes an unverified
 * endpoint (fail closed).
 */
import { App, ExpressReceiver } from "@slack/bolt";
import type { Application } from "express";

import { createChildLogger } from "../logger.js";
import { isSlackEnabled, loadSlackConfig, type SlackAppConfig } from "./config.js";
import { getSlackInstallationStore, type SlackInstallationStore } from "./installation-store.js";
import { APPROVE_ACTION_ID } from "./block-kit.js";
import {
  COMMAND_NAME,
  handleSlackApproveAction,
  handleSlackCommand,
  type SlackActorContext,
  type SlackReply,
} from "./slack-command.js";

const log = createChildLogger("slack-receiver");

/** The path the Bolt receiver listens on (slash commands + interactivity + events). */
export const SLACK_RECEIVER_BASE_PATH = "/api/integrations/slack/events";

/**
 * Resolve the METIS workspace that owns a Slack team. Returns null when the team
 * isn't installed — the handler then refuses (never acts for an unknown team).
 */
async function resolveWorkspaceId(
  store: SlackInstallationStore,
  slackTeamId: string | undefined,
): Promise<string | null> {
  if (!slackTeamId) return null;
  const install = await store.getBySlackTeam(slackTeamId);
  return install?.workspaceId ?? null;
}

/**
 * Mount the Slack Bolt receiver on the given Express app. MUST be called BEFORE
 * the global `express.json()` parser is installed so Bolt can read+verify the raw
 * request body. Returns true when mounted, false when Slack is not configured.
 */
export function mountSlackReceiver(
  app: Application,
  opts: { config?: SlackAppConfig; store?: SlackInstallationStore } = {},
): boolean {
  const config = opts.config ?? loadSlackConfig();
  if (!isSlackEnabled(config)) {
    log.info("Slack receiver not mounted — SLACK_SIGNING_SECRET is not configured");
    return false;
  }
  const store = opts.store ?? getSlackInstallationStore();

  // The receiver verifies the Slack signature + timestamp (replay) on EVERY
  // inbound request using the signing secret. signatureVerification defaults to
  // true; we set it explicitly so it can never be silently disabled.
  const receiver = new ExpressReceiver({
    signingSecret: config.signingSecret as string,
    endpoints: { events: "/" },
    signatureVerification: true,
    processBeforeResponse: true,
  });

  const bolt = new App({ receiver, signingSecret: config.signingSecret as string });

  // `/metis` slash command → status/approve/help.
  bolt.command(`/${COMMAND_NAME}`, async ({ command, ack, respond }) => {
    await ack();
    const actor = await buildActor(store, command.team_id, command.user_id);
    if (!actor) return safeRespond(respond, unmappedReply());
    const reply = await handleSlackCommand(actor, command.text);
    await safeRespond(respond, reply);
  });

  // Approve button → invoke the approval service.
  bolt.action(APPROVE_ACTION_ID, async ({ body, ack, respond, action }) => {
    await ack();
    const teamId = (body as { team?: { id?: string } }).team?.id;
    const userId = (body as { user?: { id?: string } }).user?.id;
    const actor = await buildActor(store, teamId, userId);
    if (!actor) return safeRespond(respond, unmappedReply());
    const draftId = (action as { value?: string }).value ?? null;
    const reply = await handleSlackApproveAction(actor, { draftId });
    await safeRespond(respond, reply);
  });

  app.use(SLACK_RECEIVER_BASE_PATH, receiver.router);
  log.info("Slack Bolt receiver mounted", { path: SLACK_RECEIVER_BASE_PATH });
  return true;
}

/** Build the actor context for a verified Slack payload (team must be installed). */
async function buildActor(
  store: SlackInstallationStore,
  teamId: string | undefined,
  userId: string | undefined,
): Promise<SlackActorContext | null> {
  const workspaceId = await resolveWorkspaceId(store, teamId);
  if (!workspaceId || !teamId || !userId) return null;
  return { workspaceId, slackTeamId: teamId, slackUserId: userId };
}

/** The refusal posted when the team is not installed / payload lacks identity. */
function unmappedReply(): SlackReply {
  return {
    outcome: "unmapped-sender",
    responseType: "ephemeral",
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: ":warning: *Not connected*" } },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "This Slack workspace isn't connected to METIS, or your account isn't linked.",
        },
      },
    ],
  };
}

type Respond = (msg: {
  response_type: "ephemeral" | "in_channel";
  blocks: unknown[];
}) => Promise<unknown>;

/** Post a handler reply via Slack `respond()`; never throws into the listener. */
async function safeRespond(respond: Respond, reply: SlackReply): Promise<void> {
  try {
    await respond({ response_type: reply.responseType, blocks: reply.blocks });
  } catch (err) {
    log.warn("Failed to post Slack ChatOps response", { message: (err as Error).message });
  }
}
