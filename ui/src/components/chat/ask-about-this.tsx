"use client";

/**
 * Issue #2350 — "Ask about this": opens chat already scoped to a project, a
 * change request or a requirement. A link, so it opens in a new tab too; the
 * chat page asks the server whether the item may be read.
 */
import Link from "next/link";
import { MessageSquare } from "lucide-react";
import type { ChatSubjectKind } from "@metis/shared";
import { Button } from "@/components/ui/button";
import { chatAboutHref } from "@/lib/chat-subject";

const KIND_WORDS: Record<ChatSubjectKind, string> = {
  project: "this project",
  "change-request": "this change request",
  requirement: "this requirement",
};

interface Props {
  kind: ChatSubjectKind;
  id: string;
  /** The item's name, for the accessible name when several sit on one page. */
  title?: string;
  size?: "sm" | "default";
}

export function AskAboutThis({ kind, id, title, size = "sm" }: Props) {
  return (
    <Button asChild size={size} variant="outline">
      <Link
        href={chatAboutHref(kind, id)}
        aria-label={title ? `Ask about ${title} in chat` : `Ask about ${KIND_WORDS[kind]} in chat`}
        data-testid={`ask-about-${kind}`}
      >
        <MessageSquare className="mr-1 h-3.5 w-3.5" aria-hidden />
        Ask about this
      </Link>
    </Button>
  );
}
