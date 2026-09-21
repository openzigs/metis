/**
 * Issue #259 — Tunable row in the Configuration page.
 *
 * Renders one Tier-3 runtime tunable. Control type is chosen by `valueType`:
 *
 *   - string → <Input>
 *   - int    → <Input type=number>
 *   - bool   → <Switch>
 *   - csv    → <Textarea>
 *   - json   → <Textarea> (we don't validate shape here; the server does)
 *   - enum strings (handled by the server schema; we render <Input>)
 *
 * Save calls `configApi.set(key, value)`; Clear removes the override and
 * falls back to the env value. Source is shown on the right-hand badge.
 */
"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ApiError } from "@/lib/api-client";
import { configApi, type ConfigKeyView } from "@/lib/settings-api";

interface TunableRowProps {
  view: ConfigKeyView;
  onChanged: () => void;
}

export function TunableRow({ view, onChanged }: TunableRowProps) {
  const [draft, setDraft] = useState<string>(view.value ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(view.value ?? "");
  }, [view.value]);

  async function handleSave() {
    setBusy(true);
    setError(null);
    try {
      let payload: unknown = draft;
      if (view.valueType === "int") payload = Number(draft);
      else if (view.valueType === "bool") payload = /^(1|true|yes|on)$/i.test(draft.trim());
      await configApi.set(view.key, payload);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleClear() {
    setBusy(true);
    setError(null);
    try {
      await configApi.clear(view.key);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const sourceLabel =
    view.source === "db"
      ? "db"
      : view.source === "vault"
        ? "vault"
        : view.source === "env"
          ? "env"
          : "unset";

  return (
    <div
      className="flex flex-col gap-2 border-b py-3 last:border-b-0 md:flex-row md:items-start md:justify-between"
      data-testid={`config-tunable-${view.key}`}
    >
      <div className="flex-1">
        <code className="font-mono text-xs">{view.key}</code>
        <p className="mt-0.5 text-xs text-muted-foreground">{view.description}</p>
        <p className="mt-0.5 text-xs">
          <span className="text-muted-foreground">source: </span>
          <code
            className="rounded bg-muted px-1 text-xs"
            data-testid={`config-tunable-${view.key}-source`}
          >
            {sourceLabel}
          </code>
        </p>
      </div>
      <div className="flex w-full items-center gap-2 md:w-1/2">
        <TunableControl
          configKey={view.key}
          valueType={view.valueType}
          value={draft}
          disabled={busy}
          onChange={setDraft}
        />
        <Button
          size="sm"
          onClick={handleSave}
          disabled={busy}
          data-testid={`config-tunable-${view.key}-save`}
        >
          Save
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={handleClear}
          disabled={busy || view.source !== "db"}
          data-testid={`config-tunable-${view.key}-clear`}
        >
          Clear
        </Button>
      </div>
      {error ? (
        <p
          role="alert"
          className="basis-full text-xs text-destructive"
          data-testid={`config-tunable-${view.key}-error`}
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}

interface ControlProps {
  configKey: string;
  valueType: ConfigKeyView["valueType"];
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}

function TunableControl({ configKey, valueType, value, disabled, onChange }: ControlProps) {
  const testId = `config-tunable-${configKey}-input`;
  if (valueType === "bool") {
    const checked = /^(1|true|yes|on)$/i.test(value.trim());
    return (
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked ? "true" : "false")}
        aria-label={configKey}
        data-testid={testId}
      />
    );
  }
  if (valueType === "csv" || valueType === "json") {
    return (
      <textarea
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        rows={2}
        className="flex w-full rounded-md border border-input bg-background px-3 py-1 text-xs shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        aria-label={configKey}
        data-testid={testId}
      />
    );
  }
  return (
    <Input
      type={valueType === "int" ? "number" : "text"}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      className="text-xs"
      data-testid={testId}
    />
  );
}
