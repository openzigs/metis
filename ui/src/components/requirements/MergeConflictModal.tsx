"use client";

/**
 * Epic #728 / Issue #737 — MergeConflictModal component.
 *
 * Shown when a PUT /requirements/:id returns HTTP 409 (VERSION_CONFLICT).
 * Presents the user with their pending changes vs the server version and
 * lets them choose how to resolve the conflict.
 */
import { useState } from "react";
import { GitMerge } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

export interface ConflictState<T extends Record<string, unknown> = Record<string, unknown>> {
  /** The value the user was trying to save. */
  clientValue: T;
  /** The current value on the server. */
  serverValue: T;
  /** Server's authoritative version number for re-submission. */
  serverVersion: number;
  /** Flat field label → description for display. */
  fieldLabels?: Record<string, string>;
}

interface MergeConflictModalProps<T extends Record<string, unknown>> {
  conflict: ConflictState<T> | null;
  onResolve: (resolved: T, serverVersion: number) => void | Promise<void>;
  onDismiss: () => void;
}

type Resolution = "server" | "client" | "manual";

function FieldDiff({
  field,
  clientVal,
  serverVal,
  label,
}: {
  field: string;
  clientVal: unknown;
  serverVal: unknown;
  label?: string;
}) {
  const differs = JSON.stringify(clientVal) !== JSON.stringify(serverVal);
  if (!differs) return null;
  return (
    <div className="rounded-md border bg-muted/30 p-2 text-xs">
      <p className="mb-1 font-semibold">{label ?? field}</p>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <p className="mb-0.5 text-muted-foreground">Your version</p>
          <pre className="whitespace-pre-wrap rounded bg-amber-50 p-1 font-mono dark:bg-amber-900/20">
            {String(clientVal ?? "(empty)")}
          </pre>
        </div>
        <div>
          <p className="mb-0.5 text-muted-foreground">Server version</p>
          <pre className="whitespace-pre-wrap rounded bg-emerald-50 p-1 font-mono dark:bg-emerald-900/20">
            {String(serverVal ?? "(empty)")}
          </pre>
        </div>
      </div>
    </div>
  );
}

export function MergeConflictModal<T extends Record<string, unknown>>({
  conflict,
  onResolve,
  onDismiss,
}: MergeConflictModalProps<T>) {
  const [resolution, setResolution] = useState<Resolution>("server");
  const [manualText, setManualText] = useState("");
  const [saving, setSaving] = useState(false);

  if (!conflict) return null;

  // Find fields that differ
  const allKeys = Array.from(
    new Set([...Object.keys(conflict.clientValue), ...Object.keys(conflict.serverValue)]),
  ).filter((k) => k !== "version" && k !== "updatedAt" && k !== "id");

  const changedKeys = allKeys.filter(
    (k) => JSON.stringify(conflict.clientValue[k]) !== JSON.stringify(conflict.serverValue[k]),
  );

  async function handleResolve() {
    setSaving(true);
    try {
      let resolved: T;
      if (resolution === "server") {
        resolved = { ...conflict!.serverValue };
      } else if (resolution === "client") {
        resolved = { ...conflict!.clientValue };
      } else {
        // Manual — for simple string merges we put the manual text in the first
        // changed text field. More complex merges are left to the user.
        const firstTextField = changedKeys.find(
          (k) => typeof conflict!.serverValue[k] === "string",
        );
        resolved = {
          ...conflict!.serverValue,
          ...(firstTextField ? { [firstTextField]: manualText } : {}),
        } as T;
      }
      await onResolve(resolved, conflict!.serverVersion);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(v) => !v && onDismiss()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitMerge className="h-4 w-4 text-amber-500" />
            Merge Conflict
          </DialogTitle>
          <DialogDescription>
            Someone else edited this requirement while you were working on it. Choose how to resolve
            the conflict.
          </DialogDescription>
        </DialogHeader>

        {/* Field diffs */}
        <div className="flex max-h-64 flex-col gap-2 overflow-y-auto">
          {changedKeys.length === 0 ? (
            <p className="text-sm text-muted-foreground">No field-level differences found.</p>
          ) : (
            changedKeys.map((k) => (
              <FieldDiff
                key={k}
                field={k}
                clientVal={conflict.clientValue[k]}
                serverVal={conflict.serverValue[k]}
                label={conflict.fieldLabels?.[k]}
              />
            ))
          )}
        </div>

        {/* Resolution selector */}
        <div className="flex flex-col gap-1 text-sm">
          <p className="font-medium">How would you like to resolve this?</p>
          <div className="flex flex-col gap-1">
            {(
              [
                ["server", "Accept server version (discard my changes)"],
                ["client", "Keep my version (overwrite server changes)"],
                ["manual", "Manual merge"],
              ] as [Resolution, string][]
            ).map(([val, label]) => (
              <label
                key={val}
                className={cn(
                  "flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2",
                  resolution === val ? "border-primary bg-primary/5" : "hover:bg-muted",
                )}
              >
                <input
                  type="radio"
                  name="resolution"
                  value={val}
                  checked={resolution === val}
                  onChange={() => setResolution(val)}
                  className="accent-primary"
                />
                {label}
              </label>
            ))}
          </div>

          {resolution === "manual" && (
            <div className="mt-2">
              <p className="mb-1 text-xs text-muted-foreground">
                Edit the merged value for the first changed text field:
              </p>
              <Textarea
                value={manualText}
                onChange={(e) => setManualText(e.target.value)}
                placeholder="Enter your merged value…"
                className="min-h-[80px] text-sm"
              />
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onDismiss} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleResolve} disabled={saving}>
            {saving ? "Saving…" : "Resolve & Save"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
