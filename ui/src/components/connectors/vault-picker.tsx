"use client";

/**
 * VaultPicker — a combobox that lets the user select a vault secret label
 * from the list of entries in the vault, auto-formatting the selection as
 * `${vault:<label>}`. Falls back to a plain text input for custom values.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { vaultApi } from "@/lib/vault-api";
import { ApiError } from "@/lib/api-client";
import { useOptionalAuth } from "@/lib/auth-context";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

interface VaultPickerProps {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  /**
   * Offer only the secrets the caller may attach (the server's `bindable`).
   * Default true. A form whose server check applies only in some cases (Publish:
   * only a live run to a non-github.com base URL) passes false while it does not.
   */
  offerOnlyBindable?: boolean;
}

const CUSTOM_KEY = "__custom__";

/** Parse out the label from a `${vault:<label>}` string, or null. */
function parseVaultLabel(value: string): string | null {
  const m = /^\$\{vault:([A-Za-z0-9_.\-/:]+)\}$/.exec(value.trim());
  return m ? m[1] : null;
}

/** Format a vault label as the template string. */
function formatVaultRef(label: string): string {
  return `\${vault:${label}}`;
}

export function VaultPicker({
  id,
  value,
  onChange,
  placeholder,
  className,
  offerOnlyBindable = true,
}: VaultPickerProps) {
  const { data, error } = useQuery({
    queryKey: ["vault", "list"],
    queryFn: () => vaultApi.list(),
    staleTime: 30_000,
    // No per-query `retry`: the app default already never retries a 4xx.
  });
  // #2337 — a role refused `GET /api/vault` saw "No vault entries found", which
  // hid the refusal; and anyone without `vault.reveal` can attach only secrets
  // they created (the server's SECRET_BINDING_FORBIDDEN), which nothing said.
  const refused = error instanceof ApiError && error.status === 403;
  const auth = useOptionalAuth();
  const attachesOwnOnly =
    offerOnlyBindable && !(auth?.user?.permissions.includes("vault.reveal") ?? false);

  const all = data?.items ?? [];
  const parsedLabel = parseVaultLabel(value);
  // #2382 — offer only what the caller may attach (the server's `bindable`),
  // plus the secret already chosen here: a binding stays usable where it is.
  const entries = offerOnlyBindable
    ? all.filter((e) => e.bindable !== false || e.label === parsedLabel)
    : all;
  const noneBindable =
    offerOnlyBindable && all.length > 0 && !all.some((e) => e.bindable !== false);

  // Tracks whether the user explicitly chose free-text ("custom") entry. This
  // is needed because the custom <Input> would otherwise never appear for a
  // brand-new ref: it can only be revealed by an empty -> non-empty value, but
  // the only way to make the value non-empty is to type into that very input.
  const [customMode, setCustomMode] = useState(false);

  // Determine what to show in the select:
  // - If the user picked custom entry → show "Custom"
  // - If the current value matches a known vault label → show that label
  // - If value is empty → show placeholder state
  // - Otherwise → show "Custom" (free-text mode)
  const selectValue = customMode
    ? CUSTOM_KEY
    : value === ""
      ? ""
      : parsedLabel && entries.some((e) => e.label === parsedLabel)
        ? parsedLabel
        : CUSTOM_KEY;

  const showCustomInput = customMode || (value !== "" && selectValue === CUSTOM_KEY);

  return (
    <div className={cn("space-y-1", className)}>
      <Select
        value={selectValue}
        onValueChange={(v) => {
          if (v === CUSTOM_KEY) {
            // Enter free-text mode; reveal the input below for the user to type.
            setCustomMode(true);
            return;
          }
          setCustomMode(false);
          if (v === "") {
            onChange("");
          } else {
            onChange(formatVaultRef(v));
          }
        }}
      >
        <SelectTrigger id={id} className="w-full">
          <SelectValue placeholder={placeholder ?? "Choose a vault secret"} />
        </SelectTrigger>
        <SelectContent>
          {/* #23 — a plain note, not a second item: Radix mirrors every item
              into a native <select> keyed by value, so a disabled item sharing
              CUSTOM_KEY with the real custom row logged a duplicate-key error. */}
          {refused ? (
            <div
              className="max-w-xs px-2 py-1.5 text-xs text-muted-foreground"
              data-testid="vault-picker-refused"
            >
              Your role cannot list the vault&apos;s secrets. Ask an admin to add a secret, or to
              bind one for you.
            </div>
          ) : all.length === 0 ? (
            <div
              className="max-w-xs px-2 py-1.5 text-xs text-muted-foreground"
              data-testid="vault-picker-empty"
            >
              No secrets in the vault yet. Ask an admin to add one.
            </div>
          ) : noneBindable ? (
            <div
              className="max-w-xs px-2 py-1.5 text-xs text-muted-foreground"
              data-testid="vault-picker-none-bindable"
            >
              None of the vault&apos;s secrets are yours to attach. Ask an admin to bind one for
              you.
            </div>
          ) : attachesOwnOnly ? (
            <div
              className="max-w-xs px-2 py-1.5 text-xs text-muted-foreground"
              data-testid="vault-picker-own-only"
            >
              This list shows only secrets you created. For any other, ask an admin to bind it.
            </div>
          ) : null}
          {entries.map((entry) => (
            <SelectItem key={entry.id} value={entry.label}>
              <span className="font-mono text-xs">{entry.label}</span>
              {entry.description ? (
                <span className="ml-2 text-xs text-muted-foreground">{entry.description}</span>
              ) : null}
            </SelectItem>
          ))}
          <SelectItem value={CUSTOM_KEY}>
            <span className="text-muted-foreground">Type a secret name…</span>
          </SelectItem>
        </SelectContent>
      </Select>

      {showCustomInput && (
        <Input
          id={id ? `${id}-custom` : undefined}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="${vault:my-label}"
          className="font-mono text-xs"
        />
      )}
    </div>
  );
}
