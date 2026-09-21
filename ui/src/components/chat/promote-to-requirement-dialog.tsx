"use client";

/**
 * Epic #475 (Phase 4, #488) — promote a discussion message to a Requirement.
 *
 * A small form (title / type / priority) that calls
 * `POST /threads/:id/messages/:messageId/promote` (Phase 1, #479). On success it
 * shows provenance — a link to the created Requirement and a note that it came
 * from this message — preserving the audit trail the backend records.
 *
 * The form seeds its title from the message body (truncated) so a one-click
 * promote is fast. A planned, NOT-yet-implemented "Ask AI to draft acceptance
 * criteria" hook is surfaced as a disabled hint (#488 acceptance criteria — the
 * feature itself is an explicit fast-follow, out of scope here).
 */
import { useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { promoteMessage, type PromoteResult } from "@/lib/discussions-api";

const TYPES = ["feature", "bug", "chore", "epic", "task"] as const;
const PRIORITIES = ["low", "medium", "high", "critical"] as const;

export interface PromoteToRequirementDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  threadId: string;
  messageId: string;
  projectId: string;
  /** Message body — used to seed a sensible default title. */
  messageBody: string;
  /** Notified with the created requirement so the parent can refresh/link. */
  onPromoted?: (result: PromoteResult) => void;
}

/**
 * Strip leading markdown heading / emphasis syntax from a single line so the
 * seeded requirement title is clean prose, not raw markdown (#513). Handles:
 *  - ATX headings: leading `#`..`######` plus the following space(s).
 *  - Blockquote / list markers: a leading `>` or `-`/`*`/`+` bullet.
 *  - Wrapping emphasis tokens: `**bold**`, `*italic*`, `__u__`, `_i_`, `` `code` ``.
 * Emphasis is only unwrapped when it brackets the WHOLE remaining line, so an
 * inline `*emphasis*` mid-sentence is left untouched.
 */
export function stripLeadingMarkdown(line: string): string {
  let s = line.trim();
  // Leading block markers: heading hashes, blockquote, or a single list bullet.
  s = s.replace(/^\s*#{1,6}\s+/, "");
  s = s.replace(/^\s*>\s+/, "");
  s = s.replace(/^\s*[-*+]\s+/, "");
  s = s.trim();
  // Unwrap a single layer of emphasis that brackets the whole line.
  const wrappers: [RegExp, number][] = [
    [/^\*\*([\s\S]+)\*\*$/, 1],
    [/^__([\s\S]+)__$/, 1],
    [/^\*([\s\S]+)\*$/, 1],
    [/^_([\s\S]+)_$/, 1],
    [/^`([\s\S]+)`$/, 1],
  ];
  for (const [re, group] of wrappers) {
    const m = s.match(re);
    if (m) {
      s = m[group].trim();
      break;
    }
  }
  return s;
}

/**
 * Seed a title from the message body: first non-empty line, with leading
 * markdown heading/emphasis stripped, trimmed, ≤120 chars (#513).
 */
export function seedTitleFromBody(body: string): string {
  const firstLine = body.split("\n").find((l) => l.trim().length > 0) ?? "";
  const cleaned = stripLeadingMarkdown(firstLine);
  return cleaned.length > 120 ? `${cleaned.slice(0, 117)}…` : cleaned;
}

export function PromoteToRequirementDialog({
  open,
  onOpenChange,
  threadId,
  messageId,
  projectId,
  messageBody,
  onPromoted,
}: PromoteToRequirementDialogProps) {
  const [title, setTitle] = useState(() => seedTitleFromBody(messageBody));
  const [type, setType] = useState<(typeof TYPES)[number]>("feature");
  const [priority, setPriority] = useState<(typeof PRIORITIES)[number]>("medium");
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<PromoteResult | null>(null);

  async function handleSubmit() {
    if (!title.trim() || pending) return;
    setPending(true);
    try {
      const res = await promoteMessage(threadId, messageId, {
        title: title.trim(),
        type,
        priority,
      });
      setResult(res);
      onPromoted?.(res);
      toast.success("Promoted to a requirement");
    } catch (err) {
      toast.error((err as Error).message || "Failed to promote message");
    } finally {
      setPending(false);
    }
  }

  function close(next: boolean) {
    if (!next) {
      // Reset transient state when the dialog closes so a re-open starts clean.
      setResult(null);
    }
    onOpenChange(next);
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Promote to requirement</DialogTitle>
          {/* #513 — a11y: satisfy Radix's aria-describedby requirement and tell
              the user what this dialog does. */}
          <DialogDescription>
            Create a tracked requirement from this message. Its provenance (source message and
            thread) is recorded in the audit trail.
          </DialogDescription>
        </DialogHeader>

        {result ? (
          <div className="space-y-3" data-testid="promote-success">
            <p className="text-sm">
              Created a requirement from this message. Its provenance (source message + thread) is
              recorded in the audit trail.
            </p>
            <Link
              href={`/projects/${projectId}/analysis?requirementId=${encodeURIComponent(
                result.requirementId,
              )}`}
              className="inline-flex items-center text-sm font-medium text-primary hover:underline"
              data-testid="promote-requirement-link"
            >
              View requirement →
            </Link>
            <div className="flex justify-end">
              <Button variant="outline" onClick={() => close(false)}>
                Done
              </Button>
            </div>
          </div>
        ) : (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              void handleSubmit();
            }}
          >
            <div className="space-y-1">
              <Label htmlFor="promote-title">Title</Label>
              <Input
                id="promote-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Requirement title"
                disabled={pending}
                required
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="promote-type">Type</Label>
                <select
                  id="promote-type"
                  value={type}
                  onChange={(e) => setType(e.target.value as (typeof TYPES)[number])}
                  disabled={pending}
                  className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                >
                  {TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="promote-priority">Priority</Label>
                <select
                  id="promote-priority"
                  value={priority}
                  onChange={(e) => setPriority(e.target.value as (typeof PRIORITIES)[number])}
                  disabled={pending}
                  className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                >
                  {PRIORITIES.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* #488 — future-enhancement hook, explicitly NOT implemented here.
                Drafting acceptance criteria with the AI is a planned fast-follow
                (informed by the epic's requirements-tool research). */}
            <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
              Coming soon: <span className="font-medium">Ask AI to draft acceptance criteria</span>{" "}
              for this requirement (not available yet).
            </p>

            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => close(false)}
                disabled={pending}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={pending || !title.trim()}>
                {pending ? "Promoting…" : "Promote"}
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
