/**
 * Tests for the OpenTelemetry bootstrap (#109).
 */
import { describe, expect, it, beforeEach } from "vitest";
import {
  initOtel,
  isOtelDisabled,
  getServiceName,
  isContentCaptureEnabled,
  shutdownOtel,
  __resetOtelForTests,
} from "../src/lib/otel/init.js";

describe("otel/init", () => {
  beforeEach(() => {
    __resetOtelForTests();
  });

  it("isOtelDisabled honors OTEL_SDK_DISABLED", () => {
    expect(isOtelDisabled({ OTEL_SDK_DISABLED: "true" })).toBe(true);
    expect(isOtelDisabled({ OTEL_SDK_DISABLED: "TRUE" })).toBe(true);
    expect(isOtelDisabled({ OTEL_SDK_DISABLED: "false" })).toBe(false);
    expect(isOtelDisabled({})).toBe(false);
  });

  it("getServiceName defaults to metis-server", () => {
    expect(getServiceName({})).toBe("metis-server");
    expect(getServiceName({ OTEL_SERVICE_NAME: "custom" })).toBe("custom");
    expect(getServiceName({ OTEL_SERVICE_NAME: "  spaced  " })).toBe("spaced");
  });

  it("isContentCaptureEnabled defaults OFF for privacy", () => {
    expect(isContentCaptureEnabled({})).toBe(false);
    expect(isContentCaptureEnabled({ OTEL_GENAI_CAPTURE_CONTENT: "false" })).toBe(false);
    expect(isContentCaptureEnabled({ OTEL_GENAI_CAPTURE_CONTENT: "true" })).toBe(true);
    expect(isContentCaptureEnabled({ OTEL_GENAI_CAPTURE_CONTENT: "TRUE" })).toBe(true);
  });

  it("initOtel returns false when disabled and never starts the SDK", () => {
    let started = false;
    const ok = initOtel({
      disabled: true,
      sdkFactory: () => {
        started = true;
        return { shutdown: async () => undefined };
      },
    });
    expect(ok).toBe(false);
    expect(started).toBe(false);
  });

  it("initOtel returns true on first init with sdk factory and is idempotent", () => {
    let starts = 0;
    const factory = () => {
      starts += 1;
      return { shutdown: async () => undefined };
    };
    expect(initOtel({ sdkFactory: factory, disabled: false })).toBe(true);
    expect(initOtel({ sdkFactory: factory, disabled: false })).toBe(false);
    expect(starts).toBe(1);
  });

  it("shutdownOtel calls the SDK shutdown when started", async () => {
    let stopped = 0;
    initOtel({
      disabled: false,
      sdkFactory: () => ({
        shutdown: async () => {
          stopped += 1;
        },
      }),
    });
    await shutdownOtel();
    expect(stopped).toBe(1);
    // Subsequent shutdown is a no-op.
    await shutdownOtel();
    expect(stopped).toBe(1);
  });

  it("initOtel returns false when sdk factory throws (graceful degrade)", () => {
    const ok = initOtel({
      disabled: false,
      sdkFactory: () => {
        throw new Error("boom");
      },
    });
    expect(ok).toBe(false);
  });
});
