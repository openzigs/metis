/**
 * OpenTelemetry bootstrap (epic #158 / #109).
 *
 * Wires a Node SDK with an OTLP/HTTP trace exporter. Gated on the standard
 * `OTEL_SDK_DISABLED` env var (set to "true" to short-circuit). Honors:
 *   - OTEL_EXPORTER_OTLP_ENDPOINT  (default unset → exporter inactive)
 *   - OTEL_SERVICE_NAME            (default "metis-server")
 *   - OTEL_RESOURCE_ATTRIBUTES     (k=v,k=v style)
 *
 * IMPORTANT: this module must be imported BEFORE any other server import
 * so HTTP / Express auto-instrumentation can patch their targets.
 */
import process from "node:process";

let started = false;

interface OtelHandle {
  shutdown: () => Promise<void>;
}

let handle: OtelHandle | null = null;

export interface InitOtelOptions {
  /** Test seam — override the SDK constructor. */
  sdkFactory?: () => OtelHandle;
  /** Test seam — force-enable / disable bypassing env. */
  disabled?: boolean;
  /** Test seam — override env. */
  env?: NodeJS.ProcessEnv;
}

export function isOtelDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.OTEL_SDK_DISABLED ?? "").toLowerCase() === "true";
}

export function getServiceName(env: NodeJS.ProcessEnv = process.env): string {
  return env.OTEL_SERVICE_NAME?.trim() || "metis-server";
}

export function isContentCaptureEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.OTEL_GENAI_CAPTURE_CONTENT ?? "").toLowerCase() === "true";
}

/**
 * Initialise the SDK exactly once. Subsequent calls are no-ops. Returns true
 * when initialisation actually ran.
 */
export function initOtel(opts: InitOtelOptions = {}): boolean {
  if (started) return false;
  const env = opts.env ?? process.env;
  const disabled = opts.disabled ?? isOtelDisabled(env);
  if (disabled) {
    started = true;
    return false;
  }

  try {
    if (opts.sdkFactory) {
      handle = opts.sdkFactory();
    } else {
      // Lazy require so test runs that disable OTel never load the heavy SDK.
      const { NodeSDK } =
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require("@opentelemetry/sdk-node") as typeof import("@opentelemetry/sdk-node");
      const otlp =
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require("@opentelemetry/exporter-trace-otlp-http") as typeof import("@opentelemetry/exporter-trace-otlp-http");
      const http =
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require("@opentelemetry/instrumentation-http") as typeof import("@opentelemetry/instrumentation-http");
      const ex =
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require("@opentelemetry/instrumentation-express") as typeof import("@opentelemetry/instrumentation-express");

      const sdk = new NodeSDK({
        serviceName: getServiceName(env),
        traceExporter: new otlp.OTLPTraceExporter({
          url: env.OTEL_EXPORTER_OTLP_ENDPOINT,
        }),
        instrumentations: [new http.HttpInstrumentation(), new ex.ExpressInstrumentation()],
      });
      sdk.start();
      handle = {
        shutdown: async () => {
          await sdk.shutdown();
        },
      };
    }
    started = true;
    return true;
  } catch {
    // If the SDK fails to load (e.g. binary mismatch), don't crash the server —
    // just continue without telemetry. The fact that init failed is recorded
    // by the caller via the boolean return.
    started = true;
    return false;
  }
}

export async function shutdownOtel(): Promise<void> {
  if (handle) {
    try {
      await handle.shutdown();
    } catch {
      /* ignore shutdown errors */
    }
    handle = null;
  }
  started = false;
}

/** Test-only reset. */
export function __resetOtelForTests(): void {
  started = false;
  handle = null;
}

// Auto-init on import unless the test runner suppresses it.
if (process.env.METIS_OTEL_AUTOSTART !== "false") {
  initOtel();
}
