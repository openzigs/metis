/**
 * Issue #580 — designated "ops" workspace for PLATFORM-level sev-1 alerts.
 *
 * Some sev-1 conditions are not tied to a single tenant workspace:
 *   - vault key rotation failures (secrets are platform/project scoped), and
 *   - provider/sandbox-down for global- or user-scoped MCP servers (no project).
 *
 * To page on those, an operator designates ONE workspace via the
 * `PAGERDUTY_OPS_WORKSPACE_ID` env var; its registered PagerDuty service receives
 * the platform infra incidents. When unset, platform-level alerting is simply
 * disabled (the hooks no-op) — tenant-scoped alerts (e.g. project publish
 * rollbacks) are unaffected because they derive their workspace from the project.
 */
export function opsWorkspaceId(): string | null {
  const v = process.env.PAGERDUTY_OPS_WORKSPACE_ID;
  return v && v.trim().length > 0 ? v.trim() : null;
}
