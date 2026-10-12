/**
 * #1059 — what an aborted model call costs in the ledger.
 *
 * A call its job aborted reports no usage, but a call that was SENT is billed
 * by the provider, so the runner records an estimate of its prompt under
 * `spec-kit.<command>.aborted`. A call that was still waiting in a provider's
 * queue (the local model's concurrency limiter) when it was aborted was never
 * sent: it must cost nothing.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AIProvider, ChatMessage, ChatOptions } from "../../ai/types.js";

vi.mock("../../finops/index.js", () => ({
  assertWithinBudget: vi.fn().mockResolvedValue(undefined),
  recordUsage: vi.fn(),
  BudgetExceededError: class BudgetExceededError extends Error {},
}));
vi.mock("../../safety/index.js", () => ({
  applySafety: vi.fn(async (text: string) => ({ text, redacted: false })),
  SafetyDeniedError: class SafetyDeniedError extends Error {},
}));
vi.mock("../../audit/audit-service.js", () => ({ audit: vi.fn() }));
vi.mock("../../prisma.js", () => ({ prisma: {} }));
vi.mock("../constitution.js", () => ({
  readProjectConstitution: vi.fn().mockResolvedValue(null),
}));
vi.mock("../constitution-meta.js", () => ({
  loadAsPreamble: vi.fn().mockResolvedValue("## Constitution v1.0\nBe truthful."),
}));

const { runSpecKitAgent } = await import("./runner.js");
const { recordUsage } = await import("../../finops/index.js");
const { withSpecKitJobScope, SpecKitJobStopError } = await import("../job-scope.js");

const project = {
  id: "p1",
  name: "Proj",
  description: "",
  safetyMode: "standard" as const,
  aiProviderId: null,
};

const abortError = (): Error =>
  Object.assign(new Error("The operation was aborted"), { name: "AbortError" });

/** A job scope whose abort the test triggers. */
function jobScope() {
  const controller = new AbortController();
  let stopped: InstanceType<typeof SpecKitJobStopError> | null = null;
  return {
    scope: {
      jobId: "job-1",
      projectId: "p1",
      signal: controller.signal,
      stopError: () => stopped,
      commitPoint: async () => undefined,
      phase: () => undefined,
    },
    abort: () => {
      stopped = new SpecKitJobStopError("cancelled");
      controller.abort(stopped);
    },
  };
}

/**
 * A provider whose `chat` the test scripts: it may report that the request is
 * queued, that it got its slot, and then rejects when the signal aborts.
 */
function queueingProvider(script: (opts: ChatOptions) => void): {
  provider: AIProvider;
  entered: Promise<void>;
} {
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => (enter = resolve));
  const provider = {
    key: "local-gemma",
    model: "gemma-test",
    offline: false,
    chat(_messages: ChatMessage[], opts: ChatOptions) {
      return new Promise((_resolve, reject) => {
        opts.signal?.addEventListener("abort", () => reject(abortError()), { once: true });
        script(opts);
        enter();
      });
    },
    stream: vi.fn(),
    embed: vi.fn(),
    models: vi.fn(),
    ping: vi.fn(),
  } as unknown as AIProvider;
  return { provider, entered };
}

const run = (provider: AIProvider, scope: ReturnType<typeof jobScope>["scope"]) =>
  withSpecKitJobScope(scope, () =>
    runSpecKitAgent({
      command: "plan",
      project,
      systemPrompt: "Base command prompt.",
      userPrompt: "Draft a plan.",
      actorId: "u1",
      deps: { provider },
    }),
  );

const abortedRows = () =>
  vi
    .mocked(recordUsage)
    .mock.calls.map((call) => call[0] as { agentStep: string; inputTokens: number })
    .filter((row) => row.agentStep === "spec-kit.plan.aborted");

describe("an aborted model call (#1059)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("is recorded as a prompt estimate when the provider does not queue (it was sent)", async () => {
    const job = jobScope();
    const { provider, entered } = queueingProvider(() => undefined);
    const pending = run(provider, job.scope).catch((err: unknown) => err);
    await entered;
    job.abort();

    expect(((await pending) as Error).name).toBe("AbortError");
    expect(abortedRows()).toHaveLength(1);
    expect(abortedRows()[0]).toMatchObject({ outputTokens: 0, provider: "local-gemma" });
    expect(abortedRows()[0]!.inputTokens).toBeGreaterThan(0);
  });

  it("is recorded when it had been queued and then got its slot (it was sent)", async () => {
    const job = jobScope();
    const { provider, entered } = queueingProvider((opts) => {
      opts.onSlotQueued?.(2);
      opts.onSlotAcquired?.();
    });
    const pending = run(provider, job.scope).catch((err: unknown) => err);
    await entered;
    job.abort();
    await pending;

    expect(abortedRows()).toHaveLength(1);
  });

  it("is NOT recorded when it was still waiting for a slot (it was never sent)", async () => {
    const job = jobScope();
    const { provider, entered } = queueingProvider((opts) => {
      opts.onSlotQueued?.(1); // waiting behind another generation; no slot yet
    });
    const pending = run(provider, job.scope).catch((err: unknown) => err);
    await entered;
    job.abort();

    expect(((await pending) as Error).name).toBe("AbortError");
    expect(abortedRows()).toEqual([]);
    expect(recordUsage).not.toHaveBeenCalled();
  });

  it("records nothing for a failure that is not the job's abort", async () => {
    const job = jobScope();
    const provider = {
      key: "local-gemma",
      model: "gemma-test",
      offline: false,
      chat: async () => {
        throw new Error("upstream 500");
      },
    } as unknown as AIProvider;
    await expect(run(provider, job.scope)).rejects.toThrow("upstream 500");
    expect(recordUsage).not.toHaveBeenCalled();
  });
});
