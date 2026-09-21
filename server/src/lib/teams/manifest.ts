/**
 * Epic #547 (Phase 0, #548) — Teams app manifest scaffolding.
 *
 * Builds the `manifest.json` a developer uploads to Teams (or packages into a
 * `.zip` app package) to register the METIS bot. The manifest is deterministic
 * given the bot's app id + the public messaging-endpoint host, so it can be
 * generated and unit-tested without any Azure call.
 *
 * The real Azure-side steps (app registration, secret creation, messaging
 * endpoint wiring, Teams channel enablement) are documented in
 * `docs/integrations/teams.md` — they cannot be scripted from inside METIS.
 */

/** Teams manifest schema version this scaffolding targets. */
export const TEAMS_MANIFEST_VERSION = "1.17";
export const TEAMS_MANIFEST_SCHEMA =
  "https://developer.microsoft.com/en-us/json-schemas/teams/v1.17/MicrosoftTeams.schema.json";

export interface ManifestInput {
  /** Azure AD application (client) id of the bot — the `MicrosoftAppId`. */
  appId: string;
  /** Stable GUID for the Teams app package (distinct from the bot app id). */
  packageId: string;
  botName: string;
  /** Public https origin serving the bot endpoint, e.g. https://metis.example.com */
  publicHost: string;
  developerName?: string;
  websiteUrl?: string;
  privacyUrl?: string;
  termsUrl?: string;
}

export interface TeamsManifest {
  $schema: string;
  manifestVersion: string;
  version: string;
  id: string;
  developer: {
    name: string;
    websiteUrl: string;
    privacyUrl: string;
    termsOfUseUrl: string;
  };
  name: { short: string; full: string };
  description: { short: string; full: string };
  icons: { color: string; outline: string };
  accentColor: string;
  bots: Array<{
    botId: string;
    scopes: string[];
    supportsFiles: boolean;
    isNotificationOnly: boolean;
  }>;
  permissions: string[];
  validDomains: string[];
}

/**
 * Build a minimal-but-valid Teams manifest for the METIS bot. `scopes` covers
 * the three surfaces the shared foundation must support (team channels, group
 * chats, and 1:1) so #63/#67 and the bridge can all reuse this registration.
 */
export function buildTeamsManifest(input: ManifestInput): TeamsManifest {
  const host = normalizeHost(input.publicHost);
  const domain = hostDomain(host);
  return {
    $schema: TEAMS_MANIFEST_SCHEMA,
    manifestVersion: TEAMS_MANIFEST_VERSION,
    version: "1.0.0",
    id: input.packageId,
    developer: {
      name: input.developerName ?? "METIS",
      websiteUrl: input.websiteUrl ?? host,
      privacyUrl: input.privacyUrl ?? `${host}/privacy`,
      termsOfUseUrl: input.termsUrl ?? `${host}/terms`,
    },
    name: { short: input.botName, full: `${input.botName} for Microsoft Teams` },
    description: {
      short: "Collaborate on METIS discussions from Teams.",
      full: "Bridges METIS project discussions into Microsoft Teams channels with two-way sync, an AI participant, and promote-to-requirement.",
    },
    icons: { color: "color.png", outline: "outline.png" },
    accentColor: "#2A6FDB",
    bots: [
      {
        botId: input.appId,
        scopes: ["team", "groupChat", "personal"],
        supportsFiles: false,
        isNotificationOnly: false,
      },
    ],
    permissions: ["identity", "messageTeamMembers"],
    validDomains: [domain],
  };
}

/** The messaging endpoint URL Azure must be pointed at for a given host. */
export function botMessagingEndpoint(publicHost: string): string {
  return `${normalizeHost(publicHost)}/api/integrations/teams/messages`;
}

function normalizeHost(host: string): string {
  return host.replace(/\/+$/, "");
}

function hostDomain(host: string): string {
  try {
    return new URL(host).host;
  } catch {
    // Already a bare host (no scheme).
    return host.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  }
}
