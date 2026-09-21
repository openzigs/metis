"use client";

/**
 * Epic #162 — MCP Platform settings page (v1.1.0).
 *
 * Three tabs:
 *   • Connected — list of registered servers with Tools / Allowlist /
 *     Approval / Integrity sub-panels.
 *   • Registry — paginated browser of the public registry with Install dialog.
 *   • Import / Export — Copilot mcp.json round-trip.
 *
 * Issue references: #98, #99, #104, #105, #124.
 */
import { useMemo, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError } from "@/lib/api-client";
import { useAuth } from "@/lib/auth-context";
import {
  type MCPHiddenCharRange,
  type MCPRegistryEntry,
  type MCPSchemaDiff,
  type MCPServerView,
  type McpFederationEntry,
  mcpApi,
  mcpPlatformApi,
} from "@/lib/mcp-api";
import { queryKeys } from "@/lib/query-keys";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

type TabId = "connected" | "registry" | "federated" | "import-export";

const TABS: Array<{ id: TabId; label: string }> = [
  { id: "connected", label: "Connected" },
  { id: "registry", label: "Registry" },
  { id: "federated", label: "Federated" },
  { id: "import-export", label: "Import / Export" },
];

export default function McpSettingsPage() {
  const [tab, setTab] = useState<TabId>("connected");
  return (
    <div className="space-y-6 p-2 md:p-0" data-testid="mcp-settings-page">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">MCP platform</h1>
          <p className="text-sm text-muted-foreground">
            Browse the public registry, govern per-tool access, verify server integrity, and
            round-trip Copilot CLI <code>mcp.json</code> configs.
          </p>
        </div>
        <Button asChild>
          <Link href="/admin/mcp">Add MCP server</Link>
        </Button>
      </header>
      <div role="tablist" aria-label="MCP platform sections" className="flex gap-2 border-b">
        {TABS.map((t) => (
          <button
            key={t.id}
            id={`tab-${t.id}`}
            role="tab"
            aria-selected={tab === t.id}
            aria-controls={`tabpanel-${t.id}`}
            data-testid={`tab-${t.id}`}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px ${
              tab === t.id
                ? "border-foreground text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`tabpanel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === "connected" ? <ConnectedTab /> : null}
        {tab === "registry" ? <RegistryTab /> : null}
        {tab === "federated" ? <FederatedTab /> : null}
        {tab === "import-export" ? <ImportExportTab /> : null}
      </div>
    </div>
  );
}

// ── Connected tab ─────────────────────────────────────────────────────────────

function ConnectedTab() {
  const list = useQuery({
    queryKey: queryKeys.admin.mcp(),
    queryFn: () => mcpApi.list(),
  });
  if (list.isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (!list.data || list.data.items.length === 0) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="connected-empty">
        No MCP servers registered yet. Install one from the Registry tab or add one manually from
        Admin.
      </p>
    );
  }
  return (
    <div className="space-y-4" data-testid="connected-list">
      {list.data.items.map((s) => (
        <ConnectedServerCard key={s.id} server={s} />
      ))}
    </div>
  );
}

function ConnectedServerCard({ server }: { server: MCPServerView }) {
  return (
    <Card className="p-4 space-y-3" data-testid={`server-${server.id}`}>
      <header className="flex items-center justify-between">
        <div>
          <h2 className="font-semibold">{server.label}</h2>
          <p className="text-xs text-muted-foreground">
            {server.transport} · {server.runtime} · {server.scope} · trust={server.trustLevel}
            {server.version ? ` · v${server.version}` : ""}
          </p>
        </div>
        <span
          className={`rounded px-2 py-1 text-xs font-medium ${
            server.status === "ready"
              ? "bg-green-100 text-green-900"
              : server.status === "error"
                ? "bg-red-100 text-red-900"
                : "bg-muted text-muted-foreground"
          }`}
        >
          {server.status}
        </span>
      </header>
      <ToolTesterPanel server={server} />
      <AllowlistPanel server={server} />
      <ApprovalPanel server={server} />
      <IntegrityPanel server={server} />
    </Card>
  );
}

function ToolTesterPanel({ server }: { server: MCPServerView }) {
  const [tool, setTool] = useState<string>(server.capabilities[0]?.name ?? "");
  const [argsText, setArgsText] = useState("{}");
  const [result, setResult] = useState<{
    isError: boolean;
    durationMs: number;
    result?: unknown;
    error?: string;
  } | null>(null);
  const test = useMutation({
    mutationFn: async () => {
      let parsed: unknown = {};
      try {
        parsed = argsText.trim() ? JSON.parse(argsText) : {};
      } catch (err) {
        throw new Error(`Invalid JSON args: ${(err as Error).message}`);
      }
      return mcpPlatformApi.testTool(server.id, tool, parsed);
    },
    onSuccess: (data) => setResult(data),
    onError: (err: unknown) =>
      setResult({ isError: true, durationMs: 0, error: errorMessage(err) }),
  });
  if (server.capabilities.length === 0) {
    return (
      <details>
        <summary className="cursor-pointer text-sm">Tools</summary>
        <p className="mt-2 text-xs text-muted-foreground">
          No tools advertised. Start the server first.
        </p>
      </details>
    );
  }
  return (
    <details data-testid={`tools-${server.id}`}>
      <summary className="cursor-pointer text-sm">Tools ({server.capabilities.length})</summary>
      <div className="mt-2 space-y-2">
        <div className="flex gap-2 items-end">
          <div className="flex-1">
            <Label htmlFor={`tool-select-${server.id}`}>Tool</Label>
            <select
              id={`tool-select-${server.id}`}
              data-testid={`tool-select-${server.id}`}
              value={tool}
              onChange={(e) => setTool(e.target.value)}
              className="w-full rounded border px-2 py-1 text-sm"
            >
              {server.capabilities.map((c) => (
                <option key={c.name} value={c.name}>
                  {c.name} ({c.risk})
                </option>
              ))}
            </select>
          </div>
        </div>
        <div>
          <Label htmlFor={`args-${server.id}`}>Args (JSON)</Label>
          <textarea
            id={`args-${server.id}`}
            data-testid={`tool-args-${server.id}`}
            value={argsText}
            onChange={(e) => setArgsText(e.target.value)}
            rows={3}
            className="w-full rounded border px-2 py-1 font-mono text-xs"
          />
        </div>
        <Button
          size="sm"
          onClick={() => test.mutate()}
          disabled={test.isPending || !tool}
          data-testid={`tool-run-${server.id}`}
        >
          {test.isPending ? "Running…" : "Run"}
        </Button>
        {result ? (
          <div
            data-testid={`tool-result-${server.id}`}
            className={`rounded border p-2 text-xs ${
              result.isError ? "border-red-300 bg-red-50" : "border-green-300 bg-green-50"
            }`}
          >
            <div className="font-medium">
              {result.isError ? "Error" : "OK"} · {result.durationMs} ms
            </div>
            <pre className="mt-1 overflow-x-auto whitespace-pre-wrap">
              {result.error ?? JSON.stringify(result.result, null, 2)}
            </pre>
          </div>
        ) : null}
      </div>
    </details>
  );
}

function AllowlistPanel({ server }: { server: MCPServerView }) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<string>((server.toolAllowlist ?? []).join("\n"));
  const save = useMutation({
    mutationFn: () =>
      mcpPlatformApi.setGovernance(server.id, {
        toolAllowlist: draft.trim()
          ? draft
              .split(/\r?\n/)
              .map((s) => s.trim())
              .filter(Boolean)
          : null,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.admin.mcp() }),
  });
  return (
    <details data-testid={`allowlist-${server.id}`}>
      <summary className="cursor-pointer text-sm">
        Allowlist {server.toolAllowlist ? `(${server.toolAllowlist.length})` : "(all tools)"}
      </summary>
      <div className="mt-2 space-y-2">
        <p className="text-xs text-muted-foreground">
          One tool name per line. Empty = allow all tools.
        </p>
        <textarea
          data-testid={`allowlist-input-${server.id}`}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={4}
          className="w-full rounded border px-2 py-1 font-mono text-xs"
        />
        <Button
          size="sm"
          onClick={() => save.mutate()}
          disabled={save.isPending}
          data-testid={`allowlist-save-${server.id}`}
        >
          {save.isPending ? "Saving…" : "Save allowlist"}
        </Button>
      </div>
    </details>
  );
}

function ApprovalPanel({ server }: { server: MCPServerView }) {
  const qc = useQueryClient();
  const toggle = useMutation({
    mutationFn: (next: boolean) =>
      mcpPlatformApi.setGovernance(server.id, { requireApproval: next }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.admin.mcp() }),
  });
  return (
    <div className="text-sm">
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          data-testid={`require-approval-${server.id}`}
          checked={server.requireApproval}
          onChange={(e) => toggle.mutate(e.target.checked)}
          disabled={toggle.isPending}
        />
        Require per-call approval (chat session prompts)
      </label>
    </div>
  );
}

function IntegrityPanel({ server }: { server: MCPServerView }) {
  const qc = useQueryClient();
  const diff = useQuery({
    queryKey: ["mcp", "integrity", server.id],
    queryFn: () => mcpPlatformApi.integrityDiff(server.id),
    enabled: server.status === "ready",
  });
  const approve = useMutation({
    mutationFn: () => mcpPlatformApi.approveSnapshot(server.id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.admin.mcp() });
      qc.invalidateQueries({ queryKey: ["mcp", "integrity", server.id] });
    },
  });
  return (
    <details data-testid={`integrity-${server.id}`}>
      <summary className="cursor-pointer text-sm">
        Integrity{" "}
        {diff.data?.hasBaseline
          ? `(approved ${diff.data.approvedAt ? new Date(diff.data.approvedAt).toLocaleDateString() : ""})`
          : "(no baseline)"}
      </summary>
      <div className="mt-2 space-y-2 text-xs">
        {server.sha256 ? (
          <div>
            <span className="font-medium">sha256:</span>{" "}
            <code className="break-all">{server.sha256}</code>
          </div>
        ) : null}
        {diff.data ? <SchemaDiffView diff={diff.data.diff} /> : null}
        <Button
          size="sm"
          onClick={() => approve.mutate()}
          disabled={approve.isPending}
          data-testid={`approve-snapshot-${server.id}`}
        >
          {approve.isPending ? "Approving…" : "Approve current snapshot"}
        </Button>
      </div>
    </details>
  );
}

function SchemaDiffView({ diff }: { diff: MCPSchemaDiff }) {
  const empty = diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0;
  if (empty)
    return <p data-testid="diff-clean">Live tool surface matches the approved snapshot.</p>;
  return (
    <div data-testid="diff-changes" className="space-y-1">
      <p className="font-medium text-amber-800">Schema drift detected:</p>
      {diff.added.length ? (
        <p>
          <span className="text-green-800">added:</span> {diff.added.join(", ")}
        </p>
      ) : null}
      {diff.removed.length ? (
        <p>
          <span className="text-red-800">removed:</span> {diff.removed.join(", ")}
        </p>
      ) : null}
      {diff.changed.length ? (
        <p>
          <span className="text-amber-800">changed:</span> {diff.changed.join(", ")}
        </p>
      ) : null}
    </div>
  );
}

// ── Registry tab ──────────────────────────────────────────────────────────────

function RegistryTab() {
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [installEntry, setInstallEntry] = useState<MCPRegistryEntry | null>(null);
  const reg = useQuery({
    queryKey: ["mcp", "registry", q, page],
    queryFn: () => mcpPlatformApi.registry({ q: q || undefined, page, pageSize: 25 }),
  });
  return (
    <div className="space-y-4" data-testid="registry-tab">
      <div className="flex items-center gap-2">
        <Input
          placeholder="Search the public MCP registry"
          value={q}
          data-testid="registry-search"
          onChange={(e) => {
            setQ(e.target.value);
            setPage(1);
          }}
        />
      </div>
      {reg.isLoading ? <p>Loading registry…</p> : null}
      {reg.error ? (
        <p className="text-sm text-red-700" data-testid="registry-error">
          Registry unavailable: {errorMessage(reg.error)}
        </p>
      ) : null}
      {reg.data ? (
        <>
          {reg.data.stale ? (
            <p
              className="rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900"
              data-testid="registry-stale-banner"
            >
              Showing stale cache from {new Date(reg.data.fetchedAt).toLocaleString()} — upstream
              registry is unreachable.
            </p>
          ) : null}
          {reg.data.offline ? (
            <p
              className="rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900"
              data-testid="registry-offline-banner"
            >
              Public registry is unreachable. No cached entries are available yet.
            </p>
          ) : null}
          <ul className="space-y-2" data-testid="registry-list">
            {reg.data.servers.map((entry) => (
              <li key={entry.id} className="rounded border p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1">
                    <div className="font-medium">{entry.name}</div>
                    {entry.description ? (
                      <div className="text-xs text-muted-foreground">{entry.description}</div>
                    ) : null}
                    <div className="mt-1 text-xs">
                      {entry.publisher ?? "—"}
                      {entry.version ? ` · v${entry.version}` : ""}
                      {entry.category ? ` · ${entry.category}` : ""}
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setInstallEntry(entry)}
                    data-testid={`registry-install-${entry.id}`}
                  >
                    Install
                  </Button>
                </div>
              </li>
            ))}
          </ul>
          {reg.data.servers.length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="registry-empty">
              {reg.data.offline
                ? "Registry entries will appear after connectivity returns."
                : "No matches."}
            </p>
          ) : null}
          <div className="flex items-center justify-between">
            <Button
              size="sm"
              variant="outline"
              disabled={page <= 1}
              onClick={() => setPage((p) => p - 1)}
            >
              Prev
            </Button>
            <span className="text-xs text-muted-foreground">
              Page {page} · {reg.data.total} total
            </span>
            <Button
              size="sm"
              variant="outline"
              disabled={page * 25 >= reg.data.total}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </Button>
          </div>
        </>
      ) : null}
      <InstallDialog entry={installEntry} onClose={() => setInstallEntry(null)} />
    </div>
  );
}

function InstallDialog({
  entry,
  onClose,
}: {
  entry: MCPRegistryEntry | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [scope, setScope] = useState<"global" | "project">("global");
  const install = useMutation({
    mutationFn: () => {
      if (!entry) throw new Error("no entry");
      return mcpPlatformApi.install({ registryServerId: entry.id, scope });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.admin.mcp() });
      onClose();
    },
  });
  return (
    <Dialog open={entry != null} onOpenChange={(open) => (open ? null : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Install {entry?.name ?? ""}</DialogTitle>
        </DialogHeader>
        {entry ? (
          <div className="space-y-3">
            <p className="text-sm">{entry.description}</p>
            <div className="text-xs">
              <div>
                Transport: <code>{entry.install?.type ?? "stdio"}</code>
              </div>
              {entry.install?.command ? (
                <div>
                  Command: <code>{entry.install.command}</code>
                </div>
              ) : null}
              {entry.install?.url ? (
                <div>
                  URL: <code>{entry.install.url}</code>
                </div>
              ) : null}
            </div>
            <div>
              <Label>Scope</Label>
              <select
                value={scope}
                onChange={(e) => setScope(e.target.value as "global" | "project")}
                className="w-full rounded border px-2 py-1 text-sm"
                data-testid="install-scope"
              >
                <option value="global">Global</option>
                <option value="project">Project</option>
              </select>
            </div>
            <p className="text-xs text-muted-foreground">
              Trust level defaults to <strong>untrusted</strong>. All tools start as high-risk and
              require approval until you mark the server trusted.
            </p>
            {install.error ? (
              <p className="text-sm text-red-700" data-testid="install-error">
                {errorMessage(install.error)}
              </p>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button
                onClick={() => install.mutate()}
                disabled={install.isPending}
                data-testid="install-confirm"
              >
                {install.isPending ? "Installing…" : "Install"}
              </Button>
            </div>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

// ── Import / Export tab ───────────────────────────────────────────────────────

interface ImportPreview {
  raw: string;
  parsed: { servers: Record<string, unknown> } | null;
  error: string | null;
}

function ImportExportTab() {
  const qc = useQueryClient();
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const exportClick = async () => {
    try {
      const data = await mcpPlatformApi.exportJson();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "mcp.json";
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("export failed", err);
    }
  };
  const onFile = async (file: File) => {
    const text = await file.text();
    try {
      const parsed = JSON.parse(text) as { servers?: Record<string, unknown> };
      if (!parsed.servers || typeof parsed.servers !== "object") {
        setPreview({ raw: text, parsed: null, error: "Missing top-level `servers` object" });
        return;
      }
      setPreview({
        raw: text,
        parsed: { servers: parsed.servers },
        error: null,
      });
    } catch (err) {
      setPreview({ raw: text, parsed: null, error: (err as Error).message });
    }
  };
  const importMutation = useMutation({
    mutationFn: (mcpJson: NonNullable<ImportPreview["parsed"]>) =>
      mcpPlatformApi.importCopilot({ mcpJson }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.admin.mcp() });
      setPreview(null);
    },
  });
  return (
    <div className="space-y-6" data-testid="import-export-tab">
      <Card className="p-4 space-y-3">
        <h2 className="font-semibold">Export</h2>
        <p className="text-sm text-muted-foreground">
          Download all registered servers in Copilot CLI <code>mcp.json</code> format.
        </p>
        <Button onClick={exportClick} data-testid="export-download">
          Download mcp.json
        </Button>
      </Card>
      <Card className="p-4 space-y-3">
        <h2 className="font-semibold">Import</h2>
        <p className="text-sm text-muted-foreground">
          Drop a Copilot <code>mcp.json</code> file. Secret-shaped env vars (matching{" "}
          <code>_TOKEN/_KEY/_PASSWORD/_SECRET/PAT</code>) will be routed to the encrypted vault.
        </p>
        <input
          type="file"
          accept="application/json,.json"
          data-testid="import-file"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void onFile(f);
          }}
        />
        {preview ? (
          <div className="rounded border bg-muted p-2 text-xs">
            {preview.error ? (
              <div className="text-red-700" data-testid="import-error">
                {preview.error}
              </div>
            ) : preview.parsed ? (
              <div data-testid="import-preview">
                <div className="font-medium">
                  {Object.keys(preview.parsed.servers).length} server(s) to import:
                </div>
                <ul className="list-disc pl-5">
                  {Object.keys(preview.parsed.servers).map((name) => (
                    <li key={name}>{name}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        ) : null}
        <div className="flex gap-2">
          <Button
            onClick={() => {
              if (preview?.parsed) importMutation.mutate(preview.parsed);
            }}
            disabled={!preview?.parsed || importMutation.isPending}
            data-testid="import-confirm"
          >
            {importMutation.isPending ? "Importing…" : "Import"}
          </Button>
          {preview ? (
            <Button variant="outline" onClick={() => setPreview(null)}>
              Clear
            </Button>
          ) : null}
        </div>
        {importMutation.error ? (
          <p className="text-sm text-red-700" data-testid="import-server-error">
            {errorMessage(importMutation.error)}
          </p>
        ) : null}
      </Card>
    </div>
  );
}

// ── Approval prompt component (chat-side, exported for tests) ────────────────

export interface ApprovalPromptData {
  approvalId: string;
  serverId: string;
  serverLabel: string;
  toolName: string;
  args: unknown;
  hiddenChars: MCPHiddenCharRange[];
}

export function McpApprovalPrompt({
  data,
  onDecide,
}: {
  data: ApprovalPromptData;
  onDecide: (decision: "approved" | "denied") => void;
}) {
  const argsText = useMemo(() => JSON.stringify(data.args, null, 2), [data.args]);
  const badgeCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const r of data.hiddenChars) map.set(r.label, (map.get(r.label) ?? 0) + 1);
    return Array.from(map.entries());
  }, [data.hiddenChars]);
  return (
    <div
      role="dialog"
      aria-label="MCP tool approval required"
      className="rounded border border-amber-300 bg-amber-50 p-3 text-sm space-y-2"
      data-testid="mcp-approval-prompt"
    >
      <div className="font-medium">
        {data.serverLabel} → <code>{data.toolName}</code>
      </div>
      {badgeCounts.length > 0 ? (
        <div className="flex flex-wrap gap-1" data-testid="approval-badges">
          {badgeCounts.map(([label, count]) => (
            <span
              key={label}
              data-testid={`hidden-char-badge-${label}`}
              className="rounded bg-red-200 px-2 py-0.5 text-xs text-red-900"
            >
              {label} ×{count}
            </span>
          ))}
        </div>
      ) : null}
      <pre className="overflow-x-auto rounded bg-white p-2 text-xs">{argsText}</pre>
      <div className="flex gap-2">
        <Button size="sm" data-testid="approval-approve" onClick={() => onDecide("approved")}>
          Approve
        </Button>
        <Button
          size="sm"
          variant="outline"
          data-testid="approval-deny"
          onClick={() => onDecide("denied")}
        >
          Deny
        </Button>
      </div>
    </div>
  );
}

// ── helpers ──────────────────────────────────────────────────────────────────

function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

// ── Federated tab (Epic #195) ────────────────────────────────────────────────

function FederatedTab() {
  const qc = useQueryClient();
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const [q, setQ] = useState("");
  const [source, setSource] = useState<"federated" | "smithery" | "official" | "local">(
    "federated",
  );
  const [installError, setInstallError] = useState<string | null>(null);

  const search = useQuery({
    queryKey: ["mcp", "federation", "search", q, source],
    queryFn: () => mcpPlatformApi.searchFederated({ q: q || undefined, source, pageSize: 50 }),
    placeholderData: (prev) => prev,
  });

  const refresh = useMutation({
    mutationFn: (s?: "smithery" | "official") => mcpPlatformApi.refreshFederation(s),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["mcp", "federation", "search"], exact: false }),
  });

  const install = useMutation({
    mutationFn: (entryId: string) => mcpPlatformApi.installFederated({ entryId }),
    onSuccess: () => {
      setInstallError(null);
      qc.invalidateQueries({ queryKey: ["mcp", "federation", "search"], exact: false });
      qc.invalidateQueries({ queryKey: queryKeys.admin.mcp() });
    },
    onError: (err) => setInstallError(errorMessage(err)),
  });

  const entries = search.data?.entries ?? [];

  return (
    <section aria-label="Federated MCP registry" className="space-y-4">
      <header className="flex flex-wrap items-center gap-3">
        <input
          type="search"
          placeholder="Search federated registries…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="flex-1 min-w-[16rem] rounded border px-3 py-2 text-sm"
          aria-label="Search federated registries"
        />
        <select
          value={source}
          onChange={(e) =>
            setSource(e.target.value as "federated" | "smithery" | "official" | "local")
          }
          className="rounded border px-2 py-2 text-sm"
          aria-label="Source filter"
        >
          <option value="federated">All federated</option>
          <option value="smithery">Smithery</option>
          <option value="official">Official Registry</option>
          <option value="local">Local mirror</option>
        </select>
        {isAdmin ? (
          <button
            type="button"
            onClick={() => refresh.mutate(undefined)}
            disabled={refresh.isPending}
            className="rounded bg-slate-100 px-3 py-2 text-sm hover:bg-slate-200 disabled:opacity-50"
          >
            {refresh.isPending ? "Refreshing…" : "Refresh both"}
          </button>
        ) : null}
      </header>

      {!isAdmin ? (
        <p className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          Install requires admin approval. You can browse but not install federated servers.
        </p>
      ) : null}

      {installError ? (
        <p
          role="alert"
          className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          {installError}
        </p>
      ) : null}

      {search.isLoading ? <p className="text-sm text-slate-600">Loading…</p> : null}
      {search.error ? (
        <p role="alert" className="text-sm text-red-700">
          {errorMessage(search.error)}
        </p>
      ) : null}

      <ul className="grid gap-3" role="list">
        {entries.map((entry: McpFederationEntry) => (
          <li
            key={entry.id}
            className="rounded border border-slate-200 bg-white p-4 shadow-sm"
            data-testid="federation-entry"
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <h3 className="font-semibold text-slate-900">{entry.name}</h3>
                  <span
                    className="rounded bg-slate-100 px-2 py-0.5 text-xs font-medium uppercase text-slate-700"
                    data-testid="source-badge"
                  >
                    {entry.source}
                  </span>
                  {entry.version ? (
                    <span className="text-xs text-slate-500">v{entry.version}</span>
                  ) : null}
                </div>
                {entry.publisher ? (
                  <p className="text-xs text-slate-500">by {entry.publisher}</p>
                ) : null}
                <p className="mt-1 text-sm text-slate-700">{entry.description}</p>
                <dl className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
                  {entry.downloads != null ? (
                    <div>
                      <dt className="inline">Downloads:</dt>{" "}
                      <dd className="inline font-medium text-slate-700">
                        {entry.downloads.toLocaleString()}
                      </dd>
                    </div>
                  ) : null}
                  {entry.stars != null ? (
                    <div>
                      <dt className="inline">Stars:</dt>{" "}
                      <dd className="inline font-medium text-slate-700">
                        {entry.stars.toLocaleString()}
                      </dd>
                    </div>
                  ) : null}
                  {entry.lastUpdated ? (
                    <div>
                      <dt className="inline">Updated:</dt>{" "}
                      <dd className="inline font-medium text-slate-700">
                        {new Date(entry.lastUpdated).toLocaleDateString()}
                      </dd>
                    </div>
                  ) : null}
                  {entry.sha256 ? (
                    <div title={entry.sha256}>
                      <dt className="inline">sha256:</dt>{" "}
                      <dd className="inline font-mono text-slate-700">
                        {entry.sha256.slice(0, 12)}…
                      </dd>
                    </div>
                  ) : null}
                </dl>
              </div>
              <button
                type="button"
                onClick={() => install.mutate(entry.id)}
                disabled={!isAdmin || install.isPending || entry.source === "local"}
                className="rounded bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
                data-testid="install-button"
                aria-label={`Install ${entry.name}`}
              >
                {entry.source === "local"
                  ? "Installed"
                  : install.isPending
                    ? "Installing…"
                    : "Install"}
              </button>
            </div>
          </li>
        ))}
        {!search.isLoading && entries.length === 0 ? (
          <li className="text-sm text-slate-500">No matching servers.</li>
        ) : null}
      </ul>
    </section>
  );
}
