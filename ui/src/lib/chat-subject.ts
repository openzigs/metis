/**
 * Issue #2350 — "Ask about this": the link into chat from a project, a change
 * request or a requirement, and what chat does with it.
 *
 * The link carries only the item (`/chat?about=<kind>:<id>`). Chat asks the
 * server what it is; the server answers only for an item the caller can read
 * (`GET /api/ai/chat-subjects/:kind/:id`), and chat scopes itself to the
 * project the server names. Nothing here decides access.
 */
import { chatSubjectParam, type ChatSubjectDto, type ChatSubjectKind } from "@metis/shared";
import { apiFetch } from "@/lib/api-client";

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
