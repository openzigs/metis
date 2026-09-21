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
