"use client";

/**
 * Issue #2350 — chat opened by "Ask about this": the server's word on the item
 * (`useChatSubject`), and the line that says what the chat is about, or that it
 * was refused (`ChatSubjectNotice`).
 *
 * Deliberately not a React Query hook: the chat page's tests render it without
 * a query client, and this is one read per link.
 */
import { useEffect, useState } from "react";
import type { ChatSubjectDto, ChatSubjectKind } from "@metis/shared";
import { getChatSubject, subjectLabel } from "@/lib/chat-subject";

export type ChatSubjectState =
  | { status: "none" }
  | { status: "loading" }
  | { status: "ready"; subject: ChatSubjectDto }
  | { status: "refused" };

/** Shown when the server will not name the item: unknown, deleted, or not the caller's to read. */
export const SUBJECT_REFUSED =
  "You can’t ask about that item. It may have been deleted, or you don’t have access to it. You can still ask a question below.";

const NONE: ChatSubjectState = { status: "none" };
const LOADING: ChatSubjectState = { status: "loading" };

/**
 * What `about` (a parsed `?about=`) names, as the server answers for this
 * caller. `none` when there is no `about`; `refused` for any error, so a
 * refusal never scopes the chat.
 */
export function useChatSubject(
  about: { kind: ChatSubjectKind; id: string } | null,
): ChatSubjectState {
  const kind = about?.kind ?? null;
  const id = about?.id ?? null;
  const key = kind && id ? `${kind}:${id}` : null;
  // Each answer is kept with the item it answers, so a new link never shows the
  // previous item's answer for even one render.
  const [answer, setAnswer] = useState<{ key: string; state: ChatSubjectState } | null>(null);

  useEffect(() => {
    if (!kind || !id) return;
    let cancelled = false;
    const asked = `${kind}:${id}`;
    getChatSubject(kind, id).then(
      (subject) => {
        if (!cancelled) setAnswer({ key: asked, state: { status: "ready", subject } });
      },
      () => {
        if (!cancelled) setAnswer({ key: asked, state: { status: "refused" } });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [kind, id]);

  if (!key) return NONE;
  return answer?.key === key ? answer.state : LOADING;
}

interface NoticeProps {
  state: ChatSubjectState;
  /** False once the analyst moved the chat off the item's project. */
  inScope: boolean;
}

/** "Asking about …", or the refusal. Nothing while loading, or once the scope moved on. */
export function ChatSubjectNotice({ state, inScope }: NoticeProps) {
  if (state.status === "refused") {
    return (
      <p
        role="alert"
        data-testid="chat-subject-refused"
        className="rounded border border-destructive p-2 text-sm text-destructive"
      >
        {SUBJECT_REFUSED}
      </p>
    );
  }
  if (state.status !== "ready" || !inScope) return null;
  const { subject } = state;
  return (
    <p
      role="status"
      data-testid="chat-subject"
      className="rounded border border-primary/40 bg-primary/5 p-2 text-sm"
    >
      Asking about {subjectLabel(subject)}
      {subject.kind === "project" ? null : <> in {subject.projectName}</>}. This chat searches{" "}
      {subject.projectName}; change the scope with the project selector.
    </p>
  );
}
