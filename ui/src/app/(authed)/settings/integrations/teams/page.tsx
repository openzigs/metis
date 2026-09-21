"use client";

/**
 * Epic #547 — Microsoft Teams integration settings.
 *
 * Surfaces the workspace-admin Teams bot install + status + manifest builder
 * for a selected workspace. Wires exclusively to the EXISTING admin backend:
 *   • /api/integrations/teams/workspaces/:id/install       (#548)
 *   • /api/integrations/teams/workspaces/:id/installation  (#548)
 *   • /api/integrations/teams/workspaces/:id/manifest       (#548)
 *
 * SECURITY: the bot app password is write-only. It is typed out of every
 * response shape (see teams-integration-api) and is never rendered — the input
 * is type="password" and cleared on submit.
 *
 * Workspace-admin gated: only workspace owners/admins (or system admins) see
 * the mutating controls; members get a read-only notice.
 */
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth-context";
import {
  canManageIntegrations,
  listIntegrationWorkspaces,
} from "@/lib/notification-integrations-api";
import {
  TEAMS_APP_TYPES,
  teamsIntegrationApi,
  type TeamsAppType,
  type TeamsManifestResult,
} from "@/lib/teams-integration-api";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const ACTIVE_WORKSPACE_STORAGE_KEY = "metis.activeWorkspaceId";

export default function TeamsIntegrationPage() {
  const { user } = useAuth();
  const isSystemAdmin = user?.role === "admin";

  const workspacesQuery = useQuery({
    queryKey: ["integrations", "teams", "workspaces"],
    queryFn: listIntegrationWorkspaces,
  });
  const workspaces = useMemo(() => workspacesQuery.data ?? [], [workspacesQuery.data]);

  const [workspaceId, setWorkspaceId] = useState<string>("");

  // Default the selection to the stored active workspace, else the first one.
  useEffect(() => {
    if (workspaceId || workspaces.length === 0) return;
    let stored: string | null = null;
    try {
      stored = window.localStorage.getItem(ACTIVE_WORKSPACE_STORAGE_KEY);
    } catch {
      stored = null;
    }
    const initial = workspaces.find((w) => w.id === stored)?.id ?? workspaces[0]?.id ?? "";
    setWorkspaceId(initial);
  }, [workspaces, workspaceId]);

  const selected = workspaces.find((w) => w.id === workspaceId) ?? null;
  const canManage = isSystemAdmin || canManageIntegrations(selected?.role);

  return (
    <div className="space-y-6 p-2 md:p-0" data-testid="teams-integration-page">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Microsoft Teams</h1>
        <p className="text-sm text-muted-foreground">
          Connect a Microsoft Teams bot so discussions and notifications can bridge into Teams
          channels. The bot app password is stored server-side (encrypted) and never shown.
        </p>
      </header>

      <div className="flex items-center gap-2">
        <Label htmlFor="teams-workspace-select">Workspace</Label>
        <select
          id="teams-workspace-select"
          data-testid="teams-workspace-select"
          value={workspaceId}
          onChange={(e) => setWorkspaceId(e.target.value)}
          className="rounded border bg-background px-2 py-1 text-sm"
          disabled={workspacesQuery.isLoading || workspaces.length === 0}
        >
          {workspaces.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </select>
      </div>

      {workspacesQuery.isLoading ? (
        <p className="text-sm text-muted-foreground" data-testid="teams-workspaces-loading">
          Loading workspaces…
        </p>
      ) : null}

      {!workspacesQuery.isLoading && workspaces.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="teams-workspaces-empty">
          You do not belong to any workspaces yet.
        </p>
      ) : null}

      {workspaceId ? (
        <>
          {!canManage ? (
            <p
              className="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"
              data-testid="teams-readonly-notice"
            >
              You have read-only access to this workspace&apos;s integrations. A workspace admin can
              connect the Teams bot and generate its manifest.
            </p>
          ) : null}
          <TeamsCard workspaceId={workspaceId} canManage={canManage} />
        </>
      ) : null}
    </div>
  );
}

function TeamsCard({ workspaceId, canManage }: { workspaceId: string; canManage: boolean }) {
  const qc = useQueryClient();
  const key = ["integrations", "teams", workspaceId];

  const [appId, setAppId] = useState("");
  const [appPassword, setAppPassword] = useState("");
  const [appType, setAppType] = useState<TeamsAppType>("MultiTenant");
  const [tenantId, setTenantId] = useState("");
  const [label, setLabel] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const installation = useQuery({
    queryKey: key,
    queryFn: () => teamsIntegrationApi.getInstallation(workspaceId),
    enabled: Boolean(workspaceId),
  });

  function resetForm() {
    setAppId("");
    setAppPassword("");
    setAppType("MultiTenant");
    setTenantId("");
    setLabel("");
  }

  const installMut = useMutation({
    mutationFn: () =>
      teamsIntegrationApi.install(workspaceId, {
        appId: appId.trim(),
        appPassword,
        appType,
        tenantId: tenantId.trim() ? tenantId.trim() : null,
        label: label.trim() ? label.trim() : null,
      }),
    onSuccess: () => {
      setActionError(null);
      setNotice("Teams bot connected.");
      resetForm();
      void qc.invalidateQueries({ queryKey: key });
    },
    onError: (err: unknown) => {
      setNotice(null);
      setActionError(err instanceof Error ? err.message : "Failed to connect the Teams bot.");
    },
  });

  const uninstallMut = useMutation({
    mutationFn: () => teamsIntegrationApi.uninstall(workspaceId),
    onSuccess: () => {
      setActionError(null);
      setNotice("Teams bot disconnected.");
      void qc.invalidateQueries({ queryKey: key });
    },
    onError: (err: unknown) => {
      setNotice(null);
      setActionError(err instanceof Error ? err.message : "Failed to disconnect the Teams bot.");
    },
  });

  const summary = installation.data ?? null;
  const singleTenantMissing = appType === "SingleTenant" && !tenantId.trim();

  function submitInstall(e: React.FormEvent) {
    e.preventDefault();
    if (!appId.trim() || !appPassword || singleTenantMissing) return;
    installMut.mutate();
  }

  return (
    <Card className="space-y-4 p-4" data-testid="teams-card">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold">Teams bot</h2>
          <p className="text-xs text-muted-foreground">
            Register the Azure bot (App ID + password) for this workspace.
          </p>
        </div>
        {installation.isLoading ? (
          <span className="text-xs text-muted-foreground" data-testid="teams-status-loading">
            Checking…
          </span>
        ) : summary ? (
          <span
            className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800"
            data-testid="teams-status-connected"
          >
            Connected
          </span>
        ) : (
          <span
            className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground"
            data-testid="teams-status-disconnected"
          >
            Not connected
          </span>
        )}
      </div>

      {actionError ? (
        <p className="text-sm text-red-600" data-testid="teams-action-error">
          {actionError}
        </p>
      ) : null}
      {notice ? (
        <p className="text-sm text-emerald-700" data-testid="teams-notice">
          {notice}
        </p>
      ) : null}

      {summary ? (
        <div className="space-y-3" data-testid="teams-installed-view">
          <dl className="grid grid-cols-[max-content,1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-muted-foreground">App ID</dt>
            <dd className="font-mono text-xs">{summary.appId}</dd>
            <dt className="text-muted-foreground">App type</dt>
            <dd>{summary.appType}</dd>
            {summary.tenantId ? (
              <>
                <dt className="text-muted-foreground">Tenant ID</dt>
                <dd className="font-mono text-xs">{summary.tenantId}</dd>
              </>
            ) : null}
            {summary.label ? (
              <>
                <dt className="text-muted-foreground">Label</dt>
                <dd>{summary.label}</dd>
              </>
            ) : null}
            <dt className="text-muted-foreground">Status</dt>
            <dd>{summary.status}</dd>
          </dl>

          {canManage ? (
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="destructive"
                size="sm"
                data-testid="teams-uninstall"
                disabled={uninstallMut.isPending}
                onClick={() => uninstallMut.mutate()}
              >
                {uninstallMut.isPending ? "Disconnecting…" : "Disconnect"}
              </Button>
            </div>
          ) : null}

          <ManifestBuilder workspaceId={workspaceId} canManage={canManage} />
        </div>
      ) : canManage ? (
        <form className="space-y-3" onSubmit={submitInstall} data-testid="teams-install-form">
          <div className="space-y-1">
            <Label htmlFor="teams-app-id">Bot App ID</Label>
            <Input
              id="teams-app-id"
              data-testid="teams-app-id"
              value={appId}
              onChange={(e) => setAppId(e.target.value)}
              placeholder="00000000-0000-0000-0000-000000000000"
              autoComplete="off"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="teams-app-password">Bot App password</Label>
            <Input
              id="teams-app-password"
              data-testid="teams-app-password"
              type="password"
              value={appPassword}
              onChange={(e) => setAppPassword(e.target.value)}
              placeholder="Client secret (write-only)"
              autoComplete="new-password"
            />
            <p className="text-xs text-muted-foreground">
              Stored encrypted server-side. It is never displayed after saving.
            </p>
          </div>
          <div className="space-y-1">
            <Label htmlFor="teams-app-type">App type</Label>
            <select
              id="teams-app-type"
              data-testid="teams-app-type"
              value={appType}
              onChange={(e) => setAppType(e.target.value as TeamsAppType)}
              className="w-full rounded border bg-background px-2 py-1.5 text-sm"
            >
              {TEAMS_APP_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="teams-tenant-id">
              Tenant ID {appType === "SingleTenant" ? "(required)" : "(optional)"}
            </Label>
            <Input
              id="teams-tenant-id"
              data-testid="teams-tenant-id"
              value={tenantId}
              onChange={(e) => setTenantId(e.target.value)}
              placeholder="Azure AD tenant id"
              autoComplete="off"
            />
            {singleTenantMissing ? (
              <p className="text-xs text-red-600" data-testid="teams-tenant-required">
                A SingleTenant bot requires a tenant id.
              </p>
            ) : null}
          </div>
          <div className="space-y-1">
            <Label htmlFor="teams-label">Label (optional)</Label>
            <Input
              id="teams-label"
              data-testid="teams-label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. Production bot"
              autoComplete="off"
            />
          </div>
          <Button
            type="submit"
            size="sm"
            data-testid="teams-install-submit"
            disabled={installMut.isPending || !appId.trim() || !appPassword || singleTenantMissing}
          >
            {installMut.isPending ? "Connecting…" : "Connect Teams bot"}
          </Button>
        </form>
      ) : (
        <p className="text-sm text-muted-foreground" data-testid="teams-not-connected-readonly">
          Teams is not connected for this workspace.
        </p>
      )}
    </Card>
  );
}

function ManifestBuilder({ workspaceId, canManage }: { workspaceId: string; canManage: boolean }) {
  const [packageId, setPackageId] = useState("");
  const [publicHost, setPublicHost] = useState("");
  const [botName, setBotName] = useState("METIS");
  const [result, setResult] = useState<TeamsManifestResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const manifestMut = useMutation({
    mutationFn: () =>
      teamsIntegrationApi.getManifest(workspaceId, {
        packageId: packageId.trim(),
        publicHost: publicHost.trim(),
        botName: botName.trim() || undefined,
      }),
    onSuccess: (data) => {
      setError(null);
      setResult(data);
    },
    onError: (err: unknown) => {
      setResult(null);
      setError(err instanceof Error ? err.message : "Failed to build the manifest.");
    },
  });

  function downloadManifest() {
    if (!result) return;
    const blob = new Blob([JSON.stringify(result.manifest, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "manifest.json";
    a.click();
    URL.revokeObjectURL(url);
  }

  if (!canManage) return null;

  const canBuild = Boolean(packageId.trim() && publicHost.trim());

  return (
    <div
      className="space-y-3 rounded border border-dashed p-3"
      data-testid="teams-manifest-builder"
    >
      <div>
        <h3 className="text-sm font-semibold">Teams app manifest</h3>
        <p className="text-xs text-muted-foreground">
          Generate the <code>manifest.json</code> to upload to the Teams admin center, plus the
          messaging endpoint to register on the Azure bot.
        </p>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="teams-manifest-package">Package ID</Label>
          <Input
            id="teams-manifest-package"
            data-testid="teams-manifest-package"
            value={packageId}
            onChange={(e) => setPackageId(e.target.value)}
            placeholder="com.acme.metis"
            autoComplete="off"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="teams-manifest-host">Public host</Label>
          <Input
            id="teams-manifest-host"
            data-testid="teams-manifest-host"
            value={publicHost}
            onChange={(e) => setPublicHost(e.target.value)}
            placeholder="https://metis.example.com"
            autoComplete="off"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="teams-manifest-botname">Bot name</Label>
          <Input
            id="teams-manifest-botname"
            data-testid="teams-manifest-botname"
            value={botName}
            onChange={(e) => setBotName(e.target.value)}
            placeholder="METIS"
            autoComplete="off"
          />
        </div>
      </div>
      {error ? (
        <p className="text-sm text-red-600" data-testid="teams-manifest-error">
          {error}
        </p>
      ) : null}
      <Button
        type="button"
        size="sm"
        variant="outline"
        data-testid="teams-manifest-build"
        disabled={manifestMut.isPending || !canBuild}
        onClick={() => manifestMut.mutate()}
      >
        {manifestMut.isPending ? "Building…" : "Build manifest"}
      </Button>
      {result ? (
        <div className="space-y-2" data-testid="teams-manifest-result">
          <div className="space-y-1">
            <Label htmlFor="teams-manifest-endpoint">Messaging endpoint</Label>
            <Input
              id="teams-manifest-endpoint"
              data-testid="teams-manifest-endpoint"
              readOnly
              value={result.messagingEndpoint}
              className="font-mono text-xs"
            />
          </div>
          <Button
            type="button"
            size="sm"
            data-testid="teams-manifest-download"
            onClick={downloadManifest}
          >
            Download manifest.json
          </Button>
        </div>
      ) : null}
    </div>
  );
}
