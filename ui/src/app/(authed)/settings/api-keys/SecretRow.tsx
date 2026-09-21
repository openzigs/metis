/**
 * Issue #252 — inline edit/clear control for a single Tier-2 secret row.
 *
 * Displays the redacted value, a "from vault" or "from env" badge, and the
 * pencil/trash actions. When the user clicks the pencil the row reveals a
 * masked input + Save/Cancel. Save calls `PUT /api/admin/config/secrets/:key`
 * via the configApi client.
 *
 * Bootstrap-tier rows are NOT rendered by this component — see BootstrapRow
 * (introduced in Phase 2 #259) for that affordance.
 */
"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ApiError } from "@/lib/api-client";
import { configApi } from "@/lib/settings-api";
import { useTransientToast } from "@/hooks/use-transient-toast";

export type SecretSource = "vault" | "env" | "unset";

export interface SecretRowProps {
  /** Registered secret key, e.g. `OPENAI_API_KEY`. */
  configKey: string;
  /** Human-readable description shown beneath the key name. */
  description: string;
  /** Effective source after the most recent server response. */
  source: SecretSource;
  /** Called after a successful save / clear so the parent can refresh. */
  onChanged: () => void;
}

export function SecretRow({ configKey, description, source, onChanged }: SecretRowProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // #1284 — the hook owns the 2s dismissal timer AND cancels it on unmount.
  const { toast: savedToast, showToast: showSavedToast } = useTransientToast<"saved" | "cleared">(
    2000,
  );

  const sourceBadge = (() => {
    switch (source) {
      case "vault":
        return { label: "from vault", className: "bg-emerald-100 text-emerald-900" };
      case "env":
        return { label: "from env", className: "bg-sky-100 text-sky-900" };
      default:
        return { label: "not set", className: "bg-muted text-muted-foreground" };
    }
  })();

  async function handleSave(): Promise<void> {
    setError(null);
    if (draft.trim().length === 0) {
      setError("Value is required");
      return;
    }
    setSaving(true);
    try {
      await configApi.setSecret(configKey, draft);
      setEditing(false);
      setDraft("");
      showSavedToast("saved");
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function handleClear(): Promise<void> {
    setError(null);
    setSaving(true);
    try {
      await configApi.clearSecret(configKey);
      showSavedToast("cleared");
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Clear failed");
    } finally {
      setSaving(false);
    }
  }

  function handleCancel(): void {
    setEditing(false);
    setDraft("");
    setError(null);
  }

  return (
    <div
      className="flex flex-col gap-2 border-b py-3 last:border-b-0"
      data-testid={`config-secret-${configKey}`}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <code className="font-mono text-xs">{configKey}</code>
          <p className="mt-1 text-xs text-muted-foreground">{description}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span
            className={`rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${sourceBadge.className}`}
            data-testid={`config-secret-${configKey}-source`}
          >
            {sourceBadge.label}
          </span>
          {savedToast ? (
            <span
              role="status"
              aria-live="polite"
              className="rounded bg-emerald-100 px-2 py-0.5 text-xs text-emerald-900"
              data-testid={`config-secret-${configKey}-toast`}
            >
              {savedToast === "saved" ? "Saved" : "Cleared"}
            </span>
          ) : null}
        </div>
      </div>
      {editing ? (
        <div className="flex flex-col gap-2">
          <Input
            type="password"
            placeholder={`New value for ${configKey}`}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            data-testid={`config-secret-${configKey}-input`}
            disabled={saving}
            autoFocus
          />
          {error ? (
            <p
              role="alert"
              className="text-xs text-destructive"
              data-testid={`config-secret-${configKey}-error`}
            >
              {error}
            </p>
          ) : null}
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              onClick={handleSave}
              disabled={saving}
              data-testid={`config-secret-${configKey}-save`}
            >
              {saving ? "Saving…" : "Save"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={handleCancel}
              disabled={saving}
              data-testid={`config-secret-${configKey}-cancel`}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <code className="rounded bg-amber-100 px-1 text-xs text-amber-900">
            {source === "unset" ? "[unset]" : "[REDACTED]"}
          </code>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setEditing(true)}
            data-testid={`config-secret-${configKey}-edit`}
          >
            Edit
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={handleClear}
            disabled={source !== "vault" || saving}
            data-testid={`config-secret-${configKey}-clear`}
          >
            Clear
          </Button>
          {error ? (
            <span role="alert" className="ml-2 text-xs text-destructive">
              {error}
            </span>
          ) : null}
        </div>
      )}
    </div>
  );
}
