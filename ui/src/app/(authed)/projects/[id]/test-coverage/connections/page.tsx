"use client";

/**
 * Test Management Connections — saved Xray / Zephyr / TestRail credentials
 * (Epic #856 / Issue #871 UI surface).
 *
 * Mirrors the Jira connection management layout (`/projects/:id/jira`) and
 * the MCP registry CRUD pattern. After create, credentials are NEVER shown
 * back — only redacted vault refs (`${vault:...}`) appear in `authConfig`.
 *
 * Data-testid prefix is `tmc-` so the E2E spec can target stable selectors.
 */
import { useParams } from "next/navigation";
import Link from "next/link";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  CreateTestManagementConnectionInput,
  TestManagementConnectionDetail,
  TestManagementKind,
} from "@metis/shared";

import { testManagementApi } from "@/lib/test-management-api";
import { isLikelyEmail, suggestEmail } from "@/lib/error-suggestion";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";

interface AuthFormState {
  // xray
  clientId: string;
  clientSecret: string;
  // zephyr
  bearerToken: string;
  // testrail
  email: string;
  apiKey: string;
}

const EMPTY_AUTH: AuthFormState = {
  clientId: "",
  clientSecret: "",
  bearerToken: "",
  email: "",
  apiKey: "",
};

function statusVariant(status: string): "default" | "secondary" | "destructive" | "outline" {
  if (status === "ok") return "default";
  if (status === "error") return "destructive";
  return "secondary";
}

function buildAuthPayload(
  kind: TestManagementKind,
  state: AuthFormState,
): CreateTestManagementConnectionInput["auth"] {
  switch (kind) {
    case "xray":
      return { kind: "xray", clientId: state.clientId, clientSecret: state.clientSecret };
    case "zephyr":
      return { kind: "zephyr", bearerToken: state.bearerToken };
    case "testrail":
      return { kind: "testrail", email: state.email, apiKey: state.apiKey };
  }
}

export default function TestManagementConnectionsPage() {
  const params = useParams<{ id: string }>();
  const projectId = params?.id ?? "";
  const qc = useQueryClient();

  const [showAddForm, setShowAddForm] = useState(false);
  const [label, setLabel] = useState("");
  const [kind, setKind] = useState<TestManagementKind>("testrail");
  const [baseUrl, setBaseUrl] = useState("");
  const [auth, setAuth] = useState<AuthFormState>(EMPTY_AUTH);
  const [formError, setFormError] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<
    Record<string, { ok: boolean; latencyMs: number; errorMessage?: string }>
  >({});

  const connections = useQuery({
    queryKey: ["tmc-list", projectId],
    queryFn: () => testManagementApi.list(projectId),
    enabled: Boolean(projectId),
  });

  const createMutation = useMutation({
    mutationFn: () =>
      testManagementApi.create(projectId, {
        label,
        kind,
        baseUrl,
        auth: buildAuthPayload(kind, auth),
      }),
    onSuccess: () => {
      setShowAddForm(false);
      setLabel("");
      setBaseUrl("");
      setAuth(EMPTY_AUTH);
      setFormError(null);
      qc.invalidateQueries({ queryKey: ["tmc-list", projectId] });
    },
    onError: (err: Error) => setFormError(err.message),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => testManagementApi.remove(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tmc-list", projectId] }),
  });

  const testMutation = useMutation({
    mutationFn: (id: string) => testManagementApi.test(id),
    onSuccess: (result, id) => {
      setTestResults((s) => ({ ...s, [id]: result }));
      qc.invalidateQueries({ queryKey: ["tmc-list", projectId] });
    },
    onError: (err: Error, id) => {
      setTestResults((s) => ({
        ...s,
        [id]: { ok: false, latencyMs: 0, errorMessage: err.message },
      }));
    },
  });

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    if (!label.trim() || !baseUrl.trim()) {
      setFormError("Label and base URL are required");
      return;
    }
    if (kind === "xray" && (!auth.clientId || !auth.clientSecret)) {
      setFormError("Client ID and Client Secret are required for Xray");
      return;
    }
    if (kind === "zephyr" && !auth.bearerToken) {
      setFormError("Bearer token is required for Zephyr");
      return;
    }
    if (kind === "testrail" && (!auth.email || !auth.apiKey)) {
      setFormError("Email and API key are required for TestRail");
      return;
    }
    createMutation.mutate();
  };

  const onDelete = (row: TestManagementConnectionDetail) => {
    if (
      window.confirm(
        `Delete saved test-management connection "${row.label}"? Pulls that use this connection will need to be re-configured.`,
      )
    ) {
      deleteMutation.mutate(row.id);
    }
  };

  return (
    <div className="p-6 space-y-4" data-testid="tmc-page">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Test Management Connections</h1>
          <p className="text-sm text-muted-foreground max-w-2xl">
            Saved Xray / Zephyr / TestRail credentials used by Test Coverage pulls. Credentials are
            stored in the vault and never displayed after creation.
          </p>
        </div>
        <Link
          href={`/projects/${projectId}/test-coverage`}
          className="text-sm underline text-muted-foreground"
          data-testid="tmc-back-to-coverage"
        >
          ← Back to Test Coverage
        </Link>
      </div>

      <div className="flex items-center justify-between">
        <h2 className="text-lg font-medium">Saved connections</h2>
        <Button
          onClick={() => setShowAddForm((v) => !v)}
          data-testid="tmc-add"
          variant={showAddForm ? "outline" : "default"}
        >
          {showAddForm ? "Cancel" : "Add connection"}
        </Button>
      </div>

      {showAddForm && (
        <Card className="p-4 space-y-3" data-testid="tmc-add-form">
          <form onSubmit={onSubmit} className="space-y-3">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <Label htmlFor="tmc-kind">Kind</Label>
                <select
                  id="tmc-kind"
                  data-testid="tmc-kind"
                  value={kind}
                  onChange={(e) => {
                    setKind(e.target.value as TestManagementKind);
                    setAuth(EMPTY_AUTH);
                  }}
                  className="w-full border border-border rounded-md px-2 py-2 bg-background text-sm"
                >
                  <option value="xray">Xray</option>
                  <option value="zephyr">Zephyr Scale</option>
                  <option value="testrail">TestRail</option>
                </select>
              </div>
              <div>
                <Label htmlFor="tmc-label">Label</Label>
                <Input
                  id="tmc-label"
                  data-testid="tmc-label"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder="e.g. Prod TestRail"
                />
              </div>
              <div className="md:col-span-2">
                <Label htmlFor="tmc-baseUrl">Base URL</Label>
                <Input
                  id="tmc-baseUrl"
                  data-testid="tmc-baseUrl"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder="https://example.testrail.io"
                />
              </div>

              {kind === "xray" && (
                <>
                  <div>
                    <Label htmlFor="tmc-clientId">Client ID</Label>
                    <Input
                      id="tmc-clientId"
                      data-testid="tmc-clientId"
                      value={auth.clientId}
                      onChange={(e) => setAuth((s) => ({ ...s, clientId: e.target.value }))}
                    />
                  </div>
                  <div>
                    <Label htmlFor="tmc-clientSecret">Client Secret</Label>
                    <Input
                      id="tmc-clientSecret"
                      data-testid="tmc-clientSecret"
                      type="password"
                      value={auth.clientSecret}
                      onChange={(e) => setAuth((s) => ({ ...s, clientSecret: e.target.value }))}
                    />
                  </div>
                </>
              )}

              {kind === "zephyr" && (
                <div className="md:col-span-2">
                  <Label htmlFor="tmc-bearerToken">Bearer Token</Label>
                  <Input
                    id="tmc-bearerToken"
                    data-testid="tmc-bearerToken"
                    type="password"
                    value={auth.bearerToken}
                    onChange={(e) => setAuth((s) => ({ ...s, bearerToken: e.target.value }))}
                  />
                </div>
              )}

              {kind === "testrail" && (
                <>
                  <div>
                    <Label htmlFor="tmc-email">Email</Label>
                    <Input
                      id="tmc-email"
                      data-testid="tmc-email"
                      type="email"
                      // WCAG SC 1.3.5 (#659): this is the person's TestRail
                      // login email — a user-info field, so it carries the H98
                      // `email` purpose token. Sibling secret fields (API key,
                      // client secret, bearer token) are service credentials,
                      // not the user's identity, and intentionally omit it.
                      autoComplete="email"
                      value={auth.email}
                      onChange={(e) => setAuth((s) => ({ ...s, email: e.target.value }))}
                    />
                    {isLikelyEmail(auth.email.trim()) && suggestEmail(auth.email.trim()) ? (
                      <p
                        role="status"
                        className="mt-1 text-xs text-amber-600"
                        data-testid="tmc-email-hint"
                      >
                        Did you mean “{suggestEmail(auth.email.trim())}”? You can still use the
                        address as entered.
                      </p>
                    ) : null}
                  </div>
                  <div>
                    <Label htmlFor="tmc-apiKey">API Key</Label>
                    <Input
                      id="tmc-apiKey"
                      data-testid="tmc-apiKey"
                      type="password"
                      value={auth.apiKey}
                      onChange={(e) => setAuth((s) => ({ ...s, apiKey: e.target.value }))}
                    />
                  </div>
                </>
              )}
            </div>

            {formError && (
              <p className="text-sm text-destructive" role="alert" data-testid="tmc-form-error">
                {formError}
              </p>
            )}

            <div className="flex gap-2">
              <Button type="submit" disabled={createMutation.isPending} data-testid="tmc-submit">
                {createMutation.isPending ? "Saving…" : "Save connection"}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => setShowAddForm(false)}
                data-testid="tmc-cancel"
              >
                Cancel
              </Button>
            </div>
          </form>
        </Card>
      )}

      {connections.isLoading && (
        <p className="text-sm text-muted-foreground">Loading connections…</p>
      )}
      {connections.isError && (
        <p className="text-sm text-destructive" role="alert">
          Failed to load connections: {(connections.error as Error)?.message}
        </p>
      )}

      {connections.data && connections.data.length === 0 && !showAddForm && (
        <Card className="p-6 text-center" data-testid="tmc-empty">
          <p className="text-sm text-muted-foreground">
            No saved connections yet. Click <strong>Add connection</strong> to create one.
          </p>
        </Card>
      )}

      <div className="space-y-2">
        {(connections.data ?? []).map((row) => {
          const result = testResults[row.id];
          return (
            <Card key={row.id} className="p-4 space-y-2" data-testid={`tmc-row-${row.id}`}>
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div>
                  <div
                    className="font-medium flex items-center gap-2"
                    data-testid={`tmc-row-label-${row.id}`}
                  >
                    <span>{row.label}</span>
                    <Badge variant="outline" className="uppercase">
                      {row.kind}
                    </Badge>
                  </div>
                  <p className="text-xs text-muted-foreground break-all">{row.baseUrl}</p>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant={statusVariant(row.status)} data-testid={`tmc-status-${row.id}`}>
                    {row.status}
                  </Badge>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => testMutation.mutate(row.id)}
                    disabled={testMutation.isPending && testMutation.variables === row.id}
                    data-testid={`tmc-test-${row.id}`}
                  >
                    {testMutation.isPending && testMutation.variables === row.id
                      ? "Testing…"
                      : "Test"}
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={() => onDelete(row)}
                    disabled={deleteMutation.isPending}
                    data-testid={`tmc-delete-${row.id}`}
                  >
                    Delete
                  </Button>
                </div>
              </div>

              {result && (
                <p
                  className={`text-xs ${result.ok ? "text-emerald-600" : "text-destructive"}`}
                  role="status"
                  data-testid={`tmc-test-result-${row.id}`}
                >
                  {result.ok
                    ? `OK — ${result.latencyMs}ms`
                    : `Failed: ${result.errorMessage ?? "unknown error"}`}
                </p>
              )}
              {!result && row.errorMessage && (
                <p className="text-xs text-destructive" role="status">
                  Last error: {row.errorMessage}
                </p>
              )}
            </Card>
          );
        })}
      </div>
    </div>
  );
}
