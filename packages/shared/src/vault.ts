/**
 * Encrypted Secret vault schemas.
 *
 * IMPORTANT: ciphertext/iv/tag/salt are stored OPAQUE in this layer. Crypto
 * primitives (AES-256-GCM envelope encryption) land in Phase 2. This package
 * only describes the storage shape and validates payloads at the API boundary.
 */
import { z } from "zod";
import { dateSchema, idSchema, timestampsSchema } from "./common.js";

const base64ish = z
  .string()
  .min(1)
  .max(8192)
  .regex(/^[A-Za-z0-9+/=_-]+$/, "must be base64/base64url");

export const secretSchema = z
  .object({
    id: idSchema,
    name: z.string().min(1).max(128),
    description: z.string().max(512).default(""),
    ciphertext: base64ish,
    iv: base64ish,
    tag: base64ish,
    salt: base64ish,
    keyVersion: z.number().int().min(1),
    algorithm: z.string().min(1).max(64),
    createdById: idSchema.nullable(),
    deletedAt: dateSchema.nullable(),
  })
  .merge(timestampsSchema);
export type Secret = z.infer<typeof secretSchema>;

/** Inbound payload — caller submits *plaintext* + metadata; the API layer
 *  performs encryption before persisting. The shape mirrors what the storage
 *  row will look like once Phase 2 lands so the contract is stable. */
export const createSecretSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[a-zA-Z0-9_.\-/]+$/, "invalid name"),
  description: z.string().max(512).optional(),
  // Plaintext is accepted but never persisted — the server encrypts.
  plaintext: z
    .string()
    .min(1)
    .max(64 * 1024),
});
export type CreateSecretInput = z.infer<typeof createSecretSchema>;

/** Storage-shape payload — used internally by the encryption layer to write
 *  ciphertext rows and by tests that need to fixture pre-encrypted secrets. */
export const storeSecretSchema = secretSchema
  .pick({
    name: true,
    description: true,
    ciphertext: true,
    iv: true,
    tag: true,
    salt: true,
    keyVersion: true,
    algorithm: true,
    createdById: true,
  })
  .partial({ description: true, createdById: true });
export type StoreSecretInput = z.infer<typeof storeSecretSchema>;
