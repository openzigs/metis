"use client";

/**
 * #145 — edit a project custom agent's definition: persona, skills, tool
 * allowlist, preferred model, reasoning effort and approval override. The
 * version is the server's (it goes up on every save) and is shown read-only.
 *
 * The same fields as the authoring wizard, on one screen. Only the fields the
 * user changed are sent (`PATCH /api/custom-agents/:id`), so an agent that
 * still names a tool this server does not list (an older agent, or an MCP
 * server that is stopped) can have its persona edited without the save being
 * refused over a tool the user never touched.
 */
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { CustomAgentApprovalPolicy, CustomAgentDto, SdkReasoningEffort } from "@metis/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { sdkApi, type CreateCustomAgentInput } from "@/lib/sdk-alignment-api";
import { modelCatalogApi, formatModelPrice } from "@/lib/model-catalog-api";
import { skillsApi } from "@/lib/library-api";
import { formatLibrarySaveError } from "@/lib/format-agent-save-error";
import {
  APPROVAL_CHOICES,
  DEFAULT_MODEL_OPTION,
  REASONING_OPTIONS,
  RISKS,
  SUBAGENT_TOOL_REF,
  type ApprovalChoice,
  type RiskKey,
} from "./definition-options";

export interface AgentDraft {
  description: string;
  systemPrompt: string;
  tools: string[];
  skillKeys: string[];
  model: string;
  reasoningEffort: "" | SdkReasoningEffort;
  approval: Record<RiskKey, ApprovalChoice>;
}

/** The form's view of a stored agent. A stored `auto` override has no effect, so it reads as the session default. */
export function draftFromAgent(agent: CustomAgentDto): AgentDraft {
  const approval = { low: "", medium: "", high: "" } as Record<RiskKey, ApprovalChoice>;
  for (const r of RISKS) {
    const v = agent.approvalPolicy?.[r];
    if (v && v !== "auto") approval[r] = v;
  }
  return {
    description: agent.description ?? "",
    systemPrompt: agent.systemPrompt ?? "",
    tools: [...(agent.tools ?? [])],
    skillKeys: [...(agent.skillKeys ?? [])],
    model: agent.model ?? "",
    reasoningEffort: agent.reasoningEffort ?? "",
    approval,
  };
}

function approvalOf(draft: AgentDraft): CustomAgentApprovalPolicy | null {
  const out: CustomAgentApprovalPolicy = {};
  for (const r of RISKS) {
    const choice = draft.approval[r];
    if (choice !== "") out[r] = choice;
  }
  return Object.keys(out).length > 0 ? out : null;
}

const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && [...a].sort().join("\n") === [...b].sort().join("\n");

/** The PATCH body: only what changed. `null` clears the model, effort or override. */
export function buildAgentPatch(
  initial: AgentDraft,
  draft: AgentDraft,
): Partial<CreateCustomAgentInput> {
  const patch: Partial<CreateCustomAgentInput> = {};
  if (draft.description.trim() !== initial.description.trim()) {
    patch.description = draft.description.trim();
  }
  if (draft.systemPrompt.trim() !== initial.systemPrompt.trim()) {
    patch.systemPrompt = draft.systemPrompt.trim();
  }
  if (!sameSet(draft.tools, initial.tools)) patch.tools = [...draft.tools];
  if (!sameSet(draft.skillKeys, initial.skillKeys)) patch.skillKeys = [...draft.skillKeys];
  if (draft.model !== initial.model) patch.model = draft.model || null;
  if (draft.reasoningEffort !== initial.reasoningEffort) {
    patch.reasoningEffort = draft.reasoningEffort || null;
  }
  const before = approvalOf(initial);
  const after = approvalOf(draft);
  if (JSON.stringify(before) !== JSON.stringify(after)) patch.approvalPolicy = after;
  return patch;
}

interface Props {
  agent: CustomAgentDto;
  onCancel: () => void;
  onSaved: (updated: CustomAgentDto) => void;
}

export function CustomAgentEditForm({ agent, onCancel, onSaved }: Props) {
  const [initial] = useState(() => draftFromAgent(agent));
  const [draft, setDraft] = useState(initial);

  const toolsQuery = useQuery({ queryKey: ["ai-tools"], queryFn: () => sdkApi.listTools() });
  const skillsQuery = useQuery({
    queryKey: ["library-skills", "wizard"],
    queryFn: () => skillsApi.list(),
  });
  const modelsQuery = useQuery({
    queryKey: ["ai-model-catalog", "provider"],
    queryFn: () => modelCatalogApi.list(),
  });

  const listed = new Set([...(toolsQuery.data?.tools ?? []).map((t) => t.name), SUBAGENT_TOOL_REF]);
  // The agent's own refs stay visible (and removable) even when this server
  // does not list them — an older agent's names, or a stopped MCP server's.
  const toolRows = [...new Set([...[...listed].sort(), ...initial.tools])];
  const skills = (skillsQuery.data?.items ?? []).filter((s) => s.enabled && !s.archived);
  const skillRows = [
    ...skills.map((s) => ({ key: s.key, label: s.name, known: true })),
    ...initial.skillKeys
      .filter((k) => !skills.some((s) => s.key === k))
      .map((k) => ({ key: k, label: k, known: false })),
  ];
  const catalog = (modelsQuery.data?.models ?? []).map((m) => {
    const price = formatModelPrice(m);
    return { value: m.id, label: price ? `${m.displayName} — ${price}` : m.displayName };
  });
  const modelOptions = [
    DEFAULT_MODEL_OPTION,
    ...catalog,
    ...(initial.model && !catalog.some((m) => m.value === initial.model)
      ? [{ value: initial.model, label: `${initial.model} (not in the model catalog)` }]
      : []),
  ];

  const patch = buildAgentPatch(initial, draft);
  const dirty = Object.keys(patch).length > 0;
  const valid = draft.systemPrompt.trim().length > 0;

  const save = useMutation({
    mutationFn: () => sdkApi.updateAgent(agent.id, patch),
    onSuccess: (updated) => onSaved(updated),
  });

  const toggle = (field: "tools" | "skillKeys", value: string) =>
    setDraft((d) => ({
      ...d,
      [field]: d[field].includes(value)
        ? d[field].filter((x) => x !== value)
        : [...d[field], value],
    }));

  return (
    <form
      className="space-y-4"
      data-testid="ca-edit-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (dirty && valid) save.mutate();
      }}
    >
      <p className="text-xs text-muted-foreground" data-testid="ca-edit-version">
        Version {agent.version ?? "1.0.0"} — saving creates the next version.
      </p>
      <div className="space-y-2">
        <Label htmlFor="ca-edit-description">Description</Label>
        <Input
          id="ca-edit-description"
          data-testid="ca-edit-description"
          value={draft.description}
          maxLength={500}
          onChange={(e) => setDraft({ ...draft, description: e.target.value })}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="ca-edit-prompt">Persona (system prompt)</Label>
        <textarea
          id="ca-edit-prompt"
          data-testid="ca-edit-prompt"
          className="w-full min-h-[140px] rounded-md border bg-background p-2 text-sm"
          value={draft.systemPrompt}
          maxLength={20_000}
          onChange={(e) => setDraft({ ...draft, systemPrompt: e.target.value })}
        />
      </div>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Allowed tools</legend>
        <p className="text-xs text-muted-foreground">
          The agent may call only these. Every call still needs the approval its chat asks for.
        </p>
        {toolsQuery.isError && (
          <p className="text-xs text-destructive" role="alert">
            Failed to load tools.
          </p>
        )}
        <ul className="max-h-40 space-y-1 overflow-y-auto rounded border p-2">
          {toolRows.map((tool) => (
            <li key={tool} className="flex items-center gap-2">
              <input
                type="checkbox"
                id={`ca-edit-tool-${tool}`}
                data-testid={`ca-edit-tool-${tool}`}
                checked={draft.tools.includes(tool)}
                onChange={() => toggle("tools", tool)}
              />
              <Label htmlFor={`ca-edit-tool-${tool}`} className="text-sm font-normal">
                {tool === SUBAGENT_TOOL_REF ? "Delegate to other agents (agent:*)" : tool}
                {!listed.has(tool) && (
                  <span className="ml-1 text-xs text-muted-foreground">
                    (not in this server&apos;s tool list)
                  </span>
                )}
              </Label>
            </li>
          ))}
        </ul>
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Skills</legend>
        {skillRows.length === 0 ? (
          <p className="text-xs text-muted-foreground">No skills in the library yet.</p>
        ) : (
          <ul className="max-h-32 space-y-1 overflow-y-auto rounded border p-2">
            {skillRows.map((sk) => (
              <li key={sk.key} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id={`ca-edit-skill-${sk.key}`}
                  data-testid={`ca-edit-skill-${sk.key}`}
                  checked={draft.skillKeys.includes(sk.key)}
                  onChange={() => toggle("skillKeys", sk.key)}
                />
                <Label htmlFor={`ca-edit-skill-${sk.key}`} className="text-sm font-normal">
                  {sk.label}
                  {!sk.known && (
                    <span className="ml-1 text-xs text-muted-foreground">(not in the library)</span>
                  )}
                </Label>
              </li>
            ))}
          </ul>
        )}
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="ca-edit-model">Preferred model</Label>
          <select
            id="ca-edit-model"
            data-testid="ca-edit-model"
            className="w-full rounded-md border bg-background p-2 text-sm"
            value={draft.model}
            onChange={(e) => setDraft({ ...draft, model: e.target.value })}
          >
            {modelOptions.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="ca-edit-reasoning">Reasoning effort</Label>
          <select
            id="ca-edit-reasoning"
            data-testid="ca-edit-reasoning"
            className="w-full rounded-md border bg-background p-2 text-sm"
            value={draft.reasoningEffort}
            onChange={(e) =>
              setDraft({ ...draft, reasoningEffort: e.target.value as "" | SdkReasoningEffort })
            }
          >
            {REASONING_OPTIONS.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Approval</legend>
        <p className="text-xs text-muted-foreground">
          Ask for approval more often than the chat would. An agent can never ask less.
        </p>
        {RISKS.map((risk) => (
          <div key={risk} className="flex items-center gap-2">
            <Label htmlFor={`ca-edit-approval-${risk}`} className="w-28 text-sm font-normal">
              {risk} risk
            </Label>
            <select
              id={`ca-edit-approval-${risk}`}
              data-testid={`ca-edit-approval-${risk}`}
              className="rounded-md border bg-background p-1 text-sm"
              value={draft.approval[risk]}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  approval: { ...draft.approval, [risk]: e.target.value as ApprovalChoice },
                })
              }
            >
              {APPROVAL_CHOICES.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>
        ))}
      </fieldset>

      {save.isError && (
        <p role="alert" className="text-sm text-destructive" data-testid="ca-edit-error">
          {formatLibrarySaveError(save.error)}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          type="submit"
          data-testid="ca-edit-save"
          disabled={!dirty || !valid || save.isPending}
        >
          {save.isPending ? "Saving…" : "Save changes"}
        </Button>
      </div>
    </form>
  );
}
