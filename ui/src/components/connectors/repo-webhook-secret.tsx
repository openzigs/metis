"use client";

/**
 * #1475 — a GitHub repository connection's own webhook secret.
 *
 * With its own secret, the connection has its own receiver URL, and only
 * deliveries that secret signed reach its project, so another project
 * connecting the same repository cannot receive them. The secret is shown
 * once, when it is created; the server keeps no copy it could show again, so a
 * lost secret is replaced.
 */
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import type { RepoConnector } from "@metis/shared";
import { ApiError } from "@/lib/api-client";
import { repoConnectorsApi } from "@/lib/connectors-api";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";

type Connector = Pick<
  RepoConnector,
  | "id"
  | "provider"
  | "status"
  | "webhookSecretConfigured"
  | "webhookSecretNeedsRenewal"
  | "webhookPath"
  | "issuesWebhookPath"
>;

async function copy(text: string): Promise<void> {
  try {
    if (!navigator.clipboard) throw new Error("no clipboard");
    await navigator.clipboard.writeText(text);
    toast.success("Copied");
  } catch {
    toast.error("Could not copy. Select the text and copy it yourself.");
  }
}

function CopyField({ id, label, value }: { id: string; label: string; value: string }) {
  return (
    <div className="space-y-1">
      <label className="block font-medium" htmlFor={id}>
        {label}
      </label>
      <div className="flex items-center gap-2">
        <Input
          id={id}
          readOnly
          value={value}
          className="h-7 font-mono text-xs"
          onFocus={(e) => e.currentTarget.select()}
        />
        <Button
          size="sm"
          variant="outline"
          aria-label={`Copy ${label}`}
          onClick={() => void copy(value)}
        >
          Copy
        </Button>
      </div>
    </div>
  );
}

export function RepoWebhookSecret({
  projectId,
  connector,
  onChanged,
}: {
  projectId: string;
  connector: Connector;
  onChanged: () => void;
}) {
  const [shown, setShown] = useState<string | null>(null);
  const generate = useMutation({
    mutationFn: () => repoConnectorsApi.generateWebhookSecret(projectId, connector.id),
    onSuccess: (data) => {
      setShown(data.secret);
      onChanged();
    },
    onError: (err) => {
      toast.error(err instanceof ApiError ? err.message : "Could not create a webhook secret");
      onChanged();
    },
  });
  const remove = useMutation({
    mutationFn: () => repoConnectorsApi.removeWebhookSecret(projectId, connector.id),
    onSuccess: () => {
      setShown(null);
      onChanged();
    },
    onError: (err) => {
      toast.error(err instanceof ApiError ? err.message : "Could not remove the webhook secret");
      onChanged();
    },
  });

  if (connector.provider !== "github" && connector.provider !== "github_enterprise") return null;
  const busy = generate.isPending || remove.isPending;
  const configured = connector.webhookSecretConfigured;
  const stale = connector.webhookSecretNeedsRenewal;
  const hasOwn = configured || stale;

  const generateLabel = configured ? "Replace webhook secret" : "Create webhook secret";

  return (
    <div className="mt-2 space-y-2 text-xs" data-testid={`webhook-secret-${connector.id}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className={stale ? "font-medium text-warning" : "text-muted-foreground"}>
          GitHub webhook:{" "}
          {configured
            ? "this connection has its own secret"
            : stale
              ? "needs a new secret: its secret no longer works on this server"
              : "uses the server's shared secret"}
        </span>
        {configured ? (
          // Replacing a working secret breaks the live hook at once: ask first.
          <ConfirmDialog
            title="Replace this connection's webhook secret?"
            description="The current secret stops working at once, until you paste the new one into the GitHub webhook."
            confirmLabel="Replace"
            onConfirm={() => generate.mutate()}
            trigger={
              <Button size="sm" variant="outline" disabled={busy}>
                {generateLabel}
              </Button>
            }
          />
        ) : (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => generate.mutate()}>
            {generateLabel}
          </Button>
        )}
        {hasOwn ? (
          <ConfirmDialog
            title="Go back to the server's shared secret?"
            description="The connection's own webhook stops working, and its project gets shared-secret deliveries only if no earlier connection takes them."
            confirmLabel="Use shared secret"
            onConfirm={() => remove.mutate()}
            trigger={
              <Button size="sm" variant="outline" disabled={busy}>
                Use shared secret
              </Button>
            }
          />
        ) : null}
      </div>
      {stale && !shown ? (
        <p className="text-warning">
          The server&apos;s key changed, or the connection was moved to another server, so
          GitHub&apos;s deliveries to this connection are refused. Create a new secret and paste it
          into the webhook.
        </p>
      ) : null}
      {/* Shown to every shared-secret connection, whatever else connects the
          repository, so it never says whether another project does. */}
      {!hasOwn && !shown ? (
        <p className="text-muted-foreground">
          With the shared secret, this project gets the repository&apos;s deliveries only if no
          other project connected it earlier on the same secret, because METIS cannot tell the
          webhooks apart. Create a secret for this connection to be sure.
        </p>
      ) : null}
      {/* Depends on this connection's own status only. */}
      {!hasOwn && !shown && connector.status !== "connected" ? (
        <p className="font-medium text-warning" data-testid={`webhook-needs-test-${connector.id}`}>
          Shared-secret deliveries reach this connection only after a successful Test. Click Test,
          or create a secret for this connection.
        </p>
      ) : null}
      {shown ? (
        <div className="space-y-2 rounded border border-info/40 bg-info-muted p-2">
          <CopyField
            id={`webhook-secret-value-${connector.id}`}
            label="Webhook secret (shown only now)"
            value={shown}
          />
          {connector.webhookPath ? (
            <CopyField
              id={`webhook-url-${connector.id}`}
              label="Payload URL path"
              value={connector.webhookPath}
            />
          ) : null}
          {connector.issuesWebhookPath ? (
            <CopyField
              id={`webhook-issues-url-${connector.id}`}
              label="Issue events payload URL path"
              value={connector.issuesWebhookPath}
            />
          ) : null}
          <p>
            In the repository&apos;s GitHub webhook settings, set the Payload URL to your METIS
            server&apos;s public address followed by this path, and the Secret to this secret. Until
            you do, that webhook&apos;s deliveries no longer reach this project.
          </p>
          {connector.issuesWebhookPath ? (
            <p data-testid={`webhook-issues-hint-${connector.id}`}>
              Issue events (task sync and drift) now reach this project only at the issue events
              path, signed with this same secret: point the issue webhook of each repository this
              project publishes issues to at it.
            </p>
          ) : null}
        </div>
      ) : configured && connector.webhookPath ? (
        <div className="space-y-1 text-muted-foreground">
          <p>
            Payload URL path: <code>{connector.webhookPath}</code>
          </p>
          {connector.issuesWebhookPath ? (
            <p>
              Issue events payload URL path: <code>{connector.issuesWebhookPath}</code>
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
