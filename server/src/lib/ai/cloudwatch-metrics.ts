/**
 * Epic #594 / Issue #608 — CloudWatch Metrics Publisher.
 *
 * Batches and publishes custom metrics to CloudWatch when
 * `ENABLE_CLOUDWATCH_METRICS=true`. Uses dynamic import so the
 * `@aws-sdk/client-cloudwatch` dependency is only loaded when the
 * feature flag is enabled — no hard dependency.
 *
 * Metrics published:
 *   - metis/InputTokens
 *   - metis/OutputTokens
 *   - metis/InvocationLatency
 *   - metis/EstimatedCost
 *
 * Dimensions: ProjectId, ModelId, UserId, Environment
 */
import { createChildLogger } from "../logger.js";

const log = createChildLogger("cloudwatch-metrics");

const NAMESPACE = "metis";
const FLUSH_INTERVAL_MS = 5_000;
const MAX_BATCH_SIZE = 20; // CloudWatch limit per PutMetricData

export interface MetricDatum {
  name: string;
  value: number;
  unit: "Count" | "Milliseconds" | "None";
  dimensions: Record<string, string>;
  timestamp?: Date;
}

export class CloudWatchMetricsPublisher {
  private queue: MetricDatum[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private enabled: boolean;
  private cwClient: unknown = null;
  private initPromise: Promise<void> | null = null;

  constructor(enabled?: boolean) {
    this.enabled = enabled ?? process.env.ENABLE_CLOUDWATCH_METRICS === "true";
  }

  /** Start the flush timer. Idempotent. */
  start(): void {
    if (!this.enabled || this.timer) return;
    this.timer = setInterval(() => {
      void this.flush();
    }, FLUSH_INTERVAL_MS);
    // Don't keep the process alive just for metrics.
    if (this.timer && typeof this.timer === "object" && "unref" in this.timer) {
      (this.timer as { unref: () => void }).unref();
    }
    log.info("CloudWatch metrics publisher started");
  }

  /** Stop the flush timer and drain the queue. */
  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.queue.length > 0) {
      await this.flush();
    }
  }

  /** Enqueue a metric datum. Non-blocking. */
  record(datum: MetricDatum): void {
    if (!this.enabled) return;
    this.queue.push({ ...datum, timestamp: datum.timestamp ?? new Date() });
    // Auto-start on first record.
    this.start();
  }

  /** Convenience: record token usage metrics. */
  recordTokenUsage(opts: {
    inputTokens: number;
    outputTokens: number;
    latencyMs?: number;
    estimatedCostUsd?: number;
    projectId?: string;
    modelId: string;
    userId: string;
    environment?: string;
  }): void {
    if (!this.enabled) return;

    const dims: Record<string, string> = {
      ModelId: opts.modelId,
      UserId: opts.userId,
    };
    if (opts.projectId) dims.ProjectId = opts.projectId;
    if (opts.environment) dims.Environment = opts.environment;

    this.record({ name: "InputTokens", value: opts.inputTokens, unit: "Count", dimensions: dims });
    this.record({
      name: "OutputTokens",
      value: opts.outputTokens,
      unit: "Count",
      dimensions: dims,
    });
    if (opts.latencyMs != null) {
      this.record({
        name: "InvocationLatency",
        value: opts.latencyMs,
        unit: "Milliseconds",
        dimensions: dims,
      });
    }
    if (opts.estimatedCostUsd != null) {
      this.record({
        name: "EstimatedCost",
        value: opts.estimatedCostUsd,
        unit: "None",
        dimensions: dims,
      });
    }
  }

  /** Number of queued metrics. */
  get queueSize(): number {
    return this.queue.length;
  }

  /** Whether the publisher is enabled. */
  get isEnabled(): boolean {
    return this.enabled;
  }

  // ── Internals ────────────────────────────────────────────────────────────

  /** Flush queued metrics to CloudWatch. */
  async flush(): Promise<void> {
    if (this.queue.length === 0) return;

    const batch = this.queue.splice(0, MAX_BATCH_SIZE);
    try {
      const client = await this.getClient();
      if (!client) {
        // SDK not available — log and discard.
        log.debug("CloudWatch SDK not available, discarding metrics", { count: batch.length });
        return;
      }

      // Dynamic import — module name in a variable to suppress TS2307 since
      // @aws-sdk/client-cloudwatch is an optional peer dependency.
      const sdkModule = "@aws-sdk/client-cloudwatch";
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { PutMetricDataCommand } = (await import(/* webpackIgnore: true */ sdkModule)) as any;

      const metricData = batch.map((d) => ({
        MetricName: d.name,
        Value: d.value,
        Unit: d.unit,
        Timestamp: d.timestamp,
        Dimensions: Object.entries(d.dimensions).map(([Name, Value]) => ({ Name, Value })),
      }));

      await (client as { send: (cmd: unknown) => Promise<unknown> }).send(
        new PutMetricDataCommand({ Namespace: NAMESPACE, MetricData: metricData }),
      );

      log.debug("CloudWatch metrics flushed", { count: batch.length });
    } catch (err) {
      log.warn("CloudWatch metrics flush failed — discarding batch", {
        count: batch.length,
        error: (err as Error).message,
      });
      // Don't re-queue — graceful degradation.
    }
  }

  private async getClient(): Promise<unknown> {
    if (this.cwClient) return this.cwClient;

    if (!this.initPromise) {
      this.initPromise = (async () => {
        try {
          // Dynamic import — module name in a variable to suppress TS2307 since
          // @aws-sdk/client-cloudwatch is an optional peer dependency.
          const sdkModule = "@aws-sdk/client-cloudwatch";
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const mod = (await import(/* webpackIgnore: true */ sdkModule)) as any;
          this.cwClient = new mod.CloudWatchClient({});
          log.info("CloudWatch client initialized");
        } catch {
          log.warn("@aws-sdk/client-cloudwatch not available — CloudWatch metrics disabled");
          this.enabled = false;
          this.cwClient = null;
        }
      })();
    }

    await this.initPromise;
    return this.cwClient;
  }
}

let singleton: CloudWatchMetricsPublisher | null = null;

export function getCloudWatchPublisher(): CloudWatchMetricsPublisher {
  if (!singleton) singleton = new CloudWatchMetricsPublisher();
  return singleton;
}

/** Test helper. */
export function __resetCloudWatchPublisherSingleton(): void {
  if (singleton) {
    void singleton.stop();
  }
  singleton = null;
}
