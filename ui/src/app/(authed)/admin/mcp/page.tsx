"use client";

/**
 * Phase 6 — MCP server admin page.
 *
 * Lists registered MCP servers, exposes start/stop/restart/test controls, and
 * a creation form that validates against the same zod schema the server uses
 * (mirrored client-side via the API contract).
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError } from "@/lib/api-client";
import { useAuth } from "@/lib/auth-context";
import {
  type CreateMCPServerInput,
  type MCPRuntime,
  type MCPServerView,
  type MCPTransport,
  type MCPTrustLevel,
  mcpApi,
} from "@/lib/mcp-api";
import { queryKeys } from "@/lib/query-keys";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

const STATUS_BADGE: Record<MCPServerView["status"], string> = {
  idle: "bg-muted text-muted-foreground",
  starting: "bg-yellow-100 text-yellow-900",
  ready: "bg-green-100 text-green-900",
  error: "bg-red-100 text-red-900",
  disabled: "bg-muted text-muted-foreground",
};

export default function McpAdminPage() {
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: queryKeys.admin.mcp(),
    queryFn: () => mcpApi.list(),
  });
  const [createOpen, setCreateOpen] = useState(false);

  const invalidate = () => qc.invalidateQueries({ queryKey: queryKeys.admin.mcp() });

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">MCP servers</h1>
          <p className="text-sm text-muted-foreground">
            Register, start, and monitor Model Context Protocol servers. Secrets are vault-backed —
            plaintext is never persisted in the registry row.
          </p>
        </div>
        <Dialog open={createOpen} onOpenChange={setCreateOpen}>
          <DialogTrigger asChild>
            <Button data-testid="new-mcp-server">Add server</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Register MCP server</DialogTitle>
            </DialogHeader>
            <CreateForm
              onCancel={() => setCreateOpen(false)}
              onCreated={() => {
                setCreateOpen(false);
                invalidate();
              }}
            />
          </DialogContent>
        </Dialog>
      </header>

      <Card className="p-0">
        <table className="w-full text-left text-sm">
          <thead className="text-xs uppercase text-muted-foreground">
            <tr>
              <th className="px-4 py-3">Label</th>
              <th className="px-4 py-3">Transport</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Trust</th>
              <th className="px-4 py-3">Tools</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {list.isLoading ? (
              <tr>
                <td className="px-4 py-6 text-muted-foreground" colSpan={6}>
                  Loading…
                </td>
              </tr>
            ) : list.data?.items.length === 0 ? (
              <tr>
                <td className="px-4 py-6 text-muted-foreground" colSpan={6}>
                  No MCP servers registered yet.
                </td>
              </tr>
            ) : (
              list.data?.items.map((server) => (
                <ServerRow key={server.id} server={server} onChange={invalidate} />
              ))
            )}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

function ServerRow({ server, onChange }: { server: MCPServerView; onChange: () => void }) {
  const start = useMutation({ mutationFn: () => mcpApi.start(server.id), onSuccess: onChange });
  const stop = useMutation({ mutationFn: () => mcpApi.stop(server.id), onSuccess: onChange });
  const restart = useMutation({
    mutationFn: () => mcpApi.restart(server.id),
    onSuccess: onChange,
  });
  const test = useMutation({ mutationFn: () => mcpApi.test(server.id), onSuccess: onChange });
  const remove = useMutation({ mutationFn: () => mcpApi.remove(server.id), onSuccess: onChange });

  return (
    <tr className="border-t">
      <td className="px-4 py-3">
        <div className="font-medium">{server.label}</div>
        <div className="text-xs text-muted-foreground">{server.id}</div>
      </td>
      <td className="px-4 py-3 capitalize">{server.transport}</td>
      <td className="px-4 py-3">
        <span
          className={`rounded px-2 py-0.5 text-xs font-medium ${STATUS_BADGE[server.status]}`}
          data-testid={`mcp-status-${server.id}`}
        >
          {server.status}
        </span>
        {server.lastError ? (
          <div className="mt-1 text-xs text-red-700">{server.lastError}</div>
        ) : null}
      </td>
      <td className="px-4 py-3">
        <span
          className={`rounded px-2 py-0.5 text-xs font-medium ${
            server.trustLevel === "trusted"
              ? "bg-green-50 text-green-900"
              : "bg-yellow-50 text-yellow-900"
          }`}
        >
          {server.trustLevel}
        </span>
      </td>
      <td className="px-4 py-3">{server.capabilities.length}</td>
      <td className="px-4 py-3 text-right space-x-2">
        <Button
          variant="outline"
          size="sm"
          disabled={start.isPending}
          onClick={() => start.mutate()}
        >
          Start
        </Button>
        <Button variant="outline" size="sm" disabled={stop.isPending} onClick={() => stop.mutate()}>
          Stop
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={restart.isPending}
          onClick={() => restart.mutate()}
        >
          Restart
        </Button>
        <Button variant="outline" size="sm" disabled={test.isPending} onClick={() => test.mutate()}>
          Test
        </Button>
        <Button
          variant="destructive"
          size="sm"
          disabled={remove.isPending}
          onClick={() => {
            if (window.confirm(`Delete MCP server ${server.label}?`)) remove.mutate();
          }}
        >
          Delete
        </Button>
      </td>
    </tr>
  );
}

function CreateForm({ onCancel, onCreated }: { onCancel: () => void; onCreated: () => void }) {
  const { user } = useAuth();
  const canPromoteTrust = user?.permissions.includes("mcp.manage") ?? false;
  const [label, setLabel] = useState("");
  const [transport, setTransport] = useState<MCPTransport>("stdio");
  const [runtime, setRuntime] = useState<MCPRuntime>("native");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [url, setUrl] = useState("");
  const [trustLevel, setTrustLevel] = useState<MCPTrustLevel>("untrusted");
  const [coldStart, setColdStart] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () => {
      // Epic #272 — k8s-sse runtime always uses SSE transport.
      const effectiveTransport: MCPTransport = runtime === "k8s-sse" ? "sse" : transport;
      const input: CreateMCPServerInput = {
        label,
        transport: effectiveTransport,
        runtime,
        trustLevel,
      };
      if (runtime === "k8s-sse") {
        // The wrapper image is required; the in-cluster URL is constructed by
        // the provisioner so the user-supplied URL field is ignored.
        input.command = command;
        input.args = args
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean);
        input.coldStart = coldStart;
      } else if (effectiveTransport === "stdio") {
        input.command = command;
        input.args = args
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean);
      } else {
        input.url = url;
      }
      return mcpApi.create(input);
    },
    onSuccess: onCreated,
    onError: (err: unknown) => {
      setError(err instanceof ApiError ? err.message : "Failed to register server");
    },
  });

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        create.mutate();
      }}
    >
      <div className="space-y-2">
        <Label htmlFor="mcp-label">Label</Label>
        <Input
          id="mcp-label"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          required
          data-testid="mcp-label"
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="mcp-transport">Transport</Label>
        {runtime === "k8s-sse" ? (
          <Input
            id="mcp-transport"
            data-testid="mcp-transport-readonly"
            value="SSE (managed)"
            readOnly
            disabled
          />
        ) : (
          <select
            id="mcp-transport"
            className="border-input bg-background w-full rounded-md border px-3 py-2 text-sm"
            value={transport}
            onChange={(e) => setTransport(e.target.value as MCPTransport)}
          >
            <option value="stdio">stdio</option>
            <option value="http">http (streamable)</option>
            <option value="sse">sse</option>
          </select>
        )}
      </div>
      <div className="space-y-2">
        <Label htmlFor="mcp-runtime">Runtime</Label>
        <select
          id="mcp-runtime"
          data-testid="mcp-runtime-select"
          className="border-input bg-background w-full rounded-md border px-3 py-2 text-sm"
          value={runtime}
          onChange={(e) => setRuntime(e.target.value as MCPRuntime)}
        >
          <option value="native" data-testid="mcp-runtime-option-native">
            Native (host runtime)
          </option>
          <option value="docker-stdio" data-testid="mcp-runtime-option-docker-stdio">
            Docker (stdio)
          </option>
          <option value="k8s-sse" data-testid="mcp-runtime-option-k8s-sse">
            K8s (SSE)
          </option>
        </select>
        <p className="text-xs text-muted-foreground">
          {runtime === "k8s-sse"
            ? "K8s deploys a per-MCP pod with NetworkPolicy + per-server ServiceAccount. Wrapper image must match MCP_IMAGE_ALLOWLIST."
            : runtime === "docker-stdio"
              ? "Wrapper image must match MCP_IMAGE_ALLOWLIST. Args become the image entrypoint args."
              : "Native runs the command directly on the host. No container isolation."}
        </p>
      </div>
      {runtime === "k8s-sse" ? (
        <div className="flex items-center gap-2">
          <input
            id="mcp-cold-start"
            type="checkbox"
            data-testid="mcp-cold-start"
            checked={coldStart}
            onChange={(e) => setColdStart(e.target.checked)}
          />
          <Label htmlFor="mcp-cold-start" className="text-sm font-normal">
            Cold start (scale to zero when idle)
          </Label>
          <span className="text-xs text-muted-foreground">
            Trades wake-up latency (~5–15s) for resource savings.
          </span>
        </div>
      ) : null}
      {transport === "stdio" || runtime === "k8s-sse" ? (
        <>
          <div className="space-y-2">
            <Label htmlFor="mcp-command">
              {runtime === "docker-stdio" || runtime === "k8s-sse" ? "Wrapper image" : "Command"}
            </Label>
            <Input
              id="mcp-command"
              data-testid="mcp-command-input"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder={
                runtime === "k8s-sse"
                  ? "ghcr.io/metis-mcps/uvx-runner-sse:1.0"
                  : runtime === "docker-stdio"
                    ? "ghcr.io/metis-mcps/uvx-runner:1.0"
                    : "npx"
              }
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="mcp-args">Args (one per line)</Label>
            <textarea
              id="mcp-args"
              className="border-input bg-background h-24 w-full rounded-md border px-3 py-2 text-sm"
              value={args}
              onChange={(e) => setArgs(e.target.value)}
              placeholder={"-y\n@modelcontextprotocol/server-filesystem\n/path"}
            />
          </div>
        </>
      ) : (
        <div className="space-y-2">
          <Label htmlFor="mcp-url">URL</Label>
          <Input
            id="mcp-url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://mcp.example.com"
            required
          />
        </div>
      )}
      <div className="space-y-2">
        <Label htmlFor="mcp-trust">Trust level</Label>
        {canPromoteTrust ? (
          <select
            id="mcp-trust"
            data-testid="mcp-trust"
            className="border-input bg-background w-full rounded-md border px-3 py-2 text-sm"
            value={trustLevel}
            onChange={(e) => setTrustLevel(e.target.value as MCPTrustLevel)}
          >
            <option value="untrusted">untrusted (always prompt)</option>
            <option value="trusted">trusted</option>
          </select>
        ) : (
          <p
            className="text-xs text-muted-foreground"
            data-testid="mcp-trust-locked"
            title="Admin only"
          >
            Trust level: <strong>untrusted</strong> — only administrators can promote.
          </p>
        )}
      </div>
      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      <div className="flex justify-end space-x-2">
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={create.isPending} data-testid="mcp-create-submit">
          {create.isPending ? "Registering…" : "Register"}
        </Button>
      </div>
    </form>
  );
}
