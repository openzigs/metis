"use client";

/**
 * Epic #556 / Issues #562 + #563 — Jira integration page.
 *
 * Combines connection management and issue browsing in a single project tab.
 * - Connection list with status badges + Add/Edit/Delete/Test
 * - Jira project selector, JQL search, issue table, detail panel
 */
import { useParams } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import DOMPurify from "dompurify";
import { ApiError } from "@/lib/api-client";
import { jiraApi } from "@/lib/jira-api";
import { queryKeys } from "@/lib/query-keys";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import type { JiraConnectionDetail, JiraIssue, JiraIssueDetail } from "@metis/shared";

// ---- Status badge helper ---------------------------------------------------

function statusColor(status: string): string {
  switch (status) {
    case "ok":
      return "bg-emerald-100 text-emerald-700";
    case "error":
      return "bg-red-100 text-red-700";
    default:
      return "bg-slate-100 text-slate-700";
  }
}

// ---- Main page component ---------------------------------------------------

export default function JiraPage() {
  const params = useParams<{ id: string }>();
  const projectId = params?.id ?? "";
  const qc = useQueryClient();

  // ── Connection state ─────────────────────────────────────────────────
  const [showAddForm, setShowAddForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [selectedConnectionId, setSelectedConnectionId] = useState<string | null>(null);

  // ── Form state ───────────────────────────────────────────────────────
  const [label, setLabel] = useState("");
  const [edition, setEdition] = useState<"cloud" | "datacenter">("cloud");
  const [baseUrl, setBaseUrl] = useState("");
  const [username, setUsername] = useState("");
  const [apiToken, setApiToken] = useState("");
  const [proxyUrl, setProxyUrl] = useState("");
  const [tlsRejectUnauthorized, setTlsRejectUnauthorized] = useState(true);
  const [formError, setFormError] = useState<string | null>(null);

  // ── Issue browsing state ─────────────────────────────────────────────
  const [selectedJiraProject, setSelectedJiraProject] = useState<string>("");
  const [jqlFilter, setJqlFilter] = useState("");
  const [activeJql, setActiveJql] = useState("");
  const [searchStartAt, setSearchStartAt] = useState(0);
  const [selectedIssueKey, setSelectedIssueKey] = useState<string | null>(null);
  const [selectedIssues, setSelectedIssues] = useState<Set<string>>(new Set());
  const [sortField, setSortField] = useState("created");
  const [sortDir, setSortDir] = useState<"ASC" | "DESC">("DESC");
  const [statusFilter, setStatusFilter] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [priorityFilter, setPriorityFilter] = useState("");

  // ── Queries ──────────────────────────────────────────────────────────
  const connections = useQuery({
    queryKey: queryKeys.jira.connections(projectId),
    queryFn: () => jiraApi.list(projectId),
    enabled: Boolean(projectId),
  });

  const jiraProjects = useQuery({
    queryKey: queryKeys.jira.projects(selectedConnectionId ?? ""),
    queryFn: () => jiraApi.listProjects(selectedConnectionId!),
    enabled: Boolean(selectedConnectionId),
    staleTime: 5 * 60_000, // 5min cache
  });

  const effectiveJql = useMemo(() => {
    let base = activeJql;
    if (!base) {
      const parts: string[] = [];
      if (selectedJiraProject) parts.push(`project = "${selectedJiraProject}"`);
      if (statusFilter) parts.push(`status = "${statusFilter}"`);
      if (typeFilter) parts.push(`issuetype = "${typeFilter}"`);
      if (priorityFilter) parts.push(`priority = "${priorityFilter}"`);
      base = parts.join(" AND ");
    }
    if (!base) return "";
    if (/order by/i.test(base)) return base;
    return `${base} ORDER BY ${sortField} ${sortDir}`;
  }, [
    activeJql,
    selectedJiraProject,
    statusFilter,
    typeFilter,
    priorityFilter,
    sortField,
    sortDir,
  ]);

  const searchResults = useQuery({
    queryKey: queryKeys.jira.search(selectedConnectionId ?? "", effectiveJql, searchStartAt),
    queryFn: () =>
      jiraApi.search(selectedConnectionId!, {
        jql: effectiveJql,
        startAt: searchStartAt,
        maxResults: 20,
      }),
    enabled: Boolean(selectedConnectionId) && Boolean(effectiveJql),
  });

  const issueDetail = useQuery({
    queryKey: queryKeys.jira.issue(selectedConnectionId ?? "", selectedIssueKey ?? ""),
    queryFn: () => jiraApi.getIssue(selectedConnectionId!, selectedIssueKey!),
    enabled: Boolean(selectedConnectionId) && Boolean(selectedIssueKey),
  });

  // ── Mutations ────────────────────────────────────────────────────────
  const createConn = useMutation({
    mutationFn: () =>
      jiraApi.create(projectId, {
        label: label.trim(),
        edition,
        baseUrl: baseUrl.trim(),
        username: username.trim(),
        apiToken: apiToken.trim(),
        proxyUrl: proxyUrl.trim() || undefined,
        tlsRejectUnauthorized,
      }),
    onSuccess: () => {
      resetForm();
      setShowAddForm(false);
      qc.invalidateQueries({ queryKey: queryKeys.jira.connections(projectId) });
    },
    onError: (err) => setFormError(err instanceof ApiError ? err.message : "Failed"),
  });

  const updateConn = useMutation({
    mutationFn: () =>
      jiraApi.update(editingId!, {
        label: label.trim() || undefined,
        edition,
        baseUrl: baseUrl.trim() || undefined,
        username: username.trim() || undefined,
        apiToken: apiToken.trim() || undefined,
        proxyUrl: proxyUrl.trim() || undefined,
        tlsRejectUnauthorized,
      }),
    onSuccess: () => {
      resetForm();
      setEditingId(null);
      qc.invalidateQueries({ queryKey: queryKeys.jira.connections(projectId) });
    },
    onError: (err) => setFormError(err instanceof ApiError ? err.message : "Failed"),
  });

  const deleteConn = useMutation({
    mutationFn: (id: string) => jiraApi.remove(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.jira.connections(projectId) });
      if (selectedConnectionId) setSelectedConnectionId(null);
    },
  });

  const testConn = useMutation({
    mutationFn: (id: string) => jiraApi.test(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.jira.connections(projectId) }),
  });

  // ── Helpers ──────────────────────────────────────────────────────────
  function resetForm() {
    setLabel("");
    setEdition("cloud");
    setBaseUrl("");
    setUsername("");
    setApiToken("");
    setProxyUrl("");
    setTlsRejectUnauthorized(true);
    setFormError(null);
  }

  function startEdit(conn: JiraConnectionDetail) {
    setEditingId(conn.id);
    setLabel(conn.label);
    setEdition(conn.edition);
    setBaseUrl(conn.baseUrl);
    setUsername(conn.username);
    setApiToken("");
    setProxyUrl(conn.proxyUrl ?? "");
    setTlsRejectUnauthorized(conn.tlsRejectUnauthorized);
    setFormError(null);
    setShowAddForm(false);
  }

  function handleSearch() {
    setActiveJql(jqlFilter.trim());
    setSearchStartAt(0);
    setSelectedIssueKey(null);
  }

  function updateFilter(setter: (v: string) => void, value: string) {
    setter(value);
    setActiveJql("");
    setJqlFilter("");
    setSearchStartAt(0);
    setSelectedIssueKey(null);
  }

  function toggleSort(field: string) {
    if (sortField === field) {
      setSortDir((d) => (d === "ASC" ? "DESC" : "ASC"));
    } else {
      setSortField(field);
      setSortDir("DESC");
    }
    setSearchStartAt(0);
  }

  function toggleIssueSelection(key: string) {
    setSelectedIssues((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const formValid =
    label.trim().length > 0 &&
    baseUrl.trim().length > 0 &&
    username.trim().length > 0 &&
    (editingId ? true : apiToken.trim().length > 0);

  if (!projectId) return <div className="p-6">Invalid project id.</div>;

  return (
    <div className="space-y-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold">Jira Integration</h1>
        <p className="text-sm text-muted-foreground">
          Connect to Jira Cloud or Data Center instances to browse and analyze issues.
        </p>
      </header>

      {/* ── Connection management (#562) ─────────────────────────────── */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-medium">Connections</h2>
          {!showAddForm && !editingId && (
            <Button onClick={() => setShowAddForm(true)} data-testid="add-jira-connection">
              Add Connection
            </Button>
          )}
        </div>

        {/* Connection form (add / edit) */}
        {(showAddForm || editingId) && (
          <Card className="space-y-3 p-4" data-testid="jira-connection-form">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="jira-label">Label</Label>
                <Input
                  id="jira-label"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder="production-cloud"
                />
              </div>
              <div>
                <Label htmlFor="jira-edition">Edition</Label>
                <select
                  id="jira-edition"
                  className="mt-1 block w-full rounded border px-2 py-1 text-sm"
                  value={edition}
                  onChange={(e) => setEdition(e.target.value as "cloud" | "datacenter")}
                >
                  <option value="cloud">Cloud</option>
                  <option value="datacenter">Data Center</option>
                </select>
              </div>
              <div>
                <Label htmlFor="jira-url">Base URL</Label>
                <Input
                  id="jira-url"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder={
                    edition === "cloud" ? "https://your-org.atlassian.net" : "https://jira.corp.net"
                  }
                />
              </div>
              <div>
                <Label htmlFor="jira-user">{edition === "cloud" ? "Email" : "Username"}</Label>
                <Input
                  id="jira-user"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder={edition === "cloud" ? "you@company.com" : "svc-account"}
                  // WCAG SC 1.3.5 (#659): this field is the person's Atlassian
                  // login — their account email on Jira Cloud, their username on
                  // Data Center — so it carries the matching H98 purpose token.
                  autoComplete={edition === "cloud" ? "email" : "username"}
                />
              </div>
              <div>
                <Label htmlFor="jira-token">
                  {edition === "cloud" ? "API Token" : "Personal Access Token"}
                </Label>
                <Input
                  id="jira-token"
                  type="password"
                  value={apiToken}
                  onChange={(e) => setApiToken(e.target.value)}
                  placeholder={editingId ? "••••••••" : "Enter token"}
                />
              </div>
              <div>
                <Label htmlFor="jira-proxy">Proxy URL (optional)</Label>
                <Input
                  id="jira-proxy"
                  value={proxyUrl}
                  onChange={(e) => setProxyUrl(e.target.value)}
                  placeholder="http://proxy:8080"
                />
              </div>
              <div className="col-span-2 flex items-center gap-2">
                <input
                  id="jira-tls"
                  type="checkbox"
                  checked={tlsRejectUnauthorized}
                  onChange={(e) => setTlsRejectUnauthorized(e.target.checked)}
                />
                <Label htmlFor="jira-tls">Verify TLS certificates</Label>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button
                onClick={() => (editingId ? updateConn.mutate() : createConn.mutate())}
                disabled={!formValid || createConn.isPending || updateConn.isPending}
              >
                {editingId ? "Update" : "Add"} Connection
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  resetForm();
                  setShowAddForm(false);
                  setEditingId(null);
                }}
              >
                Cancel
              </Button>
              {formError && <span className="text-sm text-red-600">{formError}</span>}
            </div>
          </Card>
        )}

        {/* Connection list */}
        <ul className="space-y-2" data-testid="jira-connection-list">
          {(connections.data ?? []).map((conn) => (
            <li key={conn.id}>
              <Card
                className={`flex items-center justify-between p-3 cursor-pointer transition-colors ${
                  selectedConnectionId === conn.id
                    ? "border-primary ring-1 ring-primary"
                    : "hover:border-muted-foreground/40"
                }`}
                onClick={() => {
                  setSelectedConnectionId(conn.id);
                  setSelectedJiraProject("");
                  setActiveJql("");
                  setSelectedIssueKey(null);
                }}
                data-testid={`jira-connection-${conn.id}`}
              >
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{conn.label}</span>
                    <Badge variant={conn.edition === "cloud" ? "secondary" : "outline"}>
                      {conn.edition}
                    </Badge>
                    <span className={`rounded px-2 py-0.5 text-xs ${statusColor(conn.status)}`}>
                      {conn.status}
                    </span>
                  </div>
                  <div className="font-mono text-xs text-muted-foreground">{conn.baseUrl}</div>
                  {conn.errorMessage && (
                    <div className="mt-1 text-xs text-red-600">{conn.errorMessage}</div>
                  )}
                </div>
                <div
                  className="flex flex-wrap items-center gap-2"
                  onClick={(e) => e.stopPropagation()}
                >
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => testConn.mutate(conn.id)}
                    disabled={testConn.isPending}
                  >
                    {testConn.isPending ? "Testing…" : "Test"}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => startEdit(conn)}>
                    Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={() => {
                      if (confirm("Delete this Jira connection?")) deleteConn.mutate(conn.id);
                    }}
                  >
                    Delete
                  </Button>
                </div>
              </Card>
            </li>
          ))}
          {!connections.isLoading && (connections.data ?? []).length === 0 && (
            <p className="text-sm text-muted-foreground">
              No Jira connections yet. Click &quot;Add Connection&quot; to get started.
            </p>
          )}
        </ul>
      </section>

      {/* ── Issue viewer (#563) ──────────────────────────────────────── */}
      {selectedConnectionId && (
        <section className="space-y-4">
          <h2 className="text-lg font-medium">Issue Browser</h2>

          {/* ── Toolbar ─────────────────────────────────────────────── */}
          <div className="space-y-2">
            {/* Row 1: structured filters */}
            <div className="flex flex-wrap items-end gap-2">
              <div>
                <Label htmlFor="jira-project-select">Project</Label>
                <select
                  id="jira-project-select"
                  className="mt-1 block w-52 rounded border bg-background px-2 py-1.5 text-sm"
                  value={selectedJiraProject}
                  onChange={(e) => {
                    setSelectedJiraProject(e.target.value);
                    setActiveJql("");
                    setJqlFilter("");
                    setSearchStartAt(0);
                    setSelectedIssueKey(null);
                  }}
                >
                  <option value="">All projects…</option>
                  {(jiraProjects.data ?? []).map((p) => (
                    <option key={p.key} value={p.key}>
                      {p.key} — {p.name}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <Label htmlFor="status-filter">Status</Label>
                <select
                  id="status-filter"
                  className="mt-1 block w-44 rounded border bg-background px-2 py-1.5 text-sm"
                  value={statusFilter}
                  onChange={(e) => updateFilter(setStatusFilter, e.target.value)}
                >
                  <option value="">Any status</option>
                  <option>To Do</option>
                  <option>In Progress</option>
                  <option>Done</option>
                  <option>Closed</option>
                  <option>Open</option>
                  <option>Resolved</option>
                  <option>Ready for Business Owner Approval</option>
                </select>
              </div>

              <div>
                <Label htmlFor="type-filter">Type</Label>
                <select
                  id="type-filter"
                  className="mt-1 block w-36 rounded border bg-background px-2 py-1.5 text-sm"
                  value={typeFilter}
                  onChange={(e) => updateFilter(setTypeFilter, e.target.value)}
                >
                  <option value="">Any type</option>
                  <option>Bug</option>
                  <option>Story</option>
                  <option>Task</option>
                  <option>Epic</option>
                  <option>Sub-task</option>
                  <option>Test Execution</option>
                </select>
              </div>

              <div>
                <Label htmlFor="priority-filter">Priority</Label>
                <select
                  id="priority-filter"
                  className="mt-1 block w-32 rounded border bg-background px-2 py-1.5 text-sm"
                  value={priorityFilter}
                  onChange={(e) => updateFilter(setPriorityFilter, e.target.value)}
                >
                  <option value="">Any priority</option>
                  <option>Highest</option>
                  <option>High</option>
                  <option>Medium</option>
                  <option>Low</option>
                  <option>Lowest</option>
                </select>
              </div>

              <div>
                <Label>Sort</Label>
                <div className="mt-1 flex gap-1">
                  <select
                    className="block w-32 rounded border bg-background px-2 py-1.5 text-sm"
                    value={sortField}
                    onChange={(e) => {
                      setSortField(e.target.value);
                      setSearchStartAt(0);
                    }}
                  >
                    <option value="created">Created</option>
                    <option value="updated">Updated</option>
                    <option value="priority">Priority</option>
                    <option value="status">Status</option>
                    <option value="assignee">Assignee</option>
                    <option value="issuetype">Type</option>
                  </select>
                  <button
                    className="rounded border bg-background px-2 py-1.5 text-sm hover:bg-muted"
                    onClick={() => {
                      setSortDir((d) => (d === "ASC" ? "DESC" : "ASC"));
                      setSearchStartAt(0);
                    }}
                    title={
                      sortDir === "ASC" ? "Ascending — click to flip" : "Descending — click to flip"
                    }
                  >
                    {sortDir === "ASC" ? "↑ Asc" : "↓ Desc"}
                  </button>
                </div>
              </div>
            </div>

            {/* Row 2: advanced JQL bar */}
            <div className="flex gap-2 items-center">
              <span className="text-xs text-muted-foreground shrink-0" aria-hidden="true">
                JQL:
              </span>
              <Input
                aria-label="JQL Filter"
                value={jqlFilter}
                onChange={(e) => setJqlFilter(e.target.value)}
                placeholder='Advanced: project = "KEY" AND labels = "perf" ORDER BY updated DESC'
                className="flex-1 font-mono text-xs h-8"
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleSearch();
                }}
              />
              <Button size="sm" onClick={handleSearch} disabled={searchResults.isFetching}>
                {searchResults.isFetching ? "…" : "Search"}
              </Button>
              {(activeJql || statusFilter || typeFilter || priorityFilter) && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setActiveJql("");
                    setJqlFilter("");
                    setStatusFilter("");
                    setTypeFilter("");
                    setPriorityFilter("");
                    setSearchStartAt(0);
                  }}
                >
                  Clear filters
                </Button>
              )}
            </div>
          </div>

          {/* ── Table + sticky side panel ────────────────────────────── */}
          <div className="flex gap-4 items-start">
            {/* Table area */}
            <div className="flex-1 min-w-0 space-y-2">
              {searchResults.isError && (
                <div
                  className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-700"
                  role="alert"
                  data-testid="jira-search-error"
                >
                  Search failed:{" "}
                  {searchResults.error instanceof Error
                    ? searchResults.error.message
                    : "An unexpected error occurred"}
                </div>
              )}

              {searchResults.isFetching && (
                <p className="text-sm text-muted-foreground animate-pulse">Loading issues…</p>
              )}

              {!searchResults.data && !searchResults.isError && !searchResults.isFetching && (
                <Card className="p-6 text-center text-sm text-muted-foreground">
                  Select a project or apply filters to browse issues.
                </Card>
              )}

              {searchResults.data && (
                <>
                  <div className="flex items-center justify-between text-sm text-muted-foreground">
                    <span>
                      Showing {searchResults.data.startAt + 1}–
                      {Math.min(
                        searchResults.data.startAt + searchResults.data.issues.length,
                        searchResults.data.total,
                      )}{" "}
                      of {searchResults.data.total}
                      {selectedIssues.size > 0 && (
                        <span className="ml-2 font-medium text-foreground">
                          · {selectedIssues.size} selected
                        </span>
                      )}
                    </span>
                    {selectedIssues.size > 0 && (
                      <Button size="sm" data-testid="analyze-selected">
                        Analyze Selected ({selectedIssues.size})
                      </Button>
                    )}
                  </div>

                  <div className="overflow-x-auto rounded border">
                    <table className="w-full text-sm" data-testid="jira-issue-table">
                      <thead>
                        <tr className="border-b bg-muted/50 text-left text-xs font-medium">
                          <th className="w-8 p-2">
                            <input
                              type="checkbox"
                              checked={
                                searchResults.data.issues.length > 0 &&
                                searchResults.data.issues.every((i) => selectedIssues.has(i.key))
                              }
                              onChange={(e) => {
                                if (e.target.checked) {
                                  setSelectedIssues(
                                    new Set(searchResults.data!.issues.map((i) => i.key)),
                                  );
                                } else {
                                  setSelectedIssues(new Set());
                                }
                              }}
                            />
                          </th>
                          <SortHeader
                            field="summary"
                            label="Key / Summary"
                            active={sortField}
                            dir={sortDir}
                            onSort={toggleSort}
                          />
                          <SortHeader
                            field="status"
                            label="Status"
                            active={sortField}
                            dir={sortDir}
                            onSort={toggleSort}
                          />
                          <SortHeader
                            field="issuetype"
                            label="Type"
                            active={sortField}
                            dir={sortDir}
                            onSort={toggleSort}
                          />
                          <SortHeader
                            field="priority"
                            label="Priority"
                            active={sortField}
                            dir={sortDir}
                            onSort={toggleSort}
                          />
                          <SortHeader
                            field="assignee"
                            label="Assignee"
                            active={sortField}
                            dir={sortDir}
                            onSort={toggleSort}
                          />
                          <SortHeader
                            field="created"
                            label="Created"
                            active={sortField}
                            dir={sortDir}
                            onSort={toggleSort}
                          />
                        </tr>
                      </thead>
                      <tbody>
                        {searchResults.data.issues.map((issue) => (
                          <IssueRow
                            key={issue.key}
                            issue={issue}
                            selected={selectedIssues.has(issue.key)}
                            onToggle={() => toggleIssueSelection(issue.key)}
                            onView={() =>
                              setSelectedIssueKey(issue.key === selectedIssueKey ? null : issue.key)
                            }
                            isActive={selectedIssueKey === issue.key}
                          />
                        ))}
                      </tbody>
                    </table>
                  </div>

                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={searchStartAt === 0}
                      onClick={() => {
                        setSearchStartAt(Math.max(0, searchStartAt - 20));
                        setSelectedIssueKey(null);
                      }}
                    >
                      ← Previous
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={
                        searchStartAt + searchResults.data.issues.length >= searchResults.data.total
                      }
                      onClick={() => {
                        setSearchStartAt(searchStartAt + 20);
                        setSelectedIssueKey(null);
                      }}
                    >
                      Next →
                    </Button>
                  </div>
                </>
              )}
            </div>

            {/* ── Issue detail — sticky right panel ────────────────── */}
            {selectedIssueKey && (
              <div
                className="w-[420px] shrink-0 sticky top-4 max-h-[calc(100vh-10rem)] overflow-y-auto rounded-lg border bg-card shadow-lg"
                data-testid="jira-issue-detail"
              >
                {issueDetail.isLoading && (
                  <div className="p-4 text-sm text-muted-foreground animate-pulse">Loading…</div>
                )}
                {issueDetail.data && (
                  <IssueDetailPanel
                    issue={issueDetail.data}
                    connectionId={selectedConnectionId!}
                    onClose={() => setSelectedIssueKey(null)}
                  />
                )}
              </div>
            )}
          </div>
        </section>
      )}
    </div>
  );
}

// ---- Sub-components --------------------------------------------------------

function SortHeader({
  field,
  label,
  active,
  dir,
  onSort,
}: {
  field: string;
  label: string;
  active: string;
  dir: "ASC" | "DESC";
  onSort: (field: string) => void;
}) {
  return (
    <th
      className="p-2 cursor-pointer select-none whitespace-nowrap hover:bg-muted/70"
      onClick={() => onSort(field)}
    >
      {label}
      <span className="ml-1 text-muted-foreground text-xs">
        {active === field ? (dir === "ASC" ? "↑" : "↓") : ""}
      </span>
    </th>
  );
}

function IssueRow({
  issue,
  selected,
  onToggle,
  onView,
  isActive,
}: {
  issue: JiraIssue;
  selected: boolean;
  onToggle: () => void;
  onView: () => void;
  isActive: boolean;
}) {
  const fields = issue.fields as Record<string, unknown>;
  const status = fields.status as { name?: string } | undefined;
  const issuetype = fields.issuetype as { name?: string } | undefined;
  const priority = fields.priority as { name?: string } | undefined;
  const assignee = fields.assignee as { displayName?: string } | undefined;
  const created = fields.created as string | undefined;

  return (
    <tr
      className={`border-b cursor-pointer transition-colors ${
        isActive ? "bg-primary/10 hover:bg-primary/15" : "hover:bg-muted/30"
      }`}
      onClick={onView}
      data-testid={`jira-issue-row-${issue.key}`}
    >
      <td className="p-2" onClick={(e) => e.stopPropagation()}>
        <input type="checkbox" checked={selected} onChange={onToggle} />
      </td>
      <td className="p-2">
        <div className="font-mono text-xs font-semibold text-primary">{issue.key}</div>
        <div className="max-w-xs truncate text-xs mt-0.5 text-muted-foreground">
          {String(fields.summary ?? "")}
        </div>
      </td>
      <td className="p-2">
        {status?.name && (
          <Badge variant="outline" className="text-xs">
            {status.name}
          </Badge>
        )}
      </td>
      <td className="p-2 text-xs text-muted-foreground">{issuetype?.name ?? "—"}</td>
      <td className="p-2 text-xs text-muted-foreground">{priority?.name ?? "—"}</td>
      <td className="p-2 text-xs text-muted-foreground">{assignee?.displayName ?? "Unassigned"}</td>
      <td className="p-2 text-xs text-muted-foreground">
        {created ? new Date(created).toLocaleDateString() : "—"}
      </td>
    </tr>
  );
}

function IssueDetailPanel({
  issue,
  connectionId,
  onClose,
}: {
  issue: JiraIssueDetail;
  connectionId: string;
  onClose: () => void;
}) {
  const fields = issue.fields as Record<string, unknown>;
  const rendered = (issue.renderedFields ?? {}) as Record<string, unknown>;
  const status = fields.status as { name?: string } | undefined;
  const issuetype = fields.issuetype as { name?: string } | undefined;
  const priority = fields.priority as { name?: string } | undefined;
  const assignee = fields.assignee as { displayName?: string; emailAddress?: string } | undefined;
  const rawDescription = rendered.description ?? fields.description ?? "";
  const comments = fields.comment as
    | { comments?: Array<{ author: { displayName?: string }; body: unknown; created: string }> }
    | undefined;
  const renderedComments = rendered.comment as
    | { comments?: Array<{ author: { displayName?: string }; body: string; created: string }> }
    | undefined;
  const attachments = fields.attachment as
    | Array<{ id: string; filename: string; mimeType: string; size: number; content: string }>
    | undefined;
  const issuelinks = fields.issuelinks as
    | Array<{
        type: { name: string };
        outwardIssue?: { key: string; fields: { summary: string } };
        inwardIssue?: { key: string; fields: { summary: string } };
      }>
    | undefined;

  /** Build the proxy URL for a Jira attachment/image URL. */
  const proxyUrl = useCallback(
    (jiraUrl: string) =>
      `/api/jira/connections/${encodeURIComponent(connectionId)}/attachment-proxy?url=${encodeURIComponent(jiraUrl)}`,
    [connectionId],
  );

  /** Sanitize HTML and rewrite Jira-hosted img src to our proxy. */
  const sanitizedDescription = useMemo(() => {
    if (!rawDescription || typeof rawDescription !== "string") return "";
    // If no HTML tags, treat as plain text
    if (!/<[a-z][\s\S]*>/i.test(rawDescription)) return "";
    const clean = DOMPurify.sanitize(rawDescription, {
      ADD_TAGS: ["img"],
      ADD_ATTR: ["src", "alt", "style", "class"],
    });
    // Rewrite img src URLs pointing to the Jira instance through our proxy
    return clean.replace(/(<img\s[^>]*?\bsrc=")([^"]+)(")/gi, (_match, pre, src, post) => {
      // Only proxy URLs that look like Jira attachment URLs
      if (/\/secure\/attachment\//i.test(src) || /\/rest\/api\//i.test(src)) {
        return `${pre}${proxyUrl(src)}${post}`;
      }
      return `${pre}${src}${post}`;
    });
  }, [rawDescription, proxyUrl]);

  const isPlainText =
    !sanitizedDescription && typeof rawDescription === "string" && rawDescription.length > 0;

  return (
    <div className="divide-y">
      {/* Sticky header */}
      <div className="sticky top-0 z-10 bg-card p-4 border-b">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-1.5 mb-1">
              <span className="font-mono text-xs font-bold text-primary">{issue.key}</span>
              {status?.name && (
                <Badge variant="outline" className="text-xs">
                  {status.name}
                </Badge>
              )}
              {issuetype?.name && (
                <Badge variant="secondary" className="text-xs">
                  {issuetype.name}
                </Badge>
              )}
              {priority?.name && (
                <Badge variant="secondary" className="text-xs">
                  {priority.name}
                </Badge>
              )}
            </div>
            <h3 className="text-sm font-semibold leading-snug">{String(fields.summary ?? "")}</h3>
            {assignee && (
              <p className="text-xs text-muted-foreground mt-1">
                {assignee.displayName ?? "Unassigned"}
                {assignee.emailAddress ? ` · ${assignee.emailAddress}` : ""}
              </p>
            )}
          </div>
          <Button size="sm" variant="ghost" className="shrink-0 h-7 w-7 p-0" onClick={onClose}>
            ✕
          </Button>
        </div>
      </div>

      {/* Description */}
      {(sanitizedDescription || isPlainText) && (
        <div className="p-4 space-y-1">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Description
          </h4>
          {sanitizedDescription ? (
            <div
              className="prose prose-sm dark:prose-invert max-w-none text-xs leading-relaxed
                         prose-img:max-w-full prose-img:rounded prose-img:border
                         prose-p:my-1 prose-headings:my-2 prose-blockquote:my-2 prose-blockquote:border-l-primary"
              dangerouslySetInnerHTML={{ __html: sanitizedDescription }}
            />
          ) : (
            <pre className="whitespace-pre-wrap text-xs font-sans leading-relaxed">
              {String(rawDescription)}
            </pre>
          )}
        </div>
      )}

      {/* Linked issues */}
      {issuelinks && issuelinks.length > 0 && (
        <div className="p-4 space-y-1">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Linked Issues ({issuelinks.length})
          </h4>
          <ul className="space-y-1">
            {issuelinks.map((link, i) => {
              const related = link.outwardIssue ?? link.inwardIssue;
              return (
                <li key={i} className="flex items-start gap-2 text-xs">
                  <Badge variant="outline" className="text-xs shrink-0">
                    {link.type.name}
                  </Badge>
                  {related && (
                    <span>
                      <span className="font-mono font-medium">{related.key}</span>{" "}
                      <span className="text-muted-foreground">{related.fields?.summary}</span>
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* Attachments */}
      {attachments && attachments.length > 0 && (
        <div className="p-4 space-y-2">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Attachments ({attachments.length})
          </h4>
          <ul className="space-y-2">
            {attachments.map((a) => {
              const isImage = a.mimeType.startsWith("image/");
              const url = proxyUrl(a.content);
              return (
                <li key={a.id} className="text-xs">
                  <a
                    href={url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 text-primary hover:underline font-mono"
                  >
                    {isImage ? "🖼" : "📎"} {a.filename}
                    <span className="text-muted-foreground font-sans">
                      ({(a.size / 1024).toFixed(1)} KB)
                    </span>
                  </a>
                  {isImage && (
                    <img
                      src={url}
                      alt={a.filename}
                      className="mt-1 max-w-full max-h-48 rounded border object-contain"
                      loading="lazy"
                    />
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* Comments */}
      {comments?.comments && comments.comments.length > 0 && (
        <div className="p-4 space-y-2">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Comments ({comments.comments.length})
          </h4>
          {comments.comments.map((c, i) => {
            const renderedBody = renderedComments?.comments?.[i]?.body;
            const bodyHtml =
              typeof renderedBody === "string" && /<[a-z][\s\S]*>/i.test(renderedBody)
                ? DOMPurify.sanitize(renderedBody)
                : null;
            return (
              <div key={i} className="rounded border bg-muted/30 p-2.5 text-xs">
                <div className="flex items-center gap-2 text-muted-foreground mb-1">
                  <span className="font-medium text-foreground">
                    {c.author?.displayName ?? "Unknown"}
                  </span>
                  <span>{new Date(c.created).toLocaleString()}</span>
                </div>
                {bodyHtml ? (
                  <div
                    className="prose prose-sm dark:prose-invert max-w-none text-xs prose-p:my-1"
                    dangerouslySetInnerHTML={{ __html: bodyHtml }}
                  />
                ) : typeof c.body === "string" ? (
                  <p className="leading-relaxed">{c.body}</p>
                ) : (
                  <pre className="whitespace-pre-wrap">{JSON.stringify(c.body, null, 2)}</pre>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
