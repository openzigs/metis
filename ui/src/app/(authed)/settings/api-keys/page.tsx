/**
 * Epic #196 / #221 — Settings sub-page: Configuration.
 *
 * Surfaces the user-scoped provider preferences (default provider/model,
 * reasoning effort) plus the pre-existing security-eval trigger and
 * env-var view.
 *
 * Epic #249 (Phase 2 — #259) — reorganises into Secrets / Tunables /
 * Bootstrap / Audit-log sections backed by the unified
 * `/api/admin/config` surface (#257). The route stays at /settings/api-keys
 * for back-compat; the H1 + sidebar label say "Configuration".
 */
"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  configApi,
  loadProviderPrefs,
  resetProviderPrefs,
  saveProviderPrefs,
  settingsApi,
  type ConfigKeyView,
  type ProviderPrefs,
} from "@/lib/settings-api";
import { phase12QueryKeys } from "@/lib/phase12-query-keys";
import { ApiError } from "@/lib/api-client";
import { useTransientFlag } from "@/hooks/use-transient-toast";
import { SecretRow, type SecretSource } from "./SecretRow";
import { TunableRow } from "./TunableRow";
import { AuditLogTab } from "./AuditLogTab";

const BOOTSTRAP_TOOLTIP = "Bootstrap config — set in `.env`. Restart required to change.";

type SettingsTab = "config" | "audit";

interface SettingsApiKeysPageProps {
  initialTab?: SettingsTab;
}

export default function SettingsApiKeysPage({
  initialTab = "config",
}: SettingsApiKeysPageProps = {}) {
  return (
    <div className="space-y-6 p-2 md:p-0" data-testid="settings-api-keys-root">
      <header>
        <h1 className="text-2xl font-semibold">Configuration</h1>
        <p className="text-sm text-muted-foreground">
          Provider preferences, security evaluations, and runtime configuration. Plaintext
          credentials live in the encrypted Vault — see{" "}
          <a href="/vault" className="underline">
            /vault
          </a>
          .
        </p>
      </header>
      <ProviderPrefsSection />
      <SecurityEvalSection />
      <RuntimeConfigSection initialTab={initialTab} />
      <EnvVarsSection />
    </div>
  );
}

function RuntimeConfigSection({ initialTab }: { initialTab: SettingsTab }) {
  const searchParams = useSearchParams();
  const [tab, setTab] = useState<SettingsTab>(
    searchParams.get("tab") === "audit" || initialTab === "audit" ? "audit" : "config",
  );
  return (
    <Card className="p-0" data-testid="settings-config-tabs">
      <div className="flex items-center gap-2 border-b px-3 py-2" role="tablist">
        <Button
          type="button"
          variant={tab === "config" ? "default" : "ghost"}
          size="sm"
          role="tab"
          aria-selected={tab === "config"}
          onClick={() => setTab("config")}
          data-testid="settings-tab-secrets"
        >
          Runtime configuration
        </Button>
        <Button
          type="button"
          variant={tab === "audit" ? "default" : "ghost"}
          size="sm"
          role="tab"
          aria-selected={tab === "audit"}
          onClick={() => setTab("audit")}
          data-testid="settings-tab-audit"
        >
          Audit log
        </Button>
      </div>
      <div className="p-4" role="tabpanel">
        {tab === "config" ? <ConfigTabBody /> : <AuditLogTab />}
      </div>
    </Card>
  );
}

function ConfigTabBody() {
  const queryClient = useQueryClient();
  const cfgQuery = useQuery({
    queryKey: ["admin", "config", "list"],
    queryFn: () => configApi.list(),
    retry: false,
  });

  const refresh = (): void => {
    queryClient.invalidateQueries({ queryKey: ["admin", "config", "list"] });
    queryClient.invalidateQueries({ queryKey: ["admin", "config", "audit"] });
  };

  if (cfgQuery.isError && cfgQuery.error instanceof ApiError && cfgQuery.error.status === 403) {
    return (
      <p className="text-xs text-muted-foreground" data-testid="settings-config-forbidden">
        You don&apos;t have permission to view runtime configuration. Ask an admin for{" "}
        <code>admin.read</code>.
      </p>
    );
  }
  if (cfgQuery.isLoading) {
    return <p className="text-xs text-muted-foreground">Loading…</p>;
  }
  if (cfgQuery.isError) {
    return (
      <p role="alert" className="text-xs text-destructive">
        {(cfgQuery.error as Error).message}
      </p>
    );
  }

  const items = cfgQuery.data?.items ?? [];
  const secrets = items.filter((i) => i.tier === "secret");
  const tunables = items.filter((i) => i.tier === "tunable");
  const bootstrap = items.filter((i) => i.tier === "bootstrap");

  return (
    <div className="space-y-6" data-testid="settings-config-section">
      <section>
        <h3 className="mb-2 text-sm font-semibold">Runtime secrets</h3>
        <p className="mb-2 text-xs text-muted-foreground">
          Vault-backed values. Save rotates the secret; Clear removes the override and falls back to
          the env value.
        </p>
        <div data-testid="settings-secrets">
          {secrets.map((view) => (
            <SecretRow
              key={view.key}
              configKey={view.key}
              description={view.description}
              source={mapSource(view.source)}
              onChanged={refresh}
            />
          ))}
        </div>
      </section>

      <section>
        <h3 className="mb-2 text-sm font-semibold">Runtime tunables</h3>
        <p className="mb-2 text-xs text-muted-foreground">
          DB-backed runtime knobs. Save persists the value to <code>runtime_config</code>; Clear
          deletes the override and falls back to <code>.env</code>.
        </p>
        <div data-testid="settings-tunables">
          {tunables.map((view) => (
            <TunableRow key={view.key} view={view} onChanged={refresh} />
          ))}
        </div>
      </section>

      <section>
        <h3 className="mb-2 text-sm font-semibold">Bootstrap configuration</h3>
        <p className="mb-2 text-xs text-muted-foreground">
          Read-only — these values are loaded from <code>.env</code> at boot. Restart the server to
          change them.
        </p>
        <div data-testid="settings-bootstrap">
          {bootstrap.map((view) => (
            <div
              key={view.key}
              className="flex items-center justify-between gap-3 border-b py-2 last:border-b-0"
              data-testid={`config-bootstrap-${view.key}`}
            >
              <div>
                <code className="font-mono text-xs">{view.key}</code>
                <p className="mt-0.5 text-xs text-muted-foreground">{view.description}</p>
              </div>
              <code
                className="rounded bg-muted px-1 text-xs"
                title={BOOTSTRAP_TOOLTIP}
                data-testid={`config-bootstrap-${view.key}-value`}
              >
                {view.value ?? "[unset]"}
              </code>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function mapSource(source: ConfigKeyView["source"]): SecretSource {
  if (source === "vault") return "vault";
  if (source === "db") return "vault"; // tunables don't render here, but keep the type honest
  if (source === "env") return "env";
  return "unset";
}

function ProviderPrefsSection() {
  const [saved, setSaved] = useState<ProviderPrefs>(() => loadProviderPrefs());
  const [draft, setDraft] = useState<ProviderPrefs>(saved);
  // #1284 — the hook owns the 2s dismissal timer AND cancels it on unmount.
  const { active: savedToast, show: showSavedToast } = useTransientFlag(2000);
  const dirty =
    draft.defaultProvider !== saved.defaultProvider ||
    draft.defaultModel !== saved.defaultModel ||
    draft.reasoningEffort !== saved.reasoningEffort;

  function handleSave() {
    saveProviderPrefs(draft);
    setSaved(draft);
    showSavedToast();
  }

  function handleReset() {
    resetProviderPrefs();
    const fresh = loadProviderPrefs();
    setSaved(fresh);
    setDraft(fresh);
  }

  return (
    <Card className="space-y-3 p-4" data-testid="settings-provider">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">Provider preferences</h2>
          <p className="text-xs text-muted-foreground">
            Defaults applied to new chat sessions. Changes take effect after you click Save.
          </p>
        </div>
        {savedToast ? (
          <span
            role="status"
            aria-live="polite"
            className="rounded bg-emerald-100 px-2 py-1 text-xs text-emerald-900"
            data-testid="settings-provider-saved"
          >
            Saved
          </span>
        ) : null}
      </div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <label className="space-y-1 text-sm">
          <span className="text-muted-foreground">Provider</span>
          <Input
            data-testid="settings-provider-key"
            value={draft.defaultProvider}
            onChange={(e) => setDraft({ ...draft, defaultProvider: e.target.value })}
          />
        </label>
        <label className="space-y-1 text-sm">
          <span className="text-muted-foreground">Default model</span>
          <Input
            data-testid="settings-provider-model"
            value={draft.defaultModel}
            onChange={(e) => setDraft({ ...draft, defaultModel: e.target.value })}
          />
        </label>
        <label className="space-y-1 text-sm">
          <span className="text-muted-foreground">Reasoning effort</span>
          <select
            data-testid="settings-provider-effort"
            aria-label="Reasoning effort"
            className="w-full rounded border bg-background px-2 py-1 text-sm"
            value={draft.reasoningEffort}
            onChange={(e) =>
              setDraft({
                ...draft,
                reasoningEffort: e.target.value as ProviderPrefs["reasoningEffort"],
              })
            }
          >
            <option value="minimal">minimal</option>
            <option value="medium">medium</option>
            <option value="high">high</option>
          </select>
        </label>
      </div>
      <div className="flex items-center gap-2">
        <Button onClick={handleSave} disabled={!dirty} data-testid="settings-provider-save">
          Save
        </Button>
        <Button variant="outline" onClick={handleReset} data-testid="settings-provider-reset">
          Reset to defaults
        </Button>
      </div>
    </Card>
  );
}

function SecurityEvalSection() {
  const [report, setReport] = useState<import("@/lib/projects-api").RedTeamReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const run = async () => {
    setRunning(true);
    setError(null);
    try {
      const { securityEvalApi } = await import("@/lib/projects-api");
      const result = await securityEvalApi.run();
      setReport(result);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Run failed");
    } finally {
      setRunning(false);
    }
  };

  return (
    <Card className="space-y-3 p-4" data-testid="settings-security-eval">
      <h2 className="text-sm font-semibold">Security eval (red team)</h2>
      <p className="text-xs text-muted-foreground">
        Run the prompt-injection regression suite on demand. Admin only.
      </p>
      <div className="flex items-center gap-2">
        <Button onClick={run} disabled={running} data-testid="security-eval-run">
          {running ? "Running…" : "Run security eval"}
        </Button>
        {report ? (
          <a
            className="text-xs underline"
            href={`data:application/json;charset=utf-8,${encodeURIComponent(
              JSON.stringify(report, null, 2),
            )}`}
            download={`red-team-${report.ranAt.replace(/[:.]/g, "-")}.json`}
          >
            Download last report
          </a>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      {report ? (
        <p className="text-xs text-muted-foreground" data-testid="security-eval-summary">
          {report.passed}/{report.total} passed · score {report.score.toFixed(3)}
          {report.failed > 0 ? ` · ${report.failed} failures` : ""}
        </p>
      ) : null}
    </Card>
  );
}

function EnvVarsSection() {
  const [forbidden, setForbidden] = useState(false);
  const q = useQuery({
    queryKey: phase12QueryKeys.envVars(),
    queryFn: () => settingsApi.envVars(),
    retry: false,
  });

  useEffect(() => {
    if (q.isError && q.error instanceof ApiError && q.error.status === 403) {
      setForbidden(true);
    }
  }, [q.isError, q.error]);

  if (forbidden) {
    return (
      <Card className="p-4" data-testid="settings-env">
        <h2 className="text-sm font-semibold">Environment variables</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          You don&apos;t have permission to view runtime configuration. Ask an admin for{" "}
          <code>admin.read</code>.
        </p>
      </Card>
    );
  }

  return (
    <Card className="p-4" data-testid="settings-env">
      <h2 className="text-sm font-semibold">Environment variables</h2>
      <p className="mt-1 text-xs text-muted-foreground">
        Read-only view of curated runtime env vars. Secrets show as
        <code className="mx-1">[REDACTED]</code>; missing values show as
        <code className="mx-1">[unset]</code>.
      </p>
      {q.isLoading ? (
        <p className="mt-3 text-xs text-muted-foreground">Loading…</p>
      ) : q.isError ? (
        <p
          role="alert"
          className="mt-3 rounded border border-destructive p-2 text-xs text-destructive"
        >
          {(q.error as Error).message}
        </p>
      ) : (
        <table
          className="mt-3 w-full text-left text-xs"
          aria-label="Environment variables"
          data-testid="settings-env-table"
        >
          <thead>
            <tr className="text-muted-foreground">
              <th className="py-1 pr-3 font-medium">Key</th>
              <th className="py-1 pr-3 font-medium">Value</th>
              <th className="py-1 pr-3 font-medium">Class</th>
            </tr>
          </thead>
          <tbody>
            {(q.data?.items ?? []).map((row) => (
              <tr key={row.key} className="border-t" data-testid={`settings-env-${row.key}`}>
                <td className="py-1 pr-3 font-mono">{row.key}</td>
                <td className="py-1 pr-3">
                  <code
                    className={
                      row.classification === "secret" && row.set
                        ? "rounded bg-amber-100 px-1 text-amber-900"
                        : !row.set
                          ? "text-muted-foreground"
                          : ""
                    }
                  >
                    {row.value}
                  </code>
                </td>
                <td className="py-1 pr-3">
                  <span
                    className={
                      row.classification === "secret"
                        ? "rounded bg-rose-100 px-1.5 py-0.5 text-rose-900"
                        : "rounded bg-sky-100 px-1.5 py-0.5 text-sky-900"
                    }
                  >
                    {row.classification}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}
