/**
 * Epic #547 — typed wrappers for the workspace-admin Microsoft Teams
 * integration surface.
 *
 * Backs the /settings/integrations/teams page. Wires exclusively to the
 * EXISTING admin backend at /api/integrations/teams/workspaces/:id/* (#548):
 *   • install      — register the bot app id + password (write-only secret)
 *   • installation — GET current status / DELETE to uninstall
 *   • manifest     — build the manifest.json a developer uploads to Teams
 *
 * SECURITY: the bot app password is strictly write-only. It is only ever SENT
 * to the server (encrypted server-side into the vault) and is deliberately
 * omitted from every response shape here so the UI can never render it.
 */
import { apiFetch } from "@/lib/api-client";

/** Bot identity types accepted from Azure. Mirrors `MicrosoftAppType`. */
export const TEAMS_APP_TYPES = ["MultiTenant", "SingleTenant", "UserAssignedMSID"] as const;
export type TeamsAppType = (typeof TEAMS_APP_TYPES)[number];

/** Secret-free view of a Teams installation (mirror of `InstallationSummary`). */
export interface TeamsInstallationSummary {
  id: string;
  workspaceId: string;
  appId: string;
  tenantId: string | null;
  appType: string;
  status: string;
  label: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TeamsInstallInput {
  appId: string;
  /** PLAINTEXT bot password — write-only, encrypted server-side, never returned. */
  appPassword: string;
  tenantId?: string | null;
  appType?: TeamsAppType;
  label?: string | null;
}

export interface TeamsManifestInput {
  /** Reverse-domain package id for the Teams app (e.g. com.acme.metis). */
  packageId: string;
  /** Publicly reachable host for the bot messaging endpoint. */
  publicHost: string;
  /** Display name for the bot. Defaults server-side to "METIS". */
  botName?: string;
}

export interface TeamsManifestResult {
  manifest: Record<string, unknown>;
  messagingEndpoint: string;
}

const teamsBase = (workspaceId: string) =>
  `/integrations/teams/workspaces/${encodeURIComponent(workspaceId)}`;

export const teamsIntegrationApi = {
  /**
   * Fetch the current installation summary, or `null` when Teams is not yet
   * installed for the workspace (the server 404s in that case).
   */
  getInstallation: async (workspaceId: string): Promise<TeamsInstallationSummary | null> => {
    try {
      return await apiFetch<TeamsInstallationSummary>(`${teamsBase(workspaceId)}/installation`);
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  },

  /** Register (or replace) the bot credentials for the workspace. */
  install: (workspaceId: string, input: TeamsInstallInput) =>
    apiFetch<TeamsInstallationSummary>(`${teamsBase(workspaceId)}/install`, {
      method: "POST",
      body: input,
    }),

  /** Remove the installation. */
  uninstall: (workspaceId: string) =>
    apiFetch<{ uninstalled: boolean }>(`${teamsBase(workspaceId)}/installation`, {
      method: "DELETE",
    }),

  /** Build the Teams manifest package metadata for the installed app. */
  getManifest: (workspaceId: string, input: TeamsManifestInput) =>
    apiFetch<TeamsManifestResult>(`${teamsBase(workspaceId)}/manifest`, {
      params: {
        packageId: input.packageId,
        publicHost: input.publicHost,
        ...(input.botName ? { botName: input.botName } : {}),
      },
    }),
};

function isNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "status" in err &&
    (err as { status: number }).status === 404
  );
}
