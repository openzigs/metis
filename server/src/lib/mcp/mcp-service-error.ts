/**
 * Standalone error class for the MCP registry — extracted from
 * `mcp-service.ts` so validators (`validation.ts`, `image-allowlist.ts`) can
 * throw it without creating a circular import back into the service file.
 */
export class MCPRegistryError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "MCPRegistryError";
    this.status = status;
    this.code = code;
  }
}

/**
 * #335 — a `scope: "project"` server must name its project. One code and one
 * message for every create path (routes and `MCPRegistryService.create`).
 */
export const PROJECT_REQUIRED = "PROJECT_REQUIRED";
export const PROJECT_REQUIRED_MESSAGE =
  'A project-scoped MCP server needs a projectId: name the project it belongs to, or register it with scope "global".';
