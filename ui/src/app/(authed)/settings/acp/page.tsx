"use client";

/**
 * Settings → ACP (Epic #163, Issue #119).
 *
 * Generate / list / revoke ACP API tokens. The plaintext token is shown
 * exactly once at creation. Also provides a connection-string snippet for
 * `~/.copilot/mcp.json` and the WebSocket URL for remote ACP clients.
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiError } from "@/lib/api-client";
import { acpApi, type CreatedApiToken } from "@/lib/enterprise-api";

const DOC_URL = "/docs/ACP.md";

export default function AcpSettingsPage() {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState("acp:read,acp:run");
  const [revealed, setRevealed] = useState<CreatedApiToken | null>(null);

  const list = useQuery({
    queryKey: ["acp-tokens"],
    queryFn: () => acpApi.listTokens(),
  });

  const create = useMutation({
    mutationFn: () =>
      acpApi.createToken({
        name,
        scopes: scopes
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      }),
    onSuccess: (data) => {
      setRevealed(data);
      setName("");
      qc.invalidateQueries({ queryKey: ["acp-tokens"] });
    },
  });

  const revoke = useMutation({
    mutationFn: (id: string) => acpApi.revokeToken(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["acp-tokens"] }),
  });

  const wsUrl = useMemo(() => {
    if (typeof window === "undefined") return "wss://server/api/acp";
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${window.location.host}/api/acp`;
  }, []);

  const mcpSnippet = useMemo(() => {
    const token = revealed?.token ?? "<paste-token-here>";
    return JSON.stringify(
      {
        servers: {
          metis: {
            url: wsUrl,
            transport: "ws",
            headers: { Authorization: `Bearer ${token}` },
          },
        },
      },
      null,
      2,
    );
  }, [revealed, wsUrl]);

  return (
    <div className="space-y-6 p-2 md:p-0" data-testid="acp-settings-root">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">ACP — Agent Client Protocol</h1>
        <p className="text-sm text-muted-foreground">
          Expose METIS to external Copilot CLIs over JSON-RPC.{" "}
          <a className="underline" href={DOC_URL}>
            Wire format docs
          </a>
        </p>
      </header>

      <Card className="p-4" data-testid="acp-create-card">
        <h2 className="text-sm font-semibold">Generate ACP token</h2>
        <div className="mt-3 grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="acp-name">Token name</Label>
            <Input
              id="acp-name"
              data-testid="acp-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="laptop-cli"
            />
          </div>
          <div>
            <Label htmlFor="acp-scopes">Scopes (csv)</Label>
            <Input
              id="acp-scopes"
              data-testid="acp-scopes"
              value={scopes}
              onChange={(e) => setScopes(e.target.value)}
            />
          </div>
        </div>
        <Button
          className="mt-3"
          size="sm"
          data-testid="acp-generate"
          disabled={!name.trim() || create.isPending}
          onClick={() => create.mutate()}
        >
          {create.isPending ? "Generating…" : "Generate ACP token"}
        </Button>
        {create.error && (
          <p className="mt-2 text-xs text-red-600" data-testid="acp-error">
            {create.error instanceof ApiError ? create.error.message : String(create.error)}
          </p>
        )}
      </Card>

      {revealed && (
        <Card className="space-y-2 p-4" data-testid="acp-revealed-card">
          <h3 className="text-sm font-semibold">Token created — copy now</h3>
          <p className="text-xs text-muted-foreground">
            The plaintext token is shown ONCE and cannot be retrieved later.
          </p>
          <code
            className="block break-all rounded bg-muted p-2 font-mono text-xs"
            data-testid="acp-revealed-token"
          >
            {revealed.token}
          </code>
          <h4 className="mt-2 text-xs font-semibold uppercase text-muted-foreground">
            ~/.copilot/mcp.json snippet
          </h4>
          <pre className="overflow-auto rounded bg-muted p-2 text-xs" data-testid="acp-mcp-snippet">
            {mcpSnippet}
          </pre>
          <p className="text-xs">
            WebSocket URL: <code data-testid="acp-ws-url">{wsUrl}</code>
          </p>
        </Card>
      )}

      <Card className="p-4">
        <h2 className="text-sm font-semibold">Active tokens</h2>
        <ul className="mt-3 divide-y" data-testid="acp-token-list">
          {(list.data ?? []).map((t) => (
            <li
              key={t.id}
              className="flex items-center justify-between py-2"
              data-testid={`acp-token-row-${t.id}`}
            >
              <div>
                <div className="text-sm font-medium">{t.name}</div>
                <div className="text-xs text-muted-foreground">
                  {t.prefix}··· · scopes: {t.scopes.join(", ") || "(none)"}
                  {t.revokedAt ? " · revoked" : ""}
                </div>
              </div>
              {!t.revokedAt && (
                <Button
                  variant="outline"
                  size="sm"
                  data-testid={`acp-revoke-${t.id}`}
                  disabled={revoke.isPending}
                  onClick={() => revoke.mutate(t.id)}
                >
                  Revoke
                </Button>
              )}
            </li>
          ))}
          {!list.data?.length && (
            <li className="py-2 text-xs text-muted-foreground">No tokens yet.</li>
          )}
        </ul>
      </Card>
    </div>
  );
}
