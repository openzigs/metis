/**
 * Epic #196 / #222 — Standalone /vault admin UI.
 *
 * Surfaces the four operations promised in USER_GUIDE §17:
 *   • list — entries with label, scope, last-rotated, key-version
 *   • create — new entry; plaintext sent over TLS, never stored client-side
 *   • rotate — replace plaintext under the same id; another user's secret
 *     shows its owner and bindings and needs an explicit "Rotate anyway" (#482),
 *     which is tied to the bindings shown and makes the admin the owner (#502);
 *     a list over the server's cap is confirmed by its digest instead (#611)
 *   • audit — per-entry audit trail (read/write/rotate/delete)
 *
 * Permissions: requires `vault.read` (server enforces). Roles without it see a
 * forbidden notice in place of the table. Revealing plaintext needs
 * `vault.reveal`, which only admins hold (#324) — other roles get no Reveal
 * control; the server refuses them regardless.
 */
"use client";

import { useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { hasPermission } from "@metis/shared";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SkeletonText } from "@/components/ui/skeleton";
import { ApiError } from "@/lib/api-client";
import { useAuth } from "@/lib/auth-context";
import {
  vaultApi,
  VAULT_ROTATE_BINDINGS_CHANGED,
  VAULT_ROTATE_FOREIGN_OWNER,
  type VaultEntry,
  type VaultAuditEntry,
  type VaultForeignOwner,
  type VaultRotateConfirm,
} from "@/lib/vault-api";
import { bindingTypeLabel } from "@/lib/vault-binding-summary";
import { useTransientFlag } from "@/hooks/use-transient-toast";
import { PageHeader } from "@/components/ui/page-header";

const VAULT_LIST_KEY = ["vault", "list"] as const;

export default function VaultPage() {
  const qc = useQueryClient();
  const list = useQuery<{ items: VaultEntry[] }, ApiError>({
    queryKey: VAULT_LIST_KEY,
    queryFn: () => vaultApi.list(),
    retry: false,
  });

  const [selected, setSelected] = useState<VaultEntry | null>(null);

  const isForbidden = list.error?.status === 403;
  const { user } = useAuth();
  // #410 — Settings → Configuration is gated on `admin.read`, so only roles
  // that can open it get the pointer there.
  const canSeeServerConfig = user ? hasPermission(user.role, "admin.read") : false;

  return (
    <div className="space-y-6 p-2 md:p-0" data-testid="vault-root">
      <PageHeader
        title="Vault"
        description={
          <>
            Encrypted secret storage. Plaintext is never displayed by default — use{" "}
            <strong>Reveal</strong> to view a single value (admin-only, audited) or{" "}
            <strong>Rotate</strong> to replace it.
          </>
        }
      />

      {canSeeServerConfig ? (
        <p className="text-xs text-muted-foreground" data-testid="vault-server-config-note">
          Connectors, MCP servers and publishing reference Vault entries as{" "}
          <code>{"${vault:…}"}</code>. Global entries named after a server configuration key, such
          as a provider API key, are the server&apos;s runtime secrets: rotate or clear those in{" "}
          <Link href="/settings/api-keys" className="underline underline-offset-2">
            Settings → Configuration
          </Link>
          .
        </p>
      ) : null}

      {isForbidden ? (
        <Card className="p-4" data-testid="vault-forbidden">
          <p className="text-sm">
            You don&apos;t have permission to view the vault. Ask an administrator for the{" "}
            <code>vault.read</code> permission.
          </p>
        </Card>
      ) : (
        <>
          <CreateEntryCard
            onCreated={() => {
              void qc.invalidateQueries({ queryKey: VAULT_LIST_KEY });
            }}
          />
          <Card className="p-4" data-testid="vault-list-card">
            <h2 className="text-sm font-semibold">Entries</h2>
            {list.isLoading ? (
              <SkeletonText lines={3} className="mt-3" />
            ) : list.isError ? (
              <p
                role="alert"
                className="mt-3 rounded border border-destructive p-2 text-xs text-destructive"
              >
                {list.error.message}
              </p>
            ) : (
              <table
                className="mt-3 w-full text-left text-xs"
                aria-label="Vault entries"
                data-testid="vault-list"
              >
                <thead>
                  <tr className="text-muted-foreground">
                    <th className="py-1 pr-3 font-medium">Label</th>
                    <th className="py-1 pr-3 font-medium">Scope</th>
                    <th className="py-1 pr-3 font-medium">Key version</th>
                    <th className="py-1 pr-3 font-medium">Updated</th>
                    <th className="py-1 pr-3 font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {(list.data?.items ?? []).map((entry) => (
                    <tr key={entry.id} className="border-t" data-testid={`vault-row-${entry.id}`}>
                      <td className="py-1 pr-3 font-mono">{entry.label}</td>
                      <td className="py-1 pr-3">{entry.scope}</td>
                      <td className="py-1 pr-3">v{entry.keyVersion}</td>
                      <td className="py-1 pr-3">{new Date(entry.updatedAt).toLocaleString()}</td>
                      <td className="py-1 pr-3">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setSelected(entry)}
                          data-testid={`vault-row-open-${entry.id}`}
                        >
                          Open
                        </Button>
                      </td>
                    </tr>
                  ))}
                  {(list.data?.items ?? []).length === 0 ? (
                    <tr>
                      <td
                        colSpan={5}
                        className="py-3 text-center text-xs text-muted-foreground"
                        data-testid="vault-list-empty"
                      >
                        No entries yet — create one above.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            )}
          </Card>
          {selected ? (
            <EntryDetail
              entry={selected}
              onClose={() => setSelected(null)}
              onChanged={() => {
                void qc.invalidateQueries({ queryKey: VAULT_LIST_KEY });
              }}
            />
          ) : null}
        </>
      )}
    </div>
  );
}

function CreateEntryCard({ onCreated }: { onCreated: () => void }) {
  const [label, setLabel] = useState("");
  const [value, setValue] = useState("");
  const [scope, setScope] = useState<"global" | "project">("global");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () =>
      vaultApi.create({
        label: label.trim(),
        value,
        scope,
        description: description.trim() || undefined,
      }),
    onSuccess: () => {
      setLabel("");
      setValue("");
      setDescription("");
      setScope("global");
      setError(null);
      onCreated();
    },
    onError: (err: ApiError) => {
      setError(err.message);
    },
  });

  const disabled = create.isPending || label.trim().length === 0 || value.length === 0;

  return (
    <Card className="space-y-3 p-4" data-testid="vault-create-card">
      <h2 className="text-sm font-semibold">Create entry</h2>
      <p className="text-xs text-muted-foreground">
        Plaintext is encrypted server-side and never persisted to disk unencrypted. The label may
        use <code>a-z 0-9 _ . - :</code>.
      </p>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="vault-create-label">Label</Label>
          <Input
            id="vault-create-label"
            data-testid="vault-create-label"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="github-pat"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="vault-create-scope">Scope</Label>
          <select
            id="vault-create-scope"
            data-testid="vault-create-scope"
            className="w-full rounded border bg-background px-2 py-1 text-sm"
            value={scope}
            onChange={(e) => setScope(e.target.value as "global" | "project")}
          >
            <option value="global">global</option>
            <option value="project">project</option>
          </select>
        </div>
        <div className="space-y-1 md:col-span-2">
          <Label htmlFor="vault-create-value">Value (plaintext)</Label>
          <Input
            id="vault-create-value"
            type="password"
            data-testid="vault-create-value"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="ghp_..."
            autoComplete="off"
          />
        </div>
        <div className="space-y-1 md:col-span-2">
          <Label htmlFor="vault-create-description">Description (optional)</Label>
          <Input
            id="vault-create-description"
            data-testid="vault-create-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="GitHub PAT for org/repo issue publishing"
          />
        </div>
      </div>
      {error ? (
        <p role="alert" className="text-xs text-destructive" data-testid="vault-create-error">
          {error}
        </p>
      ) : null}
      <div>
        <Button
          onClick={() => create.mutate()}
          disabled={disabled}
          data-testid="vault-create-submit"
        >
          {create.isPending ? "Creating…" : "Create entry"}
        </Button>
      </div>
    </Card>
  );
}

/**
 * #611 (PR #627 review) — over the confirm cap, counts by binding type and by
 * destination host, so reviewing 1,000+ bindings starts from a few rows.
 * #629 — the server counts the WHOLE set, including bindings past the listing.
 */
function OverCapSummary({ counts }: { counts: VaultForeignOwner["bindingCounts"] }) {
  const { byType, byHost, moreHosts, withoutHost } = counts;
  return (
    <div className="grid gap-2 sm:grid-cols-2" data-testid="vault-entry-rotate-over-cap-summary">
      <div>
        <p className="font-semibold">By type</p>
        <ul data-testid="vault-entry-rotate-counts-by-type">
          {byType.map((t) => (
            <li key={t.type}>
              {bindingTypeLabel(t.type)}: {t.count}
            </li>
          ))}
        </ul>
      </div>
      <div>
        <p className="font-semibold">By destination host</p>
        <ul data-testid="vault-entry-rotate-counts-by-host">
          {byHost.map((h) => (
            <li key={h.host}>
              {h.host}: {h.count}
            </li>
          ))}
          {moreHosts.hosts > 0 ? (
            <li>
              {moreHosts.hosts} more hosts: {moreHosts.bindings}
            </li>
          ) : null}
          {withoutHost > 0 ? (
            <li>No network host (driver, provider or command): {withoutHost}</li>
          ) : null}
        </ul>
      </div>
    </div>
  );
}

function EntryDetail({
  entry,
  onClose,
  onChanged,
}: {
  entry: VaultEntry;
  onClose: () => void;
  onChanged: () => void;
}) {
  const qc = useQueryClient();
  const { user } = useAuth();
  const canReveal = user ? hasPermission(user.role, "vault.reveal") : false;
  const [revealed, setRevealed] = useState<string | null>(null);
  const [revealError, setRevealError] = useState<string | null>(null);
  // #1284 — the hook owns the 1.5s dismissal timer AND cancels it on unmount.
  const { active: copied, show: showCopied } = useTransientFlag(1500);
  const [rotateValue, setRotateValue] = useState("");
  const [rotateError, setRotateError] = useState<string | null>(null);
  const [foreignOwner, setForeignOwner] = useState<VaultForeignOwner | null>(null);
  const [bindingsChanged, setBindingsChanged] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  // #611 — too many bindings to echo back: confirm by the digest of the whole list.
  // #629 — judged on the total: the listing itself stops at the cap.
  const overCap =
    foreignOwner !== null && foreignOwner.bindingsTotal > foreignOwner.maxConfirmedBindings;

  const auditQuery = useQuery({
    queryKey: ["vault", "audit", entry.id],
    queryFn: () => vaultApi.audit(entry.id),
    retry: false,
  });

  const reveal = useMutation({
    mutationFn: () => vaultApi.reveal(entry.id),
    onSuccess: (data) => {
      setRevealed(data.plaintext);
      setRevealError(null);
      void qc.invalidateQueries({ queryKey: ["vault", "audit", entry.id] });
    },
    onError: (err: ApiError) => setRevealError(err.message),
  });

  const rotate = useMutation({
    // #502 — a confirm carries the bindings (type, id, destination; #557 routing) the admin was shown;
    // #611 — or, over the cap, the digest of that whole list.
    mutationFn: (confirm: VaultRotateConfirm | null) =>
      confirm
        ? vaultApi.rotate(entry.id, rotateValue, { confirmForeignOwner: true, ...confirm })
        : vaultApi.rotate(entry.id, rotateValue),
    onSuccess: () => {
      setRotateValue("");
      setRotateError(null);
      setForeignOwner(null);
      setBindingsChanged(false);
      setRevealed(null);
      onChanged();
      void qc.invalidateQueries({ queryKey: ["vault", "audit", entry.id] });
    },
    onError: (err: ApiError) => {
      // #482 — another user's secret: show who owns it and where it is bound,
      // and let the admin confirm rather than failing outright.
      // #502 — if the bindings changed since, show the live list to confirm again.
      const changed = err.code === VAULT_ROTATE_BINDINGS_CHANGED;
      if ((err.code === VAULT_ROTATE_FOREIGN_OWNER || changed) && err.details) {
        setRotateError(null);
        setForeignOwner(err.details as VaultForeignOwner);
        setBindingsChanged(changed);
        return;
      }
      setForeignOwner(null);
      setBindingsChanged(false);
      setRotateError(err.message);
    },
  });

  const remove = useMutation({
    mutationFn: () => vaultApi.remove(entry.id),
    onSuccess: () => {
      onChanged();
      onClose();
    },
    onError: (err: ApiError) => setDeleteError(err.message),
  });

  async function copyToClipboard() {
    if (!revealed) return;
    try {
      await navigator.clipboard.writeText(revealed);
      showCopied();
    } catch {
      // Clipboard API may not exist in some environments — fall back silently.
    }
  }

  return (
    <Card className="space-y-4 p-4" data-testid="vault-entry-detail">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">{entry.label}</h2>
          <p className="text-xs text-muted-foreground">
            Scope: <strong>{entry.scope}</strong> · Key version v{entry.keyVersion} · Updated{" "}
            {new Date(entry.updatedAt).toLocaleString()}
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={onClose} data-testid="vault-entry-close">
          Close
        </Button>
      </div>

      <section className="space-y-2" data-testid="vault-entry-reveal">
        <h3 className="text-xs font-semibold uppercase text-muted-foreground">Plaintext</h3>
        {revealed ? (
          <div className="flex items-center gap-2">
            <code
              className="rounded bg-muted px-2 py-1 font-mono text-xs"
              data-testid="vault-entry-plaintext"
            >
              {maskPreview(revealed)}
            </code>
            <Button
              size="sm"
              variant="outline"
              onClick={copyToClipboard}
              data-testid="vault-entry-copy"
            >
              {copied ? "Copied" : "Copy"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setRevealed(null)}
              data-testid="vault-entry-hide"
            >
              Hide
            </Button>
          </div>
        ) : !canReveal ? (
          <p className="text-xs text-muted-foreground" data-testid="vault-entry-reveal-admin-only">
            Revealing a secret&apos;s value is limited to administrators. You can still use this
            secret by reference.
          </p>
        ) : (
          <Button
            size="sm"
            onClick={() => reveal.mutate()}
            disabled={reveal.isPending}
            data-testid="vault-entry-reveal-btn"
          >
            {reveal.isPending ? "Revealing…" : "Reveal (audited)"}
          </Button>
        )}
        {revealError ? (
          <p role="alert" className="text-xs text-destructive">
            {revealError}
          </p>
        ) : null}
      </section>

      <section className="space-y-2" data-testid="vault-entry-rotate">
        <h3 className="text-xs font-semibold uppercase text-muted-foreground">Rotate value</h3>
        <div className="flex items-center gap-2">
          <Input
            type="password"
            value={rotateValue}
            onChange={(e) => {
              setRotateValue(e.target.value);
              setForeignOwner(null);
              setBindingsChanged(false);
            }}
            placeholder="New plaintext value"
            autoComplete="off"
            data-testid="vault-entry-rotate-input"
          />
          <Button
            size="sm"
            onClick={() => rotate.mutate(null)}
            disabled={rotate.isPending || rotateValue.length === 0 || foreignOwner !== null}
            data-testid="vault-entry-rotate-submit"
          >
            {rotate.isPending ? "Rotating…" : "Rotate"}
          </Button>
        </div>
        {foreignOwner ? (
          <div
            role="alert"
            className="space-y-2 rounded border border-destructive/50 p-3 text-xs"
            data-testid="vault-entry-rotate-foreign-owner"
          >
            <p>
              This secret belongs to{" "}
              <strong>
                {foreignOwner.owner.displayName ??
                  foreignOwner.owner.username ??
                  foreignOwner.owner.id}
              </strong>
              . Rotating it sends your value wherever they have bound it. The secret then becomes
              yours, so they can no longer bind it anywhere new; their existing bindings keep
              working.
            </p>
            {bindingsChanged ? (
              <p className="font-semibold" data-testid="vault-entry-rotate-bindings-changed">
                Its bindings changed since you were shown them. Review the list below and confirm
                again.
              </p>
            ) : null}
            {overCap ? (
              <>
                <p className="font-semibold" data-testid="vault-entry-rotate-over-cap">
                  It is bound to {foreignOwner.bindingsTotal} resources, more than the{" "}
                  {foreignOwner.maxConfirmedBindings} a confirmation can list one by one. Rotate
                  anyway confirms all of them as one. Start from the counts, which cover every
                  binding: if every binding type and destination host is one you expect, the list
                  only needs a scan for names you do not recognise. If any binding changes before
                  you confirm, you will be shown the new list.
                </p>
                <OverCapSummary counts={foreignOwner.bindingCounts} />
              </>
            ) : null}
            {foreignOwner.bindings.length === 0 ? (
              <p>
                No DB or repo connector, import source, MCP server, Jira or test-management
                connection uses it; other references (e.g. notification channels, BYOK) were not
                checked.
              </p>
            ) : (
              <ul className="list-disc pl-4" data-testid="vault-entry-rotate-bindings">
                {foreignOwner.bindings.map((b) => (
                  <li key={`${b.type}:${b.id}`}>
                    {b.label}
                    {b.destination ? (
                      <span className="text-muted-foreground"> — {b.destination}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
            {foreignOwner.bindingsTruncated ? (
              <p data-testid="vault-entry-rotate-bindings-truncated">
                Showing the first {foreignOwner.bindings.length} of {foreignOwner.bindingsTotal}{" "}
                bindings. The counts above cover all of them, and Rotate anyway confirms all of
                them.
              </p>
            ) : null}
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="destructive"
                onClick={() =>
                  rotate.mutate(
                    overCap
                      ? { confirmedBindingsDigest: foreignOwner.bindingsDigest }
                      : {
                          confirmedBindings: foreignOwner.bindings.map(
                            ({ type, id, destination, routing }) => ({
                              type,
                              id,
                              destination,
                              routing,
                            }),
                          ),
                        },
                  )
                }
                disabled={rotate.isPending}
                data-testid="vault-entry-rotate-confirm"
              >
                Rotate anyway
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setForeignOwner(null);
                  setBindingsChanged(false);
                }}
                data-testid="vault-entry-rotate-cancel"
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : null}
        {rotateError ? (
          <p role="alert" className="text-xs text-destructive">
            {rotateError}
          </p>
        ) : null}
      </section>

      <section className="space-y-2" data-testid="vault-entry-audit">
        <h3 className="text-xs font-semibold uppercase text-muted-foreground">Audit trail</h3>
        {auditQuery.isLoading ? (
          <SkeletonText lines={3} />
        ) : auditQuery.isError ? (
          <p role="alert" className="text-xs text-destructive">
            {(auditQuery.error as Error).message}
          </p>
        ) : (auditQuery.data?.items ?? []).length === 0 ? (
          <p className="text-xs text-muted-foreground">No audit events yet.</p>
        ) : (
          <ul className="space-y-1 text-xs">
            {(auditQuery.data?.items ?? []).map((row: VaultAuditEntry) => (
              <li
                key={row.id}
                className="flex items-center gap-2"
                data-testid={`vault-audit-${row.id}`}
              >
                <span className="font-mono text-muted-foreground">
                  {new Date(row.createdAt).toLocaleString()}
                </span>
                <span className="rounded bg-info-muted px-1.5 text-info">{row.action}</span>
                <span className="text-muted-foreground">by {row.actorId ?? "system"}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-2 border-t pt-3" data-testid="vault-entry-delete">
        <h3 className="text-xs font-semibold uppercase text-destructive">Danger zone</h3>
        <p className="text-xs text-muted-foreground">
          Soft-deletes the entry. Anything still referencing
          <code className="mx-1">${`{vault:${entry.label}}`}</code> will fail to resolve.
        </p>
        <Button
          variant="destructive"
          size="sm"
          onClick={() => remove.mutate()}
          disabled={remove.isPending}
          data-testid="vault-entry-delete-btn"
        >
          {remove.isPending ? "Deleting…" : "Delete entry"}
        </Button>
        {deleteError ? (
          <p role="alert" className="text-xs text-destructive">
            {deleteError}
          </p>
        ) : null}
      </section>
    </Card>
  );
}

/** Show the first 4 + last 4 chars of a secret as a quick visual confirmation. */
function maskPreview(plaintext: string): string {
  if (plaintext.length <= 8) return "•".repeat(plaintext.length);
  return `${plaintext.slice(0, 4)}…${plaintext.slice(-4)}`;
}
