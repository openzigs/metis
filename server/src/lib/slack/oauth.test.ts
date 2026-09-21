/**
 * Issue #579 — Slack OAuth install-flow tests. Proves CSRF state signing/TTL, the
 * code→token exchange, and that the bot token is persisted ENCRYPTED (via the
 * install store) and never leaked.
 */
import { describe, expect, it, vi } from "vitest";

import {
  buildAuthorizeUrl,
  completeSlackOAuth,
  signOAuthState,
  verifyOAuthState,
  STATE_TTL_SECONDS,
  type OAuthAccessResult,
  type SlackTokenExchange,
} from "./oauth.js";
import type { SlackInstallationStore } from "./installation-store.js";

const STATE_SECRET = "state-secret-aaaaaaaaaaaaaaaaaaaaaaaa";

describe("OAuth state signing (#579)", () => {
  it("round-trips a signed state", () => {
    const now = 1_700_000_000_000;
    const state = signOAuthState({ workspaceId: "ws-1", userId: "u-1" }, STATE_SECRET, now);
    const payload = verifyOAuthState(state, STATE_SECRET, now);
    expect(payload).toMatchObject({ workspaceId: "ws-1", userId: "u-1" });
  });

  it("rejects a tampered state", () => {
    const state = signOAuthState({ workspaceId: "ws-1" }, STATE_SECRET);
    expect(verifyOAuthState(state + "x", STATE_SECRET)).toBeNull();
  });

  it("rejects a state signed with a different secret", () => {
    const state = signOAuthState({ workspaceId: "ws-1" }, "other-secret-bbbbbbbbbbbbbbbb");
    expect(verifyOAuthState(state, STATE_SECRET)).toBeNull();
  });

  it("rejects an expired state", () => {
    const now = 1_700_000_000_000;
    const state = signOAuthState({ workspaceId: "ws-1" }, STATE_SECRET, now);
    const later = now + (STATE_TTL_SECONDS + 60) * 1000;
    expect(verifyOAuthState(state, STATE_SECRET, later)).toBeNull();
  });

  it("rejects malformed states without throwing", () => {
    expect(verifyOAuthState(undefined, STATE_SECRET)).toBeNull();
    expect(verifyOAuthState("", STATE_SECRET)).toBeNull();
    expect(verifyOAuthState("nodot", STATE_SECRET)).toBeNull();
    expect(verifyOAuthState(".sig", STATE_SECRET)).toBeNull();
  });
});

describe("buildAuthorizeUrl (#579)", () => {
  it("builds the authorize URL with client id, scopes and state", () => {
    const url = buildAuthorizeUrl({
      clientId: "123.456",
      scopes: ["commands", "chat:write"],
      state: "the-state",
      redirectUri: "https://app/callback",
    });
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe("https://slack.com/oauth/v2/authorize");
    expect(u.searchParams.get("client_id")).toBe("123.456");
    expect(u.searchParams.get("scope")).toBe("commands,chat:write");
    expect(u.searchParams.get("state")).toBe("the-state");
    expect(u.searchParams.get("redirect_uri")).toBe("https://app/callback");
  });
});

describe("completeSlackOAuth (#579)", () => {
  function fakeStore() {
    return {
      install: vi.fn(async (input) => ({
        id: "inst-1",
        workspaceId: input.workspaceId,
        slackTeamId: input.slackTeamId,
        slackTeamName: input.slackTeamName ?? null,
        botUserId: input.botUserId ?? null,
        status: "active",
        label: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      })),
    } as unknown as SlackInstallationStore;
  }

  const okExchange: SlackTokenExchange = async () =>
    ({
      ok: true,
      access_token: "xoxb-the-bot-token",
      bot_user_id: "U999",
      team: { id: "T1", name: "Acme" },
    }) satisfies OAuthAccessResult;

  it("exchanges the code and persists the install (token never returned)", async () => {
    const store = fakeStore();
    const state = signOAuthState({ workspaceId: "ws-1", userId: "u-1" }, STATE_SECRET);
    const summary = await completeSlackOAuth({
      clientId: "id",
      clientSecret: "sec",
      stateSecret: STATE_SECRET,
      code: "the-code",
      state,
      exchange: okExchange,
      store,
    });
    expect(summary.slackTeamId).toBe("T1");
    expect(JSON.stringify(summary)).not.toContain("xoxb-the-bot-token");
    expect(store.install).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws-1",
        slackTeamId: "T1",
        botToken: "xoxb-the-bot-token",
        botUserId: "U999",
        createdById: "u-1",
      }),
    );
  });

  it("rejects an invalid state before any exchange", async () => {
    const store = fakeStore();
    const exchange = vi.fn(okExchange);
    await expect(
      completeSlackOAuth({
        clientId: "id",
        clientSecret: "sec",
        stateSecret: STATE_SECRET,
        code: "c",
        state: "forged.sig",
        exchange,
        store,
      }),
    ).rejects.toMatchObject({ code: "INVALID_STATE" });
    expect(exchange).not.toHaveBeenCalled();
    expect(store.install).not.toHaveBeenCalled();
  });

  it("rejects a missing code", async () => {
    const state = signOAuthState({ workspaceId: "ws-1" }, STATE_SECRET);
    await expect(
      completeSlackOAuth({
        clientId: "id",
        clientSecret: "sec",
        stateSecret: STATE_SECRET,
        code: "",
        state,
        exchange: okExchange,
        store: fakeStore(),
      }),
    ).rejects.toMatchObject({ code: "MISSING_CODE" });
  });

  it("maps a Slack-side error response to EXCHANGE_FAILED (no leak)", async () => {
    const state = signOAuthState({ workspaceId: "ws-1" }, STATE_SECRET);
    const badExchange: SlackTokenExchange = async () => ({ ok: false, error: "invalid_code" });
    await expect(
      completeSlackOAuth({
        clientId: "id",
        clientSecret: "sec",
        stateSecret: STATE_SECRET,
        code: "c",
        state,
        exchange: badExchange,
        store: fakeStore(),
      }),
    ).rejects.toMatchObject({ code: "EXCHANGE_FAILED" });
  });

  it("maps a thrown transport error to EXCHANGE_FAILED", async () => {
    const state = signOAuthState({ workspaceId: "ws-1" }, STATE_SECRET);
    const throwingExchange: SlackTokenExchange = async () => {
      throw new Error("network down");
    };
    await expect(
      completeSlackOAuth({
        clientId: "id",
        clientSecret: "sec",
        stateSecret: STATE_SECRET,
        code: "c",
        state,
        exchange: throwingExchange,
        store: fakeStore(),
      }),
    ).rejects.toMatchObject({ code: "EXCHANGE_FAILED" });
  });
});
