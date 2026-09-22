/**
 * AWS Cost Explorer integration (Epic #47 / Issue #53).
 *
 * Pulls actual AWS Bedrock spend (per region, optionally grouped by the
 * inference-profile cost-allocation tag) and reconciles it against
 * METIS-tracked spend. When the discrepancy exceeds 10% a warning is raised
 * (reusing the #49 alert event store).
 *
 * The AWS SDK is abstracted behind `CostExplorerClient` so:
 *   - tests inject a fake (NO live AWS calls, NO credentials in tests);
 *   - real calls are gated behind `AWS_COST_EXPLORER_ENABLED=true`.
 *
 * The real adapter calls `GetCostAndUsage` (AWS SDK v3,
 * `@aws-sdk/client-cost-explorer`). Request shape verified against the AWS
 * Billing & Cost Management API reference (see report citations):
 *   - `TimePeriod`: { Start, End } as `YYYY-MM-DD`, Start inclusive / End
 *     exclusive.
 *   - `Granularity`: "MONTHLY".
 *   - `Metrics`: ["UnblendedCost"].
 *   - `Filter.Dimensions`: { Key: "SERVICE", Values: ["Amazon Bedrock"] } AND
 *     { Key: "REGION", Values: [region] } when a region is given.
 *   - `GroupBy`: [{ Type: "DIMENSION", Key: "REGION" }] (+ optional TAG group).
 * Response: `ResultsByTime[].{Total, Groups[].{Keys, Metrics[metric].Amount}}`,
 * amounts are decimal-USD strings.
 */
import { createChildLogger } from "../logger.js";
import { prisma } from "../prisma.js";

const log = createChildLogger("finops-aws-cost-explorer");

/** A normalised cost line returned by the abstraction (USD). */
export interface AwsCostLine {
  /** Group key — region, or `region | tagValue` when grouped by tag. */
  key: string;
  amountUsd: number;
}

export interface CostAndUsageQuery {
  /** Inclusive start `YYYY-MM-DD` (UTC). */
  start: string;
  /** Exclusive end `YYYY-MM-DD` (UTC). */
  end: string;
  /** AWS region filter (e.g. "us-east-1"); undefined = all regions. */
  region?: string;
  /** Cost-allocation tag key to group by (e.g. "metis:inferenceProfile"). */
  tagKey?: string;
  /** AWS service name to filter on. Default "Amazon Bedrock". */
  service?: string;
}

export interface CostAndUsageResult {
  totalUsd: number;
  lines: AwsCostLine[];
}

/** The mockable boundary. The real adapter wraps the AWS SDK. */
export interface CostExplorerClient {
  getCostAndUsage(query: CostAndUsageQuery): Promise<CostAndUsageResult>;
}

// ---------------------------------------------------------------------------
// Real adapter (lazy SDK import, env-gated).
// ---------------------------------------------------------------------------

interface AwsGroup {
  Keys?: string[];
  Metrics?: Record<string, { Amount?: string; Unit?: string }>;
}
interface AwsResultByTime {
  Total?: Record<string, { Amount?: string; Unit?: string }>;
  Groups?: AwsGroup[];
}
interface AwsGetCostAndUsageResponse {
  ResultsByTime?: AwsResultByTime[];
}

const METRIC = "UnblendedCost";

/** Build the GetCostAndUsage request payload from a normalised query. */
export function buildCostAndUsageInput(query: CostAndUsageQuery): Record<string, unknown> {
  const service = query.service ?? "Amazon Bedrock";
  const dimensionFilters: Array<Record<string, unknown>> = [
    { Dimensions: { Key: "SERVICE", Values: [service] } },
  ];
  if (query.region) {
    dimensionFilters.push({ Dimensions: { Key: "REGION", Values: [query.region] } });
  }
  const filter = dimensionFilters.length === 1 ? dimensionFilters[0] : { And: dimensionFilters };

  const groupBy: Array<Record<string, string>> = [{ Type: "DIMENSION", Key: "REGION" }];
  if (query.tagKey) groupBy.push({ Type: "TAG", Key: query.tagKey });

  return {
    TimePeriod: { Start: query.start, End: query.end },
    Granularity: "MONTHLY",
    Metrics: [METRIC],
    Filter: filter,
    GroupBy: groupBy,
  };
}

/** Parse a GetCostAndUsage response into normalised cost lines (USD). */
export function parseCostAndUsageResponse(resp: AwsGetCostAndUsageResponse): CostAndUsageResult {
  const lines: AwsCostLine[] = [];
  let totalUsd = 0;
  for (const result of resp.ResultsByTime ?? []) {
    for (const group of result.Groups ?? []) {
      const amount = Number(group.Metrics?.[METRIC]?.Amount ?? "0");
      const key = (group.Keys ?? []).join(" | ") || "unknown";
      const safe = Number.isFinite(amount) ? amount : 0;
      lines.push({ key, amountUsd: safe });
      totalUsd += safe;
    }
    // When there are no groups, fall back to the period Total.
    if ((result.Groups ?? []).length === 0) {
      const amount = Number(result.Total?.[METRIC]?.Amount ?? "0");
      if (Number.isFinite(amount) && amount > 0) {
        lines.push({ key: "total", amountUsd: amount });
        totalUsd += amount;
      }
    }
  }
  return { totalUsd, lines };
}

export interface AwsClientConfig {
  region: string;
}

/**
 * Build the real Cost Explorer client. Lazily imports the AWS SDK so the
 * module never requires the dependency unless this is actually called. AWS
 * credentials come from the standard AWS credential chain (never hardcoded).
 */
export function createAwsCostExplorerClient(config: AwsClientConfig): CostExplorerClient {
  return {
    async getCostAndUsage(query: CostAndUsageQuery): Promise<CostAndUsageResult> {
      const sdk = (await import("@aws-sdk/client-cost-explorer")) as unknown as {
        CostExplorerClient: new (cfg: { region: string }) => {
          send(cmd: unknown): Promise<AwsGetCostAndUsageResponse>;
        };
        GetCostAndUsageCommand: new (input: Record<string, unknown>) => unknown;
      };
      const client = new sdk.CostExplorerClient({ region: config.region });
      const command = new sdk.GetCostAndUsageCommand(buildCostAndUsageInput(query));
      const resp = await client.send(command);
      return parseCostAndUsageResponse(resp);
    },
  };
}

/** Returns the real client when enabled via env, otherwise null. */
export function resolveCostExplorerClient(
  env: NodeJS.ProcessEnv = process.env,
): CostExplorerClient | null {
  if (env.AWS_COST_EXPLORER_ENABLED !== "true") return null;
  const region = env.AWS_COST_EXPLORER_REGION ?? env.AWS_REGION ?? "us-east-1";
  return createAwsCostExplorerClient({ region });
}

// ---------------------------------------------------------------------------
// Reconciliation.
// ---------------------------------------------------------------------------

export interface ReconciliationResult {
  /** AWS-reported Bedrock spend in cents. */
  awsCents: number;
  /** METIS-tracked Bedrock spend in cents. */
  metisCents: number;
  /** abs(aws - metis) / max(aws, 1) as a fraction. */
  discrepancy: number;
  /** True when discrepancy exceeds the threshold (default 10%). */
  warning: boolean;
  awsLines: AwsCostLine[];
}

/** Default discrepancy threshold that triggers a warning (10%). */
export const DISCREPANCY_THRESHOLD = 0.1;

/** Sum METIS-tracked Bedrock spend (cents) over a window from TokenUsage. */
async function metisBedrockCents(start: Date, end: Date): Promise<number> {
  const rows = await prisma.tokenUsage.findMany({
    where: {
      provider: { startsWith: "bedrock" },
      createdAt: { gte: start, lt: end },
    },
    select: { costCents: true },
  });
  // #22 — unpriced rows (null) have no METIS-side cost to reconcile.
  return rows.reduce((sum, r) => sum + (r.costCents ?? 0), 0);
}

export interface ReconcileOptions {
  client: CostExplorerClient;
  start: Date;
  end: Date;
  region?: string;
  tagKey?: string;
  threshold?: number;
  /** Persist a warning AlertEvent on the given workspace when over threshold. */
  warnWorkspaceId?: string;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Reconcile AWS Bedrock spend against METIS-tracked spend for a window.
 * When the discrepancy exceeds the threshold and `warnWorkspaceId` is set, a
 * warning AlertEvent is persisted (reuses the #49 store).
 */
export async function reconcileBedrockSpend(opts: ReconcileOptions): Promise<ReconciliationResult> {
  const threshold = opts.threshold ?? DISCREPANCY_THRESHOLD;
  const usage = await opts.client.getCostAndUsage({
    start: isoDate(opts.start),
    end: isoDate(opts.end),
    region: opts.region,
    tagKey: opts.tagKey,
  });
  const awsCents = Math.round(usage.totalUsd * 100);
  const metisCents = await metisBedrockCents(opts.start, opts.end);
  // Symmetric, bounded discrepancy ratio: divide by the larger of the two
  // sides (Mi2) so a small AWS figure can't inflate the ratio asymmetrically.
  const discrepancy = Math.abs(awsCents - metisCents) / Math.max(awsCents, metisCents, 1);
  const warning = discrepancy > threshold;

  if (warning && opts.warnWorkspaceId) {
    try {
      await prisma.alertEvent.create({
        data: {
          workspaceId: opts.warnWorkspaceId,
          ruleId: "aws-reconciliation",
          spendCents: awsCents,
          budgetCents: metisCents,
          ratio: discrepancy,
          basis: "aws-reconciliation",
          deliveries: JSON.stringify([
            {
              channelId: "system",
              type: "reconciliation-warning",
              ok: true,
            },
          ]),
        },
      });
    } catch (err) {
      // The reconciliation warning is best-effort; never throw.
      log.warn("failed to persist reconciliation warning", {
        workspaceId: opts.warnWorkspaceId,
        error: (err as Error).message,
      });
    }
  }

  log.info("bedrock spend reconciliation", {
    awsCents,
    metisCents,
    discrepancy: Number(discrepancy.toFixed(4)),
    warning,
  });

  return { awsCents, metisCents, discrepancy, warning, awsLines: usage.lines };
}
