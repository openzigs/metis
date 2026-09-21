/**
 * Epic #547 (Phase 0, #548) — Teams manifest scaffolding tests.
 *
 * The manifest is deterministic given the bot app id + public host, so it is
 * fully unit-testable without any Azure call.
 */
import { describe, expect, it } from "vitest";

import { buildTeamsManifest, botMessagingEndpoint, TEAMS_MANIFEST_VERSION } from "./manifest.js";

describe("buildTeamsManifest (#548)", () => {
  const base = {
    appId: "11111111-2222-3333-4444-555555555555",
    packageId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    botName: "METIS",
    publicHost: "https://metis.example.com",
  };

  it("targets the documented manifest version and wires the bot app id", () => {
    const m = buildTeamsManifest(base);
    expect(m.manifestVersion).toBe(TEAMS_MANIFEST_VERSION);
    expect(m.id).toBe(base.packageId);
    expect(m.bots).toHaveLength(1);
    expect(m.bots[0].botId).toBe(base.appId);
  });

  it("supports team, groupChat and personal scopes (shared base for #63/#67/bridge)", () => {
    const m = buildTeamsManifest(base);
    expect(m.bots[0].scopes).toEqual(["team", "groupChat", "personal"]);
    expect(m.bots[0].isNotificationOnly).toBe(false);
  });

  it("derives validDomains from the public host", () => {
    const m = buildTeamsManifest(base);
    expect(m.validDomains).toEqual(["metis.example.com"]);
  });

  it("strips a trailing slash from the public host in derived URLs", () => {
    const m = buildTeamsManifest({ ...base, publicHost: "https://metis.example.com/" });
    expect(m.developer.privacyUrl).toBe("https://metis.example.com/privacy");
  });

  it("computes the bot messaging endpoint path", () => {
    expect(botMessagingEndpoint("https://metis.example.com")).toBe(
      "https://metis.example.com/api/integrations/teams/messages",
    );
    expect(botMessagingEndpoint("https://metis.example.com/")).toBe(
      "https://metis.example.com/api/integrations/teams/messages",
    );
  });
});
