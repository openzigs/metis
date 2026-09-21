"use client";

/**
 * VaultPicker — a combobox that lets the user select a vault secret label
 * from the list of entries in the vault, auto-formatting the selection as
 * `${vault:<label>}`. Falls back to a plain text input for custom values.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { vaultApi } from "@/lib/vault-api";
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

export function VaultPicker({ id, value, onChange, placeholder, className }: VaultPickerProps) {
  const { data } = useQuery({
    queryKey: ["vault", "list"],
    queryFn: () => vaultApi.list(),
    staleTime: 30_000,
  });

  const entries = data?.items ?? [];
  const parsedLabel = parseVaultLabel(value);

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
          <SelectValue placeholder={placeholder ?? "${vault:select-a-key}"} />
        </SelectTrigger>
        <SelectContent>
          {entries.length === 0 && (
            <SelectItem value={CUSTOM_KEY} disabled>
              No vault entries found
            </SelectItem>
          )}
          {entries.map((entry) => (
            <SelectItem key={entry.id} value={entry.label}>
              <span className="font-mono text-xs">{entry.label}</span>
              {entry.description ? (
                <span className="ml-2 text-xs text-muted-foreground">{entry.description}</span>
              ) : null}
            </SelectItem>
          ))}
          <SelectItem value={CUSTOM_KEY}>
            <span className="text-muted-foreground">Enter custom ref…</span>
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
