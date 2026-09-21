/**
 * Per-workspace vault namespace helpers (Epic #759, Issue #762).
 *
 * Vault keys belonging to a workspace are prefixed with `ws:<workspaceId>:`.
 * Global (unscoped) secrets retain their original labels.
 */

/**
 * Generates a workspace-namespaced vault label.
 */
export function workspaceVaultLabel(workspaceId: string, label: string): string {
  return `ws:${workspaceId}:${label}`;
}

/**
 * Extracts the workspace ID from a namespaced vault label.
 * Returns null if the label is not workspace-scoped.
 */
export function parseWorkspaceVaultLabel(
  label: string,
): { workspaceId: string; key: string } | null {
  const match = label.match(/^ws:([^:]+):(.+)$/);
  if (!match) return null;
  return { workspaceId: match[1], key: match[2] };
}

/**
 * Returns true if the label belongs to the given workspace.
 */
export function isWorkspaceSecret(label: string, workspaceId: string): boolean {
  return label.startsWith(`ws:${workspaceId}:`);
}

/**
 * Filters secrets to only those belonging to a workspace (or unscoped globals).
 */
export function filterSecretsForWorkspace(
  secrets: { label: string }[],
  workspaceId: string,
): typeof secrets {
  return secrets.filter(
    (s) => isWorkspaceSecret(s.label, workspaceId) || !s.label.startsWith("ws:"),
  );
}
