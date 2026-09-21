"use client";

/**
 * Test Coverage — project page (Epic #856 issue #865).
 *
 * Sections (top → bottom):
 *
 *   1. Import — file upload (Excel / CSV / Markdown / Gherkin / DOCX) +
 *      paste-as-text fallback.
 *   2. Run history — most-recent first; new-run button.
 *   3. Latest run summary — coverage %, budget, status pill.
 *   4. Coverage matrix — virtualised grid (issue #868).
 *   5. Gap list — uncovered/partial requirements, severity colour.
 *   6. Suggestions — accept / reject / export with low-confidence guard.
 *   7. Export — Excel or Gherkin download.
 *
 * Real-time progress comes from the Socket.IO `testcoverage:*` channel via
 * `useSocket()`; on every event we invalidate the relevant TanStack Query
 * cache slice so the UI stays fresh without polling.
 */
import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { useSocket } from "@/lib/socket-client";
import {
  testCoverageApi,
  downloadBlob,
  type ExportTarget,
  type SuggestionDto,
  type ConnectorSource,
  type ConnectorPullRequest,
} from "@/lib/test-coverage-api";
import { CoverageMatrix } from "@/components/test-coverage/coverage-matrix";
import { testManagementApi } from "@/lib/test-management-api";

function parseGwt(json: string): { given: string[]; when: string[]; then: string[] } {
  try {
    const v = JSON.parse(json) as { given?: string[]; when?: string[]; then?: string[] };
    return { given: v.given ?? [], when: v.when ?? [], then: v.then ?? [] };
  } catch {
    return { given: [], when: [], then: [] };
  }
}

function parseJsonOrEmpty(text: string): Record<string, unknown> {
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Per-connector required-fields hint used by the picker form. */
const CONNECTOR_FIELDS: Record<
  ConnectorSource,
  ReadonlyArray<{ key: string; label: string; type?: "password" | "number" }>
> = {
  jira: [
    { key: "baseUrl", label: "Base URL" },
    { key: "username", label: "Username / email" },
    { key: "apiToken", label: "API token", type: "password" },
    { key: "projectKey", label: "Project key" },
  ],
  xray: [
    { key: "baseUrl", label: "Base URL" },
    { key: "clientId", label: "Client ID" },
    { key: "clientSecret", label: "Client secret", type: "password" },
    { key: "projectKey", label: "Project key" },
  ],
  zephyr: [
    { key: "baseUrl", label: "Base URL" },
    { key: "bearerToken", label: "Bearer token", type: "password" },
    { key: "projectKey", label: "Project key" },
  ],
  testrail: [
    { key: "baseUrl", label: "Base URL" },
    { key: "email", label: "Email" },
    { key: "apiKey", label: "API key", type: "password" },
    { key: "projectId", label: "Project ID", type: "number" },
    { key: "suiteId", label: "Suite ID (optional)", type: "number" },
  ],
};

/**
 * WCAG SC 1.3.5 (#659): map a connector field key to its H98 autocomplete
 * purpose token. Only user-identity fields are tagged — the TestRail login
 * `email` and the Jira `username` (login / account email). Service secrets
 * (apiToken, apiKey, clientSecret, bearerToken) are intentionally left
 * untagged, matching the connections page convention.
 */
function connectorFieldAutoComplete(key: string): "email" | "username" | undefined {
  if (key === "email") return "email";
  if (key === "username") return "username";
  return undefined;
}

function buildConnectorPayload(
  source: ConnectorSource,
  label: string,
  form: Record<string, string>,
  savedConnectionId?: string,
): ConnectorPullRequest {
  // Saved-connection branch: only xray / zephyr / testrail (jira uses inline creds only).
  if (savedConnectionId && source !== "jira") {
    if (source === "xray") {
      return {
        source: "xray",
        label,
        connectionId: savedConnectionId,
        projectKey: form.projectKey ?? "",
      };
    }
    if (source === "zephyr") {
      return {
        source: "zephyr",
        label,
        connectionId: savedConnectionId,
        projectKey: form.projectKey ?? "",
      };
    }
    return {
      source: "testrail",
      label,
      connectionId: savedConnectionId,
      projectId: Number.parseInt(form.projectId ?? "0", 10) || 0,
      suiteId: form.suiteId ? Number.parseInt(form.suiteId, 10) : undefined,
    };
  }
  switch (source) {
    case "jira":
      return {
        source: "jira",
        label,
        edition: "cloud",
        baseUrl: form.baseUrl ?? "",
        username: form.username ?? "",
        apiToken: form.apiToken ?? "",
        projectKey: form.projectKey ?? "",
      };
    case "xray":
      return {
        source: "xray",
        label,
        baseUrl: form.baseUrl ?? "",
        clientId: form.clientId ?? "",
        clientSecret: form.clientSecret ?? "",
        projectKey: form.projectKey ?? "",
      };
    case "zephyr":
      return {
        source: "zephyr",
        label,
        baseUrl: form.baseUrl ?? "",
        bearerToken: form.bearerToken ?? "",
        projectKey: form.projectKey ?? "",
      };
    case "testrail":
      return {
        source: "testrail",
        label,
        baseUrl: form.baseUrl ?? "",
        email: form.email ?? "",
        apiKey: form.apiKey ?? "",
        projectId: Number.parseInt(form.projectId ?? "0", 10) || 0,
        suiteId: form.suiteId ? Number.parseInt(form.suiteId, 10) : undefined,
      };
  }
}

/**
 * Render a numeric value with a fixed number of decimals, falling back to a
 * safe placeholder when the value is missing/undefined/null/NaN. The Test
 * Coverage report once read `report.coveragePercentage` (a field the API
 * never emits — it sends `summary.coveragePct`), so `.toFixed` was called on
 * `undefined` and crashed the whole project view into the error boundary.
 * Every `.toFixed` call site on this page now routes through this guard so a
 * missing number can never throw again.
 */
function safeFixed(value: number | null | undefined, digits: number, fallback = "—"): string {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(digits) : fallback;
}

/** Coerce a possibly-missing number to a finite number (default 0). */
function safeNum(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function severityClass(sev: string): string {
  switch (sev) {
    case "critical":
      return "bg-red-700 text-white";
    case "high":
      return "bg-red-500 text-white";
    case "medium":
      return "bg-amber-500 text-white";
    default:
      return "bg-slate-400 text-white";
  }
}

function statusClass(status: string): string {
  switch (status) {
    case "running":
    case "queued":
      return "bg-blue-500 text-white";
    case "succeeded":
      return "bg-green-600 text-white";
    case "failed":
      return "bg-red-600 text-white";
    default:
      return "bg-slate-400 text-white";
  }
}

export default function TestCoveragePage() {
  const params = useParams<{ id: string }>();
  const projectId = params?.id ?? "";
  const qc = useQueryClient();
  const socket = useSocket();
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const [pasteLabel, setPasteLabel] = useState("Pasted cases");
  const [pasteSource, setPasteSource] = useState<"csv" | "markdown" | "gherkin">("csv");
  const [activeSuggestion, setActiveSuggestion] = useState<SuggestionDto | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportTarget, setExportTarget] = useState<ExportTarget>("excel");
  const [exportOverride, setExportOverride] = useState(false);
  const [exportConnectionJson, setExportConnectionJson] = useState<string>("{}");
  const [exportOptionsJson, setExportOptionsJson] = useState<string>("{}");

  // Connector pull picker — Jira / Xray / Zephyr / TestRail.
  const [connectorSource, setConnectorSource] = useState<ConnectorSource>("jira");
  const [connectorLabel, setConnectorLabel] = useState("Connector pull");
  const [connectorForm, setConnectorForm] = useState<Record<string, string>>({});
  // Saved-connection toggle (Issue #871). Jira is excluded — it has its own
  // saved-connection surface and is not part of TestManagementConnection.
  const [useSavedConnection, setUseSavedConnection] = useState(false);
  const [savedConnectionId, setSavedConnectionId] = useState<string>("");

  const importsQuery = useQuery({
    queryKey: ["tc-imports", projectId],
    queryFn: () => testCoverageApi.listImports(projectId),
    enabled: Boolean(projectId),
  });

  const runsQuery = useQuery({
    queryKey: ["tc-runs", projectId],
    queryFn: () => testCoverageApi.listRuns(projectId),
    enabled: Boolean(projectId),
    refetchInterval: 4000,
  });

  const latestRunId = useMemo(() => {
    const runs = runsQuery.data ?? [];
    return runs[0]?.id ?? null;
  }, [runsQuery.data]);

  const reportQuery = useQuery({
    queryKey: ["tc-report", projectId, latestRunId],
    queryFn: () => testCoverageApi.getReport(projectId, latestRunId as string),
    enabled: Boolean(projectId && latestRunId),
  });

  const budgetQuery = useQuery({
    queryKey: ["tc-budget", projectId, latestRunId],
    queryFn: () => testCoverageApi.getBudget(projectId, latestRunId as string),
    enabled: Boolean(projectId && latestRunId),
  });

  const uploadMutation = useMutation({
    mutationFn: (file: File) => testCoverageApi.uploadImport(projectId, file),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tc-imports", projectId] });
    },
  });

  const pasteMutation = useMutation({
    mutationFn: () =>
      testCoverageApi.pasteImport(projectId, {
        source: pasteSource,
        text: pasteText,
        label: pasteLabel,
      }),
    onSuccess: () => {
      setPasteOpen(false);
      setPasteText("");
      qc.invalidateQueries({ queryKey: ["tc-imports", projectId] });
    },
  });

  const connectorMutation = useMutation({
    mutationFn: () =>
      testCoverageApi.pullFromConnector(
        projectId,
        buildConnectorPayload(
          connectorSource,
          connectorLabel,
          connectorForm,
          useSavedConnection && connectorSource !== "jira" && savedConnectionId
            ? savedConnectionId
            : undefined,
        ),
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tc-imports", projectId] });
    },
  });

  // Saved test-management connections (Issue #871). Only used by the
  // xray / zephyr / testrail connector sources; jira is excluded.
  const savedConnectionsQuery = useQuery({
    queryKey: ["tc-saved-tmc", projectId],
    queryFn: () => testManagementApi.list(projectId),
    enabled: Boolean(projectId) && useSavedConnection && connectorSource !== "jira",
  });
  const savedConnectionsForSource = useMemo(
    () => (savedConnectionsQuery.data ?? []).filter((c) => c.kind === connectorSource),
    [savedConnectionsQuery.data, connectorSource],
  );

  const runMutation = useMutation({
    mutationFn: () => testCoverageApi.createRun(projectId, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tc-runs", projectId] });
    },
  });

  const updateSuggestion = useMutation({
    mutationFn: (input: { id: string; status: "accepted" | "rejected" | "exported" }) =>
      testCoverageApi.updateSuggestion(projectId, input.id, {
        status: input.status,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tc-report", projectId, latestRunId] });
      setActiveSuggestion(null);
    },
  });

  const exportMutation = useMutation({
    mutationFn: async () => {
      if (!latestRunId) throw new Error("No run to export");
      const body: Parameters<typeof testCoverageApi.exportRun>[1] = {
        runId: latestRunId,
        target: exportTarget,
        overrideLowConfidence: exportOverride,
      };
      if (exportTarget !== "excel" && exportTarget !== "gherkin") {
        body.connection = parseJsonOrEmpty(exportConnectionJson);
        body.options = parseJsonOrEmpty(exportOptionsJson);
      }
      return testCoverageApi.exportRun(projectId, body);
    },
    onSuccess: (result) => {
      if (result.kind === "file") {
        downloadBlob(result.blob, result.filename);
      }
      // For push results the dialog stays open so the user can see the summary
      // via the mutation's `data` (rendered below the form).
      if (result.kind === "file") {
        setExportOpen(false);
      } else {
        qc.invalidateQueries({ queryKey: ["tc-report", projectId, latestRunId] });
      }
    },
  });

  // Subscribe to run lifecycle events for live progress.
  useEffect(() => {
    if (!socket || !projectId) return;
    const onRunUpdate = () => {
      qc.invalidateQueries({ queryKey: ["tc-runs", projectId] });
      if (latestRunId) {
        qc.invalidateQueries({ queryKey: ["tc-report", projectId, latestRunId] });
        qc.invalidateQueries({ queryKey: ["tc-budget", projectId, latestRunId] });
      }
    };
    socket.on("testcoverage:run-update", onRunUpdate);
    socket.on("testcoverage:run-finished", onRunUpdate);
    return () => {
      socket.off("testcoverage:run-update", onRunUpdate);
      socket.off("testcoverage:run-finished", onRunUpdate);
    };
  }, [socket, qc, projectId, latestRunId]);

  const report = reportQuery.data;

  const requirementsForMatrix = useMemo(() => {
    if (!report) return [];
    const seen = new Map<string, string>();
    for (const m of report.mappings) {
      if (!seen.has(m.requirementId)) seen.set(m.requirementId, m.requirementId);
    }
    return Array.from(seen.entries()).map(([id]) => ({ id, title: id }));
  }, [report]);

  const testCasesForMatrix = useMemo(() => {
    if (!report) return [];
    const seen = new Map<string, string>();
    for (const m of report.mappings) {
      if (!seen.has(m.testCaseDocId)) seen.set(m.testCaseDocId, m.testCaseDocId);
    }
    return Array.from(seen.entries()).map(([id]) => ({ id, title: id }));
  }, [report]);

  const matrixCells = useMemo(() => {
    if (!report) return [];
    return report.mappings.map((m) => ({
      requirementId: m.requirementId,
      testCaseId: m.testCaseDocId,
      score: m.fused,
    }));
  }, [report]);

  if (!projectId) {
    return <div className="p-6">Invalid project id.</div>;
  }

  const runs = runsQuery.data ?? [];
  const imports = importsQuery.data ?? [];
  const budget = budgetQuery.data;

  return (
    <div className="p-6 space-y-6" data-testid="test-coverage-page">
      <header className="space-y-1">
        <h1 className="text-2xl font-bold">Test Coverage</h1>
        <p className="text-sm text-muted-foreground">
          Import existing tests, run gap analysis, and export coverage reports or AI-generated
          suggestions.
        </p>
      </header>

      {/* ---- Section 1: Import ---- */}
      <Card className="p-4 space-y-3" data-testid="tc-import-card">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Import test cases</h2>
          <div className="flex gap-2">
            <label className="inline-flex">
              <input
                type="file"
                className="sr-only"
                aria-label="Upload test cases"
                data-testid="tc-upload-input"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) uploadMutation.mutate(f);
                  e.target.value = "";
                }}
                accept=".xlsx,.xls,.csv,.md,.markdown,.feature,.docx"
              />
              <span
                className="inline-flex items-center rounded-md border border-border bg-primary text-primary-foreground px-3 py-2 text-sm font-medium cursor-pointer hover:bg-primary/90"
                role="button"
              >
                Upload file
              </span>
            </label>
            <Button
              variant="outline"
              onClick={() => setPasteOpen(true)}
              data-testid="tc-paste-button"
            >
              Paste text
            </Button>
          </div>
        </div>
        {uploadMutation.isError && (
          <p className="text-sm text-destructive" role="alert">
            Upload failed: {(uploadMutation.error as Error)?.message}
          </p>
        )}
        <div className="text-sm text-muted-foreground" data-testid="tc-imports-list">
          {importsQuery.isLoading ? (
            "Loading imports…"
          ) : imports.length === 0 ? (
            <span data-testid="tc-imports-empty">
              No imports yet. Upload an Excel/CSV/Markdown/Gherkin/DOCX file or paste text.
            </span>
          ) : (
            <ul className="space-y-1">
              {imports.slice(0, 6).map((imp) => (
                <li key={imp.id} className="text-xs">
                  <span className="font-medium">{imp.filename ?? imp.source}</span>
                  {" — "}
                  {imp.casesUpserted} cases (parsed {imp.casesParsed}) ·{" "}
                  {new Date(imp.createdAt).toLocaleString()}
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>

      {/* ---- Section 1b: Connector pull (Jira / Xray / Zephyr / TestRail) ---- */}
      <Card className="p-4 space-y-3" data-testid="tc-connector-card">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-lg font-semibold">Pull from connector</h2>
          <div className="flex items-center gap-2">
            <Link
              href={`/projects/${projectId}/test-coverage/connections`}
              className="text-xs underline text-muted-foreground"
              data-testid="tc-manage-saved-connections-link"
            >
              Manage saved connections →
            </Link>
            <Badge variant="outline">{connectorSource.toUpperCase()}</Badge>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          Pull test cases directly from an external test-management system. Credentials are sent
          once per request and never persisted, or pick a saved connection for Xray / Zephyr /
          TestRail.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <label className="text-sm" htmlFor="tc-connector-source">
            Source:
          </label>
          <select
            id="tc-connector-source"
            className="text-sm border border-border rounded-md px-2 py-1 bg-background"
            value={connectorSource}
            onChange={(e) => {
              setConnectorSource(e.target.value as ConnectorSource);
              setConnectorForm({});
              setSavedConnectionId("");
            }}
            aria-label="Connector source"
            data-testid="tc-connector-source"
          >
            <option value="jira">Jira</option>
            <option value="xray">Xray</option>
            <option value="zephyr">Zephyr Scale</option>
            <option value="testrail">TestRail</option>
          </select>
          <input
            className="text-sm border border-border rounded-md px-2 py-1 bg-background"
            placeholder="Import label"
            value={connectorLabel}
            onChange={(e) => setConnectorLabel(e.target.value)}
            aria-label="Import label"
          />
          {connectorSource !== "jira" && (
            <label className="text-sm flex items-center gap-1.5 ml-2">
              <input
                type="checkbox"
                checked={useSavedConnection}
                onChange={(e) => {
                  setUseSavedConnection(e.target.checked);
                  setSavedConnectionId("");
                }}
                data-testid="tc-use-saved-connection"
              />
              Use saved connection
            </label>
          )}
        </div>
        {useSavedConnection && connectorSource !== "jira" && (
          <div className="flex flex-wrap items-center gap-2">
            <label className="text-sm" htmlFor="tc-saved-connection">
              Saved connection:
            </label>
            <select
              id="tc-saved-connection"
              className="text-sm border border-border rounded-md px-2 py-1 bg-background min-w-[16rem]"
              value={savedConnectionId}
              onChange={(e) => setSavedConnectionId(e.target.value)}
              data-testid="tc-connector-saved"
              disabled={savedConnectionsQuery.isLoading}
            >
              <option value="">
                {savedConnectionsQuery.isLoading
                  ? "Loading…"
                  : savedConnectionsForSource.length === 0
                    ? `No saved ${connectorSource} connections`
                    : "Select a connection…"}
              </option>
              {savedConnectionsForSource.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label} — {c.baseUrl}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          {CONNECTOR_FIELDS[connectorSource]
            // Hide credential fields when a saved connection is in use; keep
            // pull-scope fields (projectKey / projectId / suiteId).
            .filter((f) => {
              if (!(useSavedConnection && connectorSource !== "jira")) return true;
              return ["projectKey", "projectId", "suiteId"].includes(f.key);
            })
            .map((f) => (
              <label key={f.key} className="text-xs text-muted-foreground flex flex-col gap-1">
                {f.label}
                <input
                  className="text-sm border border-border rounded-md px-2 py-1 bg-background"
                  type={
                    f.type === "password" ? "password" : f.type === "number" ? "number" : "text"
                  }
                  value={connectorForm[f.key] ?? ""}
                  onChange={(e) => setConnectorForm((s) => ({ ...s, [f.key]: e.target.value }))}
                  autoComplete={connectorFieldAutoComplete(f.key)}
                  data-testid={`tc-connector-${f.key}`}
                />
              </label>
            ))}
        </div>
        {connectorMutation.isError && (
          <p className="text-sm text-destructive" role="alert">
            Pull failed: {(connectorMutation.error as Error)?.message}
          </p>
        )}
        {connectorMutation.isSuccess && connectorMutation.data && (
          <p className="text-sm text-muted-foreground" data-testid="tc-connector-success">
            Imported {connectorMutation.data.casesUpserted} cases (parsed{" "}
            {connectorMutation.data.casesParsed}).
          </p>
        )}
        <Button
          onClick={() => connectorMutation.mutate()}
          disabled={connectorMutation.isPending}
          data-testid="tc-connector-pull"
        >
          {connectorMutation.isPending ? "Pulling…" : "Pull"}
        </Button>
      </Card>

      {/* ---- Section 2 + 3: Runs + summary ---- */}
      <Card className="p-4 space-y-3" data-testid="tc-runs-card">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Coverage runs</h2>
          <Button
            onClick={() => runMutation.mutate()}
            disabled={runMutation.isPending}
            data-testid="tc-new-run-button"
          >
            {runMutation.isPending ? "Starting…" : "Start new run"}
          </Button>
        </div>
        {runs.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="tc-runs-empty">
            No runs yet. Click <strong>Start new run</strong> to analyse coverage.
          </p>
        ) : (
          <div className="space-y-2">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-2 text-sm">
              {runs.slice(0, 6).map((run) => (
                <div
                  key={run.id}
                  className="rounded-md border border-border p-3 space-y-1"
                  data-testid="tc-run-row"
                >
                  <div className="flex items-center justify-between">
                    <code className="text-xs">{run.id.slice(0, 8)}</code>
                    <Badge className={statusClass(run.status)}>{run.status}</Badge>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {new Date(run.createdAt).toLocaleString()}
                  </div>
                </div>
              ))}
            </div>

            {report && (
              <div
                className="rounded-md border border-border p-4 grid grid-cols-1 md:grid-cols-3 gap-4"
                data-testid="tc-summary"
              >
                <div>
                  <div className="text-xs text-muted-foreground">Coverage</div>
                  <div className="text-2xl font-bold" data-testid="tc-coverage-pct">
                    {safeFixed(report.summary?.coveragePct, 1, "0.0")}%
                  </div>
                  <Progress value={safeNum(report.summary?.coveragePct)} className="mt-2" />
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">Gaps</div>
                  <div className="text-2xl font-bold">{report.gaps.length}</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">Suggestions</div>
                  <div className="text-2xl font-bold">{report.suggestions.length}</div>
                </div>
                {budget && (
                  <div
                    className="md:col-span-3 text-xs text-muted-foreground"
                    data-testid="tc-budget-line"
                  >
                    Budget: ${safeFixed(safeNum(budget.usedCents) / 100, 2, "0.00")} spent of $
                    {safeFixed(safeNum(budget.limitCents) / 100, 2, "0.00")} ·{" "}
                    {safeNum(budget.limitCents) > 0
                      ? safeFixed(
                          (safeNum(budget.usedCents) / safeNum(budget.limitCents)) * 100,
                          0,
                          "0",
                        )
                      : "0"}
                    % used
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </Card>

      {/* ---- Section 4: Matrix ---- */}
      {report && requirementsForMatrix.length > 0 && (
        <Card className="p-4 space-y-3" data-testid="tc-matrix-card">
          <h2 className="text-lg font-semibold">Coverage matrix</h2>
          <CoverageMatrix
            requirements={requirementsForMatrix}
            testCases={testCasesForMatrix}
            cells={matrixCells}
          />
          <div className="flex gap-3 text-xs text-muted-foreground">
            <span>
              <span className="inline-block w-3 h-3 bg-green-500 align-middle mr-1" />≥ 0.8 covered
            </span>
            <span>
              <span className="inline-block w-3 h-3 bg-amber-500 align-middle mr-1" />
              0.5–0.8 partial
            </span>
            <span>
              <span className="inline-block w-3 h-3 bg-red-500 align-middle mr-1" />
              &lt; 0.5 uncovered
            </span>
          </div>
        </Card>
      )}

      {/* ---- Section 5: Gaps ---- */}
      {report && report.gaps.length > 0 && (
        <Card className="p-4 space-y-3" data-testid="tc-gaps-card">
          <h2 className="text-lg font-semibold">Gaps ({report.gaps.length})</h2>
          <ul className="space-y-1">
            {report.gaps.map((g) => (
              <li
                key={g.id}
                className="flex items-center gap-3 text-sm border-b border-border py-2"
              >
                <Badge className={severityClass(g.severity)}>{g.severity}</Badge>
                <code className="text-xs">{g.requirementId}</code>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {/* ---- Section 6: Suggestions ---- */}
      {report && report.suggestions.length > 0 && (
        <Card className="p-4 space-y-3" data-testid="tc-suggestions-card">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">Suggested tests ({report.suggestions.length})</h2>
            <Button
              variant="outline"
              onClick={() => setExportOpen(true)}
              data-testid="tc-export-button"
            >
              Export…
            </Button>
          </div>
          <ul className="space-y-2">
            {report.suggestions.map((s) => (
              <li
                key={s.id}
                className="border border-border rounded-md p-3 flex items-start justify-between gap-3"
                data-testid="tc-suggestion-row"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium truncate">{s.title}</span>
                    {s.lowConfidence && (
                      <Badge className="bg-amber-500 text-white" data-testid="tc-low-conf-badge">
                        low confidence
                      </Badge>
                    )}
                    <Badge variant="outline">{s.status}</Badge>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Faithfulness: {safeFixed(s.faithfulness, 2, "—")}
                  </div>
                </div>
                <div className="flex gap-2 shrink-0">
                  <Button size="sm" variant="outline" onClick={() => setActiveSuggestion(s)}>
                    Review
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => updateSuggestion.mutate({ id: s.id, status: "accepted" })}
                    disabled={updateSuggestion.isPending}
                  >
                    Accept
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => updateSuggestion.mutate({ id: s.id, status: "rejected" })}
                  >
                    Reject
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {/* ---- Paste dialog ---- */}
      <Dialog open={pasteOpen} onOpenChange={setPasteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Paste test cases</DialogTitle>
            <DialogDescription>
              Paste CSV, Markdown table, or Gherkin feature text below.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="flex gap-2 items-center">
              <label className="text-sm">Format:</label>
              <select
                className="text-sm border border-border rounded-md px-2 py-1 bg-background"
                value={pasteSource}
                onChange={(e) => setPasteSource(e.target.value as "csv" | "markdown" | "gherkin")}
                aria-label="Paste format"
              >
                <option value="csv">CSV</option>
                <option value="markdown">Markdown</option>
                <option value="gherkin">Gherkin</option>
              </select>
              <input
                className="text-sm border border-border rounded-md px-2 py-1 bg-background flex-1"
                value={pasteLabel}
                onChange={(e) => setPasteLabel(e.target.value)}
                aria-label="Label"
              />
            </div>
            <Textarea
              rows={10}
              value={pasteText}
              onChange={(e) => setPasteText(e.target.value)}
              data-testid="tc-paste-textarea"
              placeholder={"title,steps,expected\nLogin,Submit,Dashboard shown"}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPasteOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => pasteMutation.mutate()}
              disabled={!pasteText.trim() || !pasteLabel.trim() || pasteMutation.isPending}
              data-testid="tc-paste-submit"
            >
              {pasteMutation.isPending ? "Importing…" : "Import"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---- Suggestion review drawer ---- */}
      <Dialog
        open={Boolean(activeSuggestion)}
        onOpenChange={(o) => !o && setActiveSuggestion(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{activeSuggestion?.title}</DialogTitle>
            <DialogDescription>
              Review the generated Given/When/Then before accepting.
              {activeSuggestion?.lowConfidence && (
                <span className="block mt-1 text-amber-600 font-medium">
                  ⚠ Low-confidence: faithfulness &lt; 0.6.
                </span>
              )}
            </DialogDescription>
          </DialogHeader>
          {activeSuggestion && (
            <div className="space-y-3 text-sm">
              {(["given", "when", "then"] as const).map((bucket) => {
                const gwt = parseGwt(activeSuggestion.gwtJson);
                const items = gwt[bucket];
                return (
                  <div key={bucket}>
                    <div className="font-semibold capitalize">{bucket}</div>
                    {items.length === 0 ? (
                      <div className="text-xs text-muted-foreground">(none)</div>
                    ) : (
                      <ul className="list-disc pl-5">
                        {items.map((line, i) => (
                          <li key={i}>{line}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() =>
                activeSuggestion &&
                updateSuggestion.mutate({
                  id: activeSuggestion.id,
                  status: "rejected",
                })
              }
            >
              Reject
            </Button>
            <Button
              onClick={() =>
                activeSuggestion &&
                updateSuggestion.mutate({
                  id: activeSuggestion.id,
                  status: "accepted",
                })
              }
            >
              Accept
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---- Export dialog ---- */}
      <Dialog open={exportOpen} onOpenChange={setExportOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Export coverage report</DialogTitle>
            <DialogDescription>
              Downloads the latest run as an Excel workbook or a Gherkin feature file.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <label className="text-sm">Format:</label>
              <select
                className="text-sm border border-border rounded-md px-2 py-1 bg-background"
                value={exportTarget}
                onChange={(e) => setExportTarget(e.target.value as ExportTarget)}
                aria-label="Export format"
              >
                <option value="excel">Excel (.xlsx)</option>
                <option value="gherkin">Gherkin (.feature)</option>
                <option value="github">GitHub Issues</option>
                <option value="xray">Jira / Xray</option>
                <option value="jira">Jira (Xray alias)</option>
                <option value="zephyr">Zephyr Scale</option>
                <option value="testrail">TestRail</option>
              </select>
            </div>
            {exportTarget !== "excel" && exportTarget !== "gherkin" && (
              <div className="space-y-2" data-testid="tc-export-external">
                <label className="text-xs text-muted-foreground" htmlFor="tc-export-connection">
                  Connection JSON (baseUrl + credentials)
                </label>
                <Textarea
                  id="tc-export-connection"
                  value={exportConnectionJson}
                  onChange={(e) => setExportConnectionJson(e.target.value)}
                  rows={4}
                  className="font-mono text-xs"
                />
                <label className="text-xs text-muted-foreground" htmlFor="tc-export-options">
                  Options JSON (projectKey / sectionId / repo etc.)
                </label>
                <Textarea
                  id="tc-export-options"
                  value={exportOptionsJson}
                  onChange={(e) => setExportOptionsJson(e.target.value)}
                  rows={4}
                  className="font-mono text-xs"
                />
                {exportMutation.data?.kind === "push" && (
                  <div className="text-xs text-muted-foreground" data-testid="tc-export-result">
                    Pushed {exportMutation.data.result.created.length} · failed{" "}
                    {exportMutation.data.result.failed.length} · skipped{" "}
                    {exportMutation.data.result.skipped.length}
                  </div>
                )}
              </div>
            )}
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={exportOverride}
                onChange={(e) => setExportOverride(e.target.checked)}
                data-testid="tc-export-override"
              />
              Override low-confidence guard (audit-logged)
            </label>
            {exportMutation.isError && (
              <p className="text-sm text-destructive" role="alert">
                Export failed: {(exportMutation.error as Error)?.message}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setExportOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => exportMutation.mutate()}
              disabled={exportMutation.isPending || !latestRunId}
              data-testid="tc-export-submit"
            >
              {exportMutation.isPending ? "Exporting…" : "Download"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
