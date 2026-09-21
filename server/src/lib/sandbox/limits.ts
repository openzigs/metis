/**
 * Sandbox hard limits (Epic #395 #412).
 *
 * Single source of truth for the absolute maxima any caller is allowed to
 * request. Per-`Project` overrides may *tighten* these but never loosen
 * them. Importing modules MUST NOT inline magic numbers — every adapter
 * imports from this file so audits can grep for the constants.
 */
import { SandboxLimitExceededError } from "./types.js";

export const SANDBOX_HARD_LIMITS = {
  /** Maximum logical CPU count any sandbox may request. */
  maxVCpus: 4,
  /** Maximum memory cap (MiB) — 8 GiB. */
  maxMemMiB: 8 * 1024,
  /** Maximum wall-clock per-create (ms) — 5 minutes. */
  maxWallClockMs: 300_000,
  /** Minimum wall-clock per-create (ms) — 1 second. */
  minWallClockMs: 1_000,
  /** Maximum single `files.write` payload size (bytes) — 100 MiB. */
  maxFileWriteBytes: 100 * 1024 * 1024,
  /** Maximum stdout/stderr captured per `runCode`/`commands.run` (bytes). */
  maxStreamCaptureBytes: 64 * 1024,
} as const;

export { SandboxLimitExceededError };
