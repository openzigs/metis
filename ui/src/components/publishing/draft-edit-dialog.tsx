"use client";

/**
 * #776 — edit a generated issue draft before a batch publishes it.
 *
 * The batch path used to offer only Preview and Approve, so a reviewer could
 * not fix a title, add acceptance criteria or drop a wrong label. Saving sends
 * only the fields that changed; an approved draft returns to "draft" on the
 * server so the approval always covers the text that will be published.
 */
import { useEffect, useState } from "react";
import type { EditIssueDraftInput, IssueDraft } from "@metis/shared";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export interface DraftEditDialogProps {
  draft: Pick<IssueDraft, "id" | "title" | "body" | "labels" | "status"> | null;
  onOpenChange: (open: boolean) => void;
  onSave: (input: EditIssueDraftInput) => void;
  saving?: boolean;
  error?: string | null;
}

/** Labels are stored as a JSON array string; anything malformed reads as none. */
export function parseDraftLabels(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((l): l is string => typeof l === "string") : [];
  } catch {
    return [];
  }
}

function splitLabels(text: string): string[] {
  return [
    ...new Set(
      text
        .split(",")
        .map((l) => l.trim())
        .filter(Boolean),
    ),
  ];
}

/** Only the fields the user actually changed. */
export function changedFields(
  draft: { title: string; body: string; labels: string },
  next: { title: string; body: string; labels: string },
): EditIssueDraftInput | null {
  const out: { title?: string; body?: string; labels?: string[] } = {};
  if (next.title.trim() !== draft.title) out.title = next.title.trim();
  if (next.body.trim() !== draft.body.trim()) out.body = next.body.trim();
  const before = parseDraftLabels(draft.labels);
  const after = splitLabels(next.labels);
  if (before.join("\n") !== after.join("\n")) out.labels = after;
  return Object.keys(out).length > 0 ? (out as EditIssueDraftInput) : null;
}

export function DraftEditDialog({
  draft,
  onOpenChange,
  onSave,
  saving,
  error,
}: DraftEditDialogProps) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [labels, setLabels] = useState("");

  useEffect(() => {
    if (!draft) return;
    setTitle(draft.title);
    setBody(draft.body);
    setLabels(parseDraftLabels(draft.labels).join(", "));
  }, [draft]);

  const changes = draft ? changedFields(draft, { title, body, labels }) : null;
  const invalid = title.trim() === "" || body.trim() === "";

  return (
    <Dialog open={Boolean(draft)} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Edit draft</DialogTitle>
          <DialogDescription>
            Changes are saved to this draft before it is published.
            {draft?.status === "approved" ? " Saving returns it to draft for re-approval." : ""}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label htmlFor="draft-edit-title">Title</Label>
            <Input
              id="draft-edit-title"
              value={title}
              maxLength={255}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="draft-edit-body">Body (Markdown)</Label>
            <textarea
              id="draft-edit-body"
              className="mt-1 h-64 w-full rounded-md border bg-background p-2 font-mono text-xs"
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="draft-edit-labels">Labels (comma-separated)</Label>
            <Input
              id="draft-edit-labels"
              value={labels}
              onChange={(e) => setLabels(e.target.value)}
            />
          </div>
          {error && (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => changes && onSave(changes)}
              disabled={!changes || invalid || saving}
            >
              {saving ? "Saving…" : "Save draft"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
