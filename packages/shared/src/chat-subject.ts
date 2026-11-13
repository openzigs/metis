/**
 * Issue #2350 (epic #2328) — "Ask about this": chat opened from a project, a
 * change request or a requirement, already scoped to it.
 *
 * The entry point is a link, `/chat?about=<kind>:<id>`. The chat page asks the
 * server what the item is (`GET /api/ai/chat-subjects/:kind/:id`), and the
 * server answers only for an item the caller can read: anything else is the one
 * 404, so a link to another workspace's change request opens nothing.
 */

export const CHAT_SUBJECT_KINDS = ["project", "change-request", "requirement"] as const;

export type ChatSubjectKind = (typeof CHAT_SUBJECT_KINDS)[number];

/** What the server says an "Ask about this" item is. */
export interface ChatSubjectDto {
  kind: ChatSubjectKind;
  id: string;
  /** The project the chat is scoped to: the item itself, or the one that holds it. */
  projectId: string;
  projectName: string;
  /** The item's name: the project's, the change request's or the requirement's. */
  title: string;
  /** For a requirement, the change request it belongs to; `null` otherwise. */
  changeRequestTitle: string | null;
}

/** The longest id an `about` value may carry; ids are cuids, far shorter. */
export const CHAT_SUBJECT_ID_MAX = 120;

/**
 * The `about` query value for an item, `<kind>:<id>`. The id is URI-encoded so
 * the value survives as one query parameter.
 */
export function chatSubjectParam(kind: ChatSubjectKind, id: string): string {
  return `${kind}:${encodeURIComponent(id)}`;
}

/**
 * Parse an `about` query value. `null` for anything that does not name a known
 * kind and a non-empty id of at most {@link CHAT_SUBJECT_ID_MAX} characters.
 * (Parsing is not authorization: the server decides whether the caller may
 * read the item.)
 */
export function parseChatSubjectParam(
  raw: string | null | undefined,
): { kind: ChatSubjectKind; id: string } | null {
  if (!raw) return null;
  const sep = raw.indexOf(":");
  if (sep <= 0) return null;
  const kind = raw.slice(0, sep);
  if (!(CHAT_SUBJECT_KINDS as readonly string[]).includes(kind)) return null;
  let id: string;
  try {
    id = decodeURIComponent(raw.slice(sep + 1));
  } catch {
    return null;
  }
  if (!id || id.length > CHAT_SUBJECT_ID_MAX) return null;
  return { kind: kind as ChatSubjectKind, id };
}

/**
 * PR #2428 review — the item a chat turn is about, sent with every turn of an
 * "Ask about this" chat. The server re-checks that the caller can read it and
 * tells the model what it is, so the chat stays tied to the item even when the
 * analyst rewrites the opening question.
 */
export interface ChatSubjectRef {
  kind: ChatSubjectKind;
  id: string;
}
