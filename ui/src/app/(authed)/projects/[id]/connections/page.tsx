"use client";

/**
 * Connections tab — Phase 8.
 *
 * Lists repo + database connectors for a project, with simple add/edit/delete,
 * test, and (for DB) ad-hoc read-only query forms. UI is intentionally
 * minimal — production polish would split each section into dedicated
 * components.
 */
import { useParams } from "next/navigation";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError } from "@/lib/api-client";
import { toast } from "sonner";
import {
  repoConnectorsApi,
  dbConnectorsApi,
  suggestedConnectorsApi,
  type ConnectorTestResult,
  type DeepIngestSummary,
  type RefreshIngestSummary,
  type SuggestedConnector,
} from "@/lib/connectors-api";
import { projectsApi } from "@/lib/projects-api";
import { VaultPicker } from "@/components/connectors/vault-picker";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { useConnectorProgress, useConnectorDiscovery } from "@/hooks/use-connector-events";
import { DbConnectorWizard } from "@/components/connectors/db-connector-wizard";
import { DatabaseResourceManager } from "@/components/connectors/database-resource-manager";
import { RebuildCacheButton } from "@/components/projects/rebuild-cache-button";

const repoKeys = {
  list: (pid: string) => ["connectors", "repos", pid] as const,
};
const dbKeys = {
  list: (pid: string) => ["connectors", "dbs", pid] as const,
};
const suggestedKeys = {
  list: (pid: string) => ["connectors", "suggested", pid] as const,
};
const projectKeys = {
  detail: (pid: string) => ["project", pid] as const,
};

function statusBadge(status: string): string {
  switch (status) {
    case "ready":
      return "bg-emerald-100 text-emerald-700";
    case "error":
      return "bg-red-100 text-red-700";
    case "testing":
      return "bg-amber-100 text-amber-700";
    default:
      return "bg-slate-100 text-slate-700";
  }
}

/** Format a date as a relative time string (e.g., "2h ago", "3d ago"). */
function relativeTime(date: string | Date | null | undefined): string | null {
  if (!date) return null;
  const d = typeof date === "string" ? new Date(date) : date;
  const now = Date.now();
  const diffMs = now - d.getTime();
  if (diffMs < 0) return "just now";
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return "just now";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 30) return `${diffDay}d ago`;
  return d.toLocaleDateString();
}

function isVaultRefOrEmpty(value: string): boolean {
  return value.trim() === "" || /^\$\{vault:[A-Za-z0-9_.\-/:]+\}$/.test(value.trim());
}

/**
 * Split a comma/newline-separated identifier list into a trimmed, de-duplicated
 * array. Used by the DB connector allow-list editor (#882).
 */
function splitIdentifiers(raw: string): string[] {
  const seen = new Set<string>();
  for (const part of raw.split(/[\n,]/)) {
    const id = part.trim();
    if (id) seen.add(id);
  }
  return [...seen];
}

export default function ConnectionsPage() {
  const params = useParams<{ id: string }>();
  const projectId = params?.id ?? "";
  const qc = useQueryClient();

  // Socket.IO real-time progress + discovery (#664, #669)
  const { progressMap, clearProgress } = useConnectorProgress(projectId);
  useConnectorDiscovery(projectId, () => {
    qc.invalidateQueries({ queryKey: suggestedKeys.list(projectId) });
  });

  const repos = useQuery({
    queryKey: repoKeys.list(projectId),
    queryFn: () => repoConnectorsApi.list(projectId),
    enabled: Boolean(projectId),
  });
  const dbs = useQuery({
    queryKey: dbKeys.list(projectId),
    queryFn: async () => (await dbConnectorsApi.list(projectId)) ?? [],
    enabled: Boolean(projectId),
  });

  const suggested = useQuery({
    queryKey: suggestedKeys.list(projectId),
    queryFn: () => suggestedConnectorsApi.list(projectId, "pending"),
    enabled: Boolean(projectId),
  });

  const dismissSuggestion = useMutation({
    mutationFn: (id: string) => suggestedConnectorsApi.updateStatus(projectId, id, "dismissed"),
    onSuccess: () => qc.invalidateQueries({ queryKey: suggestedKeys.list(projectId) }),
  });

  // ── Wizard state (Epic #701) ───────────────────────────────────────────
  const [wizardSuggestion, setWizardSuggestion] = useState<SuggestedConnector | null>(null);

  // ── Per-project "allow credential scan" toggle (Epic #701) ─────────────
  const project = useQuery({
    queryKey: projectKeys.detail(projectId),
    queryFn: () => projectsApi.get(projectId),
    enabled: Boolean(projectId),
  });
  const toggleAllowCredentialScan = useMutation({
    mutationFn: (value: boolean) =>
      projectsApi.updateAllowCredentialScan(projectId, { allowCredentialScan: value }),
    onSuccess: (_data, value) => {
      qc.invalidateQueries({ queryKey: projectKeys.detail(projectId) });
      if (value) {
        // Enabling — offer to rescan existing repos for credentials
        const primaryRepo = (repos.data ?? []).find((r) => r.isPrimary) ?? (repos.data ?? [])[0];
        if (primaryRepo) {
          toast("Credential scan enabled. Rescan repository now?", {
            action: {
              label: "Rescan",
              onClick: () => rescanCredentials.mutate(primaryRepo.id),
            },
            duration: 8000,
          });
        } else {
          toast.success("Credential scan enabled. Will run on next repo ingest.");
        }
      } else {
        toast.success("Credential scan disabled.");
      }
    },
    onError: (err: unknown) => {
      toast.error(err instanceof ApiError ? err.message : "Failed to update setting.");
    },
  });

  const rescanCredentials = useMutation({
    mutationFn: (repoId: string) => repoConnectorsApi.rescanCredentials(projectId, repoId),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: suggestedKeys.list(projectId) });
      if (data.connectionsFound > 0) {
        toast.success(
          `Rescan complete: ${data.connectionsFound} connection(s) found, ${data.suggestionsUpserted} updated.`,
        );
      } else {
        toast.success("Rescan complete. No new credentials discovered.");
      }
    },
    onError: (err: unknown) => {
      toast.error(err instanceof ApiError ? err.message : "Credential rescan failed.");
    },
  });

  // ── Inline branch edit state ──────────────────────────────────────────
  const [editingBranchId, setEditingBranchId] = useState<string | null>(null);
  const [editBranchValue, setEditBranchValue] = useState("");

  const updateRepoBranch = useMutation({
    mutationFn: ({ id, branch }: { id: string; branch: string }) =>
      repoConnectorsApi.update(projectId, id, { defaultBranch: branch }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: repoKeys.list(projectId) });
      setEditingBranchId(null);
      toast.success("Branch updated");
    },
    onError: (err) => {
      toast.error(err instanceof ApiError ? err.message : "Failed to update branch");
    },
  });

  const [editingApiBaseId, setEditingApiBaseId] = useState<string | null>(null);
  const [editApiBaseValue, setEditApiBaseValue] = useState("");

  const [editingSecretId, setEditingSecretId] = useState<string | null>(null);
  const [editSecretValue, setEditSecretValue] = useState("");

  const updateRepoSecret = useMutation({
    mutationFn: ({ id, secretRef }: { id: string; secretRef: string }) =>
      repoConnectorsApi.update(projectId, id, { secretRef: secretRef.trim() || undefined }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: repoKeys.list(projectId) });
      setEditingSecretId(null);
      toast.success("Secret updated");
    },
    onError: (err) => {
      toast.error(err instanceof ApiError ? err.message : "Failed to update secret");
    },
  });

  const updateRepoApiBase = useMutation({
    mutationFn: ({ id, apiBaseUrl }: { id: string; apiBaseUrl: string }) =>
      repoConnectorsApi.update(projectId, id, {
        apiBaseUrl: apiBaseUrl.trim() || null,
        provider: apiBaseUrl.trim() ? "github_enterprise" : "github",
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: repoKeys.list(projectId) });
      setEditingApiBaseId(null);
      toast.success("API base URL updated");
    },
    onError: (err) => {
      toast.error(err instanceof ApiError ? err.message : "Failed to update API base URL");
    },
  });

  // ── Repo form state ────────────────────────────────────────────────────
  const [repoLabel, setRepoLabel] = useState("");
  const [repoOwner, setRepoOwner] = useState("");
  const [repoName, setRepoName] = useState("");
  const [repoApiBase, setRepoApiBase] = useState("");
  const [repoSecretRef, setRepoSecretRef] = useState("");
  const [repoError, setRepoError] = useState<string | null>(null);
  // Issue #288 — non-git source types: GitHub | Local server path | Upload .zip
  const [repoSource, setRepoSource] = useState<"github" | "local" | "upload">("github");
  const [repoLocalPath, setRepoLocalPath] = useState("");
  const [repoUploadFile, setRepoUploadFile] = useState<File | null>(null);

  function resetRepoForm() {
    setRepoLabel("");
    setRepoOwner("");
    setRepoName("");
    setRepoApiBase("");
    setRepoSecretRef("");
    setRepoLocalPath("");
    setRepoUploadFile(null);
    setRepoError(null);
    qc.invalidateQueries({ queryKey: repoKeys.list(projectId) });
  }

  const createLocalRepo = useMutation({
    mutationFn: () =>
      repoConnectorsApi.createLocal(projectId, {
        label: repoLabel.trim(),
        localPath: repoLocalPath.trim(),
      }),
    onSuccess: () => {
      resetRepoForm();
      toast.success("Local directory connector created");
    },
    onError: (err) => {
      setRepoError(err instanceof ApiError ? err.message : "Failed");
      toast.error("Failed to create local connector");
    },
  });

  const createUploadRepo = useMutation({
    mutationFn: () => {
      if (!repoUploadFile) throw new ApiError(400, "Select a .zip file first");
      return repoConnectorsApi.createUpload(projectId, repoLabel.trim(), repoUploadFile);
    },
    onSuccess: () => {
      resetRepoForm();
      toast.success("Folder upload connector created");
    },
    onError: (err) => {
      setRepoError(err instanceof ApiError ? err.message : "Failed");
      toast.error("Failed to create upload connector");
    },
  });

  const createRepo = useMutation({
    mutationFn: () =>
      repoConnectorsApi.create(projectId, {
        label: repoLabel.trim(),
        provider: repoApiBase ? "github_enterprise" : "github",
        ownerOrOrg: repoOwner.trim(),
        repoName: repoName.trim(),
        apiBaseUrl: repoApiBase.trim() || undefined,
        secretRef: repoSecretRef.trim() || undefined,
      }),
    onSuccess: () => {
      setRepoLabel("");
      setRepoOwner("");
      setRepoName("");
      setRepoApiBase("");
      setRepoSecretRef("");
      setRepoError(null);
      qc.invalidateQueries({ queryKey: repoKeys.list(projectId) });
      toast.success("Repository connector created");
    },
    onError: (err) => {
      setRepoError(err instanceof ApiError ? err.message : "Failed");
      toast.error("Failed to create repository connector");
    },
  });

  const removeRepo = useMutation({
    mutationFn: (id: string) => repoConnectorsApi.remove(projectId, id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: repoKeys.list(projectId) });
      toast.success("Repository connector removed");
    },
  });
  const testRepo = useMutation({
    mutationFn: (id: string) => repoConnectorsApi.test(projectId, id),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: repoKeys.list(projectId) });
      if (data.ok) toast.success(`Test passed (${data.latencyMs}ms)`);
      else toast.error(data.message ?? "Test failed");
    },
  });
  const [deepIngestResult, setDeepIngestResult] = useState<{
    connectorId: string;
    summary: DeepIngestSummary;
  } | null>(null);
  const deepIngestRepo = useMutation({
    mutationFn: (id: string) => repoConnectorsApi.deepIngest(projectId, id),
    onSuccess: (data, id) => {
      setDeepIngestResult({ connectorId: id, summary: data });
      setRefreshIngestResult(null);
      qc.invalidateQueries({ queryKey: repoKeys.list(projectId) });
      qc.invalidateQueries({ queryKey: suggestedKeys.list(projectId) });
      toast.success("Deep ingest complete");
    },
    onError: (err, id) => {
      toast.error(err instanceof ApiError ? err.message : "Deep ingest failed");
      clearProgress(id);
    },
  });
  const [refreshIngestResult, setRefreshIngestResult] = useState<{
    connectorId: string;
    summary: RefreshIngestSummary;
  } | null>(null);
  const refreshIngestRepo = useMutation({
    mutationFn: (id: string) => repoConnectorsApi.refreshIngest(projectId, id),
    onSuccess: (data, id) => {
      setRefreshIngestResult({ connectorId: id, summary: data });
      setDeepIngestResult(null);
      qc.invalidateQueries({ queryKey: repoKeys.list(projectId) });
      qc.invalidateQueries({ queryKey: suggestedKeys.list(projectId) });
      toast.success("Sync complete");
    },
    onError: (err, id) => {
      toast.error(err instanceof ApiError ? err.message : "Sync failed");
      clearProgress(id);
    },
  });
  const isRepoIngesting = deepIngestRepo.isPending || refreshIngestRepo.isPending;

  const setPrimary = useMutation({
    mutationFn: (id: string) => repoConnectorsApi.setPrimary(projectId, id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: repoKeys.list(projectId) });
      qc.invalidateQueries({ queryKey: ["connectors", "repos", projectId, "primary"] });
    },
  });

  // ── DB form state ──────────────────────────────────────────────────────
  const [dbLabel, setDbLabel] = useState("");
  const [dbDriver, setDbDriver] = useState("postgres");
  const [dbHost, setDbHost] = useState("");
  const [dbPort, setDbPort] = useState("");
  const [dbDatabase, setDbDatabase] = useState("");
  const [dbUsername, setDbUsername] = useState("");
  const [dbSecretRef, setDbSecretRef] = useState("");
  // #882 — per-connector table/column allow-list (defense-in-depth for AI DB
  // tools). Comma/newline-separated; serialized into `options.allowList`.
  const [dbAllowTables, setDbAllowTables] = useState("");
  const [dbAllowColumns, setDbAllowColumns] = useState("");
  const [dbError, setDbError] = useState<string | null>(null);

  const createDb = useMutation({
    mutationFn: () => {
      const allowTables = splitIdentifiers(dbAllowTables);
      const allowColumns = splitIdentifiers(dbAllowColumns);
      const options =
        allowTables.length > 0 || allowColumns.length > 0
          ? JSON.stringify({
              allowList: {
                tables: allowTables,
                ...(allowColumns.length > 0 ? { columns: allowColumns } : {}),
              },
            })
          : undefined;
      return dbConnectorsApi.create(projectId, {
        label: dbLabel.trim(),
        driver: dbDriver as "postgres" | "mysql" | "oracle" | "sqlserver",
        host: dbHost.trim() || undefined,
        port: dbPort ? Number(dbPort) : undefined,
        databaseName: dbDatabase.trim() || undefined,
        username: dbUsername.trim() || undefined,
        secretRef: dbSecretRef.trim() || undefined,
        options,
      });
    },
    onSuccess: () => {
      setDbLabel("");
      setDbHost("");
      setDbPort("");
      setDbDatabase("");
      setDbUsername("");
      setDbSecretRef("");
      setDbAllowTables("");
      setDbAllowColumns("");
      setDbError(null);
      qc.invalidateQueries({ queryKey: dbKeys.list(projectId) });
      toast.success("Database connector created");
    },
    onError: (err) => {
      setDbError(err instanceof ApiError ? err.message : "Failed");
      toast.error("Failed to create database connector");
    },
  });

  const removeDb = useMutation({
    mutationFn: (id: string) => dbConnectorsApi.remove(projectId, id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: dbKeys.list(projectId) });
      toast.success("Database connector removed");
    },
  });
  const testDb = useMutation({
    mutationFn: (id: string) => dbConnectorsApi.test(projectId, id),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: dbKeys.list(projectId) });
      if (data.ok) toast.success(`Test passed (${data.latencyMs}ms)`);
      else toast.error(data.message ?? "Test failed");
    },
  });
  const ingestDb = useMutation({
    mutationFn: (id: string) => dbConnectorsApi.ingest(projectId, id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: dbKeys.list(projectId) });
      toast.success("Database ingest started");
    },
  });

  // ── Ad-hoc query ───────────────────────────────────────────────────────
  const [queryDbId, setQueryDbId] = useState<string>("");
  const [sql, setSql] = useState<string>("SELECT 1");
  const [queryResult, setQueryResult] = useState<unknown>(null);
  const [queryError, setQueryError] = useState<string | null>(null);
  const runQuery = useMutation({
    mutationFn: () => dbConnectorsApi.query(projectId, queryDbId, sql),
    onSuccess: (data) => {
      setQueryResult(data);
      setQueryError(null);
    },
    onError: (err) => {
      setQueryResult(null);
      setQueryError(err instanceof ApiError ? err.message : "Query failed");
    },
  });

  const testResultMessage = useMemo(() => {
    const r = (testRepo.data ?? testDb.data) as ConnectorTestResult | undefined;
    if (!r) return null;
    return r.ok ? `OK in ${r.latencyMs}ms` : (r.message ?? "Failed");
  }, [testRepo.data, testDb.data]);
  const repoFormValid =
    repoLabel.trim().length > 0 &&
    repoOwner.trim().length > 0 &&
    repoName.trim().length > 0 &&
    isVaultRefOrEmpty(repoSecretRef);

  if (!projectId) return <div className="p-6">Invalid project id.</div>;

  return (
    <div className="space-y-8 p-6">
      <header>
        <h1 className="text-2xl font-semibold">
          Connections
          {(suggested.data?.count ?? 0) > 0 && (
            <Badge variant="secondary" className="ml-2 align-middle">
              {suggested.data!.count} suggestion{suggested.data!.count > 1 ? "s" : ""}
            </Badge>
          )}
        </h1>
        <p className="text-sm text-muted-foreground">
          Repo and database connectors for this project. Secrets are stored as vault references —
          never as plaintext.
        </p>
        {testResultMessage ? (
          <p className="mt-2 text-sm text-muted-foreground">
            Last test: <span className="font-mono">{testResultMessage}</span>
          </p>
        ) : null}
        <div className="mt-3 flex items-center gap-2">
          <input
            id="allow-credential-scan"
            type="checkbox"
            className="h-4 w-4 cursor-pointer accent-emerald-600"
            data-testid="allow-credential-scan-toggle"
            checked={project.data?.allowCredentialScan === true}
            disabled={!project.data || toggleAllowCredentialScan.isPending}
            onChange={(e) => toggleAllowCredentialScan.mutate(e.target.checked)}
          />
          <label htmlFor="allow-credential-scan" className="cursor-pointer text-sm">
            Allow credential scan during repo discovery
            <span className="ml-2 text-xs text-muted-foreground">
              (passwords from <span className="font-mono">.env*</span> are vaulted; opt-in only)
            </span>
          </label>
        </div>
      </header>

      {/* ── Suggested connectors (Epic #467) ────────────────────────── */}
      {(suggested.data?.count ?? 0) > 0 && (
        <section className="space-y-3">
          <h2 className="text-lg font-medium">Suggested Database Connectors</h2>
          <p className="text-sm text-muted-foreground">
            These database connections were discovered in your repository code. Connect to pre-fill
            a new database connector, or dismiss to hide.
          </p>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {suggested.data!.suggestions.map((s: SuggestedConnector) => (
              <Card key={s.id} className="flex flex-col gap-2 p-4">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-semibold capitalize">{s.driverType}</span>
                  <Badge
                    variant={
                      s.confidence === "high"
                        ? "default"
                        : s.confidence === "medium"
                          ? "secondary"
                          : "outline"
                    }
                  >
                    {s.confidence}
                  </Badge>
                </div>
                <p className="font-mono text-sm text-muted-foreground">
                  {s.host ? `${s.host}${s.port ? `:${s.port}` : ""}` : "(no host)"}
                  {s.database ? `/${s.database}` : ""}
                </p>
                <p className="truncate text-xs text-muted-foreground" title={s.sourceFile}>
                  {s.sourceFile}:{s.lineNumber}
                </p>
                <div className="mt-auto flex gap-2 pt-2">
                  <Button size="sm" onClick={() => setWizardSuggestion(s)}>
                    Configure
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => dismissSuggestion.mutate(s.id)}
                  >
                    Dismiss
                  </Button>
                </div>
              </Card>
            ))}
          </div>
        </section>
      )}

      {/* ── Repo connectors ─────────────────────────────────────────── */}
      <section className="space-y-3">
        <h2 className="text-lg font-medium">Repository connectors</h2>
        <Card className="space-y-3 p-4">
          <div>
            <Label htmlFor="repo-source">Source</Label>
            <select
              id="repo-source"
              data-testid="repo-source-select"
              className="w-full rounded border bg-background px-2 py-1 text-sm"
              value={repoSource}
              onChange={(e) => {
                setRepoSource(e.target.value as "github" | "local" | "upload");
                setRepoError(null);
              }}
            >
              <option value="github">GitHub repository</option>
              <option value="local">Local directory (server path)</option>
              <option value="upload">Upload folder (.zip)</option>
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="repo-label">Label</Label>
              <Input
                id="repo-label"
                value={repoLabel}
                onChange={(e) => setRepoLabel(e.target.value)}
              />
            </div>
            {repoSource === "github" && (
              <>
                <div>
                  <Label htmlFor="repo-owner">Owner / org</Label>
                  <Input
                    id="repo-owner"
                    value={repoOwner}
                    onChange={(e) => setRepoOwner(e.target.value)}
                  />
                </div>
                <div>
                  <Label htmlFor="repo-name">Repo name</Label>
                  <Input
                    id="repo-name"
                    value={repoName}
                    onChange={(e) => setRepoName(e.target.value)}
                  />
                </div>
                <div>
                  <Label htmlFor="repo-base">GitHub Enterprise URL</Label>
                  <Input
                    id="repo-base"
                    value={repoApiBase}
                    onChange={(e) => setRepoApiBase(e.target.value)}
                    placeholder="https://git.example.com"
                  />
                </div>
                <div className="col-span-2">
                  <Label htmlFor="repo-secret">Secret ref (vault)</Label>
                  <VaultPicker
                    id="repo-secret"
                    value={repoSecretRef}
                    onChange={setRepoSecretRef}
                    placeholder="${vault:my-token-label}"
                  />
                </div>
              </>
            )}
            {repoSource === "local" && (
              <div className="col-span-2">
                <Label htmlFor="repo-local-path">Server directory path</Label>
                <Input
                  id="repo-local-path"
                  data-testid="repo-local-path"
                  value={repoLocalPath}
                  onChange={(e) => setRepoLocalPath(e.target.value)}
                  placeholder="/srv/code/my-app"
                />
                <p className="mt-1 text-xs text-muted-foreground">
                  Must be inside an allowlisted{" "}
                  <span className="font-mono">LOCAL_SOURCE_ROOTS</span> directory. Requires admin.
                </p>
              </div>
            )}
            {repoSource === "upload" && (
              <div className="col-span-2">
                <Label htmlFor="repo-upload">Folder archive (.zip)</Label>
                <input
                  id="repo-upload"
                  data-testid="repo-upload-input"
                  type="file"
                  accept=".zip,application/zip"
                  className="w-full text-sm"
                  onChange={(e) => setRepoUploadFile(e.target.files?.[0] ?? null)}
                />
              </div>
            )}
          </div>
          <div className="flex items-center gap-2">
            {repoSource === "github" && (
              <Button
                data-testid="add-repo-github"
                onClick={() => createRepo.mutate()}
                disabled={!repoFormValid || createRepo.isPending}
              >
                Add repo connector
              </Button>
            )}
            {repoSource === "local" && (
              <Button
                data-testid="add-repo-local"
                onClick={() => createLocalRepo.mutate()}
                disabled={
                  repoLabel.trim().length === 0 ||
                  repoLocalPath.trim().length === 0 ||
                  createLocalRepo.isPending
                }
              >
                Add local directory
              </Button>
            )}
            {repoSource === "upload" && (
              <Button
                data-testid="add-repo-upload"
                onClick={() => createUploadRepo.mutate()}
                disabled={
                  repoLabel.trim().length === 0 || !repoUploadFile || createUploadRepo.isPending
                }
              >
                Upload folder
              </Button>
            )}
            {repoSource === "github" && !isVaultRefOrEmpty(repoSecretRef) ? (
              <span className="text-sm text-red-600">
                Secret ref must look like ${"${vault:name}"}.
              </span>
            ) : null}
            {repoError ? <span className="text-sm text-red-600">{repoError}</span> : null}
          </div>
        </Card>

        <ul className="space-y-2">
          {(repos.data ?? []).map((r) => (
            <li key={r.id}>
              <Card className="flex flex-col p-3">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{r.label}</span>
                      {r.isPrimary && (
                        <Badge
                          className="bg-indigo-100 text-indigo-700"
                          data-testid="primary-badge"
                        >
                          Primary
                        </Badge>
                      )}
                    </div>
                    {r.provider === "local" || r.provider === "upload" ? (
                      <div className="flex items-center gap-2 font-mono text-xs text-muted-foreground">
                        {r.provider} ·{" "}
                        {r.provider === "local"
                          ? r.hasLocalSource
                            ? "(server directory)"
                            : "(no source)"
                          : "(uploaded .zip)"}
                      </div>
                    ) : (
                      <div className="flex items-center gap-2 font-mono text-xs text-muted-foreground">
                        {r.provider} · {r.ownerOrOrg}/{r.repoName}@
                        {editingBranchId === r.id ? (
                          <span className="flex items-center gap-1">
                            <input
                              className="h-5 w-32 rounded border bg-background px-1 font-mono text-xs"
                              value={editBranchValue}
                              onChange={(e) => setEditBranchValue(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter")
                                  updateRepoBranch.mutate({
                                    id: r.id,
                                    branch: editBranchValue.trim(),
                                  });
                                if (e.key === "Escape") setEditingBranchId(null);
                              }}
                              autoFocus
                            />
                            <Button
                              size="sm"
                              className="h-5 px-1 text-xs"
                              onClick={() =>
                                updateRepoBranch.mutate({
                                  id: r.id,
                                  branch: editBranchValue.trim(),
                                })
                              }
                              disabled={updateRepoBranch.isPending || !editBranchValue.trim()}
                            >
                              Save
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-5 px-1 text-xs"
                              onClick={() => setEditingBranchId(null)}
                            >
                              ✕
                            </Button>
                          </span>
                        ) : (
                          <button
                            className="underline decoration-dotted hover:text-foreground"
                            title="Click to change branch"
                            onClick={() => {
                              setEditingBranchId(r.id);
                              setEditBranchValue(r.defaultBranch);
                            }}
                          >
                            {r.defaultBranch}
                          </button>
                        )}
                      </div>
                    )}
                    {r.errorMessage ? (
                      <div className="mt-1 text-xs text-red-600">{r.errorMessage}</div>
                    ) : null}
                    <div className="flex items-center gap-1 font-mono text-xs text-muted-foreground">
                      <span className="shrink-0 text-muted-foreground/60">Token:</span>
                      {editingSecretId === r.id ? (
                        <span className="flex items-center gap-1">
                          <input
                            className="h-5 w-64 rounded border bg-background px-1 font-mono text-xs"
                            value={editSecretValue}
                            onChange={(e) => setEditSecretValue(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" && isVaultRefOrEmpty(editSecretValue))
                                updateRepoSecret.mutate({ id: r.id, secretRef: editSecretValue });
                              if (e.key === "Escape") setEditingSecretId(null);
                            }}
                            placeholder="${vault:my-token-label}"
                            autoFocus
                          />
                          <Button
                            size="sm"
                            className="h-5 px-1 text-xs"
                            onClick={() =>
                              updateRepoSecret.mutate({ id: r.id, secretRef: editSecretValue })
                            }
                            disabled={
                              updateRepoSecret.isPending || !isVaultRefOrEmpty(editSecretValue)
                            }
                          >
                            Save
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-5 px-1 text-xs"
                            onClick={() => setEditingSecretId(null)}
                          >
                            ✕
                          </Button>
                        </span>
                      ) : (
                        <button
                          className="underline decoration-dotted hover:text-foreground"
                          title="Click to set vault secret reference (e.g. ${vault:github-pat})"
                          onClick={() => {
                            setEditingSecretId(r.id);
                            setEditSecretValue(r.secretRef ?? "");
                          }}
                        >
                          {r.secretRef ? (
                            r.secretRef
                          ) : (
                            <span className="italic text-amber-500">not set — click to add</span>
                          )}
                        </button>
                      )}
                    </div>
                    {r.provider === "github_enterprise" && (
                      <div className="flex items-center gap-1 font-mono text-xs text-muted-foreground">
                        <span className="shrink-0">API:</span>
                        {editingApiBaseId === r.id ? (
                          <span className="flex items-center gap-1">
                            <input
                              className="h-5 w-64 rounded border bg-background px-1 font-mono text-xs"
                              value={editApiBaseValue}
                              onChange={(e) => setEditApiBaseValue(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter")
                                  updateRepoApiBase.mutate({
                                    id: r.id,
                                    apiBaseUrl: editApiBaseValue.trim(),
                                  });
                                if (e.key === "Escape") setEditingApiBaseId(null);
                              }}
                              placeholder="https://git.example.com/api/v3"
                              autoFocus
                            />
                            <Button
                              size="sm"
                              className="h-5 px-1 text-xs"
                              onClick={() =>
                                updateRepoApiBase.mutate({
                                  id: r.id,
                                  apiBaseUrl: editApiBaseValue.trim(),
                                })
                              }
                              disabled={updateRepoApiBase.isPending}
                            >
                              Save
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-5 px-1 text-xs"
                              onClick={() => setEditingApiBaseId(null)}
                            >
                              ✕
                            </Button>
                          </span>
                        ) : (
                          <button
                            className="underline decoration-dotted hover:text-foreground"
                            title="Click to change API base URL (e.g. https://git.example.com/api/v3)"
                            onClick={() => {
                              setEditingApiBaseId(r.id);
                              setEditApiBaseValue(r.apiBaseUrl ?? "");
                            }}
                          >
                            {r.apiBaseUrl || (
                              <span className="italic text-muted-foreground/60">not set</span>
                            )}
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`rounded px-2 py-0.5 text-xs ${statusBadge(r.status)}`}>
                      {r.status}
                    </span>
                    {!r.isPrimary && (repos.data ?? []).length > 1 && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setPrimary.mutate(r.id)}
                        disabled={setPrimary.isPending}
                        data-testid={`set-primary-${r.id}`}
                      >
                        Set as primary
                      </Button>
                    )}
                    <Button size="sm" variant="outline" onClick={() => testRepo.mutate(r.id)}>
                      Test
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => refreshIngestRepo.mutate(r.id)}
                      disabled={isRepoIngesting}
                      title="Pull latest commits and re-ingest changed files"
                    >
                      {refreshIngestRepo.isPending && refreshIngestRepo.variables === r.id
                        ? "Syncing…"
                        : "Sync"}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => deepIngestRepo.mutate(r.id)}
                      disabled={isRepoIngesting}
                      title="Fresh clone and full re-ingest (first-time setup)"
                    >
                      {deepIngestRepo.isPending && deepIngestRepo.variables === r.id
                        ? "Ingesting…"
                        : "Deep Ingest"}
                    </Button>
                    <RebuildCacheButton projectId={projectId} repoId={r.id} />
                    <Button size="sm" variant="destructive" onClick={() => removeRepo.mutate(r.id)}>
                      Delete
                    </Button>
                  </div>
                </div>
                {progressMap[r.id] && (
                  <div className="mt-2 space-y-1" data-testid={`progress-${r.id}`}>
                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                      <span>{progressMap[r.id].step}</span>
                      <span>
                        {progressMap[r.id].current}/{progressMap[r.id].total}
                      </span>
                    </div>
                    <Progress
                      value={
                        progressMap[r.id].total
                          ? ((progressMap[r.id].current ?? 0) / progressMap[r.id].total!) * 100
                          : 0
                      }
                    />
                  </div>
                )}
              </Card>
            </li>
          ))}
          {!repos.isLoading && (repos.data ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">No repo connectors yet.</p>
          ) : null}
          {deepIngestResult ? (
            <div className="rounded border border-emerald-600/30 bg-emerald-950/20 p-3 text-sm">
              <div className="mb-1 font-medium text-emerald-400">Deep ingest complete</div>
              <div className="grid grid-cols-2 gap-x-6 gap-y-0.5 font-mono text-xs text-zinc-300">
                <span>Files parsed</span>
                <span>
                  {deepIngestResult.summary.codeGraph.filesParsed} /{" "}
                  {deepIngestResult.summary.codeGraph.filesScanned} scanned
                </span>
                <span>Symbols</span>
                <span>{deepIngestResult.summary.codeGraph.symbolsUpserted.toLocaleString()}</span>
                <span>Edges</span>
                <span>{deepIngestResult.summary.codeGraph.edgesUpserted.toLocaleString()}</span>
                <span>RAG chunks</span>
                <span>
                  {deepIngestResult.summary.sourceKnowledge.chunkCount.toLocaleString()} (
                  {deepIngestResult.summary.sourceKnowledge.documentsCreated} docs)
                </span>
                <span>Clone size</span>
                <span>{(deepIngestResult.summary.cloneSizeBytes / 1024 / 1024).toFixed(1)} MB</span>
              </div>
            </div>
          ) : null}
          {refreshIngestResult ? (
            <div className="rounded border border-sky-600/30 bg-sky-950/20 p-3 text-sm">
              <div className="mb-1 font-medium text-sky-400">
                Sync complete &mdash;{" "}
                {refreshIngestResult.summary.pulled
                  ? `pulled ${refreshIngestResult.summary.filesChanged} changed file${refreshIngestResult.summary.filesChanged === 1 ? "" : "s"}`
                  : "fresh clone (pull failed)"}
              </div>
              <div className="grid grid-cols-2 gap-x-6 gap-y-0.5 font-mono text-xs text-zinc-300">
                <span>Files re-parsed</span>
                <span>
                  {refreshIngestResult.summary.codeGraph.filesParsed} /{" "}
                  {refreshIngestResult.summary.codeGraph.filesScanned} scanned
                </span>
                <span>Symbols upserted</span>
                <span>
                  {refreshIngestResult.summary.codeGraph.symbolsUpserted.toLocaleString()}
                </span>
                <span>Edges upserted</span>
                <span>{refreshIngestResult.summary.codeGraph.edgesUpserted.toLocaleString()}</span>
                <span>RAG chunks</span>
                <span>
                  +{refreshIngestResult.summary.sourceKnowledge.documentsCreated} new ·{" "}
                  {refreshIngestResult.summary.sourceKnowledge.documentsUpdated} updated ·{" "}
                  {refreshIngestResult.summary.sourceKnowledge.chunkCount.toLocaleString()} total
                </span>
                <span>Took</span>
                <span>
                  {(refreshIngestResult.summary.codeGraph.durationMs / 1000).toFixed(1)} s
                </span>
              </div>
            </div>
          ) : null}
        </ul>
      </section>

      {/* ── DB connectors ───────────────────────────────────────────── */}
      <section className="space-y-3">
        <h2 className="text-lg font-medium">Database connectors</h2>
        <Card className="space-y-3 p-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="db-label">Label</Label>
              <Input id="db-label" value={dbLabel} onChange={(e) => setDbLabel(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="db-driver">Driver</Label>
              <select
                id="db-driver"
                className="mt-1 block w-full rounded border px-2 py-1 text-sm"
                value={dbDriver}
                onChange={(e) => setDbDriver(e.target.value)}
              >
                <option value="postgres">postgres</option>
                <option value="mysql">mysql</option>
                <option value="oracle">oracle</option>
                <option value="sqlserver">sqlserver</option>
              </select>
            </div>
            <div>
              <Label htmlFor="db-host">Host</Label>
              <Input id="db-host" value={dbHost} onChange={(e) => setDbHost(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="db-port">Port</Label>
              <Input
                id="db-port"
                value={dbPort}
                onChange={(e) => setDbPort(e.target.value)}
                inputMode="numeric"
              />
            </div>
            <div>
              <Label htmlFor="db-name">Database</Label>
              <Input
                id="db-name"
                value={dbDatabase}
                onChange={(e) => setDbDatabase(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="db-user">Username</Label>
              <Input
                id="db-user"
                value={dbUsername}
                onChange={(e) => setDbUsername(e.target.value)}
              />
            </div>
            <div className="col-span-2">
              <Label htmlFor="db-secret">Secret ref (vault)</Label>
              <VaultPicker
                id="db-secret"
                value={dbSecretRef}
                onChange={setDbSecretRef}
                placeholder="${vault:my-pw-label}"
              />
            </div>
            <div className="col-span-2">
              <Label htmlFor="db-allow-tables">Allowed tables (optional)</Label>
              <Input
                id="db-allow-tables"
                value={dbAllowTables}
                onChange={(e) => setDbAllowTables(e.target.value)}
                placeholder="people, orders, public.invoices"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                Comma- or newline-separated. When set, AI queries may only touch these tables. Leave
                blank to allow all tables (read-only validation still applies).
              </p>
            </div>
            <div className="col-span-2">
              <Label htmlFor="db-allow-columns">Allowed columns (optional)</Label>
              <Input
                id="db-allow-columns"
                value={dbAllowColumns}
                onChange={(e) => setDbAllowColumns(e.target.value)}
                placeholder="id, name, created_at"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                Optional column allow-list. When set, <code>SELECT *</code> and any non-listed
                column are rejected.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button onClick={() => createDb.mutate()} disabled={!dbLabel || createDb.isPending}>
              Add database connector
            </Button>
            {dbError ? <span className="text-sm text-red-600">{dbError}</span> : null}
          </div>
        </Card>

        <ul className="space-y-2">
          {(dbs.data ?? []).map((d) => (
            <li key={d.id}>
              <Card className="flex items-center justify-between p-3">
                <div>
                  <div className="font-medium">{d.label}</div>
                  <div className="font-mono text-xs text-muted-foreground">
                    {d.driver} · {d.host ?? "—"}
                    {d.port ? `:${d.port}` : ""} / {d.databaseName ?? "—"}
                  </div>
                  <div className="mt-1 flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                    {relativeTime(d.lastTestedAt) && (
                      <span
                        title={
                          d.lastTestedAt ? new Date(d.lastTestedAt).toLocaleString() : undefined
                        }
                      >
                        Tested {relativeTime(d.lastTestedAt)}
                      </span>
                    )}
                    {relativeTime(d.lastIngestAt) && (
                      <span
                        title={
                          d.lastIngestAt ? new Date(d.lastIngestAt).toLocaleString() : undefined
                        }
                      >
                        Ingested {relativeTime(d.lastIngestAt)}
                      </span>
                    )}
                    {!relativeTime(d.lastTestedAt) && !relativeTime(d.lastIngestAt) && (
                      <span className="italic">Never tested or ingested</span>
                    )}
                  </div>
                  {d.errorMessage ? (
                    <div className="mt-1 text-xs text-red-600">{d.errorMessage}</div>
                  ) : null}
                </div>
                <div className="flex items-center gap-2">
                  <span className={`rounded px-2 py-0.5 text-xs ${statusBadge(d.status)}`}>
                    {d.status}
                  </span>
                  <Button size="sm" variant="outline" onClick={() => testDb.mutate(d.id)}>
                    Test
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => ingestDb.mutate(d.id)}>
                    Ingest
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setQueryDbId(d.id)}>
                    Query
                  </Button>
                  <Button size="sm" variant="destructive" onClick={() => removeDb.mutate(d.id)}>
                    Delete
                  </Button>
                </div>
              </Card>
            </li>
          ))}
          {!dbs.isLoading && (dbs.data ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">No database connectors yet.</p>
          ) : null}
        </ul>

        {queryDbId ? (
          <Card className="space-y-2 p-4">
            <Label htmlFor="sql">Read-only SQL (SELECT only)</Label>
            <textarea
              id="sql"
              className="block h-32 w-full rounded border p-2 font-mono text-sm"
              value={sql}
              onChange={(e) => setSql(e.target.value)}
            />
            <div className="flex items-center gap-2">
              <Button onClick={() => runQuery.mutate()} disabled={runQuery.isPending}>
                Run
              </Button>
              <Button variant="outline" onClick={() => setQueryDbId("")}>
                Close
              </Button>
              {queryError ? <span className="text-sm text-red-600">{queryError}</span> : null}
            </div>
            {queryResult ? (
              <pre className="max-h-64 overflow-auto rounded bg-muted p-2 text-xs">
                {JSON.stringify(queryResult, null, 2)}
              </pre>
            ) : null}
          </Card>
        ) : null}
      </section>

      {/* Epic #820 (#828) — shared physical-database identity management. */}
      <section className="space-y-3 border-t border-border pt-6">
        <DatabaseResourceManager
          projectId={projectId}
          workspaceId={project.data ? (project.data.workspaceId ?? null) : undefined}
        />
      </section>
      {wizardSuggestion ? (
        <DbConnectorWizard
          projectId={projectId}
          suggestion={wizardSuggestion}
          open={Boolean(wizardSuggestion)}
          onOpenChange={(o) => {
            if (!o) setWizardSuggestion(null);
          }}
          onProvisioned={() => {
            qc.invalidateQueries({ queryKey: dbKeys.list(projectId) });
            qc.invalidateQueries({ queryKey: suggestedKeys.list(projectId) });
            toast.success("Database connector provisioned");
          }}
        />
      ) : null}
    </div>
  );
}
