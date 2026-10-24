/**
 * #1475 — per-connector GitHub webhook secrets.
 *
 * A GitHub repository connector can carry its own webhook secret. Deliveries
 * signed with it arrive at the connector's own receiver URLs
 * (`/api/webhooks/github/pr/c/:connectorId`, and for issue events
 * `/api/webhooks/github/issues/c/:connectorId`, #1483) and go to that
 * connector's project only. The secret is never stored: it is derived, on demand, from
 * the vault master key, the connector id and a random nonce kept on the
 * connector (`webhookSecretNonce`). Replacing the secret is a new nonce;
 * removing it clears the nonce.
 *
 * Derived rather than vault-encrypted because the receiver computes it for an
 * unauthenticated delivery, and a vault decrypt runs argon2id (64 MiB) per
 * call. This is one HMAC.
 *
 * The derivation depends on `VAULT_MASTER_KEY` and on the connector id, so a
 * key rotation, or a portability import that gives the connector a new id,
 * changes the secret. `webhookSecretCheck` is stored next to the nonce so that
 * change is visible rather than silent: a check that no longer matches means
 * the connector "needs a new secret" ({@link connectorSecretState}). The check
 * is a truncated HMAC under a separately derived key, so it reveals nothing
 * about the secret.
 *
 * Without a master key the feature is off: generating refuses, and no
 * delivery is matched to a connector. (The vault's dev-only ephemeral key is
 * deliberately not used: a webhook secret that silently changes on restart
 * breaks the hook with no sign why.)
 */
import crypto from "node:crypto";

const SECRET_INFO = "metis.github-webhook-secret.v1";
const CHECK_INFO = "metis.github-webhook-secret-check.v1";
const NONCE_BYTES = 32;
const CHECK_CHARS = 16;

/** The two derivation keys, or `null` when no `VAULT_MASTER_KEY` is configured. */
export interface WebhookSecretRoot {
  secret: Buffer;
  check: Buffer;
}

export function webhookSecretRootKey(
  env: NodeJS.ProcessEnv = process.env,
): WebhookSecretRoot | null {
  const raw = env.VAULT_MASTER_KEY?.trim();
  if (!raw) return null;
  const ikm = Buffer.from(raw, "base64");
  if (ikm.length === 0) return null;
  const derive = (info: string) =>
    Buffer.from(crypto.hkdfSync("sha256", ikm, Buffer.alloc(0), info, 32));
  return { secret: derive(SECRET_INFO), check: derive(CHECK_INFO) };
}

/**
 * The connector's own receiver path, relative to the server's origin. Kept in
 * step with the `/api/webhooks` mount and `githubPrWebhookRouter`'s
 * `/github/pr/c/:connectorId` route (asserted by the #1475 route test).
 */
export function connectorWebhookPath(connectorId: string): string {
  return `/api/webhooks/github/pr/c/${encodeURIComponent(connectorId)}`;
}

/**
 * #1483 — the connector's own `issues` receiver path, signed with the same
 * secret: `githubPrWebhookRouter`'s `/github/issues/c/:connectorId`. Its
 * deliveries go to the connector's project only, whichever repository the
 * hook is on (the one its issues are published to).
 */
export function connectorIssuesWebhookPath(connectorId: string): string {
  return `/api/webhooks/github/issues/c/${encodeURIComponent(connectorId)}`;
}

/** A fresh nonce for {@link connectorWebhookSecret}. */
export function newWebhookSecretNonce(): string {
  return crypto.randomBytes(NONCE_BYTES).toString("base64url");
}

/**
 * The webhook secret of one connector. Bound to the connector id, so a nonce
 * copied onto another connector does not reproduce this connector's secret.
 */
export function connectorWebhookSecret(
  root: WebhookSecretRoot,
  connectorId: string,
  nonce: string,
): string {
  return crypto
    .createHmac("sha256", root.secret)
    .update(`${connectorId}\0${nonce}`)
    .digest("base64url");
}

/** The non-secret check stored beside the nonce (see the module comment). */
export function webhookSecretCheck(
  root: WebhookSecretRoot,
  connectorId: string,
  nonce: string,
): string {
  return crypto
    .createHmac("sha256", root.check)
    .update(`${connectorId}\0${nonce}`)
    .digest("base64url")
    .slice(0, CHECK_CHARS);
}

/**
 * - `none`: no own secret; the connector takes shared-secret deliveries.
 * - `active`: its own secret is the one this server derives today.
 * - `stale`: it had one, but the master key or the connector id changed since,
 *   so the secret GitHub holds no longer verifies. Shown as "needs a new
 *   secret", and treated as `none` for shared-secret routing.
 */
export type ConnectorSecretState = "none" | "active" | "stale";

export function connectorSecretState(
  row: { id: string; webhookSecretNonce?: string | null; webhookSecretCheck?: string | null },
  root: WebhookSecretRoot | null = webhookSecretRootKey(),
): ConnectorSecretState {
  if (!row.webhookSecretNonce) return "none";
  if (!root || !row.webhookSecretCheck) return "stale";
  const expected = webhookSecretCheck(root, row.id, row.webhookSecretNonce);
  const a = Buffer.from(expected);
  const b = Buffer.from(row.webhookSecretCheck);
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? "active" : "stale";
}
