/**
 * Issue #2350 — "Ask about this": the link into chat from a project, a change
 * request or a requirement, and what chat does with it.
 *
 * The link carries only the item (`/chat?about=<kind>:<id>`). Chat asks the
 * server what it is; the server answers only for an item the caller can read
 * (`GET /api/ai/chat-subjects/:kind/:id`), and chat scopes itself to the
 * project the server names. Nothing here decides access.
 */
import {
  CHAT_SUBJECT_KINDS,
  chatSubjectParam,
  type ChatSubjectDto,
  type ChatSubjectKind,
} from "@metis/shared";
import { apiFetch } from "@/lib/api-client";

/**
 * PR #2428 review — which item each "Ask about this" chat is about, by session
 * id, so a reload or a history link resumes the chat still tied to its item.
 * The chat sends the item's kind and id with every turn and the server decides,
 * each time, whether the caller may still read it: this store holds no access,
 * only what to ask about and what to show.
 */
const SESSION_SUBJECTS_KEY = "metis.chat.sessionSubjects";
/** Oldest chats are forgotten past this many; they resume as ordinary chats. */
export const SESSION_SUBJECTS_MAX = 50;

type SubjectsBySession = Record<string, ChatSubjectDto>;

function isSubject(v: unknown): v is ChatSubjectDto {
  if (!v || typeof v !== "object") return false;
  const s = v as Record<string, unknown>;
  return (
    (CHAT_SUBJECT_KINDS as readonly unknown[]).includes(s.kind) &&
    typeof s.id === "string" &&
    typeof s.projectId === "string" &&
    typeof s.projectName === "string" &&
    typeof s.title === "string" &&
    (s.changeRequestTitle === null || typeof s.changeRequestTitle === "string")
  );
}

function readSubjects(): SubjectsBySession {
  if (typeof window === "undefined") return {};
  try {
    const raw: unknown = JSON.parse(window.localStorage.getItem(SESSION_SUBJECTS_KEY) ?? "{}");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const out: SubjectsBySession = {};
    for (const [id, s] of Object.entries(raw)) if (isSubject(s)) out[id] = s;
    return out;
  } catch {
    return {};
  }
}

/** The item the chat `sessionId` was opened from, or `null`. */
export function loadSessionSubject(sessionId: string): ChatSubjectDto | null {
  return readSubjects()[sessionId] ?? null;
}

/** Remember that the chat `sessionId` is about `subject` (newest last). */
export function storeSessionSubject(sessionId: string, subject: ChatSubjectDto): void {
  if (typeof window === "undefined") return;
  const all = readSubjects();
  delete all[sessionId];
  all[sessionId] = subject;
  const kept = Object.entries(all).slice(-SESSION_SUBJECTS_MAX);
  try {
    window.localStorage.setItem(SESSION_SUBJECTS_KEY, JSON.stringify(Object.fromEntries(kept)));
  } catch {
    /* storage full or blocked: the chat works, a reload just forgets the item */
  }
}

/** The chat link for an item. */
export function chatAboutHref(kind: ChatSubjectKind, id: string): string {
  return `/chat?about=${encodeURIComponent(chatSubjectParam(kind, id))}`;
}

/** The server's word on an item: what it is, or a refusal (thrown `ApiError`). */
export function getChatSubject(kind: ChatSubjectKind, id: string): Promise<ChatSubjectDto> {
  return apiFetch<ChatSubjectDto>(
    `/ai/chat-subjects/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`,
  );
}

const KIND_WORDS: Record<ChatSubjectKind, string> = {
  project: "project",
  "change-request": "change request",
  requirement: "requirement",
};

/** The item in words, for the chat's "Asking about" line. */
export function subjectLabel(subject: ChatSubjectDto): string {
  if (subject.kind === "project") return `the project “${subject.title}”`;
  if (subject.kind === "requirement" && subject.changeRequestTitle) {
    return `the requirement “${subject.title}” in the change request “${subject.changeRequestTitle}”`;
  }
  return `the ${KIND_WORDS[subject.kind]} “${subject.title}”`;
}

/**
 * The question the composer opens with: the analyst's to edit or send. A
 * project has none; the suggested prompts already cover a whole system.
 */
export function subjectPrompt(subject: ChatSubjectDto): string {
  switch (subject.kind) {
    case "project":
      return "";
    case "change-request":
      return `What does the change request “${subject.title}” ask for, and what would it affect?`;
    case "requirement":
      return `Explain ${subjectLabel(subject)}: what it asks for, and how the system handles it today.`;
  }
}
