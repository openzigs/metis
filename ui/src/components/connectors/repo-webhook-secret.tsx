"use client";

/**
 * #1475 — a GitHub repository connection's own webhook secret.
 *
 * With its own secret, the connection gets exactly the GitHub deliveries that
 * secret signed, so another project connecting the same repository cannot
 * receive them. The secret is shown once, when it is created; the server keeps
 * no copy it could show again, so a lost secret is replaced.
 */
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import type { RepoConnector } from "@metis/shared";
import { ApiError } from "@/lib/api-client";
import { repoConnectorsApi } from "@/lib/connectors-api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function RepoWebhookSecret({
  projectId,
  connector,
  onChanged,
}: {
  projectId: string;
  connector: Pick<RepoConnector, "id" | "provider" | "webhookSecretConfigured">;
  onChanged: () => void;
}) {
  const [shown, setShown] = useState<string | null>(null);
  const generate = useMutation({
    mutationFn: () => repoConnectorsApi.generateWebhookSecret(projectId, connector.id),
    onSuccess: (data) => {
      setShown(data.secret);
      onChanged();
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.message : "Could not create a webhook secret"),
  });
  const remove = useMutation({
    mutationFn: () => repoConnectorsApi.removeWebhookSecret(projectId, connector.id),
    onSuccess: () => {
      setShown(null);
      onChanged();
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.message : "Could not remove the webhook secret"),
  });

  if (connector.provider !== "github" && connector.provider !== "github_enterprise") return null;
  const busy = generate.isPending || remove.isPending;

  return (
    <div className="mt-2 space-y-2 text-xs" data-testid={`webhook-secret-${connector.id}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-muted-foreground">
          GitHub webhook:{" "}
          {connector.webhookSecretConfigured
            ? "this connection has its own secret"
            : "uses the server's shared secret"}
        </span>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => generate.mutate()}>
          {connector.webhookSecretConfigured ? "Replace webhook secret" : "Create webhook secret"}
        </Button>
        {connector.webhookSecretConfigured ? (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => remove.mutate()}>
            Use shared secret
          </Button>
        ) : null}
      </div>
      {shown ? (
        <div className="space-y-1 rounded border border-info/40 bg-info-muted p-2">
          <label className="block font-medium" htmlFor={`webhook-secret-value-${connector.id}`}>
            Webhook secret (shown only now)
          </label>
          <div className="flex items-center gap-2">
            <Input
              id={`webhook-secret-value-${connector.id}`}
              readOnly
              value={shown}
              className="h-7 font-mono text-xs"
              onFocus={(e) => e.currentTarget.select()}
            />
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                void navigator.clipboard?.writeText(shown);
                toast.success("Copied");
              }}
            >
              Copy
            </Button>
          </div>
          <p>
            In the repository&apos;s GitHub webhook settings, set this as the webhook&apos;s Secret
            (Payload URL: your METIS server&apos;s <code>/api/webhooks/github/pr</code>). Until you
            do, that webhook&apos;s deliveries no longer reach this project.
          </p>
        </div>
      ) : null}
    </div>
  );
}
