/**
 * Issue #69 (epic #816 / #726) — typed wrappers for the Slack + PagerDuty
 * workspace-admin integration surfaces.
 *
 * Backs the /settings/integrations/notifications page:
 *   • Slack   — install status, OAuth authorize kickoff, direct install, uninstall.
 *   • PagerDuty — per-service routing-key config register / list / delete.
 *
 * SECURITY: secrets are strictly write-only. The Slack bot token and the
 * PagerDuty routing key are only ever SENT to the server (never returned), and
 * these types deliberately omit them from every response shape so the UI can
 * never render them.
 */
import { apiFetch } from "@/lib/api-client";

// ── Slack ──────────────────────────────────────────────────────────────────

/** Secret-free view of a Slack installation (mirror of `SlackInstallationSummary`). */
export interface SlackInstallationSummary {
  id: string;
  workspaceId: string;
  slackTeamId: string;
  slackTeamName: string | null;
  botUserId: string | null;
  status: string;
  label: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SlackDirectInstallInput {
  slackTeamId: string;
  /** PLAINTEXT bot token — write-only, encrypted server-side, never returned. */
  botToken: string;
  slackTeamName?: string | null;
  botUserId?: string | null;
  label?: string | null;
}

const slackBase = (workspaceId: string) =>
  `/integrations/slack/workspaces/${encodeURIComponent(workspaceId)}`;

export const slackIntegrationApi = {
  /**
   * Fetch the current installation summary, or `null` when Slack is not yet
   * installed for the workspace (the server 404s in that case).
   */
  getInstallation: async (workspaceId: string): Promise<SlackInstallationSummary | null> => {
    try {
      return await apiFetch<SlackInstallationSummary>(`${slackBase(workspaceId)}/installation`);
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  },

  /** Begin the OAuth install; returns the Slack authorize URL to redirect to. */
  authorize: (workspaceId: string) =>
    apiFetch<{ url: string }>(`${slackBase(workspaceId)}/authorize`),

  /** Direct (non-OAuth) token registration. */
  install: (workspaceId: string, input: SlackDirectInstallInput) =>
    apiFetch<SlackInstallationSummary>(`${slackBase(workspaceId)}/install`, {
      method: "POST",
      body: input,
    }),

  /** Revoke + remove the installation. */
  uninstall: (workspaceId: string) =>
    apiFetch<{ deleted: boolean }>(`${slackBase(workspaceId)}/installation`, {
      method: "DELETE",
    }),
};

// ── PagerDuty ────────────────────────────────────────────────────────────────

/** Secret-free view of a PagerDuty service config (mirror of `ServiceConfigSummary`). */
export interface PagerDutyServiceConfigSummary {
  id: string;
  workspaceId: string;
  serviceKey: string;
  label: string | null;
  status: string;
  createdById: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PagerDutyRegisterInput {
  /** Free-form logical service name. Defaults server-side to "default". */
  serviceKey?: string;
  /** PLAINTEXT routing (integration) key — write-only, encrypted server-side. */
  routingKey: string;
  label?: string | null;
}

const pagerDutyBase = (workspaceId: string) =>
  `/integrations/pagerduty/workspaces/${encodeURIComponent(workspaceId)}`;

export const pagerDutyIntegrationApi = {
  listServiceConfigs: (workspaceId: string) =>
    apiFetch<PagerDutyServiceConfigSummary[]>(`${pagerDutyBase(workspaceId)}/service-configs`),

  registerServiceConfig: (workspaceId: string, input: PagerDutyRegisterInput) =>
    apiFetch<PagerDutyServiceConfigSummary>(`${pagerDutyBase(workspaceId)}/service-configs`, {
      method: "POST",
      body: input,
    }),

  deleteServiceConfig: (workspaceId: string, serviceKey: string) =>
    apiFetch<{ deleted: boolean }>(
      `${pagerDutyBase(workspaceId)}/service-configs/${encodeURIComponent(serviceKey)}`,
      { method: "DELETE" },
    ),
};

// ── Workspaces (for the selector) ─────────────────────────────────────────────

export interface IntegrationWorkspace {
  id: string;
  name: string;
  slug: string;
  /** The requesting user's role in this workspace: owner | admin | member. */
  role: string;
}

/**
 * List the workspaces the current user belongs to (with their per-workspace
 * role). Used to drive the workspace selector + admin-gating on the
 * notification-integrations page.
 */
export function listIntegrationWorkspaces(): Promise<IntegrationWorkspace[]> {
  return apiFetch<IntegrationWorkspace[]>("/workspaces");
}

/**
 * True when the given workspace role can manage integrations. Workspace admins
 * and owners qualify. System admins are handled separately (they bypass
 * workspace RBAC on the server), so callers OR this with a system-admin check.
 */
export function canManageIntegrations(role: string | undefined): boolean {
  return role === "admin" || role === "owner";
}

function isNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "status" in err &&
    (err as { status: number }).status === 404
  );
}
