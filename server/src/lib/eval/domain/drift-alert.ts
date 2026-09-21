/**
 * Epic #803 (Epic 09) — Domain-eval drift alert dispatcher.
 *
 * When the nightly run detects that corpus F1 dropped more than the threshold
 * week-over-week, we notify the eval channel. Rather than invent a new
 * transport we reuse the codebase's hardened outbound primitive
 * ({@link safeFetch}, SSRF-guarded) to POST a Slack-compatible JSON payload to
 * the webhook configured in `EVAL_ALERT_WEBHOOK_URL`. When the variable is
 * unset the dispatcher is a no-op so local/dev runs stay quiet.
 *
 * Issue #1321 reuses this module for the online (live-traffic) eval: the same
 * webhook, the same SSRF-guarded transport, the same never-throw contract. See
 * {@link postAlert} and {@link dispatchOnlineDriftAlert}.
 */
import {
  describeBaselineStaleness,
  type DomainEvalRunResult,
  type OnlineEvalWindowSummary,
} from "@metis/shared";
import { safeFetch, type SafeFetchOptions } from "../../net/safe-fetch.js";

export interface DriftAlertOptions {
  /** Override the webhook URL (defaults to `EVAL_ALERT_WEBHOOK_URL`). */
  webhookUrl?: string;
  /** Test seam forwarded to {@link safeFetch}. */
  fetchImpl?: SafeFetchOptions["fetchImpl"];
  /** Allow loopback targets (tests point at a local stub). */
  allowLoopback?: boolean;
}

export interface DriftAlertOutcome {
  dispatched: boolean;
  reason: string;
  status?: number;
}

export function buildDriftMessage(run: DomainEvalRunResult): string {
  const delta = run.drift.deltaF1 ?? 0;
  const prev = run.drift.previousF1;
  const prevTxt = prev == null ? "n/a" : `${(prev * 100).toFixed(1)}%`;
  const base =
    `:rotating_light: *Domain Eval drift detected* — corpus F1 dropped ` +
    `${Math.abs(delta * 100).toFixed(1)}% week-over-week ` +
    `(${prevTxt} → ${(run.corpusF1 * 100).toFixed(1)}%, threshold ` +
    `${(run.drift.thresholdPct * 100).toFixed(0)}%). Run \`${run.runId}\` on commit ` +
    `\`${run.commit ?? "unknown"}\` across ${run.itemCount} corpus items.`;
  // #1333 — "week-over-week" above is only true while the nightly is actually
  // committing envelopes. When it is not, the comparison silently becomes
  // against whatever the last committed run was, so the caveat is appended
  // here rather than left to whoever reads the number.
  const staleness = describeBaselineStaleness(run.drift);
  return staleness ? `${base} ${staleness}` : base;
}

/**
 * Shared transport for every eval drift alert. POSTs a Slack-compatible JSON
 * payload through the SSRF-guarded {@link safeFetch}. Never throws — a flaky
 * webhook must not fail the job that noticed the drift.
 */
export async function postAlert(
  payload: Record<string, unknown>,
  opts: DriftAlertOptions = {},
): Promise<DriftAlertOutcome> {
  const webhookUrl = opts.webhookUrl ?? process.env.EVAL_ALERT_WEBHOOK_URL ?? "";
  if (!webhookUrl.trim()) {
    return { dispatched: false, reason: "WEBHOOK_NOT_CONFIGURED" };
  }
  try {
    const res = await safeFetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      fetchImpl: opts.fetchImpl,
      allowLoopback: opts.allowLoopback,
    });
    if (res.status >= 200 && res.status < 300) {
      return { dispatched: true, reason: "OK", status: res.status };
    }
    return { dispatched: false, reason: `HTTP_${res.status}`, status: res.status };
  } catch (err) {
    return { dispatched: false, reason: `ERROR:${(err as Error).message}` };
  }
}

/**
 * Dispatch a drift alert for `run`. Only sends when `run.drift.alert` is true
 * and a webhook URL is configured. Errors are caught and reported in the
 * outcome rather than thrown so a flaky webhook never fails the nightly job.
 */
export async function dispatchDriftAlert(
  run: DomainEvalRunResult,
  opts: DriftAlertOptions = {},
): Promise<DriftAlertOutcome> {
  if (!run.drift.alert) {
    return { dispatched: false, reason: "NO_DRIFT" };
  }
  return await postAlert(
    {
      text: buildDriftMessage(run),
      runId: run.runId,
      corpusF1: run.corpusF1,
      previousF1: run.drift.previousF1,
      deltaF1: run.drift.deltaF1,
      thresholdPct: run.drift.thresholdPct,
      commit: run.commit,
      baselineRunId: run.drift.baselineRunId,
      baselineAgeDays: run.drift.baselineAgeDays,
      staleBaseline: run.drift.staleBaseline,
    },
    opts,
  );
}

export function buildOnlineDriftMessage(w: OnlineEvalWindowSummary): string {
  const current = w.meanScores[w.drift.metric];
  const prev = w.drift.previous;
  const prevTxt = prev == null ? "n/a" : `${(prev * 100).toFixed(1)}%`;
  // #1329 — an UNVERIFIABLE metric is null, and `null * 100` is 0 in JS. The
  // scorer already refuses to raise an alert on one, but this builder is
  // exported and must not render "0.0%" for "we could not measure it".
  const currentTxt = current == null ? "n/a" : `${(current * 100).toFixed(1)}%`;
  return (
    `:rotating_light: *Online eval drift detected* — mean \`${w.drift.metric}\` over live ` +
    `traffic dropped ${Math.abs((w.drift.delta ?? 0) * 100).toFixed(1)}% window-over-window ` +
    `(${prevTxt} → ${currentTxt}, threshold ` +
    `${(w.drift.thresholdPct * 100).toFixed(0)}%). Window \`${w.windowId}\` over ` +
    `${w.sampleCount} sampled runs, judge \`${w.judge}\`.`
  );
}

/**
 * Issue #1321 — drift alert for a completed online-eval window.
 *
 * `alert` is only ever true when the configured judge is a real one, so this
 * can never page on `StubRagasJudge` output (see `eval/online/scorer.ts`).
 */
export async function dispatchOnlineDriftAlert(
  window: OnlineEvalWindowSummary,
  opts: DriftAlertOptions = {},
): Promise<DriftAlertOutcome> {
  if (!window.drift.alert) {
    return { dispatched: false, reason: "NO_DRIFT" };
  }
  return await postAlert(
    {
      text: buildOnlineDriftMessage(window),
      windowId: window.windowId,
      metric: window.drift.metric,
      current: window.meanScores[window.drift.metric],
      previous: window.drift.previous,
      delta: window.drift.delta,
      thresholdPct: window.drift.thresholdPct,
      sampleCount: window.sampleCount,
      judge: window.judge,
    },
    opts,
  );
}
