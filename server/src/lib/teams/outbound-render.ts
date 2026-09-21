/**
 * Epic #547 (Phase 2, #550) — render a METIS DiscussionMessage for Teams.
 *
 * Outbound mirroring posts a proactive Teams activity for each new in-app
 * message. The Teams channel has no METIS author chrome, so authorship MUST be
 * rendered INTO the message text — and human vs AI authorship must be visibly
 * distinct (acceptance criterion). This module is a pure string formatter (no
 * I/O, no SDK) so the human/ai branching is trivially unit-testable.
 *
 * Rendering contract:
 *   - HUMAN: prefixed with the author's display name, e.g. `**Ada Lovelace**: …`.
 *     A bold name + plain body reads as a person speaking.
 *   - AI:    prefixed with a robot marker + the model, e.g.
 *     `🤖 **METIS AI** (gpt-4o): …`, so a reader never mistakes an AI reply for a
 *     teammate. The model is included for provenance (matches the in-app badge).
 *
 * The body is passed through verbatim except for a length clamp — Teams rejects
 * oversized activities, and an unbounded discussion message (or a hostile paste)
 * must never make the proactive send throw. We do NOT attempt to sanitize
 * markdown: Teams renders a constrained markdown subset and the body already
 * survived in-app rendering; escaping here would corrupt legitimate formatting.
 */
import type { Activity, Attachment } from "botbuilder";

import type { AuthorKind } from "../discussions/message-invariant.js";

/** Teams caps a single activity's text; clamp well under the limit defensively. */
export const TEAMS_MESSAGE_MAX_CHARS = 3800;

/**
 * The Adaptive Card `Action.Submit` id for the "Promote to requirement" button
 * (#553). The action carries `{ metisAction: "promote", threadId, messageId }`
 * in its `data`; Teams echoes that `data` back verbatim in `activity.value` when
 * the button is pressed, which is how the promote handler correlates the Teams
 * click back to the source `DiscussionMessage` WITHOUT any new schema.
 */
export const PROMOTE_ACTION_ID = "metis.promoteToRequirement";

/** Discriminator stored in the submit `data.metisAction` (and echoed back). */
export const PROMOTE_ACTION = "promote";

/** The Adaptive Card content-type Teams expects on an attachment. */
const ADAPTIVE_CARD_CONTENT_TYPE = "application/vnd.microsoft.card.adaptive";

/** The author facts the renderer needs — resolved by the caller. */
export interface OutboundAuthor {
  authorKind: AuthorKind | string;
  /** Display name of a human author (resolved from User), if known. */
  displayName?: string | null;
  /** AI model name (e.g. "gpt-4o"), for an AI message. */
  aiModel?: string | null;
}

/** Clamp text to `max` chars, appending a single-char ellipsis when truncated. */
export function clampBody(body: string, max: number = TEAMS_MESSAGE_MAX_CHARS): string {
  if (body.length <= max) return body;
  // Reserve one char for the ellipsis so the result never exceeds `max`.
  return `${body.slice(0, max - 1)}…`;
}

/**
 * Render the proactive Teams message text for a discussion message. Human and
 * AI authorship are rendered distinctly; unknown author kinds degrade to a
 * neutral prefix rather than throwing (defence in depth — a malformed row must
 * not break the best-effort mirror).
 */
export function renderTeamsMessage(author: OutboundAuthor, body: string): string {
  const clamped = clampBody(body);

  if (author.authorKind === "ai") {
    const model = author.aiModel?.trim();
    const modelSuffix = model ? ` (${model})` : "";
    return `🤖 **METIS AI**${modelSuffix}: ${clamped}`;
  }

  // human (and any non-ai kind — treated as a person, never as AI).
  const name = author.displayName?.trim() || "METIS user";
  return `**${name}**: ${clamped}`;
}

/** Inputs to render a mirrored message as an actionable Adaptive Card (#553). */
export interface MirroredMessageCardInput {
  /** The already-rendered message text (from {@link renderTeamsMessage}). */
  text: string;
  /** Thread the source message belongs to (rides in the action data). */
  threadId: string;
  /** The source `DiscussionMessage` id (rides in the action data). */
  messageId: string;
}

/**
 * Build the proactive activity for a mirrored discussion message (#550 + #553).
 *
 * The activity carries:
 *   - a `text` fallback (the rendered `**name**: body` string) so a client that
 *     does not render Adaptive Cards still shows the message, and
 *   - an Adaptive Card attachment with a single "Promote to requirement"
 *     `Action.Submit` button whose `data` is
 *     `{ metisAction: "promote", threadId, messageId }`.
 *
 * WHY `Action.Submit` (not `Action.Execute`): a submit arrives back at the bot
 * as a normal `message` activity with the `data` echoed verbatim in
 * `activity.value` — which the functional turn handler (#548) already routes.
 * `Action.Execute` produces an `adaptiveCard/action` INVOKE activity that
 * botbuilder-js does not reliably dispatch unless the turn logic subclasses
 * `TeamsActivityHandler` (which this bot deliberately does not). Submit also
 * means the `DiscussionMessage` correlation needs NO new schema: it rides in the
 * card payload, which Teams returns untouched on click.
 */
export function renderMirroredMessageActivity(input: MirroredMessageCardInput): Partial<Activity> {
  const card = {
    type: "AdaptiveCard",
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    version: "1.4",
    body: [
      {
        type: "TextBlock",
        text: input.text,
        wrap: true,
      },
    ],
    actions: [
      {
        type: "Action.Submit",
        id: PROMOTE_ACTION_ID,
        title: "Promote to requirement",
        data: {
          metisAction: PROMOTE_ACTION,
          threadId: input.threadId,
          messageId: input.messageId,
        },
      },
    ],
  };

  const attachment: Attachment = {
    contentType: ADAPTIVE_CARD_CONTENT_TYPE,
    content: card,
  };

  return {
    type: "message",
    text: input.text,
    attachments: [attachment],
  };
}
