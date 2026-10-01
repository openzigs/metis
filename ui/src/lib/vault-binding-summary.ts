/**
 * #611 (PR #627 review) — display names for the binding types the server
 * lists (`server/src/lib/vault/rotate-foreign-owner.ts`). #629 — the counts
 * themselves now come from the server, over the whole set, since the 409 lists
 * only the first `maxConfirmedBindings` bindings.
 */
const TYPE_LABELS: Record<string, string> = {
  db_connector: "DB connector",
  repo_connector: "Repo connector",
  import_source: "Import source",
  mcp_server: "MCP server",
  jira_connection: "Jira connection",
  test_management_connection: "Test-management connection",
};

/** A binding type's display name; an unknown type shows as itself. */
export function bindingTypeLabel(type: string): string {
  return TYPE_LABELS[type] ?? type;
}
