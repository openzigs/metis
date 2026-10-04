"use client";

/**
 * #776 — open one draft as a DRAFT pull request on the saved publish target.
 *
 * Two steps, so nothing is written by accident: "Plan" is a server dry run
 * that shows exactly where the PR would go and what it would write; only then
 * is "Open draft PR" offered. There is no owner/repo field — the server uses
 * the project's saved publish target and refuses the analysed repository.
 */
import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import type { DraftPullRequestResult } from "@metis/shared";
import { publishingApi } from "@/lib/publishing-api";
import { ApiError } from "@/lib/api-client";
import { vaultRefHint, VAULT_REF_EXAMPLE } from "@/lib/vault-ref";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export interface DraftPullRequestDialogProps {
  projectId: string;
  draft: { id: string; title: string } | null;
  onOpenChange: (open: boolean) => void;
}

const CREDENTIAL_TEXT: Record<DraftPullRequestResult["credentialCheck"], string> = {
  resolved: "The vault secret resolved — a live run would reach GitHub.",
  missing: "No vault secret ref given — a live run needs one.",
  unresolved: "That vault secret ref does not name a vault secret.",
};

function messageOf(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

export function DraftPullRequestDialog({
  projectId,
  draft,
  onOpenChange,
}: DraftPullRequestDialogProps) {
  const [secretRef, setSecretRef] = useState("");
  const [plan, setPlan] = useState<DraftPullRequestResult | null>(null);

  useEffect(() => {
    setPlan(null);
  }, [draft?.id]);

  const body = () => ({ secretRef: secretRef.trim() || undefined });
  const planMutation = useMutation({
    mutationFn: () =>
      publishingApi.draftPullRequest(projectId, draft!.id, { ...body(), dryRun: true }),
    onSuccess: setPlan,
  });
  const openMutation = useMutation({
    mutationFn: () =>
      publishingApi.draftPullRequest(projectId, draft!.id, { ...body(), dryRun: false }),
    onSuccess: setPlan,
  });
  const hint = vaultRefHint(secretRef);
  const opened = plan?.pullRequest ?? null;

  return (
    <Dialog
      open={Boolean(draft)}
      onOpenChange={(open) => {
        if (!open) {
          setPlan(null);
          planMutation.reset();
          openMutation.reset();
        }
        onOpenChange(open);
      }}
    >
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Draft pull request</DialogTitle>
          <DialogDescription>
            Commits this draft as a spec file on its own branch and opens a draft pull request on
            the project&apos;s saved publish target. Plan first: nothing is written until you
            confirm.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-sm font-medium">{draft?.title}</p>
          <div>
            <Label htmlFor="draft-pr-secret">Vault secret ref</Label>
            <Input
              id="draft-pr-secret"
              placeholder={VAULT_REF_EXAMPLE}
              value={secretRef}
              onChange={(e) => {
                setSecretRef(e.target.value);
                setPlan(null);
              }}
              aria-invalid={Boolean(hint) || undefined}
            />
            {hint && <p className="mt-1 text-xs text-destructive">{hint}</p>}
          </div>

          {plan && (
            <div className="rounded-md border p-3 text-xs" data-testid="draft-pr-plan">
              <p className="font-medium">
                {opened ? "Opened" : "Plan"} · against{" "}
                <span className="font-mono">
                  {plan.target.owner}/{plan.target.repo}
                </span>
                {opened ? "" : " · nothing was written"}
              </p>
              <ul className="mt-2 list-disc pl-4">
                {plan.actions.map((a) => (
                  <li key={a.kind}>{a.summary}</li>
                ))}
              </ul>
              {!opened && <p className="mt-2">{CREDENTIAL_TEXT[plan.credentialCheck]}</p>}
              {!opened && plan.upstreamCheck && (
                <p className="mt-1 text-muted-foreground" data-testid="draft-pr-upstream-check">
                  {plan.upstreamCheck.note}
                </p>
              )}
              {opened && (
                <p className="mt-2">
                  {opened.reused ? "An open draft pull request already existed: " : ""}
                  <a
                    href={opened.htmlUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline"
                  >
                    #{opened.number}
                  </a>
                </p>
              )}
            </div>
          )}

          {(planMutation.error || openMutation.error) && (
            <p role="alert" className="text-xs text-destructive">
              {messageOf(
                planMutation.error ?? openMutation.error,
                "The draft pull request request failed.",
              )}
            </p>
          )}

          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              onClick={() => planMutation.mutate()}
              disabled={!draft || planMutation.isPending || Boolean(opened)}
            >
              {planMutation.isPending ? "Planning…" : "Plan (dry run)"}
            </Button>
            <Button
              onClick={() => openMutation.mutate()}
              disabled={
                !plan ||
                Boolean(opened) ||
                plan.credentialCheck !== "resolved" ||
                openMutation.isPending
              }
            >
              {openMutation.isPending ? "Opening…" : "Open draft PR"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
