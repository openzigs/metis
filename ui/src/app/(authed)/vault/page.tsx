/**
 * Epic #196 / #222 — Standalone /vault admin UI.
 *
 * Surfaces the four operations promised in USER_GUIDE §17:
 *   • list — entries with label, scope, last-rotated, key-version
 *   • create — new entry; plaintext sent over TLS, never stored client-side
 *   • rotate — replace plaintext under the same id
 *   • audit — per-entry audit trail (read/write/rotate/delete)
 *
 * Permissions: requires `vault.read` (server enforces). Non-admins see a
 * forbidden notice in place of the table.
 */
"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SkeletonText } from "@/components/ui/skeleton";
import { ApiError } from "@/lib/api-client";
import { vaultApi, type VaultEntry, type VaultAuditEntry } from "@/lib/vault-api";
import { useTransientFlag } from "@/hooks/use-transient-toast";

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

  return (
    <div className="space-y-6 p-2 md:p-0" data-testid="vault-root">
      <header>
        <h1 className="text-2xl font-semibold">Vault</h1>
        <p className="text-sm text-muted-foreground">
          Encrypted secret storage. Plaintext is never displayed by default — use{" "}
          <strong>Reveal</strong> to view a single value (audited) or <strong>Rotate</strong> to
          replace it.
        </p>
      </header>

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
  const [revealed, setRevealed] = useState<string | null>(null);
  const [revealError, setRevealError] = useState<string | null>(null);
  // #1284 — the hook owns the 1.5s dismissal timer AND cancels it on unmount.
  const { active: copied, show: showCopied } = useTransientFlag(1500);
  const [rotateValue, setRotateValue] = useState("");
  const [rotateError, setRotateError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

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
    mutationFn: () => vaultApi.rotate(entry.id, rotateValue),
    onSuccess: () => {
      setRotateValue("");
      setRotateError(null);
      setRevealed(null);
      onChanged();
      void qc.invalidateQueries({ queryKey: ["vault", "audit", entry.id] });
    },
    onError: (err: ApiError) => setRotateError(err.message),
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
            onChange={(e) => setRotateValue(e.target.value)}
            placeholder="New plaintext value"
            autoComplete="off"
            data-testid="vault-entry-rotate-input"
          />
          <Button
            size="sm"
            onClick={() => rotate.mutate()}
            disabled={rotate.isPending || rotateValue.length === 0}
            data-testid="vault-entry-rotate-submit"
          >
            {rotate.isPending ? "Rotating…" : "Rotate"}
          </Button>
        </div>
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
                <span className="rounded bg-sky-100 px-1.5 text-sky-900">{row.action}</span>
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
