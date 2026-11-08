"use client";

/**
 * #1871 — the extracted rules of one governing revision.
 *
 * Each row is a control id, a one-line summary and the clause reference;
 * expanding it shows the clause excerpt verbatim, as #1870 verified it against
 * the stored text. Rules are used as extracted (never gated on review), so a
 * workspace admin corrects them here: Edit changes the summary or control id,
 * Remove soft-deletes the rule. Members see the same table without those controls.
 */
import { Fragment, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { resolveErrorMessage } from "@/lib/use-app-mutation";
import {
  governingApi,
  governingKeys,
  type GoverningRule,
  type GoverningRulePatch,
} from "@/lib/governing-api";

interface Props {
  workspaceId: string;
  documentId: string;
  documentTitle: string;
  /** A revision other than the current one; omitted for the current revision. */
  revisionId?: string;
  canManage: boolean;
}

export function GoverningRulesTable({
  workspaceId,
  documentId,
  documentTitle,
  revisionId,
  canManage,
}: Props) {
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [editing, setEditing] = useState<string | null>(null);
  const [removing, setRemoving] = useState<GoverningRule | null>(null);

  const rules = useQuery({
    queryKey: governingKeys.rules(workspaceId, documentId, revisionId),
    queryFn: () => governingApi.rules(workspaceId, documentId, revisionId),
  });

  const patch = useMutation({
    mutationFn: ({ ruleId, body }: { ruleId: string; body: GoverningRulePatch }) =>
      governingApi.editRule(workspaceId, ruleId, body),
    onSuccess: async () => {
      setEditing(null);
      setRemoving(null);
      await queryClient.invalidateQueries({ queryKey: governingKeys.all(workspaceId) });
    },
  });

  function toggle(ruleId: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(ruleId)) next.delete(ruleId);
      else next.add(ruleId);
      return next;
    });
  }

  const heading = `Rules of ${documentTitle}`;

  if (rules.isPending) {
    return <p className="text-sm text-muted-foreground">Loading rules…</p>;
  }
  if (rules.isError) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {resolveErrorMessage(rules.error, "Could not load the rules")}
      </p>
    );
  }

  const { revision, rules: rows } = rules.data;

  return (
    <section aria-label={heading} className="space-y-3">
      <h2 className="text-base font-semibold">
        {heading} · {revision.revisionLabel}
        {revision.isCurrent ? " (current)" : ""}
      </h2>
      <Alert variant="info" role="note">
        <AlertDescription>
          Rules are used as extracted. {canManage ? "You" : "A workspace admin"} can correct a
          rule&apos;s summary or control id, or remove it, here.
        </AlertDescription>
      </Alert>

      {patch.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {resolveErrorMessage(patch.error, "Could not save the rule")}
        </p>
      ) : null}

      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {revision.extractionState === "done"
            ? "No rules were extracted from this revision."
            : "No rules yet — extraction has not finished."}
        </p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-muted-foreground">
              <th scope="col" className="w-8 py-2">
                <span className="sr-only">Expand</span>
              </th>
              <th scope="col" className="py-2 pr-3">
                Control
              </th>
              <th scope="col" className="py-2 pr-3">
                Summary
              </th>
              <th scope="col" className="py-2 pr-3">
                Clause
              </th>
              {canManage ? (
                <th scope="col" className="py-2">
                  <span className="sr-only">Actions</span>
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {rows.map((rule) => {
              const open = expanded.has(rule.id);
              return (
                <Fragment key={rule.id}>
                  <tr className="border-b align-top">
                    <td className="py-2">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        aria-expanded={open}
                        aria-label={`Show clause for ${rule.controlId}`}
                        onClick={() => toggle(rule.id)}
                      >
                        {open ? (
                          <ChevronDown className="h-4 w-4" aria-hidden />
                        ) : (
                          <ChevronRight className="h-4 w-4" aria-hidden />
                        )}
                      </Button>
                    </td>
                    <td className="py-2 pr-3 font-mono">{rule.controlId}</td>
                    <td className="py-2 pr-3">
                      {editing === rule.id ? (
                        <RuleEditForm
                          rule={rule}
                          saving={patch.isPending}
                          onCancel={() => setEditing(null)}
                          onSave={(body) => patch.mutate({ ruleId: rule.id, body })}
                        />
                      ) : (
                        <>
                          {rule.summary}
                          {rule.editedAt ? (
                            <span className="ml-2 text-xs text-muted-foreground">(edited)</span>
                          ) : null}
                        </>
                      )}
                    </td>
                    <td className="py-2 pr-3">{rule.clauseRef}</td>
                    {canManage ? (
                      <td className="py-2">
                        <div className="flex justify-end gap-1">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            aria-label={`Edit ${rule.controlId}`}
                            disabled={editing === rule.id}
                            onClick={() => setEditing(rule.id)}
                          >
                            Edit
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            aria-label={`Remove ${rule.controlId}`}
                            onClick={() => setRemoving(rule)}
                          >
                            Remove
                          </Button>
                        </div>
                      </td>
                    ) : null}
                  </tr>
                  {open ? (
                    <tr className="border-b">
                      <td />
                      <td colSpan={canManage ? 4 : 3} className="pb-3 pr-3">
                        <blockquote
                          aria-label={`Clause excerpt for ${rule.controlId}`}
                          className="whitespace-pre-wrap border-l-2 pl-3 text-muted-foreground"
                        >
                          {rule.clauseExcerpt}
                        </blockquote>
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      )}

      <AlertDialog
        open={removing !== null}
        onOpenChange={(open) => (open ? undefined : setRemoving(null))}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove rule {removing?.controlId}?</AlertDialogTitle>
            <AlertDialogDescription>
              The rule is no longer used for this revision. Findings that already cite it keep their
              citation.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (removing) patch.mutate({ ruleId: removing.id, body: { deleted: true } });
              }}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

function RuleEditForm({
  rule,
  saving,
  onCancel,
  onSave,
}: {
  rule: GoverningRule;
  saving: boolean;
  onCancel: () => void;
  onSave: (body: { summary?: string; controlId?: string }) => void;
}) {
  const [summary, setSummary] = useState(rule.summary);
  const [controlId, setControlId] = useState(rule.controlId);

  function submit(e: FormEvent) {
    e.preventDefault();
    const body: { summary?: string; controlId?: string } = {};
    if (summary.trim() !== rule.summary) body.summary = summary.trim();
    if (controlId.trim() !== rule.controlId) body.controlId = controlId.trim();
    if (body.summary === undefined && body.controlId === undefined) {
      onCancel();
      return;
    }
    onSave(body);
  }

  const summaryId = `rule-summary-${rule.id}`;
  const controlFieldId = `rule-control-${rule.id}`;
  const valid = summary.trim() !== "" && controlId.trim() !== "";

  return (
    <form onSubmit={submit} className="space-y-2" aria-label={`Edit rule ${rule.controlId}`}>
      <div className="space-y-1">
        <Label htmlFor={summaryId}>Summary</Label>
        <Input
          id={summaryId}
          maxLength={500}
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor={controlFieldId}>Control id</Label>
        <Input
          id={controlFieldId}
          maxLength={64}
          value={controlId}
          onChange={(e) => setControlId(e.target.value)}
        />
      </div>
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={!valid || saving}>
          Save
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
