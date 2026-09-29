/**
 * #145 — the choices a custom agent's definition offers, shared by the
 * authoring wizard and the edit form so both present the same fields the
 * same way.
 */
import type { CustomAgentApprovalPolicy, SdkReasoningEffort } from "@metis/shared";

/**
 * Epic #129 — the one agent-level grant besides the server's real tools
 * (`GET /ai/tools`): calling other agents.
 */
export const SUBAGENT_TOOL_REF = "agent:*";

export type RiskKey = keyof CustomAgentApprovalPolicy;
export type ApprovalChoice = "" | NonNullable<CustomAgentApprovalPolicy[RiskKey]>;
/**
 * The approval override can only TIGHTEN the session's policy, so "auto" is
 * not offered: as an override it can never have an effect.
 */
export const APPROVAL_CHOICES: ReadonlyArray<{ value: ApprovalChoice; label: string }> = [
  { value: "", label: "Session default" },
  { value: "prompt-once", label: "Ask once per session" },
  { value: "always-prompt", label: "Ask every time" },
  { value: "deny", label: "Never" },
];
export const RISKS: readonly RiskKey[] = ["low", "medium", "high"];

/** The "inherit" model choice; the rest come from the model catalog (#135). */
export const DEFAULT_MODEL_OPTION = { value: "", label: "Default (project/workspace)" } as const;

export const REASONING_OPTIONS: ReadonlyArray<{ value: "" | SdkReasoningEffort; label: string }> = [
  { value: "", label: "Default" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
] as const;
