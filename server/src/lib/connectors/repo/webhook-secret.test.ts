/** #1475 — per-connector webhook secret derivation and its check. */
import { describe, expect, it } from "vitest";
import {
  connectorIssuesWebhookPath,
  connectorSecretState,
  connectorWebhookPath,
  connectorWebhookSecret,
  newWebhookSecretNonce,
  webhookSecretCheck,
  webhookSecretRootKey,
} from "./webhook-secret.js";

const KEY_A = Buffer.alloc(32, 1).toString("base64");
const KEY_B = Buffer.alloc(32, 2).toString("base64");
const rootA = webhookSecretRootKey({ VAULT_MASTER_KEY: KEY_A })!;
const rootB = webhookSecretRootKey({ VAULT_MASTER_KEY: KEY_B })!;

describe("webhookSecretRootKey", () => {
  it("is null without a vault master key, so no secret can be issued or matched", () => {
    expect(webhookSecretRootKey({})).toBeNull();
    expect(webhookSecretRootKey({ VAULT_MASTER_KEY: "   " })).toBeNull();
  });

  it("is stable for one master key, differs between keys, and separates secret from check", () => {
    const again = webhookSecretRootKey({ VAULT_MASTER_KEY: KEY_A })!;
    expect(rootA.secret.equals(again.secret)).toBe(true);
    expect(rootA.secret.equals(rootB.secret)).toBe(false);
    expect(rootA.secret.equals(rootA.check)).toBe(false);
    expect(rootA.secret.equals(Buffer.from(KEY_A, "base64"))).toBe(false);
  });
});

describe("connectorWebhookSecret", () => {
  it("is deterministic for one connector and nonce", () => {
    expect(connectorWebhookSecret(rootA, "c1", "n")).toBe(connectorWebhookSecret(rootA, "c1", "n"));
  });

  it("is bound to the connector id and to the nonce", () => {
    const base = connectorWebhookSecret(rootA, "c1", "n");
    expect(connectorWebhookSecret(rootA, "c2", "n")).not.toBe(base);
    expect(connectorWebhookSecret(rootA, "c1", "m")).not.toBe(base);
    // The separator keeps (id, nonce) pairs from colliding by concatenation.
    expect(connectorWebhookSecret(rootA, "c1n", "")).not.toBe(base);
  });

  it("is not its own check", () => {
    expect(connectorWebhookSecret(rootA, "c1", "n").slice(0, 16)).not.toBe(
      webhookSecretCheck(rootA, "c1", "n"),
    );
  });
});

describe("connectorSecretState", () => {
  const row = (over: Record<string, string | null> = {}) => ({
    id: "c1",
    webhookSecretNonce: "n",
    webhookSecretCheck: webhookSecretCheck(rootA, "c1", "n"),
    ...over,
  });

  it("is none without a nonce", () => {
    expect(connectorSecretState(row({ webhookSecretNonce: null }), rootA)).toBe("none");
  });

  it("is active when the check matches this server's key and the connector's id", () => {
    expect(connectorSecretState(row(), rootA)).toBe("active");
  });

  it("is stale after a master key rotation", () => {
    expect(connectorSecretState(row(), rootB)).toBe("stale");
  });

  it("is stale when the connector came back under another id (portability import)", () => {
    expect(connectorSecretState(row({ id: "c-imported" }), rootA)).toBe("stale");
  });

  it("is stale without a master key, or without a stored check", () => {
    expect(connectorSecretState(row(), null)).toBe("stale");
    expect(connectorSecretState(row({ webhookSecretCheck: null }), rootA)).toBe("stale");
  });
});

describe("connectorWebhookPath / newWebhookSecretNonce", () => {
  it("names the connector's own receiver", () => {
    expect(connectorWebhookPath("c 1")).toBe("/api/webhooks/github/pr/c/c%201");
  });

  it("#1483 — names the connector's own issues receiver", () => {
    expect(connectorIssuesWebhookPath("c 1")).toBe("/api/webhooks/github/issues/c/c%201");
  });

  it("nonces are random and URL-safe", () => {
    const a = newWebhookSecretNonce();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newWebhookSecretNonce()).not.toBe(a);
  });
});
