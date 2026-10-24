/**
 * #1475 — per-connector GitHub webhook secrets.
 *
 * A repository connector can carry its own webhook secret, so a delivery is
 * attributed to the connector whose secret signed it rather than to whichever
 * project happens to connect the same repository. The secret is never stored:
 * it is derived, on demand, from the vault master key, the connector id and a
 * random nonce kept on the connector (`webhookSecretNonce`). Replacing the
 * secret is a new nonce; removing it clears the nonce.
 *
 * Derived rather than vault-encrypted because the receiver has to compute the
 * secret of every candidate connector for an unauthenticated delivery, and a
 * vault decrypt runs argon2id (64 MiB) per call: that would let anyone with
 * the webhook URL buy expensive work per request. This is one HMAC.
 *
 * The root key is HKDF(`VAULT_MASTER_KEY`). Without a master key the feature
 * is off: generating refuses, and no delivery is ever matched to a connector.
 * (The vault's dev-only ephemeral key is deliberately not used: a webhook
 * secret that silently changes on restart breaks the hook with no sign why.)
 */
import crypto from "node:crypto";

const HKDF_INFO = "metis.github-webhook-secret.v1";
const NONCE_BYTES = 32;

/** The derivation root, or `null` when no `VAULT_MASTER_KEY` is configured. */
export function webhookSecretRootKey(env: NodeJS.ProcessEnv = process.env): Buffer | null {
  const raw = env.VAULT_MASTER_KEY?.trim();
  if (!raw) return null;
  const ikm = Buffer.from(raw, "base64");
  if (ikm.length === 0) return null;
  return Buffer.from(crypto.hkdfSync("sha256", ikm, Buffer.alloc(0), HKDF_INFO, 32));
}

/** A fresh nonce for {@link connectorWebhookSecret}. */
export function newWebhookSecretNonce(): string {
  return crypto.randomBytes(NONCE_BYTES).toString("base64url");
}

/**
 * The webhook secret of one connector. Bound to the connector id, so a nonce
 * copied onto another connector does not reproduce this connector's secret.
 */
export function connectorWebhookSecret(root: Buffer, connectorId: string, nonce: string): string {
  return crypto.createHmac("sha256", root).update(`${connectorId}\0${nonce}`).digest("base64url");
}
