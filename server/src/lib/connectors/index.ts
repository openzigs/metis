/**
 * Connector module — Phase 8 (issues #59–#64).
 *
 * Re-exports the public surface of the connector subsystem (repo + database).
 * Routes import from this barrel; internal code reaches into the sub-folders
 * directly.
 */
export * from "./types.js";
export * from "./network-allowlist.js";
export * from "./pii-redactor.js";
export * from "./vault-resolver.js";
