/**
 * Issue #2220 — an `@mention` reads as a mention, not as plain text.
 *
 * The mention picker (`MentionInput`) inserts `@<username>`, and the server
 * notifies that user, but a posted comment or discussion message showed the
 * handle as ordinary text. These helpers mark each handle up as a
 * `<span data-mention>` styled as a chip. Like `renderInlineCode`, nothing is
 * parsed as HTML: text stays a React string child, so markup in a message is
 * inert wherever it sits.
 *
 * A handle starts after the start of the text or a character that cannot be
 * part of a word or address, so `ana@example.com` is not a mention. A trailing
 * `.` or `-` ends the sentence, not the handle.
 */
import type { ReactNode } from "react";

const MENTION_PATTERN = /(^|[^\w@.])@([A-Za-z0-9](?:[\w.-]*[A-Za-z0-9_])?)/g;

/** The class every rendered mention carries. */
export const MENTION_CLASS = "rounded bg-info-muted px-1 font-medium text-info";

/** A text split into plain strings and the handles it mentions (without the `@`). */
export type MentionPart = { text: string } | { mention: string };

export function splitMentions(text: string): MentionPart[] {
  const parts: MentionPart[] = [];
  const pattern = new RegExp(MENTION_PATTERN);
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const at = match.index + match[1].length;
    if (at > lastIndex) parts.push({ text: text.slice(lastIndex, at) });
    parts.push({ mention: match[2] });
    lastIndex = at + 1 + match[2].length;
  }
  if (lastIndex < text.length) parts.push({ text: text.slice(lastIndex) });
  return parts;
}

/** `text` as React nodes, each `@handle` a mention chip. */
export function renderMentions(text: string): ReactNode[] {
  return splitMentions(text).map((part, i) =>
    "mention" in part ? (
      <span key={`mention-${i}`} data-mention={part.mention} className={MENTION_CLASS}>
        @{part.mention}
      </span>
    ) : (
      part.text
    ),
  );
}

/** The minimal mdast shape the remark plugin walks. */
interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
  data?: { hName?: string; hProperties?: Record<string, string> };
}

/** Nodes whose text is code or a link already: a handle inside stays as written. */
const SKIP: ReadonlySet<string> = new Set(["code", "inlineCode", "link", "linkReference"]);

function mentionNodes(value: string): MdNode[] {
  return splitMentions(value).map((part) =>
    "mention" in part
      ? {
          type: "mention",
          children: [{ type: "text", value: `@${part.mention}` }],
          data: {
            hName: "span",
            hProperties: { "data-mention": part.mention, className: MENTION_CLASS },
          },
        }
      : { type: "text", value: part.text },
  );
}

function walk(node: MdNode): void {
  if (!node.children || SKIP.has(node.type)) return;
  node.children = node.children.flatMap((child) => {
    if (child.type === "text" && typeof child.value === "string") return mentionNodes(child.value);
    walk(child);
    return [child];
  });
}

/** A remark plugin: the same mention chips inside rendered Markdown. */
export function remarkMentions() {
  return (tree: MdNode) => walk(tree);
}
