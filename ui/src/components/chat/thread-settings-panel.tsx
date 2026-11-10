"use client";

/**
 * Epic #475 (Phase 4, #488) — discussion thread settings panel.
 *
 * Exposes the **`aiResponseMode` 3-state segmented control** (off / on_mention /
 * auto) which persists via `PATCH /threads/:id` (#483), and an optional **anchor**
 * (attach the thread to a Requirement / Analysis / Spec Kit feature for context;
 * #488). Both are member-only — the parent only renders this for members; the
 * server independently enforces access (so a hidden control is never the only
 * gate).
 */
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import {
  updateThreadSettings,
  AI_RESPONSE_MODES,
  type AiResponseMode,
  type ThreadAnchor,
} from "@/lib/discussions-api";
import { DiscussionRequirementPicker } from "@/components/chat/discussion-requirement-picker";

const MODE_LABELS: Record<AiResponseMode, { label: string; hint: string }> = {
  off: { label: "Off", hint: "The AI never replies, even when @AI-mentioned." },
  on_mention: { label: "On mention", hint: "The AI replies only when you @AI-mention it." },
  auto: { label: "Auto", hint: "The AI replies whenever it detects a question or request." },
};

const ANCHOR_KINDS = [
  { value: "requirementId", label: "Requirement" },
  { value: "analysisId", label: "Analysis" },
  { value: "specKitFeatureId", label: "Spec Kit feature" },
] as const;
type AnchorKind = (typeof ANCHOR_KINDS)[number]["value"];

export interface ThreadSettingsPanelProps {
  threadId: string;
  /** Current AI mode (controls the segmented selection). */
  aiResponseMode: AiResponseMode;
  /** Notified with the new mode after a successful persist. */
  onModeChange?: (mode: AiResponseMode) => void;
  /** Notified after a successful anchor update. */
  onAnchorChange?: (anchor: ThreadAnchor) => void;
  /**
   * #2187 — the thread's project. When given, a Requirement anchor is chosen by
   * searching the project's requirements on title instead of pasting an id.
   */
  projectId?: string;
}

export function ThreadSettingsPanel({
  threadId,
  aiResponseMode,
  onModeChange,
  onAnchorChange,
  projectId,
}: ThreadSettingsPanelProps) {
  const [mode, setMode] = useState<AiResponseMode>(aiResponseMode);
  const [savingMode, setSavingMode] = useState<AiResponseMode | null>(null);

  const [anchorKind, setAnchorKind] = useState<AnchorKind>("requirementId");
  const [anchorId, setAnchorId] = useState("");
  const [savingAnchor, setSavingAnchor] = useState(false);
  // #2187 — a Requirement is picked by title once the project is known.
  const pickRequirement = anchorKind === "requirementId" && !!projectId;

  async function selectMode(next: AiResponseMode) {
    if (next === mode || savingMode) return;
    const prev = mode;
    setMode(next); // optimistic
    setSavingMode(next);
    try {
      await updateThreadSettings(threadId, { aiResponseMode: next });
      onModeChange?.(next);
    } catch (err) {
      setMode(prev); // roll back
      toast.error((err as Error).message || "Failed to update AI mode");
    } finally {
      setSavingMode(null);
    }
  }

  async function saveAnchor(anchor: ThreadAnchor = { [anchorKind]: anchorId.trim() }) {
    if (!Object.values(anchor).some((v) => v) || savingAnchor) return;
    setSavingAnchor(true);
    try {
      await updateThreadSettings(threadId, { anchor });
      onAnchorChange?.(anchor);
      toast.success("Anchor updated");
      setAnchorId("");
    } catch (err) {
      toast.error((err as Error).message || "Failed to set anchor");
    } finally {
      setSavingAnchor(false);
    }
  }

  return (
    <div className="space-y-5" data-testid="thread-settings-panel">
      {/* AI mode segmented control. */}
      <div className="space-y-2">
        <Label>AI participation</Label>
        <div
          role="radiogroup"
          aria-label="AI participation mode"
          className="inline-flex rounded-md border border-input p-0.5"
        >
          {AI_RESPONSE_MODES.map((m) => {
            const active = mode === m;
            return (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={active}
                disabled={savingMode !== null}
                onClick={() => void selectMode(m)}
                className={cn(
                  "rounded px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  active
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {MODE_LABELS[m].label}
              </button>
            );
          })}
        </div>
        <p className="text-xs text-muted-foreground">{MODE_LABELS[mode].hint}</p>
      </div>

      {/* Optional anchor. */}
      <div className="space-y-2">
        {/* #2203 — the label names the id box only while there is one. */}
        <Label htmlFor={pickRequirement ? undefined : "anchor-id"}>Anchor (optional)</Label>
        <p className="text-xs text-muted-foreground">
          Attach this discussion to a Requirement, Analysis, or Spec Kit feature for context.
        </p>
        <div className="flex gap-2">
          <select
            aria-label="Anchor type"
            value={anchorKind}
            onChange={(e) => setAnchorKind(e.target.value as AnchorKind)}
            disabled={savingAnchor}
            className="h-9 rounded-md border border-input bg-background px-2 text-sm"
          >
            {ANCHOR_KINDS.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </select>
          {pickRequirement ? null : (
            <>
              <Input
                id="anchor-id"
                value={anchorId}
                onChange={(e) => setAnchorId(e.target.value)}
                placeholder="Paste the id to anchor to"
                disabled={savingAnchor}
              />
              <Button
                type="button"
                onClick={() => void saveAnchor()}
                disabled={savingAnchor || !anchorId.trim()}
              >
                {savingAnchor ? "Saving…" : "Anchor"}
              </Button>
            </>
          )}
        </div>
        {pickRequirement && projectId ? (
          <DiscussionRequirementPicker
            projectId={projectId}
            value={null}
            label="Requirement"
            disabled={savingAnchor}
            onChange={(r) => {
              if (r) void saveAnchor({ requirementId: r.id });
            }}
          />
        ) : null}
      </div>
    </div>
  );
}
