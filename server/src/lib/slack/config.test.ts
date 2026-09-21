/**
 * Issue #579 — Slack app config parsing tests. Proves the fail-closed switch:
 * the Slack surface is enabled ONLY when a signing secret is present.
 */
import { describe, expect, it } from "vitest";

import { isSlackEnabled, isSlackOAuthConfigured, loadSlackConfig } from "./config.js";

describe("loadSlackConfig (#579)", () => {
  it("parses present credentials and defaults scopes", () => {
    const cfg = loadSlackConfig({
      SLACK_SIGNING_SECRET: "sigsecret",
      SLACK_CLIENT_ID: "123.456",
      SLACK_CLIENT_SECRET: "csecret",
      SLACK_STATE_SECRET: "statesecret",
    });
    expect(cfg.signingSecret).toBe("sigsecret");
    expect(cfg.clientId).toBe("123.456");
    expect(cfg.scopes).toContain("commands");
    expect(cfg.scopes).toContain("users:read.email");
  });

  it("treats blank/whitespace env vars as absent", () => {
    const cfg = loadSlackConfig({ SLACK_SIGNING_SECRET: "   ", SLACK_CLIENT_ID: "" });
    expect(cfg.signingSecret).toBeNull();
    expect(cfg.clientId).toBeNull();
  });

  it("parses a custom comma-separated scope list", () => {
    const cfg = loadSlackConfig({
      SLACK_SIGNING_SECRET: "s",
      SLACK_SCOPES: "commands, chat:write , app_mentions:read",
    });
    expect(cfg.scopes).toEqual(["commands", "chat:write", "app_mentions:read"]);
  });

  it("isSlackEnabled is true only when the signing secret is present (fail closed)", () => {
    expect(isSlackEnabled(loadSlackConfig({ SLACK_SIGNING_SECRET: "s" }))).toBe(true);
    expect(isSlackEnabled(loadSlackConfig({}))).toBe(false);
  });

  it("isSlackOAuthConfigured requires client id/secret + state secret", () => {
    expect(
      isSlackOAuthConfigured(
        loadSlackConfig({
          SLACK_SIGNING_SECRET: "s",
          SLACK_CLIENT_ID: "id",
          SLACK_CLIENT_SECRET: "sec",
          SLACK_STATE_SECRET: "state",
        }),
      ),
    ).toBe(true);
    expect(isSlackOAuthConfigured(loadSlackConfig({ SLACK_SIGNING_SECRET: "s" }))).toBe(false);
  });
});
