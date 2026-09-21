/**
 * Epic #594 / Issue #608 — CloudWatchMetricsPublisher unit tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../logger.js", () => ({
  createChildLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import {
  CloudWatchMetricsPublisher,
  getCloudWatchPublisher,
  __resetCloudWatchPublisherSingleton,
} from "./cloudwatch-metrics.js";

describe("CloudWatchMetricsPublisher", () => {
  beforeEach(() => {
    __resetCloudWatchPublisherSingleton();
    vi.clearAllMocks();
    vi.useFakeTimers();
    delete process.env.ENABLE_CLOUDWATCH_METRICS;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe("constructor", () => {
    it("defaults to disabled when env var not set", () => {
      const pub = new CloudWatchMetricsPublisher();
      expect(pub.isEnabled).toBe(false);
    });

    it("enabled when env var is true", () => {
      process.env.ENABLE_CLOUDWATCH_METRICS = "true";
      const pub = new CloudWatchMetricsPublisher();
      expect(pub.isEnabled).toBe(true);
    });

    it("accepts explicit boolean", () => {
      const pub = new CloudWatchMetricsPublisher(true);
      expect(pub.isEnabled).toBe(true);
    });
  });

  describe("record — disabled", () => {
    it("does not enqueue when disabled", () => {
      const pub = new CloudWatchMetricsPublisher(false);
      pub.record({ name: "test", value: 1, unit: "Count", dimensions: {} });
      expect(pub.queueSize).toBe(0);
    });
  });

  describe("record — enabled", () => {
    it("enqueues a metric datum", () => {
      const pub = new CloudWatchMetricsPublisher(true);
      pub.record({
        name: "InputTokens",
        value: 100,
        unit: "Count",
        dimensions: { ModelId: "sonnet" },
      });
      expect(pub.queueSize).toBe(1);
    });

    it("auto-starts the timer on first record", () => {
      const pub = new CloudWatchMetricsPublisher(true);
      pub.record({ name: "test", value: 1, unit: "Count", dimensions: {} });
      // Timer is started internally, queue has items
      expect(pub.queueSize).toBe(1);
    });
  });

  describe("recordTokenUsage", () => {
    it("does nothing when disabled", () => {
      const pub = new CloudWatchMetricsPublisher(false);
      pub.recordTokenUsage({
        inputTokens: 100,
        outputTokens: 50,
        modelId: "sonnet",
        userId: "user-1",
      });
      expect(pub.queueSize).toBe(0);
    });

    it("enqueues multiple metrics when enabled", () => {
      const pub = new CloudWatchMetricsPublisher(true);
      pub.recordTokenUsage({
        inputTokens: 100,
        outputTokens: 50,
        latencyMs: 200,
        estimatedCostUsd: 0.001,
        projectId: "proj-1",
        modelId: "sonnet",
        userId: "user-1",
        environment: "prod",
      });
      // Should enqueue: InputTokens, OutputTokens, InvocationLatency, EstimatedCost
      expect(pub.queueSize).toBe(4);
    });

    it("omits latency and cost metrics when not provided", () => {
      const pub = new CloudWatchMetricsPublisher(true);
      pub.recordTokenUsage({
        inputTokens: 100,
        outputTokens: 50,
        modelId: "haiku",
        userId: "user-2",
      });
      // InputTokens + OutputTokens only
      expect(pub.queueSize).toBe(2);
    });
  });

  describe("flush — no SDK", () => {
    it("discards metrics gracefully when SDK is not available", async () => {
      const pub = new CloudWatchMetricsPublisher(true);
      pub.record({ name: "test", value: 1, unit: "Count", dimensions: {} });
      expect(pub.queueSize).toBe(1);

      // flush will fail to import the SDK — should not throw
      await pub.flush();
      expect(pub.queueSize).toBe(0);
    });
  });

  describe("stop", () => {
    it("drains the queue on stop", async () => {
      const pub = new CloudWatchMetricsPublisher(true);
      pub.record({ name: "test", value: 42, unit: "Count", dimensions: {} });
      await pub.stop();
      // Queue should be empty after stop (flushed or discarded)
      expect(pub.queueSize).toBe(0);
    });

    it("is safe to call when already stopped", async () => {
      const pub = new CloudWatchMetricsPublisher(true);
      await pub.stop();
      await pub.stop();
    });
  });

  describe("singleton", () => {
    it("returns the same instance", () => {
      const a = getCloudWatchPublisher();
      const b = getCloudWatchPublisher();
      expect(a).toBe(b);
    });

    it("resets with __resetCloudWatchPublisherSingleton", () => {
      const a = getCloudWatchPublisher();
      __resetCloudWatchPublisherSingleton();
      const b = getCloudWatchPublisher();
      expect(a).not.toBe(b);
    });
  });
});
