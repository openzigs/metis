"use client";

/**
 * Database Resource Manager — Epic #820 Phase 2 (#828).
 *
 * The operator surface for physical-database IDENTITY: which of a project's
 * {@link DatabaseConnection}s resolve to the same shared {@link DatabaseResource},
 * which sibling projects share each resource (the cross-project blast radius),
 * and which connections are unlinked — with the precise reason why.
 *
 * It drives the 1a (#821) endpoints exposed on the connectors subtree:
 *   - `GET  …/connectors/dbs/identities`  → per-connection identity resolution.
 *   - `POST …/connectors/dbs/:id/link`    → assert a connection points at a
 *      resource (the escape hatch for the same physical DB behind two hostnames
 *      the conservative auto-key cannot detect).
 *   - `POST …/connectors/dbs/:id/unlink`  → reverse a link.
 *   - `POST …/connectors/dbs/:id/reresolve` → find-or-create a resource by the
 *      conservative identity key for an UNLINKED connection only.
 *
 * SAFETY / UX rules honoured here:
 *   - Both linking (asserting two DBs are the same) and unlinking are shown
 *     behind an explicit confirmation dialog that spells out the cross-project
 *     consequence — a destructive/irreversible-feeling action is never one click.
 *   - The link target picker only offers resources that already exist in THIS
 *     project (hence this workspace), so the UI never lets an operator link
 *     across workspaces; the API rejects it too, and that rejection is surfaced
 *     as a clean toast with the connection rolled back to its prior state.
 *   - Every mutation is optimistic with rollback on API error (react-query
 *     `onMutate` snapshot → `onError` restore → `onSettled` re-fetch).
 *   - Server error strings are surfaced via {@link ApiError} messages only;
 *     nothing is ever rendered as raw HTML (no `dangerouslySetInnerHTML`).
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { DatabaseConnector } from "@metis/shared";
import { ApiError } from "@/lib/api-client";
import {
  dbConnectorsApi,
  type ConnectionLinkResult,
  type ProjectDatabaseIdentity,
  type SharingProject,
} from "@/lib/connectors-api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ErrorState } from "@/components/ui/error-state";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export interface DatabaseResourceManagerProps {
  projectId: string;
  /**
   * The project's workspace id; pass `null` when the project has no workspace so
   * the "shared-database management unavailable" state renders explicitly. When
   * omitted the manager renders normally (no workspace assertion made).
   */
  workspaceId?: string | null;
}

/** react-query cache key for the per-project identity resolution. */
export function dbIdentityKey(projectId: string) {
  return ["connectors", "db-identities", projectId] as const;
}

/** react-query cache key for the per-project DB connector list (shared with the connections page). */
export function dbConnectorListKey(projectId: string) {
  return ["connectors", "dbs", projectId] as const;
}

/** `driver · host:port / db` label for a connection's physical endpoint. */
export function connectionEndpoint(conn: DatabaseConnector): string {
  const host = conn.host && conn.host.length > 0 ? conn.host : "—";
  const port = conn.port ? `:${conn.port}` : "";
  const db = conn.databaseName && conn.databaseName.length > 0 ? conn.databaseName : "—";
  return `${conn.driver} · ${host}${port} / ${db}`;
}

/**
 * The precise, human reason an unlinked connection is unlinked. Connection-level
 * identity gaps win over the project-level no-workspace blocker so the message
 * points at the field the operator can actually fix.
 */
export function unlinkedReason(
  conn: DatabaseConnector | undefined,
  identity: ProjectDatabaseIdentity,
  workspaceId?: string | null,
): string {
  if (identity.insufficientIdentity) {
    if (!conn || !conn.host) return "Insufficient identity — host is not set.";
    if (!conn.databaseName) return "Insufficient identity — database name is not set.";
    return "Insufficient identity — host and database name are required.";
  }
  if (workspaceId === null) {
    return "This project has no workspace, so connections cannot be linked to a shared database.";
  }
  return "Not linked to a shared database resource yet.";
}

/** A connection's identity joined to its full connector detail (may be absent). */
export interface JoinedConnection {
  identity: ProjectDatabaseIdentity;
  connection: DatabaseConnector | undefined;
}

/** A shared physical database and the connections + consumer projects on it. */
export interface ResourceGroup {
  databaseResourceId: string;
  connections: JoinedConnection[];
  consumerProjects: SharingProject[];
}

/**
 * Split the identity list into (a) resource groups — connections sharing one
 * {@link DatabaseResource}, with the union of their sibling consumer projects —
 * and (b) the unlinked connections. Pure; safe to unit-test in isolation.
 */
export function groupIdentities(
  identities: ProjectDatabaseIdentity[],
  connectionsById: Map<string, DatabaseConnector>,
): { resources: ResourceGroup[]; unlinked: JoinedConnection[] } {
  const byResource = new Map<string, JoinedConnection[]>();
  const consumersByResource = new Map<string, Map<string, string>>();
  const unlinked: JoinedConnection[] = [];

  for (const identity of identities) {
    const joined: JoinedConnection = {
      identity,
      connection: connectionsById.get(identity.connectionId),
    };
    if (identity.databaseResourceId == null) {
      unlinked.push(joined);
      continue;
    }
    const rid = identity.databaseResourceId;
    const list = byResource.get(rid) ?? [];
    list.push(joined);
    byResource.set(rid, list);

    let consumers = consumersByResource.get(rid);
    if (!consumers) {
      consumers = new Map<string, string>();
      consumersByResource.set(rid, consumers);
    }
    for (const sp of identity.sharingProjects) consumers.set(sp.projectId, sp.name);
  }

  const resources: ResourceGroup[] = [...byResource.entries()].map(
    ([databaseResourceId, connections]) => ({
      databaseResourceId,
      connections,
      consumerProjects: [
        ...(consumersByResource.get(databaseResourceId) ?? new Map()).entries(),
      ].map(([projectId, name]) => ({ projectId, name })),
    }),
  );

  return { resources, unlinked };
}

/** Surface an error as a safe, human string — never an internal/stack value. */
function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError && err.message ? err.message : fallback;
}

function connectionLabel(joined: JoinedConnection): string {
  return joined.connection?.label ?? joined.identity.connectionId;
}

interface LinkTarget {
  databaseResourceId: string;
  label: string;
}

// ── Dialogs ────────────────────────────────────────────────────────────────

/** Confirm-before-unlink dialog spelling out the cross-project consequence. */
function UnlinkDialog({
  joined,
  consumerCount,
  busy,
  onConfirm,
  onCancel,
}: {
  joined: JoinedConnection | null;
  consumerCount: number;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}): React.ReactElement {
  const label = joined ? connectionLabel(joined) : "";
  return (
    <Dialog open={joined != null} onOpenChange={(o) => (!o ? onCancel() : undefined)}>
      <DialogContent aria-label="Unlink connection from shared database">
        <DialogHeader>
          <DialogTitle>Unlink “{label}”?</DialogTitle>
          <DialogDescription>
            Unlinking tells METIS this connection is <strong>not</strong> the same physical database
            as the others on this resource. Cross-project impact analysis will stop treating a
            schema change here as affecting the{" "}
            {consumerCount === 1 ? "1 other project" : `${consumerCount} other projects`} that
            currently share this database. You can re-link it again at any time.
          </DialogDescription>
        </DialogHeader>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={onConfirm} disabled={busy}>
            Confirm unlink
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Confirm-before-link dialog with a same-workspace target picker. */
function LinkDialog({
  joined,
  targets,
  busy,
  onConfirm,
  onCancel,
}: {
  joined: JoinedConnection | null;
  targets: LinkTarget[];
  busy: boolean;
  onConfirm: (databaseResourceId: string) => void;
  onCancel: () => void;
}): React.ReactElement {
  const [selected, setSelected] = useState<string>(targets[0]?.databaseResourceId ?? "");
  const label = joined ? connectionLabel(joined) : "";

  return (
    <Dialog open={joined != null} onOpenChange={(o) => (!o ? onCancel() : undefined)}>
      <DialogContent aria-label="Link connection to a shared database">
        <DialogHeader>
          <DialogTitle>Link “{label}” to a shared database</DialogTitle>
          <DialogDescription>
            Linking tells METIS these connections point at the <strong>same</strong> physical
            database. Cross-project impact analysis will then treat a schema change here as
            affecting every project that shares this database. Only link connections you are sure
            resolve to the same server and database.
          </DialogDescription>
        </DialogHeader>
        <div className="mt-4 space-y-2">
          <label htmlFor="db-link-target" className="text-sm font-medium">
            Target shared database
          </label>
          <select
            id="db-link-target"
            className="block w-full rounded border border-input bg-background p-2 text-sm"
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
            disabled={busy || targets.length === 0}
          >
            {targets.length === 0 ? (
              <option value="">No shared databases available</option>
            ) : (
              targets.map((t) => (
                <option key={t.databaseResourceId} value={t.databaseResourceId}>
                  {t.label}
                </option>
              ))
            )}
          </select>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={() => selected && onConfirm(selected)}
            disabled={busy || selected === ""}
          >
            Confirm link
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── Manager ──────────────────────────────────────────────────────────────────

export function DatabaseResourceManager({
  projectId,
  workspaceId,
}: DatabaseResourceManagerProps): React.ReactElement {
  const qc = useQueryClient();

  const identitiesQuery = useQuery({
    queryKey: dbIdentityKey(projectId),
    queryFn: () => dbConnectorsApi.identities(projectId),
    enabled: Boolean(projectId),
  });
  const connectionsQuery = useQuery({
    queryKey: dbConnectorListKey(projectId),
    queryFn: async () => (await dbConnectorsApi.list(projectId)) ?? [],
    enabled: Boolean(projectId),
  });

  const [unlinkTarget, setUnlinkTarget] = useState<JoinedConnection | null>(null);
  const [linkTarget, setLinkTarget] = useState<JoinedConnection | null>(null);

  const connectionsById = useMemo(() => {
    const map = new Map<string, DatabaseConnector>();
    for (const c of connectionsQuery.data ?? []) map.set(c.id, c);
    return map;
  }, [connectionsQuery.data]);

  const identities = identitiesQuery.data ?? [];
  const { resources, unlinked } = useMemo(
    () => groupIdentities(identities, connectionsById),
    [identities, connectionsById],
  );

  const linkTargets = useMemo<LinkTarget[]>(
    () =>
      resources.map((r) => ({
        databaseResourceId: r.databaseResourceId,
        label: r.connections[0]?.connection
          ? connectionEndpoint(r.connections[0].connection)
          : r.databaseResourceId,
      })),
    [resources],
  );

  const linkMutation = useMutation({
    mutationFn: (vars: { connectionId: string; databaseResourceId: string }) =>
      dbConnectorsApi.link(projectId, vars.connectionId, vars.databaseResourceId),
    onMutate: async (vars) => {
      await qc.cancelQueries({ queryKey: dbIdentityKey(projectId) });
      const previous = qc.getQueryData<ProjectDatabaseIdentity[]>(dbIdentityKey(projectId));
      qc.setQueryData<ProjectDatabaseIdentity[]>(dbIdentityKey(projectId), (old) =>
        (old ?? []).map((i) =>
          i.connectionId === vars.connectionId
            ? { ...i, databaseResourceId: vars.databaseResourceId }
            : i,
        ),
      );
      return { previous };
    },
    onError: (err, _vars, context) => {
      if (context?.previous) qc.setQueryData(dbIdentityKey(projectId), context.previous);
      toast.error(errorMessage(err, "Failed to link connection."));
    },
    onSuccess: () => toast.success("Connection linked to shared database."),
    onSettled: () => qc.invalidateQueries({ queryKey: dbIdentityKey(projectId) }),
  });

  const unlinkMutation = useMutation({
    mutationFn: (connectionId: string) => dbConnectorsApi.unlink(projectId, connectionId),
    onMutate: async (connectionId) => {
      await qc.cancelQueries({ queryKey: dbIdentityKey(projectId) });
      const previous = qc.getQueryData<ProjectDatabaseIdentity[]>(dbIdentityKey(projectId));
      qc.setQueryData<ProjectDatabaseIdentity[]>(dbIdentityKey(projectId), (old) =>
        (old ?? []).map((i) =>
          i.connectionId === connectionId
            ? { ...i, databaseResourceId: null, sharingProjects: [] }
            : i,
        ),
      );
      return { previous };
    },
    onError: (err, _vars, context) => {
      if (context?.previous) qc.setQueryData(dbIdentityKey(projectId), context.previous);
      toast.error(errorMessage(err, "Failed to unlink connection."));
    },
    onSuccess: () => toast.success("Connection unlinked from shared database."),
    onSettled: () => qc.invalidateQueries({ queryKey: dbIdentityKey(projectId) }),
  });

  const reresolveMutation = useMutation({
    mutationFn: (connectionId: string) => dbConnectorsApi.reresolve(projectId, connectionId),
    onSuccess: (result: ConnectionLinkResult) => {
      toast.success(
        result.databaseResourceId
          ? "Connection resolved to a shared database."
          : "No shared database could be resolved from this connection's identity.",
      );
    },
    onError: (err) => toast.error(errorMessage(err, "Failed to resolve connection.")),
    onSettled: () => qc.invalidateQueries({ queryKey: dbIdentityKey(projectId) }),
  });

  const busy = linkMutation.isPending || unlinkMutation.isPending || reresolveMutation.isPending;

  const heading = (
    <div className="space-y-1">
      <h3 className="text-lg font-medium">Physical database identity</h3>
      <p className="text-sm text-muted-foreground">
        See which connections resolve to the same shared database across projects, and link or
        unlink them explicitly.
      </p>
    </div>
  );

  if (identitiesQuery.isLoading || connectionsQuery.isLoading) {
    return (
      <section data-testid="db-resource-manager" className="space-y-3">
        {heading}
        <p
          data-testid="db-identity-loading"
          role="status"
          className="text-sm text-muted-foreground"
        >
          Loading database identity…
        </p>
      </section>
    );
  }

  if (identitiesQuery.isError) {
    return (
      <section data-testid="db-resource-manager" className="space-y-3">
        {heading}
        <div data-testid="db-identity-error">
          <ErrorState
            error={identitiesQuery.error}
            title="Could not load database identity"
            homeHref={null}
            onRetry={() => {
              void identitiesQuery.refetch();
              void connectionsQuery.refetch();
            }}
          />
        </div>
      </section>
    );
  }

  // Project has no workspace → shared-database identity is unavailable. Still
  // list the connections explicitly (never a blank panel) with the reason.
  if (workspaceId === null) {
    return (
      <section data-testid="db-resource-manager" className="space-y-3">
        {heading}
        <p
          data-testid="db-identity-no-workspace"
          role="status"
          className="rounded border border-amber-700/40 bg-amber-950/30 p-3 text-sm text-amber-200"
        >
          This project is not part of a workspace, so shared-database identity management is
          unavailable. Add the project to a workspace to link connections across projects.
        </p>
        {identities.length > 0 ? (
          <ul data-testid="db-unlinked-list" className="space-y-2">
            {identities.map((identity) => {
              const conn = connectionsById.get(identity.connectionId);
              return (
                <li
                  key={identity.connectionId}
                  data-testid="db-unlinked-connection"
                  data-connection-id={identity.connectionId}
                  className="rounded border border-border p-3"
                >
                  <div className="font-medium">{conn?.label ?? identity.connectionId}</div>
                  {conn ? (
                    <div className="font-mono text-xs text-muted-foreground">
                      {connectionEndpoint(conn)}
                    </div>
                  ) : null}
                  <div data-testid="db-unlinked-reason" className="mt-1 text-xs text-amber-300">
                    {unlinkedReason(conn, identity, workspaceId)}
                  </div>
                </li>
              );
            })}
          </ul>
        ) : null}
      </section>
    );
  }

  if (identities.length === 0) {
    return (
      <section data-testid="db-resource-manager" className="space-y-3">
        {heading}
        <p data-testid="db-identity-empty" className="text-sm text-muted-foreground">
          No database connectors in this project yet. Add one above to manage its shared-database
          identity.
        </p>
      </section>
    );
  }

  return (
    <section data-testid="db-resource-manager" className="space-y-4">
      {heading}

      {resources.length > 0 ? (
        <ul data-testid="db-resource-list" className="space-y-3">
          {resources.map((group) => {
            const canonical = group.connections[0]?.connection;
            return (
              <li
                key={group.databaseResourceId}
                data-testid="db-resource-group"
                data-resource={group.databaseResourceId}
                className="rounded border border-border p-3"
              >
                <div className="flex items-center gap-2">
                  <Badge variant="outline">Shared database</Badge>
                  <span className="font-mono text-sm">
                    {canonical ? connectionEndpoint(canonical) : group.databaseResourceId}
                  </span>
                </div>

                {group.consumerProjects.length > 0 ? (
                  <div data-testid="db-resource-consumers" className="mt-2 text-xs">
                    <span className="text-muted-foreground">Also used by: </span>
                    {group.consumerProjects.map((p, idx) => (
                      <span key={p.projectId}>
                        {idx > 0 ? ", " : ""}
                        <span className="text-foreground">{p.name || p.projectId}</span>
                      </span>
                    ))}
                  </div>
                ) : (
                  <div
                    data-testid="db-resource-no-consumers"
                    className="mt-2 text-xs text-muted-foreground"
                  >
                    No other project in this workspace uses this database.
                  </div>
                )}

                <ul className="mt-3 space-y-2">
                  {group.connections.map((joined) => (
                    <li
                      key={joined.identity.connectionId}
                      data-testid="db-resource-connection"
                      data-connection-id={joined.identity.connectionId}
                      className="flex items-center justify-between gap-2 rounded bg-muted/40 px-2 py-1.5"
                    >
                      <div className="min-w-0">
                        <div className="truncate text-sm">{connectionLabel(joined)}</div>
                        {joined.connection ? (
                          <div className="truncate font-mono text-xs text-muted-foreground">
                            {connectionEndpoint(joined.connection)}
                          </div>
                        ) : null}
                      </div>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        aria-label={`Unlink ${connectionLabel(joined)}`}
                        onClick={() => setUnlinkTarget(joined)}
                      >
                        Unlink
                      </Button>
                    </li>
                  ))}
                </ul>
              </li>
            );
          })}
        </ul>
      ) : null}

      <div className="space-y-2">
        <h4 className="text-sm font-medium text-muted-foreground">Unlinked connections</h4>
        {unlinked.length === 0 ? (
          <p data-testid="db-unlinked-empty" className="text-sm text-muted-foreground">
            Every database connector in this project is linked to a shared database.
          </p>
        ) : (
          <ul data-testid="db-unlinked-list" className="space-y-2">
            {unlinked.map((joined) => {
              const conn = joined.connection;
              const linkable = !joined.identity.insufficientIdentity;
              return (
                <li
                  key={joined.identity.connectionId}
                  data-testid="db-unlinked-connection"
                  data-connection-id={joined.identity.connectionId}
                  className="flex flex-wrap items-center justify-between gap-2 rounded border border-border p-3"
                >
                  <div className="min-w-0">
                    <div className="truncate font-medium">{connectionLabel(joined)}</div>
                    {conn ? (
                      <div className="truncate font-mono text-xs text-muted-foreground">
                        {connectionEndpoint(conn)}
                      </div>
                    ) : null}
                    <div data-testid="db-unlinked-reason" className="mt-1 text-xs text-amber-300">
                      {unlinkedReason(conn, joined.identity, workspaceId)}
                    </div>
                  </div>
                  {linkable ? (
                    <div className="flex items-center gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        aria-label={`Re-resolve ${connectionLabel(joined)}`}
                        onClick={() => reresolveMutation.mutate(joined.identity.connectionId)}
                      >
                        Re-resolve
                      </Button>
                      {linkTargets.length > 0 ? (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          aria-label={`Link ${connectionLabel(joined)}`}
                          onClick={() => setLinkTarget(joined)}
                        >
                          Link…
                        </Button>
                      ) : null}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <UnlinkDialog
        joined={unlinkTarget}
        consumerCount={
          unlinkTarget
            ? (resources.find(
                (r) => r.databaseResourceId === unlinkTarget.identity.databaseResourceId,
              )?.consumerProjects.length ?? 0)
            : 0
        }
        busy={unlinkMutation.isPending}
        onCancel={() => setUnlinkTarget(null)}
        onConfirm={() => {
          if (unlinkTarget) unlinkMutation.mutate(unlinkTarget.identity.connectionId);
          setUnlinkTarget(null);
        }}
      />
      <LinkDialog
        key={linkTarget?.identity.connectionId ?? "closed"}
        joined={linkTarget}
        targets={linkTargets}
        busy={linkMutation.isPending}
        onCancel={() => setLinkTarget(null)}
        onConfirm={(databaseResourceId) => {
          if (linkTarget) {
            linkMutation.mutate({
              connectionId: linkTarget.identity.connectionId,
              databaseResourceId,
            });
          }
          setLinkTarget(null);
        }}
      />
    </section>
  );
}
