export {
  recordUsage,
  recordUsageAndFlush,
  setUsageEmitter,
  getPendingUsageWrites,
} from "./token-tracker.js";
export type { RecordUsageInput, RecordUsageResult } from "./token-tracker.js";
export {
  assertWithinBudget,
  projectMonthlyCost,
  projectMonthlyFromMtd,
  summarizeUsage,
  BudgetExceededError,
} from "./budget-enforcer.js";
export type { BudgetSnapshot, UsageSummaryRow, UsageWindow } from "./budget-enforcer.js";
export { getRate, computeCostCents, DEFAULT_RATE } from "./provider-rates.js";
export type { TokenRate } from "./provider-rates.js";
// Epic #47 (#48) — time-series cost forecaster.
export {
  linearRegression,
  ewma,
  predictAt,
  forecastDailyRunRate,
  projectMonthEnd,
  mape,
} from "./forecast-math.js";
export type {
  DailyCostPoint,
  OlsResult,
  ForecastInput,
  ForecastResult,
  MonthEndProjection,
  MonthEndProjectionInput,
} from "./forecast-math.js";
export {
  computeWorkspaceForecast,
  computeProjectForecast,
  recomputeAllForecasts,
  getLatestForecast,
  loadWorkspaceWindow,
  loadProjectWindow,
  backtestWindow,
  computeMonthBounds,
  startForecastRecompute,
  FORECAST_WINDOW_DAYS,
} from "./forecast-service.js";
export type {
  ForecastComputeResult,
  ForecastRow,
  ForecastRecomputeHandle,
} from "./forecast-service.js";
// Epic #47 (#49) — alert engine + threshold rules.
export { evaluateRule, evaluateRules, BUILTIN_THRESHOLDS } from "./alert-rules.js";
export type { AlertRuleState, SpendSnapshot, RuleEvaluation } from "./alert-rules.js";
export {
  tickWorkspace,
  tickAllWorkspaces,
  startAlertEngine,
  setDefaultDispatcherFactory,
} from "./alert-engine.js";
export type {
  AlertChannelRow,
  AlertNotification,
  DeliveryResult,
  AlertDispatcher,
  AlertEngineOptions,
  AlertEngineHandle,
} from "./alert-engine.js";
// Epic #47 (#50) — alert channels: email + webhook.
export {
  computeSignature,
  verifySignature,
  parseWebhookUrl,
  assertPublicHost,
  sendWebhook,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
} from "./channels/webhook-sender.js";
export type { WebhookSendInput, WebhookSendResult } from "./channels/webhook-sender.js";
export {
  LogEmailSender,
  SmtpEmailSender,
  loadSmtpConfig,
  resolveEmailSender,
} from "./channels/email-sender.js";
export type {
  EmailSender,
  EmailMessage,
  EmailSendResult,
  SmtpConfig,
} from "./channels/email-sender.js";
export { createDispatcher, buildEmailBody, buildWebhookPayload } from "./channels/dispatcher.js";
export type { DispatcherDeps } from "./channels/dispatcher.js";
// Epic #47 (#52) — monthly PDF chargeback report generator.
export {
  monthRange,
  escapeMarkdownCell,
  gatherChargebackData,
  renderChargebackMarkdown,
  buildChargebackReport,
  generateAndSendChargeback,
  runMonthlyChargeback,
} from "./chargeback-report.js";
export type {
  MonthRange,
  CostLine,
  ChargebackData,
  ChargebackReport,
  GenerateAndSendOptions,
} from "./chargeback-report.js";
export { startChargebackScheduler, CHARGEBACK_CRON } from "./chargeback-scheduler.js";
export type { ChargebackSchedulerHandle } from "./chargeback-scheduler.js";
// Epic #47 (#53) — AWS Cost Explorer integration + reconciliation.
export {
  buildCostAndUsageInput,
  parseCostAndUsageResponse,
  createAwsCostExplorerClient,
  resolveCostExplorerClient,
  reconcileBedrockSpend,
  DISCREPANCY_THRESHOLD,
} from "./aws-cost-explorer.js";
export type {
  CostExplorerClient,
  CostAndUsageQuery,
  CostAndUsageResult,
  AwsCostLine,
  AwsClientConfig,
  ReconciliationResult,
  ReconcileOptions,
} from "./aws-cost-explorer.js";
