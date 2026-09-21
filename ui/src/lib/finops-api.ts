/**
 * Typed wrappers for the workspace FinOps REST surface (Epic #47 / Issue #54).
 * Backs the /workspaces/:id/finops page: forecast, budget, alert rules, alert
 * channels, alert events, and the chargeback PDF download URL.
 */
import { apiFetch } from "@/lib/api-client";
import { API_BASE } from "@/lib/config";

export interface CostForecast {
  id: string;
  workspaceId: string;
  projectId: string | null;
  scope: string;
  monthToDateCents: number;
  projectedMonthEndCents: number;
  dailyRunRateCents: number;
  slopeCentsPerDay: number;
  ewmaCents: number;
  sampleDays: number;
  backtestMape: number | null;
  computedAt: string;
}

export interface AlertRule {
  id: string;
  workspaceId: string;
  name: string;
  thresholdPct: number;
  basis: "mtd" | "projected";
  cooldownSec: number;
  enabled: boolean;
  lastFiredAt: string | null;
}

/**
 * Alert-channel routing target. The backend (#51) routes alert rules to any of
 * these channel types; the routing secret (Slack bot token / PagerDuty routing
 * key) lives in the resolved install/service config and is NEVER part of this
 * summary — only the channel `type` + `target` are returned.
 */
export type AlertChannelType = "email" | "webhook" | "slack" | "pagerduty";

export interface AlertChannel {
  id: string;
  type: AlertChannelType;
  target: string;
  config: string;
  enabled: boolean;
}

export interface AlertEvent {
  id: string;
  workspaceId: string;
  ruleId: string;
  spendCents: number;
  budgetCents: number;
  ratio: number;
  basis: string;
  deliveries: string;
  firedAt: string;
}

export interface CreateRuleInput {
  name: string;
  thresholdPct: number;
  basis?: "mtd" | "projected";
  cooldownSec?: number;
  enabled?: boolean;
}

export interface CreateChannelInput {
  type: AlertChannelType;
  target: string;
  secret?: string | null;
  config?: string;
  enabled?: boolean;
}

const base = (workspaceId: string) => `/workspaces/${workspaceId}/finops`;

export const finopsApi = {
  getForecast: (workspaceId: string, projectId?: string) =>
    apiFetch<{ forecast: CostForecast | null }>(`${base(workspaceId)}/forecast`, {
      params: projectId ? { projectId } : undefined,
    }),

  getBudget: (workspaceId: string) =>
    apiFetch<{ monthlyBudgetCents: number | null }>(`${base(workspaceId)}/budget`),

  setBudget: (workspaceId: string, monthlyBudgetCents: number | null) =>
    apiFetch<{ monthlyBudgetCents: number | null }>(`${base(workspaceId)}/budget`, {
      method: "PUT",
      body: { monthlyBudgetCents },
    }),

  getRules: (workspaceId: string) => apiFetch<{ rules: AlertRule[] }>(`${base(workspaceId)}/rules`),

  createRule: (workspaceId: string, input: CreateRuleInput) =>
    apiFetch<{ rule: AlertRule }>(`${base(workspaceId)}/rules`, { method: "POST", body: input }),

  updateRule: (workspaceId: string, ruleId: string, input: Partial<CreateRuleInput>) =>
    apiFetch<{ rule: AlertRule }>(`${base(workspaceId)}/rules/${ruleId}`, {
      method: "PATCH",
      body: input,
    }),

  deleteRule: (workspaceId: string, ruleId: string) =>
    apiFetch<{ deleted: boolean }>(`${base(workspaceId)}/rules/${ruleId}`, { method: "DELETE" }),

  getChannels: (workspaceId: string) =>
    apiFetch<{ channels: AlertChannel[] }>(`${base(workspaceId)}/channels`),

  createChannel: (workspaceId: string, input: CreateChannelInput) =>
    apiFetch<{ channel: AlertChannel }>(`${base(workspaceId)}/channels`, {
      method: "POST",
      body: input,
    }),

  deleteChannel: (workspaceId: string, channelId: string) =>
    apiFetch<{ deleted: boolean }>(`${base(workspaceId)}/channels/${channelId}`, {
      method: "DELETE",
    }),

  getEvents: (workspaceId: string) =>
    apiFetch<{ events: AlertEvent[] }>(`${base(workspaceId)}/events`),

  /** Direct URL for the chargeback PDF download (rendered as an <a href>). */
  chargebackPdfUrl: (workspaceId: string) => `${API_BASE}${base(workspaceId)}/chargeback.pdf`,
};

export function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
