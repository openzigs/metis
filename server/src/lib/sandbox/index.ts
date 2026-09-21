/**
 * Sandbox barrel — public surface for application code.
 *
 * Application modules should import from this file rather than the
 * individual adapter files so the wiring stays a DI seam.
 */
export * from "./types.js";
export * from "./limits.js";
export * from "./clamp.js";
export * from "./factory.js";
export * from "./with-sandbox.js";
export * from "./egress-defaults.js";
export { SandboxAuditEmitter, getSandboxAuditEmitter } from "./audit/audit-emitter.js";
export { redactSandboxPayload } from "./audit/redact.js";
export { SandboxSessionRepo, getSandboxSessionRepo } from "./repos/sandbox-session.repo.js";
export {
  SandboxAuditEventRepo,
  getSandboxAuditEventRepo,
} from "./repos/sandbox-audit-event.repo.js";
