/**
 * #776 — a reviewer edits a generated issue draft before a batch publishes it.
 *
 * Before this, `/publish` offered only Preview and Approve, so a batch shipped
 * the generated title and body verbatim — including placeholder text such as
 * "No acceptance criteria were derived…". Deep Dive → Issue already let the
 * user edit; batch drafts now can too.
 *
 * Rules:
 *  - only the title, body and labels change (`editIssueDraftSchema`);
 *  - a draft that is `publishing` or `published` is refused — its text is on
 *    GitHub (or about to be), and the PublishedIssue rows hash it;
 *  - an `approved` draft goes back to `draft`, so an approval always covers the
 *    text that will actually be published;
 *  - `dedupHash` is NOT recomputed: it is the generator's identity for the
 *    draft, and `userEdited` in the metadata tells a re-generate to keep the
 *    reviewer's text instead of overwriting it (`draft-generator.ts`);
 *  - a title another live draft in the project already uses is refused, since
 *    the publisher dedups a batch by title.
 */
import type { EditIssueDraftInput, IssueDraft as SharedIssueDraft } from "@metis/shared";
import { prisma } from "../prisma.js";
import { audit } from "../audit/audit-service.js";
import { normalizeTitle } from "./dedup.js";
import { PublishError } from "./types.js";
import { toDraftApi } from "./publishing-service.js";

/** Draft statuses whose text is already (or is being) written to GitHub. */
const NOT_EDITABLE = new Set(["publishing", "published"]);

export async function editDraft(opts: {
  draftId: string;
  /** #1072 — the path project; the draft must belong to it. */
  projectId: string;
  actorId: string;
  input: EditIssueDraftInput;
}): Promise<SharedIssueDraft> {
  const draft = await prisma.issueDraft.findFirst({
    where: { id: opts.draftId, projectId: opts.projectId, deletedAt: null },
  });
  if (!draft) throw new PublishError(404, "DRAFT_NOT_FOUND", "draft not found");
  if (NOT_EDITABLE.has(draft.status)) {
    throw new PublishError(
      409,
      "DRAFT_NOT_EDITABLE",
      `a ${draft.status} draft cannot be edited; its text is already on GitHub or being written there`,
    );
  }

  const { title, body, labels } = opts.input;
  if (title !== undefined && normalizeTitle(title) !== normalizeTitle(draft.title)) {
    const siblings = await prisma.issueDraft.findMany({
      where: { projectId: opts.projectId, deletedAt: null, id: { not: draft.id } },
      select: { title: true },
    });
    const wanted = normalizeTitle(title);
    if (siblings.some((s) => normalizeTitle(s.title) === wanted)) {
      throw new PublishError(
        409,
        "DRAFT_TITLE_TAKEN",
        "another draft in this project already has that title; a batch would treat them as duplicates",
      );
    }
  }

  const fields = [
    ...(title !== undefined ? ["title"] : []),
    ...(body !== undefined ? ["body"] : []),
    ...(labels !== undefined ? ["labels"] : []),
  ];
  // Conditional on the status still being editable: a batch may claim the
  // draft (`publishing`) between the read above and this write. The status is
  // written only to send an approved draft back to `draft`; it is never
  // written back from the stale read, which would undo that claim.
  const { count } = await prisma.issueDraft.updateMany({
    where: { id: draft.id, deletedAt: null, status: { notIn: [...NOT_EDITABLE] } },
    data: {
      ...(title !== undefined ? { title } : {}),
      ...(body !== undefined ? { body } : {}),
      ...(labels !== undefined ? { labels: JSON.stringify([...new Set(labels)]) } : {}),
      ...(draft.status === "approved" ? { status: "draft" } : {}),
      metadata: JSON.stringify({
        ...parseMetadata(draft.metadata),
        userEdited: true,
        editedAt: new Date().toISOString(),
        editedById: opts.actorId,
      }),
    },
  });
  if (count === 0) {
    throw new PublishError(
      409,
      "DRAFT_NOT_EDITABLE",
      "this draft started publishing while it was being edited; its text is already being written to GitHub",
    );
  }
  const updated = await prisma.issueDraft.findUniqueOrThrow({ where: { id: draft.id } });
  // Field names only: the draft text itself is not audit material.
  audit({
    actor: { id: opts.actorId },
    action: "publish.draft.edit",
    target: { type: "issue_draft", id: draft.id },
    metadata: { projectId: opts.projectId, fields, previousStatus: draft.status },
  });
  return toDraftApi(updated);
}

function parseMetadata(raw: string | null): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw ?? "{}") as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
