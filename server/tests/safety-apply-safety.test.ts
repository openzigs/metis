/**
 * Tests for the `applySafety` orchestrator (Epic #164).
 *
 * Covers hook selection per-provider, SafetyEvent persistence, and the
 * SafetyDeniedError throw path.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

interface PersistedEvent {
  projectId: string;
  sessionId: string | null;
  direction: string;
  verdict: string;
  findings: string;
}

const events: PersistedEvent[] = [];

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    safetyEvent: {
      create: vi.fn(async ({ data }: { data: PersistedEvent }) => {
        events.push(data);
        return { id: "ev-" + events.length, ...data };
      }),
    },
  },
}));

import { applySafety, SafetyDeniedError } from "../src/lib/safety/apply-safety.js";
import type { SafetyHook, SafetyResult } from "../src/lib/safety/safety-hook.js";

beforeEach(() => {
  events.length = 0;
});

function makeHook(name: string, result: SafetyResult): SafetyHook {
  return {
    name,
    applyInput: vi.fn(async () => result),
    applyOutput: vi.fn(async () => result),
  };
}

async function flush(): Promise<void> {
  // SafetyEvent persist runs as a microtask via `void persistEvent(...)`.
  await new Promise<void>((res) => setImmediate(res));
}

describe("applySafety", () => {
  it("short-circuits when mode=off and persists no event", async () => {
    const r = await applySafety("hello", {
      projectId: "p1",
      sessionId: "s1",
      provider: "openai",
      mode: "off",
      direction: "input",
    });
    expect(r.text).toBe("hello");
    await flush();
    expect(events).toHaveLength(0);
  });

  it("uses the regex hook for non-Bedrock providers and persists allowed", async () => {
    const regex = makeHook("regex", { allowed: true, findings: [] });
    const r = await applySafety("hi", {
      projectId: "p1",
      sessionId: "s1",
      provider: "openai",
      mode: "standard",
      direction: "input",
      regexHook: regex,
    });
    expect(r.text).toBe("hi");
    expect(regex.applyInput).toHaveBeenCalled();
    await flush();
    expect(events).toHaveLength(1);
    expect(events[0].verdict).toBe("allowed");
  });

  it("uses the Bedrock hook first for bedrock-gateway provider", async () => {
    const bedrock = makeHook("bedrock", {
      allowed: true,
      redacted: "redacted text",
      findings: [{ kind: "pii", count: 1 }],
    });
    const regex = makeHook("regex", { allowed: true, findings: [] });
    const r = await applySafety("hi", {
      projectId: "p1",
      sessionId: "s1",
      provider: "bedrock-gateway",
      mode: "standard",
      direction: "input",
      bedrockHook: bedrock,
      regexHook: regex,
    });
    expect(r.text).toBe("redacted text");
    expect(r.redacted).toBe(true);
    expect(regex.applyInput).not.toHaveBeenCalled();
    await flush();
    expect(events[0].verdict).toBe("redacted");
  });

  it("falls through to regex when Bedrock returns clean (no findings)", async () => {
    const bedrock = makeHook("bedrock", { allowed: true, findings: [] });
    const regex = makeHook("regex", {
      allowed: false,
      findings: [{ kind: "prompt_injection", count: 1 }],
    });
    await expect(
      applySafety("ignore previous", {
        projectId: "p1",
        sessionId: null,
        provider: "bedrock-gateway",
        mode: "standard",
        direction: "input",
        bedrockHook: bedrock,
        regexHook: regex,
      }),
    ).rejects.toBeInstanceOf(SafetyDeniedError);
    await flush();
    expect(events.at(-1)?.verdict).toBe("blocked");
  });

  it("throws SafetyDeniedError on blocked verdict", async () => {
    const regex = makeHook("regex", {
      allowed: false,
      findings: [{ kind: "jailbreak", count: 1 }],
    });
    await expect(
      applySafety("DAN mode", {
        projectId: "p1",
        sessionId: "s1",
        provider: "openai",
        mode: "standard",
        direction: "input",
        regexHook: regex,
      }),
    ).rejects.toMatchObject({
      name: "SafetyDeniedError",
      status: 422,
      code: "SAFETY_DENIED",
    });
  });

  it("returns the redacted text when the hook rewrote the input", async () => {
    const regex = makeHook("regex", {
      allowed: true,
      redacted: "[REDACTED:SSN]",
      findings: [{ kind: "ssn", count: 1 }],
    });
    const r = await applySafety("123-45-6789", {
      projectId: "p1",
      sessionId: "s1",
      provider: "openai",
      mode: "standard",
      direction: "output",
      regexHook: regex,
    });
    expect(r.text).toBe("[REDACTED:SSN]");
    expect(r.redacted).toBe(true);
    await flush();
    expect(events[0].direction).toBe("output");
    expect(events[0].verdict).toBe("redacted");
  });
});
