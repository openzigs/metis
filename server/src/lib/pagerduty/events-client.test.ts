/**
 * Issue #580 — PagerDuty Events API v2 client tests.
 *
 * The client speaks the v2 enqueue protocol (trigger/resolve) and is fully
 * unit-tested against an injected `fetchImpl` — no real network is ever touched.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { PagerDutyEventsClient, PagerDutyApiError } from "./events-client.js";

const ENQUEUE_URL = "https://events.pagerduty.com/v2/enqueue";

/** Build a stub `fetchImpl` returning a given status + JSON body. */
function stubFetch(status: number, body: unknown): typeof fetch {
  return vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
  ) as unknown as typeof fetch;
}

describe("PagerDutyEventsClient", () => {
  afterEach(() => vi.restoreAllMocks());

  it("triggers a critical incident with the correct v2 payload", async () => {
    const fetchImpl = stubFetch(202, { status: "success", dedup_key: "abc", message: "ok" });
    const client = new PagerDutyEventsClient({ fetchImpl });

    const res = await client.trigger({
      routingKey: "R0UT1NGKEY",
      dedupKey: "metis:publish-rollback:batch-1",
      summary: "Publish rollback for project Acme",
      source: "metis/publishing",
      severity: "critical",
      component: "publishing",
      customDetails: { batchId: "batch-1", projectId: "p1" },
    });

    expect(res.dedupKey).toBe("abc");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(url)).toBe(ENQUEUE_URL);
    expect((init as RequestInit).method).toBe("POST");
    const sent = JSON.parse((init as RequestInit).body as string);
    expect(sent.routing_key).toBe("R0UT1NGKEY");
    expect(sent.event_action).toBe("trigger");
    expect(sent.dedup_key).toBe("metis:publish-rollback:batch-1");
    expect(sent.payload.summary).toBe("Publish rollback for project Acme");
    expect(sent.payload.severity).toBe("critical");
    expect(sent.payload.source).toBe("metis/publishing");
    expect(sent.payload.component).toBe("publishing");
    expect(sent.payload.custom_details).toEqual({ batchId: "batch-1", projectId: "p1" });
  });

  it("defaults severity to critical (sev-1) when omitted", async () => {
    const fetchImpl = stubFetch(202, { status: "success", dedup_key: "k" });
    const client = new PagerDutyEventsClient({ fetchImpl });
    await client.trigger({
      routingKey: "rk",
      dedupKey: "d",
      summary: "s",
      source: "src",
    });
    const init = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1];
    const sent = JSON.parse((init as RequestInit).body as string);
    expect(sent.payload.severity).toBe("critical");
  });

  it("resolves an incident with event_action=resolve and the dedup key", async () => {
    const fetchImpl = stubFetch(202, { status: "success", dedup_key: "k" });
    const client = new PagerDutyEventsClient({ fetchImpl });

    await client.resolve({ routingKey: "rk", dedupKey: "metis:provider-down:srv-9" });

    const init = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1];
    const sent = JSON.parse((init as RequestInit).body as string);
    expect(sent.event_action).toBe("resolve");
    expect(sent.dedup_key).toBe("metis:provider-down:srv-9");
    expect(sent.routing_key).toBe("rk");
    // A resolve carries no payload.severity/summary requirement beyond the keys.
    expect(sent.payload).toBeUndefined();
  });

  it("throws PagerDutyApiError on a non-2xx response", async () => {
    const fetchImpl = stubFetch(400, { status: "invalid event", errors: ["bad routing_key"] });
    const client = new PagerDutyEventsClient({ fetchImpl });

    await expect(
      client.trigger({ routingKey: "rk", dedupKey: "d", summary: "s", source: "src" }),
    ).rejects.toBeInstanceOf(PagerDutyApiError);
  });

  it("PagerDutyApiError carries the status code and never echoes the routing key", async () => {
    const fetchImpl = stubFetch(429, { status: "throttled" });
    const client = new PagerDutyEventsClient({ fetchImpl });
    try {
      await client.trigger({
        routingKey: "SECRET-KEY",
        dedupKey: "d",
        summary: "s",
        source: "src",
      });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(PagerDutyApiError);
      const e = err as PagerDutyApiError;
      expect(e.statusCode).toBe(429);
      expect(e.message).not.toContain("SECRET-KEY");
    }
  });

  it("propagates a network error from the underlying fetch", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    const client = new PagerDutyEventsClient({ fetchImpl });
    await expect(
      client.trigger({ routingKey: "rk", dedupKey: "d", summary: "s", source: "src" }),
    ).rejects.toThrow(/ECONNRESET/);
  });

  it("tolerates a non-JSON 2xx body (falls back to the request dedup key)", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("OK", { status: 202 }),
    ) as unknown as typeof fetch;
    const client = new PagerDutyEventsClient({ fetchImpl });
    const res = await client.trigger({
      routingKey: "rk",
      dedupKey: "d-fallback",
      summary: "s",
      source: "src",
    });
    expect(res.dedupKey).toBe("d-fallback");
    expect(res.status).toBe("success");
  });

  it("reports a generic error when a non-2xx body is not JSON", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("gateway timeout", { status: 502 }),
    ) as unknown as typeof fetch;
    const client = new PagerDutyEventsClient({ fetchImpl });
    await expect(
      client.trigger({ routingKey: "rk", dedupKey: "d", summary: "s", source: "src" }),
    ).rejects.toThrow(/502/);
  });

  it("includes optional component/group/class metadata when supplied", async () => {
    const fetchImpl = stubFetch(202, { status: "success", dedup_key: "k" });
    const client = new PagerDutyEventsClient({ fetchImpl });
    await client.trigger({
      routingKey: "rk",
      dedupKey: "d",
      summary: "s",
      source: "src",
      component: "c",
      group: "g",
      eventClass: "deploy",
    });
    const init = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1];
    const sent = JSON.parse((init as RequestInit).body as string);
    expect(sent.payload).toMatchObject({ component: "c", group: "g", class: "deploy" });
  });

  it("sends an abort signal so requests cannot hang forever", async () => {
    let sawSignal = false;
    const fetchImpl = vi.fn(async (_url: unknown, init: RequestInit) => {
      sawSignal = init.signal instanceof AbortSignal;
      return new Response(JSON.stringify({ status: "success", dedup_key: "k" }), { status: 202 });
    }) as unknown as typeof fetch;
    const client = new PagerDutyEventsClient({ fetchImpl, timeoutMs: 5000 });
    await client.trigger({ routingKey: "rk", dedupKey: "d", summary: "s", source: "src" });
    expect(sawSignal).toBe(true);
  });
});
