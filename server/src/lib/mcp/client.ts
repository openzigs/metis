/**
 * MCP client — wraps a transport with the MCP-spec handshake and tool calls.
 *
 *   1. POST `initialize` with our protocol version + capabilities.
 *   2. Send the `notifications/initialized` notification.
 *   3. Call `tools/list` to discover the server's tools.
 *
 * `callTool(name, args)` invokes a discovered tool through the same transport.
 */
import type { MCPToolDescriptor, MCPToolRisk } from "@metis/shared";
import { createChildLogger } from "../logger.js";
import type { MCPTransportClient } from "./types.js";

const log = createChildLogger("mcp-client");

const PROTOCOL_VERSION = "2025-06-18";

interface InitializeResult {
  protocolVersion?: string;
  serverInfo?: { name?: string; version?: string };
  capabilities?: {
    tools?: Record<string, unknown>;
    resources?: Record<string, unknown>;
    prompts?: Record<string, unknown>;
  };
}

interface ToolsListResult {
  tools?: Array<{
    name: string;
    description?: string;
    inputSchema?: unknown;
    annotations?: { destructiveHint?: boolean; readOnlyHint?: boolean };
  }>;
}

export interface MCPClientHandshake {
  protocolVersion: string;
  serverName: string | null;
  serverVersion: string | null;
  capabilities: InitializeResult["capabilities"];
  tools: MCPToolDescriptor[];
}

export class MCPClient {
  private handshakeResult: MCPClientHandshake | null = null;

  constructor(
    private readonly transport: MCPTransportClient,
    private readonly defaultRisk: MCPToolRisk = "medium",
  ) {}

  async handshake(): Promise<MCPClientHandshake> {
    const result = await this.transport.request<InitializeResult>("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      clientInfo: { name: "metis", version: "0.1.0" },
    });
    await this.transport.notify("notifications/initialized");

    const toolsResult = await this.transport
      .request<ToolsListResult>("tools/list")
      .catch((err: Error) => {
        log.warn("tools/list failed during handshake", { error: err.message });
        return { tools: [] };
      });

    const tools: MCPToolDescriptor[] = (toolsResult.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description ?? "",
      // Destructive-hint upgrades risk to high; everything else takes the
      // server-configured default. Untrusted servers are forced to high by the
      // tool registry layer, not here.
      risk: t.annotations?.destructiveHint ? "high" : this.defaultRisk,
      inputSchema: t.inputSchema,
    }));

    this.handshakeResult = {
      protocolVersion: result.protocolVersion ?? PROTOCOL_VERSION,
      serverName: result.serverInfo?.name ?? null,
      serverVersion: result.serverInfo?.version ?? null,
      capabilities: result.capabilities ?? {},
      tools,
    };
    return this.handshakeResult;
  }

  get tools(): MCPToolDescriptor[] {
    return this.handshakeResult?.tools ?? [];
  }

  async callTool(name: string, args: unknown): Promise<{ content: unknown; isError: boolean }> {
    const result = await this.transport.request<{
      content?: unknown;
      isError?: boolean;
    }>("tools/call", { name, arguments: args ?? {} });
    return {
      content: result.content ?? null,
      isError: Boolean(result.isError),
    };
  }

  /** Cheap probe used by the health-check loop. */
  async ping(): Promise<void> {
    await this.transport.request<ToolsListResult>("tools/list", undefined, 5_000);
  }

  async close(reason?: string): Promise<void> {
    await this.transport.stop(reason);
  }
}
