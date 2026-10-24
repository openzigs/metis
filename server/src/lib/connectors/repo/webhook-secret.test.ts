/** #1475 — per-connector webhook secret derivation. */
import { describe, expect, it } from "vitest";
import {
  connectorWebhookSecret,
  newWebhookSecretNonce,
  webhookSecretRootKey,
} from "./webhook-secret.js";

const KEY_A = Buffer.alloc(32, 1).toString("base64");
const KEY_B = Buffer.alloc(32, 2).toString("base64");

describe("webhookSecretRootKey", () => {
  it("is null without a vault master key, so no secret can be issued or matched", () => {
    expect(webhookSecretRootKey({})).toBeNull();
    expect(webhookSecretRootKey({ VAULT_MASTER_KEY: "   " })).toBeNull();
  });

  it("is stable for one master key and differs between master keys", () => {
    const a1 = webhookSecretRootKey({ VAULT_MASTER_KEY: KEY_A });
    const a2 = webhookSecretRootKey({ VAULT_MASTER_KEY: KEY_A });
    const b = webhookSecretRootKey({ VAULT_MASTER_KEY: KEY_B });
    expect(a1?.equals(a2!)).toBe(true);
    expect(a1?.equals(b!)).toBe(false);
    // Derived, not the master key itself.
    expect(a1?.equals(Buffer.from(KEY_A, "base64"))).toBe(false);
  });
});

describe("connectorWebhookSecret", () => {
  const root = webhookSecretRootKey({ VAULT_MASTER_KEY: KEY_A })!;

  it("is deterministic for one connector and nonce", () => {
    expect(connectorWebhookSecret(root, "c1", "n")).toBe(connectorWebhookSecret(root, "c1", "n"));
  });

  it("is bound to the connector id and to the nonce", () => {
    const base = connectorWebhookSecret(root, "c1", "n");
    expect(connectorWebhookSecret(root, "c2", "n")).not.toBe(base);
    expect(connectorWebhookSecret(root, "c1", "m")).not.toBe(base);
    // The separator keeps (id, nonce) pairs from colliding by concatenation.
    expect(connectorWebhookSecret(root, "c1n", "")).not.toBe(
      connectorWebhookSecret(root, "c1", "n"),
    );
  });
});

describe("newWebhookSecretNonce", () => {
  it("is random and URL-safe", () => {
    const a = newWebhookSecretNonce();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newWebhookSecretNonce()).not.toBe(a);
  });
});
