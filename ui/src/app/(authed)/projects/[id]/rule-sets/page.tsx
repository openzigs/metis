/**
 * Epic #708 / Issue #718 — Rule sets editor + exemplar grading UI.
 *
 * Lists rule sets and lets users add a rule, compile it (LLM-extract keywords),
 * and grade with at least five exemplars before activation.
 */
"use client";

import { useParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Card } from "@/components/ui/card";
import { scannerApi, type ExemplarGrade, type Rule, type RuleSet } from "@/lib/scanner-api";

const MIN_EXEMPLARS = 5;
const LANGUAGES = [
  "go",
  "java",
  "py",
  "python",
  "ts",
  "typescript",
  "js",
  "javascript",
  "scala",
  "sql",
  "kt",
  "kotlin",
];

export default function RuleSetsPage() {
  const params = useParams<{ id: string }>();
  const projectId = params.id;
  const qc = useQueryClient();
  const [newSetName, setNewSetName] = useState("");
  const [error, setError] = useState<string | null>(null);

  const setsQuery = useQuery({
    queryKey: ["scanner", "rule-sets", projectId],
    queryFn: () => scannerApi.listRuleSets(projectId),
  });

  const createSetMutation = useMutation({
    mutationFn: () => scannerApi.createRuleSet(projectId, { name: newSetName.trim() }),
    onSuccess: () => {
      setNewSetName("");
      setError(null);
      qc.invalidateQueries({ queryKey: ["scanner", "rule-sets", projectId] });
    },
    onError: (err: Error) => setError(err.message),
  });

  return (
    <div className="space-y-6 p-2 md:p-0" data-testid="scanner-rule-sets-root">
      <header className="space-y-2">
        {/* #430: removed redundant "← Back to project" link — the project
            section-nav (ProjectTabs, rendered by the project layout) is the
            single coherent navigation affordance for moving between sections. */}
        <h1 className="text-2xl font-semibold">Bug-scanner rule sets</h1>
        <p className="text-sm text-muted-foreground">
          Author natural-language rules, compile them into retrieval plans, and grade at least{" "}
          {MIN_EXEMPLARS} exemplars before activation.
        </p>
      </header>

      <Card className="space-y-3 p-4" data-testid="scanner-create-set-card">
        <h2 className="text-base font-semibold">Create rule set</h2>
        <div className="flex gap-2">
          <input
            data-testid="scanner-new-set-name"
            type="text"
            className="flex-1 rounded border bg-background px-2 py-1 text-sm"
            placeholder="Rule set name"
            value={newSetName}
            onChange={(e) => setNewSetName(e.target.value)}
          />
          <button
            type="button"
            className="rounded bg-primary px-3 py-1 text-sm text-primary-foreground disabled:opacity-50"
            data-testid="scanner-new-set-submit"
            disabled={!newSetName.trim() || createSetMutation.isPending}
            onClick={() => createSetMutation.mutate()}
          >
            {createSetMutation.isPending ? "Creating…" : "Create"}
          </button>
        </div>
        {error ? (
          <p role="alert" className="text-xs text-destructive" data-testid="scanner-set-error">
            {error}
          </p>
        ) : null}
      </Card>

      {setsQuery.isLoading ? (
        <p className="text-xs text-muted-foreground">Loading rule sets…</p>
      ) : setsQuery.isError ? (
        <p role="alert" className="text-xs text-destructive">
          {(setsQuery.error as Error).message}
        </p>
      ) : !setsQuery.data?.length ? (
        <p className="text-xs text-muted-foreground" data-testid="scanner-no-sets">
          No rule sets yet.
        </p>
      ) : (
        setsQuery.data.map((set) => <RuleSetCard key={set.id} projectId={projectId} set={set} />)
      )}
    </div>
  );
}

function RuleSetCard({ projectId, set }: { projectId: string; set: RuleSet }) {
  const qc = useQueryClient();
  const [draftRule, setDraftRule] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);

  const createRuleMutation = useMutation({
    mutationFn: () =>
      scannerApi.createRule(projectId, set.id, { naturalLanguage: draftRule.trim() }),
    onSuccess: () => {
      setDraftRule("");
      setCreateError(null);
      qc.invalidateQueries({ queryKey: ["scanner", "rule-sets", projectId] });
    },
    onError: (err: Error) => setCreateError(err.message),
  });

  return (
    <Card className="space-y-3 p-4" data-testid={`scanner-set-${set.id}`}>
      <div>
        <h3 className="text-base font-semibold">{set.name}</h3>
        {set.description ? (
          <p className="text-xs text-muted-foreground">{set.description}</p>
        ) : null}
      </div>

      <div className="space-y-2">
        <label className="text-xs text-muted-foreground">Add rule (natural language)</label>
        <textarea
          data-testid={`scanner-new-rule-${set.id}`}
          className="w-full rounded border bg-background px-2 py-1 text-sm"
          rows={3}
          value={draftRule}
          onChange={(e) => setDraftRule(e.target.value)}
          placeholder="e.g. Detect SQL injection caused by concatenating untrusted strings into raw queries"
        />
        <button
          type="button"
          className="rounded bg-primary px-3 py-1 text-sm text-primary-foreground disabled:opacity-50"
          data-testid={`scanner-new-rule-submit-${set.id}`}
          disabled={draftRule.trim().length < 10 || createRuleMutation.isPending}
          onClick={() => createRuleMutation.mutate()}
        >
          {createRuleMutation.isPending ? "Saving…" : "Add rule"}
        </button>
        {createError ? (
          <p role="alert" className="text-xs text-destructive">
            {createError}
          </p>
        ) : null}
      </div>

      <div className="space-y-3">
        {set.rules.map((rule) => (
          <RuleRow key={rule.id} projectId={projectId} ruleSetId={set.id} rule={rule} />
        ))}
      </div>
    </Card>
  );
}

function makeBlankExemplar(): ExemplarGrade {
  return {
    codeSnippet: "",
    language: "ts",
    expectedFinding: true,
    humanGrade: "true_positive",
  };
}

function RuleRow({
  projectId,
  ruleSetId,
  rule,
}: {
  projectId: string;
  ruleSetId: string;
  rule: Rule;
}) {
  const qc = useQueryClient();
  const [exemplars, setExemplars] = useState<ExemplarGrade[]>(() =>
    Array.from({ length: MIN_EXEMPLARS }, () => makeBlankExemplar()),
  );
  const [err, setErr] = useState<string | null>(null);

  const compileMutation = useMutation({
    mutationFn: () => scannerApi.compileRule(projectId, ruleSetId, rule.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["scanner", "rule-sets", projectId] }),
    onError: (e: Error) => setErr(e.message),
  });

  const gradeMutation = useMutation({
    mutationFn: () => scannerApi.gradeRule(projectId, ruleSetId, rule.id, { exemplars }),
    onSuccess: () => {
      setErr(null);
      qc.invalidateQueries({ queryKey: ["scanner", "rule-sets", projectId] });
    },
    onError: (e: Error) => setErr(e.message),
  });

  const validExemplars = exemplars.filter((g) => g.codeSnippet.trim().length > 0);
  const canGrade = rule.status === "awaiting_grading" && validExemplars.length >= MIN_EXEMPLARS;

  return (
    <div
      className="space-y-2 rounded border border-border p-3"
      data-testid={`scanner-rule-${rule.id}`}
    >
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm">{rule.naturalLanguage}</p>
          <p className="text-xs text-muted-foreground">
            severity: {rule.severity} · status: {rule.status}
          </p>
        </div>
        {rule.status === "draft" || rule.status === "failed" ? (
          <button
            type="button"
            className="rounded border px-2 py-1 text-xs disabled:opacity-50"
            data-testid={`scanner-rule-compile-${rule.id}`}
            disabled={compileMutation.isPending}
            onClick={() => compileMutation.mutate()}
          >
            {compileMutation.isPending ? "Compiling…" : "Compile"}
          </button>
        ) : null}
      </div>

      {rule.status === "awaiting_grading" || rule.status === "active" ? (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            Exemplars graded so far: {validExemplars.length} / {MIN_EXEMPLARS} minimum
          </p>
          {exemplars.map((ex, idx) => (
            <div key={idx} className="grid gap-2 md:grid-cols-[1fr_120px_140px_140px]">
              <textarea
                data-testid={`scanner-exemplar-snippet-${rule.id}-${idx}`}
                className="rounded border bg-background px-2 py-1 text-xs"
                rows={2}
                placeholder="Paste a short code sample"
                value={ex.codeSnippet}
                onChange={(e) => {
                  const v = e.target.value;
                  setExemplars((cur) =>
                    cur.map((c, i) => (i === idx ? { ...c, codeSnippet: v } : c)),
                  );
                }}
              />
              <select
                data-testid={`scanner-exemplar-lang-${rule.id}-${idx}`}
                className="rounded border bg-background px-2 py-1 text-xs"
                value={ex.language}
                onChange={(e) => {
                  const v = e.target.value;
                  setExemplars((cur) => cur.map((c, i) => (i === idx ? { ...c, language: v } : c)));
                }}
              >
                {LANGUAGES.map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </select>
              <select
                data-testid={`scanner-exemplar-expected-${rule.id}-${idx}`}
                className="rounded border bg-background px-2 py-1 text-xs"
                value={String(ex.expectedFinding)}
                onChange={(e) => {
                  const v = e.target.value === "true";
                  setExemplars((cur) =>
                    cur.map((c, i) => (i === idx ? { ...c, expectedFinding: v } : c)),
                  );
                }}
              >
                <option value="true">Should flag</option>
                <option value="false">Should NOT flag</option>
              </select>
              <select
                data-testid={`scanner-exemplar-grade-${rule.id}-${idx}`}
                className="rounded border bg-background px-2 py-1 text-xs"
                value={ex.humanGrade}
                onChange={(e) => {
                  const v = e.target.value as ExemplarGrade["humanGrade"];
                  setExemplars((cur) =>
                    cur.map((c, i) => (i === idx ? { ...c, humanGrade: v } : c)),
                  );
                }}
              >
                <option value="true_positive">True positive</option>
                <option value="false_positive">False positive</option>
                <option value="ambiguous">Ambiguous</option>
              </select>
            </div>
          ))}
          <button
            type="button"
            className="rounded bg-primary px-3 py-1 text-xs text-primary-foreground disabled:opacity-50"
            data-testid={`scanner-rule-grade-${rule.id}`}
            disabled={!canGrade || gradeMutation.isPending}
            onClick={() => gradeMutation.mutate()}
          >
            {gradeMutation.isPending ? "Saving…" : "Activate rule"}
          </button>
        </div>
      ) : null}

      {rule.errorMessage ? (
        <p
          role="alert"
          className="text-xs text-destructive"
          data-testid={`scanner-rule-err-${rule.id}`}
        >
          {rule.errorMessage}
        </p>
      ) : null}
      {err ? (
        <p role="alert" className="text-xs text-destructive">
          {err}
        </p>
      ) : null}
    </div>
  );
}
