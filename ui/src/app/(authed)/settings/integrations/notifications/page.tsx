"use client";

/**
 * Issue #69 (epic #816 / #726) — Slack + PagerDuty notification integrations.
 *
 * Surfaces the Slack app install + PagerDuty routing-key config + event-routing
 * (alert-channel) view for a selected workspace. Wires exclusively to the
 * EXISTING admin backends:
 *   • Slack     — /api/integrations/slack/workspaces/:id/*   (#579)
 *   • PagerDuty — /api/integrations/pagerduty/workspaces/:id/* (#580)
 *   • Channels  — /api/workspaces/:id/finops/channels          (#51)
 *
 * SECURITY: the Slack bot token and the PagerDuty routing key are write-only.
 * They are typed out of every response shape (see notification-integrations-api)
 * and are never rendered — inputs are cleared on submit and use type="password".
 *
 * Workspace-admin gated: only workspace owners/admins (or system admins) see the
 * mutating controls; members get a read-only notice.
 */
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError } from "@/lib/api-client";
import { useAuth } from "@/lib/auth-context";
import {
  canManageIntegrations,
  listIntegrationWorkspaces,
  pagerDutyIntegrationApi,
  slackIntegrationApi,
  type PagerDutyServiceConfigSummary,
} from "@/lib/notification-integrations-api";
import { finopsApi, type AlertChannel, type AlertChannelType } from "@/lib/finops-api";
import {
  emailSuggestionMessage,
  isLikelyEmail,
  isHttpUrl,
  suggestEmail,
  webhookUrlSuggestionMessage,
} from "@/lib/error-suggestion";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const ACTIVE_WORKSPACE_STORAGE_KEY = "metis.activeWorkspaceId";

export default function NotificationIntegrationsPage() {
  const { user } = useAuth();
  const isSystemAdmin = user?.role === "admin";

  const workspacesQuery = useQuery({
    queryKey: ["integrations", "notifications", "workspaces"],
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
    <div className="space-y-6 p-2 md:p-0" data-testid="notification-integrations-page">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Notification integrations</h1>
        <p className="text-sm text-muted-foreground">
          Connect Slack and PagerDuty, then choose which alert events route to each channel. Secrets
          (bot tokens, routing keys) are stored server-side and never shown.
        </p>
      </header>

      <div className="flex items-center gap-2">
        <Label htmlFor="ni-workspace-select">Workspace</Label>
        <select
          id="ni-workspace-select"
          data-testid="ni-workspace-select"
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
        <p className="text-sm text-muted-foreground" data-testid="ni-workspaces-loading">
          Loading workspaces…
        </p>
      ) : null}

      {!workspacesQuery.isLoading && workspaces.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="ni-workspaces-empty">
          You do not belong to any workspaces yet.
        </p>
      ) : null}

      {workspaceId ? (
        <>
          {!canManage ? (
            <p
              className="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"
              data-testid="ni-readonly-notice"
            >
              You have read-only access to this workspace&apos;s integrations. A workspace admin can
              connect Slack, register PagerDuty services, and change event routing.
            </p>
          ) : null}
          <SlackCard workspaceId={workspaceId} canManage={canManage} />
          <PagerDutyCard workspaceId={workspaceId} canManage={canManage} />
          <EventRoutingCard workspaceId={workspaceId} canManage={canManage} />
        </>
      ) : null}
    </div>
  );
}

// ── Slack ──────────────────────────────────────────────────────────────────

function SlackCard({ workspaceId, canManage }: { workspaceId: string; canManage: boolean }) {
  const qc = useQueryClient();
  const key = ["integrations", "slack", workspaceId];
  const [teamId, setTeamId] = useState("");
  const [botToken, setBotToken] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const installation = useQuery({
    queryKey: key,
    queryFn: () => slackIntegrationApi.getInstallation(workspaceId),
    enabled: Boolean(workspaceId),
  });

  const authorize = useMutation({
    mutationFn: () => slackIntegrationApi.authorize(workspaceId),
    onSuccess: ({ url }) => {
      setActionError(null);
      window.location.assign(url);
    },
    onError: (err) => setActionError(errorMessage(err)),
  });

  const install = useMutation({
    mutationFn: () =>
      slackIntegrationApi.install(workspaceId, {
        slackTeamId: teamId.trim(),
        botToken: botToken.trim(),
      }),
    onSuccess: () => {
      setActionError(null);
      setNotice("Slack connected.");
      // Clear the write-only secret from memory as soon as it is submitted.
      setBotToken("");
      setTeamId("");
      void qc.invalidateQueries({ queryKey: key });
    },
    onError: (err) => setActionError(errorMessage(err)),
  });

  const uninstall = useMutation({
    mutationFn: () => slackIntegrationApi.uninstall(workspaceId),
    onSuccess: () => {
      setActionError(null);
      setNotice("Slack disconnected.");
      void qc.invalidateQueries({ queryKey: key });
    },
    onError: (err) => setActionError(errorMessage(err)),
  });

  const summary = installation.data ?? null;
  const connected = summary != null;

  return (
    <Card className="space-y-3 p-4" data-testid="slack-card">
      <header className="flex items-center justify-between">
        <div>
          <h2 className="font-semibold">Slack</h2>
          <p className="text-xs text-muted-foreground">
            Post analysis + budget alerts to Slack and run ChatOps commands.
          </p>
        </div>
        <ConnectionBadge connected={connected} testId="slack-status" />
      </header>

      {installation.isLoading ? (
        <p className="text-sm text-muted-foreground" data-testid="slack-loading">
          Loading…
        </p>
      ) : null}

      {installation.error ? (
        <p className="text-sm text-red-700" data-testid="slack-error">
          Failed to load Slack status: {errorMessage(installation.error)}
        </p>
      ) : null}

      {connected && summary ? (
        <dl className="text-sm" data-testid="slack-details">
          <div className="flex gap-2">
            <dt className="text-muted-foreground">Team:</dt>
            <dd className="font-medium">{summary.slackTeamName ?? summary.slackTeamId}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="text-muted-foreground">Status:</dt>
            <dd className="font-medium">{summary.status}</dd>
          </div>
        </dl>
      ) : null}

      {actionError ? (
        <p className="text-sm text-red-700" data-testid="slack-action-error">
          {actionError}
        </p>
      ) : null}
      {notice ? (
        <p className="text-sm text-green-700" data-testid="slack-notice">
          {notice}
        </p>
      ) : null}

      {canManage ? (
        connected ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => uninstall.mutate()}
            disabled={uninstall.isPending}
            data-testid="slack-disconnect"
          >
            {uninstall.isPending ? "Disconnecting…" : "Disconnect"}
          </Button>
        ) : (
          <div className="space-y-3">
            <Button
              size="sm"
              onClick={() => authorize.mutate()}
              disabled={authorize.isPending}
              data-testid="slack-connect"
            >
              {authorize.isPending ? "Redirecting…" : "Connect with Slack"}
            </Button>
            <details data-testid="slack-manual">
              <summary className="cursor-pointer text-xs text-muted-foreground">
                Advanced: install with a bot token
              </summary>
              <div className="mt-2 space-y-2">
                <div>
                  <Label htmlFor="slack-team-id">Slack team ID</Label>
                  <Input
                    id="slack-team-id"
                    data-testid="slack-team-id"
                    value={teamId}
                    onChange={(e) => setTeamId(e.target.value)}
                    placeholder="T01234567"
                  />
                </div>
                <div>
                  <Label htmlFor="slack-bot-token">Bot token (write-only)</Label>
                  <Input
                    id="slack-bot-token"
                    data-testid="slack-bot-token"
                    type="password"
                    value={botToken}
                    onChange={(e) => setBotToken(e.target.value)}
                    placeholder="xoxb-…"
                    autoComplete="off"
                  />
                </div>
                <Button
                  size="sm"
                  onClick={() => install.mutate()}
                  disabled={install.isPending || !teamId.trim() || !botToken.trim()}
                  data-testid="slack-install-submit"
                >
                  {install.isPending ? "Installing…" : "Install"}
                </Button>
              </div>
            </details>
          </div>
        )
      ) : null}
    </Card>
  );
}

// ── PagerDuty ────────────────────────────────────────────────────────────────

function PagerDutyCard({ workspaceId, canManage }: { workspaceId: string; canManage: boolean }) {
  const qc = useQueryClient();
  const key = ["integrations", "pagerduty", workspaceId];
  const [serviceKey, setServiceKey] = useState("");
  const [routingKey, setRoutingKey] = useState("");
  const [label, setLabel] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);

  const configs = useQuery({
    queryKey: key,
    queryFn: () => pagerDutyIntegrationApi.listServiceConfigs(workspaceId),
    enabled: Boolean(workspaceId),
  });

  const register = useMutation({
    mutationFn: () =>
      pagerDutyIntegrationApi.registerServiceConfig(workspaceId, {
        serviceKey: serviceKey.trim() || undefined,
        routingKey: routingKey.trim(),
        label: label.trim() || null,
      }),
    onSuccess: () => {
      setActionError(null);
      // Clear the write-only routing key from memory once submitted.
      setRoutingKey("");
      setServiceKey("");
      setLabel("");
      void qc.invalidateQueries({ queryKey: key });
    },
    onError: (err) => setActionError(errorMessage(err)),
  });

  const remove = useMutation({
    mutationFn: (svc: string) => pagerDutyIntegrationApi.deleteServiceConfig(workspaceId, svc),
    onSuccess: () => {
      setActionError(null);
      void qc.invalidateQueries({ queryKey: key });
    },
    onError: (err) => setActionError(errorMessage(err)),
  });

  const list: PagerDutyServiceConfigSummary[] = configs.data ?? [];

  return (
    <Card className="space-y-3 p-4" data-testid="pagerduty-card">
      <header className="flex items-center justify-between">
        <div>
          <h2 className="font-semibold">PagerDuty</h2>
          <p className="text-xs text-muted-foreground">
            Register per-service routing keys for sev-1 incident alerting.
          </p>
        </div>
        <ConnectionBadge connected={list.length > 0} testId="pagerduty-status" />
      </header>

      {configs.isLoading ? (
        <p className="text-sm text-muted-foreground" data-testid="pagerduty-loading">
          Loading…
        </p>
      ) : null}

      {configs.error ? (
        <p className="text-sm text-red-700" data-testid="pagerduty-error">
          Failed to load PagerDuty configs: {errorMessage(configs.error)}
        </p>
      ) : null}

      {!configs.isLoading && !configs.error && list.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="pagerduty-empty">
          No PagerDuty services registered yet.
        </p>
      ) : null}

      {list.length > 0 ? (
        <ul className="space-y-1" data-testid="pagerduty-list">
          {list.map((cfg) => (
            <li
              key={cfg.id}
              data-testid={`pagerduty-config-${cfg.serviceKey}`}
              className="flex items-center justify-between rounded border px-2 py-1 text-sm"
            >
              <span>
                <span className="font-medium">{cfg.serviceKey}</span>
                {cfg.label ? (
                  <span className="text-muted-foreground"> · {cfg.label}</span>
                ) : null}{" "}
                <span className="text-xs text-muted-foreground">({cfg.status})</span>
              </span>
              {canManage ? (
                <button
                  onClick={() => remove.mutate(cfg.serviceKey)}
                  disabled={remove.isPending}
                  className="rounded px-2 py-0.5 text-xs text-red-600 hover:bg-red-50 disabled:opacity-50"
                  aria-label={`Delete PagerDuty service ${cfg.serviceKey}`}
                  data-testid={`pagerduty-delete-${cfg.serviceKey}`}
                >
                  Delete
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {actionError ? (
        <p className="text-sm text-red-700" data-testid="pagerduty-action-error">
          {actionError}
        </p>
      ) : null}

      {canManage ? (
        <div className="space-y-2 border-t pt-3" data-testid="pagerduty-register">
          <div>
            <Label htmlFor="pd-service-key">Service name (optional)</Label>
            <Input
              id="pd-service-key"
              data-testid="pagerduty-service-key"
              value={serviceKey}
              onChange={(e) => setServiceKey(e.target.value)}
              placeholder="default"
            />
          </div>
          <div>
            <Label htmlFor="pd-routing-key">Routing key (write-only)</Label>
            <Input
              id="pd-routing-key"
              data-testid="pagerduty-routing-key"
              type="password"
              value={routingKey}
              onChange={(e) => setRoutingKey(e.target.value)}
              placeholder="R0ABCDEF…"
              autoComplete="off"
            />
          </div>
          <div>
            <Label htmlFor="pd-label">Label (optional)</Label>
            <Input
              id="pd-label"
              data-testid="pagerduty-label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Prod on-call"
            />
          </div>
          <Button
            size="sm"
            onClick={() => register.mutate()}
            disabled={register.isPending || !routingKey.trim()}
            data-testid="pagerduty-register-submit"
          >
            {register.isPending ? "Registering…" : "Register service"}
          </Button>
        </div>
      ) : null}
    </Card>
  );
}

// ── Event routing (alert channels, #51) ──────────────────────────────────────

const CHANNEL_TYPES: AlertChannelType[] = ["email", "webhook", "slack", "pagerduty"];

function EventRoutingCard({ workspaceId, canManage }: { workspaceId: string; canManage: boolean }) {
  const qc = useQueryClient();
  const key = ["integrations", "channels", workspaceId];
  const [type, setType] = useState<AlertChannelType>("slack");
  const [target, setTarget] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);

  const channels = useQuery({
    queryKey: key,
    queryFn: () => finopsApi.getChannels(workspaceId),
    enabled: Boolean(workspaceId),
  });

  const add = useMutation({
    mutationFn: () =>
      finopsApi.createChannel(workspaceId, {
        type,
        target: target.trim(),
      }),
    onSuccess: () => {
      setActionError(null);
      setTarget("");
      void qc.invalidateQueries({ queryKey: key });
    },
    onError: (err) => setActionError(errorMessage(err)),
  });

  const remove = useMutation({
    mutationFn: (channelId: string) => finopsApi.deleteChannel(workspaceId, channelId),
    onSuccess: () => {
      setActionError(null);
      void qc.invalidateQueries({ queryKey: key });
    },
    onError: (err) => setActionError(errorMessage(err)),
  });

  const list: AlertChannel[] = channels.data?.channels ?? [];

  // SC 3.3.3 — advisory only. When a well-formed email's domain looks like a
  // typo of a common provider, offer a "did you mean…" hint WITHOUT blocking
  // submission (mail.com / ymail.com etc. are legitimate and must still submit).
  const emailValue = target.trim();
  const emailTypoSuggestion =
    type === "email" && isLikelyEmail(emailValue) ? suggestEmail(emailValue) : null;

  // SC 3.3.3 — for the target formats whose cause is client-detectable (email,
  // webhook URL) validate before the network call and suggest a correction.
  // Slack channel ids and PagerDuty service names have no derivable good form,
  // so they defer to the server as before.
  function handleAdd() {
    setValidationError(null);
    const value = target.trim();
    // Block ONLY a genuinely malformed address. A well-formed address whose
    // domain merely resembles a common provider (e.g. mail.com, ymail.com) is
    // valid and must never be blocked — the typo "did you mean…" hint below is
    // advisory only (SC 3.3.3 suggests, it does not override the user).
    if (type === "email" && !isLikelyEmail(value)) {
      setValidationError(emailSuggestionMessage(value));
      return;
    }
    if (type === "webhook" && !isHttpUrl(value)) {
      setValidationError(webhookUrlSuggestionMessage(value));
      return;
    }
    add.mutate();
  }

  return (
    <Card className="space-y-3 p-4" data-testid="event-routing-card">
      <header>
        <h2 className="font-semibold">Event routing</h2>
        <p className="text-xs text-muted-foreground">
          Choose which alert events route to which channel. Alert rules deliver to every enabled
          channel below.
        </p>
      </header>

      {channels.isLoading ? (
        <p className="text-sm text-muted-foreground" data-testid="routing-loading">
          Loading channels…
        </p>
      ) : null}

      {channels.error ? (
        <p className="text-sm text-red-700" data-testid="routing-error">
          Failed to load channels: {errorMessage(channels.error)}
        </p>
      ) : null}

      {!channels.isLoading && !channels.error && list.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="routing-empty">
          No channels configured. Alert events are not being routed anywhere yet.
        </p>
      ) : null}

      {list.length > 0 ? (
        <ul className="space-y-1" data-testid="routing-list">
          {list.map((ch) => (
            <li
              key={ch.id}
              data-testid={`routing-channel-${ch.id}`}
              className="flex items-center justify-between rounded border px-2 py-1 text-sm"
            >
              <span>
                <span className="rounded bg-muted px-2 py-0.5 text-xs font-medium uppercase">
                  {ch.type}
                </span>{" "}
                {ch.target ? <span className="font-mono text-xs">{ch.target}</span> : null}
                {!ch.enabled ? (
                  <span className="ml-2 text-xs text-muted-foreground">(disabled)</span>
                ) : null}
              </span>
              {canManage ? (
                <button
                  onClick={() => remove.mutate(ch.id)}
                  disabled={remove.isPending}
                  className="rounded px-2 py-0.5 text-xs text-red-600 hover:bg-red-50 disabled:opacity-50"
                  aria-label={`Remove ${ch.type} channel`}
                  data-testid={`routing-delete-${ch.id}`}
                >
                  Remove
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {actionError ? (
        <p className="text-sm text-red-700" data-testid="routing-action-error">
          {actionError}
        </p>
      ) : null}

      {canManage ? (
        <div className="flex flex-wrap items-end gap-2 border-t pt-3" data-testid="routing-add">
          <div>
            <Label htmlFor="routing-type">Channel</Label>
            <select
              id="routing-type"
              data-testid="routing-type"
              value={type}
              onChange={(e) => {
                setType(e.target.value as AlertChannelType);
                setValidationError(null);
              }}
              className="rounded border bg-background px-2 py-1 text-sm"
            >
              {CHANNEL_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>
          <div className="flex-1">
            <Label htmlFor="routing-target">
              {type === "slack"
                ? "Slack channel id"
                : type === "email"
                  ? "Email address"
                  : type === "webhook"
                    ? "Webhook URL"
                    : "Service name (optional)"}
            </Label>
            <Input
              id="routing-target"
              data-testid="routing-target"
              value={target}
              onChange={(e) => {
                setTarget(e.target.value);
                setValidationError(null);
              }}
              placeholder={type === "slack" ? "C01234567" : ""}
              aria-invalid={validationError ? true : undefined}
              aria-describedby={validationError ? "routing-target-error" : undefined}
            />
            {validationError ? (
              <p
                id="routing-target-error"
                role="alert"
                className="mt-1 text-xs text-red-700"
                data-testid="routing-target-error"
              >
                {validationError}
              </p>
            ) : emailTypoSuggestion ? (
              <p
                role="status"
                className="mt-1 text-xs text-amber-600"
                data-testid="routing-target-hint"
              >
                Did you mean “{emailTypoSuggestion}”? You can still add the address as entered.
              </p>
            ) : null}
          </div>
          <Button
            size="sm"
            onClick={handleAdd}
            disabled={add.isPending || (type !== "pagerduty" && !target.trim())}
            data-testid="routing-add-submit"
          >
            {add.isPending ? "Adding…" : "Add channel"}
          </Button>
        </div>
      ) : null}
    </Card>
  );
}

// ── helpers ──────────────────────────────────────────────────────────────────

function ConnectionBadge({ connected, testId }: { connected: boolean; testId: string }) {
  return (
    <span
      data-testid={testId}
      className={`rounded px-2 py-1 text-xs font-medium ${
        connected ? "bg-green-100 text-green-900" : "bg-muted text-muted-foreground"
      }`}
    >
      {connected ? "Connected" : "Not connected"}
    </span>
  );
}

function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}
