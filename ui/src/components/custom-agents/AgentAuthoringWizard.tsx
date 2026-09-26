"use client";

/**
 * Epic #260 / Issue #84 — Custom agent authoring wizard.
 *
 * Multi-step flow surfaced at `/workspaces/:id/agents/new`:
 *   1. name  — agent name + target project
 *   2. prompt — system prompt with a starter template gallery
 *   3. tools  — allowed-tool picker
 *   4. model  — model + reasoning-effort picker
 *   5. playground — create the agent (draft) and run a sample invocation,
 *      proving it returns a completion (epic AC #1: within 5s).
 *
 * The agent is created on first playground run (so we have an id to invoke),
 * then re-used for subsequent runs. The backend is PROJECT-SCOPED, so a target
 * project must be chosen before authoring.
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { sdkApi, type CreateCustomAgentInput } from "@/lib/sdk-alignment-api";
import { projectsApi } from "@/lib/projects-api";
import { modelCatalogApi, formatModelPrice } from "@/lib/model-catalog-api";
import type { SdkReasoningEffort } from "@metis/shared";

/**
 * Playground input cap — mirrors the backend's MAX_INVOKE_PAYLOAD_CHARS (20k).
 * Capping client-side avoids round-tripping over-cap input only to get a raw
 * Zod 400 back; the user gets immediate, friendly feedback instead.
 */
const MAX_PLAYGROUND_INPUT_CHARS = 20_000;

/** Starter prompts shown in the template gallery (step 2). */
const TEMPLATES: ReadonlyArray<{ id: string; label: string; description: string; prompt: string }> =
  [
    {
      id: "requirements-analyst",
      label: "Requirements Analyst",
      description: "Extracts and clarifies functional requirements from specs.",
      prompt:
        "You are a meticulous requirements analyst. Read the provided material and extract clear, testable functional and non-functional requirements. Flag ambiguities and missing acceptance criteria.",
    },
    {
      id: "risk-reviewer",
      label: "Risk Reviewer",
      description: "Surfaces delivery, security, and compliance risks.",
      prompt:
        "You are a pragmatic risk reviewer. Identify delivery, security, and compliance risks in the supplied context. Rank each risk by likelihood and impact and propose a concrete mitigation.",
    },
    {
      id: "doc-summarizer",
      label: "Document Summarizer",
      description: "Produces concise, faithful summaries of long documents.",
      prompt:
        "You are a precise document summarizer. Produce a faithful, concise summary of the supplied document. Preserve key facts, decisions, and open questions. Do not invent details.",
    },
  ] as const;

/** Tools selectable in step 3 — mirrors the analyst tool surface. */
const AVAILABLE_TOOLS: readonly string[] = [
  "knowledge_search",
  "web_search",
  "read_document",
  "code_search",
  "create_issue",
] as const;

/** The "inherit" choice in step 4; the rest come from the model catalog (#135). */
const DEFAULT_MODEL_OPTION = { value: "", label: "Default (project/workspace)" } as const;

const REASONING_OPTIONS: ReadonlyArray<{ value: "" | SdkReasoningEffort; label: string }> = [
  { value: "", label: "Default" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
] as const;

const STEPS = ["name", "prompt", "tools", "model", "playground"] as const;
type Step = (typeof STEPS)[number];

interface Props {
  workspaceId: string;
}

export function AgentAuthoringWizard({ workspaceId }: Props) {
  const [stepIndex, setStepIndex] = useState(0);
  const step: Step = STEPS[stepIndex];

  const [name, setName] = useState("");
  const [projectId, setProjectId] = useState("");
  const [description, setDescription] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [tools, setTools] = useState<string[]>([]);
  const [model, setModel] = useState("");
  const [reasoningEffort, setReasoningEffort] = useState<"" | SdkReasoningEffort>("");

  const [playgroundInput, setPlaygroundInput] = useState("");
  // Cache the created agent id so repeated playground runs re-use it.
  const [draftAgentId, setDraftAgentId] = useState<string | null>(null);

  const projectsQuery = useQuery({
    queryKey: ["wizard-projects", workspaceId],
    queryFn: () => projectsApi.list({ workspaceId, limit: 100 }),
    enabled: Boolean(workspaceId),
  });
  const projects = projectsQuery.data?.items ?? [];
  // #135 — the configured provider's models, from the server-side catalog.
  const modelsQuery = useQuery({
    queryKey: ["ai-model-catalog", "provider"],
    queryFn: () => modelCatalogApi.list(),
  });
  const modelOptions = [
    DEFAULT_MODEL_OPTION,
    ...(modelsQuery.data?.models ?? []).map((m) => {
      const price = formatModelPrice(m);
      return { value: m.id, label: price ? `${m.displayName} — ${price}` : m.displayName };
    }),
  ];

  function buildInput(): CreateCustomAgentInput {
    return {
      projectId,
      name: name.trim(),
      description: description.trim(),
      systemPrompt: systemPrompt.trim(),
      tools,
      model: model || null,
      reasoningEffort: reasoningEffort || null,
    };
  }

  const playground = useMutation({
    mutationFn: async () => {
      let id = draftAgentId;
      if (!id) {
        const created = await sdkApi.createAgent(buildInput());
        id = created.id;
        setDraftAgentId(id);
      }
      return sdkApi.invokeAgent(id, { projectId, input: playgroundInput });
    },
  });

  const canLeaveName = name.trim().length >= 2 && projectId.length > 0;
  const canLeavePrompt = systemPrompt.trim().length > 0;
  const nextDisabled = useMemo(() => {
    if (step === "name") return !canLeaveName;
    if (step === "prompt") return !canLeavePrompt;
    return false;
  }, [step, canLeaveName, canLeavePrompt]);

  const isLastStep = stepIndex === STEPS.length - 1;

  function goNext() {
    if (!isLastStep && !nextDisabled) setStepIndex((i) => i + 1);
  }
  function goBack() {
    if (stepIndex > 0) setStepIndex((i) => i - 1);
  }

  function toggleTool(tool: string) {
    setTools((prev) => (prev.includes(tool) ? prev.filter((t) => t !== tool) : [...prev, tool]));
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6" data-testid="agent-wizard-root">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">New Custom Agent</h1>
        <p className="text-sm text-muted-foreground">
          Author a project-scoped analyst: name, prompt, tools, and model — then try it in the
          playground.
        </p>
      </header>

      <ol className="flex flex-wrap gap-2 text-xs" data-testid="wizard-steps">
        {STEPS.map((s, i) => (
          <li
            key={s}
            data-testid={`wizard-step-indicator-${s}`}
            className={`rounded px-2 py-1 ${
              i === stepIndex
                ? "bg-primary text-primary-foreground"
                : i < stepIndex
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground"
            }`}
          >
            {i + 1}. {s}
          </li>
        ))}
      </ol>

      <Card className="space-y-4 p-4">
        {step === "name" && (
          <div className="space-y-4" data-testid="wizard-step-name">
            <div className="space-y-2">
              <Label htmlFor="wizard-name">Agent name</Label>
              <Input
                id="wizard-name"
                data-testid="wizard-name-input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Compliance Reviewer"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="wizard-description">Description (optional)</Label>
              <Input
                id="wizard-description"
                data-testid="wizard-description-input"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="What does this agent specialize in?"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="wizard-project">Project</Label>
              <select
                id="wizard-project"
                data-testid="wizard-project-select"
                className="w-full rounded-md border bg-background p-2 text-sm"
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
              >
                <option value="">Select a project…</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              {projectsQuery.isError && (
                <p className="text-xs text-destructive" role="alert">
                  Failed to load projects.
                </p>
              )}
            </div>
          </div>
        )}

        {step === "prompt" && (
          <div className="space-y-4" data-testid="wizard-step-prompt">
            <div className="space-y-2">
              <Label>Template gallery</Label>
              <div className="grid gap-2 sm:grid-cols-3" data-testid="wizard-template-gallery">
                {TEMPLATES.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    data-testid={`wizard-template-${t.id}`}
                    onClick={() => setSystemPrompt(t.prompt)}
                    className="rounded-md border p-3 text-left text-xs hover:border-primary"
                  >
                    <span className="block font-medium text-foreground">{t.label}</span>
                    <span className="text-muted-foreground">{t.description}</span>
                  </button>
                ))}
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="wizard-prompt">System prompt</Label>
              <textarea
                id="wizard-prompt"
                data-testid="wizard-prompt-input"
                className="w-full min-h-[160px] rounded-md border bg-background p-2 text-sm"
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
                placeholder="Describe the agent's role, expertise, and guardrails…"
              />
            </div>
          </div>
        )}

        {step === "tools" && (
          <div className="space-y-3" data-testid="wizard-step-tools">
            <Label>Allowed tools</Label>
            <p className="text-xs text-muted-foreground">
              Pick the tools this agent may call during an analysis run. The playground itself runs
              prompt-only.
            </p>
            <ul className="space-y-2">
              {AVAILABLE_TOOLS.map((tool) => (
                <li key={tool} className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    id={`wizard-tool-${tool}`}
                    data-testid={`wizard-tool-${tool}`}
                    checked={tools.includes(tool)}
                    onChange={() => toggleTool(tool)}
                  />
                  <Label htmlFor={`wizard-tool-${tool}`} className="text-sm font-normal">
                    {tool}
                  </Label>
                </li>
              ))}
            </ul>
          </div>
        )}

        {step === "model" && (
          <div className="space-y-4" data-testid="wizard-step-model">
            <div className="space-y-2">
              <Label htmlFor="wizard-model">Model</Label>
              <select
                id="wizard-model"
                data-testid="wizard-model-select"
                className="w-full rounded-md border bg-background p-2 text-sm"
                value={model}
                onChange={(e) => setModel(e.target.value)}
              >
                {modelOptions.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="wizard-reasoning">Reasoning effort</Label>
              <select
                id="wizard-reasoning"
                data-testid="wizard-reasoning-select"
                className="w-full rounded-md border bg-background p-2 text-sm"
                value={reasoningEffort}
                onChange={(e) => setReasoningEffort(e.target.value as "" | SdkReasoningEffort)}
              >
                {REASONING_OPTIONS.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
        )}

        {step === "playground" && (
          <div className="space-y-3" data-testid="wizard-step-playground">
            <Label htmlFor="wizard-playground">Try it out</Label>
            <p className="text-xs text-muted-foreground">
              Saving the agent and running a sample prompt confirms it produces a completion.
            </p>
            <textarea
              id="wizard-playground"
              data-testid="wizard-playground-input"
              className="w-full min-h-[100px] rounded-md border bg-background p-2 text-sm"
              value={playgroundInput}
              maxLength={MAX_PLAYGROUND_INPUT_CHARS}
              onChange={(e) =>
                setPlaygroundInput(e.target.value.slice(0, MAX_PLAYGROUND_INPUT_CHARS))
              }
              placeholder="Give the agent something to analyze…"
            />
            <p className="text-xs text-muted-foreground" data-testid="wizard-playground-charcount">
              {playgroundInput.length.toLocaleString()} /{" "}
              {MAX_PLAYGROUND_INPUT_CHARS.toLocaleString()} characters
            </p>
            <Button
              type="button"
              data-testid="wizard-playground-run"
              onClick={() => playground.mutate()}
              disabled={playground.isPending || playgroundInput.trim().length === 0}
            >
              {playground.isPending ? "Running…" : "Run playground"}
            </Button>

            {playground.isError && (
              <p
                className="text-sm text-destructive"
                role="alert"
                data-testid="wizard-playground-error"
              >
                Playground failed:{" "}
                {playground.error instanceof Error ? playground.error.message : "unknown error"}
              </p>
            )}
            {playground.data && (
              <div
                className="space-y-1 rounded-md border bg-muted/40 p-3 text-sm"
                data-testid="wizard-playground-output"
              >
                <pre className="whitespace-pre-wrap break-words">{playground.data.content}</pre>
                <p className="text-xs text-muted-foreground">
                  {playground.data.model} · {playground.data.usage.totalTokens} tokens
                </p>
              </div>
            )}
          </div>
        )}
      </Card>

      <div className="flex items-center justify-between">
        <Button
          type="button"
          variant="outline"
          data-testid="wizard-back"
          onClick={goBack}
          disabled={stepIndex === 0}
        >
          Back
        </Button>
        {!isLastStep && (
          <Button type="button" data-testid="wizard-next" onClick={goNext} disabled={nextDisabled}>
            Next
          </Button>
        )}
      </div>
    </div>
  );
}
