/**
 * Issue #217 — one source ingest per connector at a time, shared by every entry
 * point (sync routes, scheduled refresh, eval runner), so two runs can never
 * interleave `sourceIngestState` writes.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  INGEST_IN_PROGRESS,
  acquireConnectorIngest,
  assertConnectorIngestLease,
  isConnectorIngestActive,
  tryAcquireConnectorIngest,
  withConnectorIngest,
  type ConnectorIngestLease,
} from "../src/lib/connectors/ingest-guard.js";
import { ConnectorError } from "../src/lib/connectors/types.js";

const held: ConnectorIngestLease[] = [];
function track(lease: ConnectorIngestLease | null): ConnectorIngestLease | null {
  if (lease) held.push(lease);
  return lease;
}

afterEach(() => {
  for (const lease of held.splice(0)) lease.release();
});

describe("connector ingest guard (#217)", () => {
  it("admits one holder per connector and refuses a second until it is released", () => {
    const first = track(tryAcquireConnectorIngest("c1", "sync"));
    expect(first).not.toBeNull();
    expect(first).toMatchObject({ connectorId: "c1", holder: "sync", held: true });
    expect(isConnectorIngestActive("c1")).toBe(true);
    expect(tryAcquireConnectorIngest("c1", "scheduled-refresh")).toBeNull();

    first!.release();
    expect(first!.held).toBe(false);
    expect(isConnectorIngestActive("c1")).toBe(false);
    expect(track(tryAcquireConnectorIngest("c1", "scheduled-refresh"))).not.toBeNull();
  });

  it("is per connector: a different connector is not blocked", () => {
    track(tryAcquireConnectorIngest("c1", "sync"));
    expect(track(tryAcquireConnectorIngest("c2", "sync"))).not.toBeNull();
  });

  it("a stale lease released twice never frees a newer holder's claim", () => {
    const first = tryAcquireConnectorIngest("c1", "sync")!;
    first.release();
    const second = track(tryAcquireConnectorIngest("c1", "eval"))!;
    first.release();
    expect(isConnectorIngestActive("c1")).toBe(true);
    expect(second.held).toBe(true);
  });

  it("acquireConnectorIngest throws a 409 INGEST_IN_PROGRESS ConnectorError when busy", () => {
    track(acquireConnectorIngest("c1", "sync"));
    let caught: unknown;
    try {
      acquireConnectorIngest("c1", "scheduled-refresh");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConnectorError);
    expect(caught).toMatchObject({ status: 409, code: INGEST_IN_PROGRESS });
  });

  it("withConnectorIngest releases on success and on failure", async () => {
    await expect(
      withConnectorIngest("c1", "sync", async (lease) => {
        expect(lease.held).toBe(true);
        expect(isConnectorIngestActive("c1")).toBe(true);
        return 7;
      }),
    ).resolves.toBe(7);
    expect(isConnectorIngestActive("c1")).toBe(false);

    await expect(
      withConnectorIngest("c1", "sync", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(isConnectorIngestActive("c1")).toBe(false);
  });

  it("withConnectorIngest refuses without running the body when busy", async () => {
    track(acquireConnectorIngest("c1", "sync"));
    let ran = false;
    await expect(
      withConnectorIngest("c1", "scheduled-refresh", async () => {
        ran = true;
      }),
    ).rejects.toMatchObject({ status: 409, code: INGEST_IN_PROGRESS });
    expect(ran).toBe(false);
    // The refusal must not release the existing holder's claim.
    expect(isConnectorIngestActive("c1")).toBe(true);
  });

  it("assertConnectorIngestLease rejects a released lease or one for another connector", () => {
    const lease = acquireConnectorIngest("c1", "sync");
    expect(() => assertConnectorIngestLease(lease, "c1")).not.toThrow();
    expect(() => assertConnectorIngestLease(lease, "c2")).toThrow(ConnectorError);
    lease.release();
    expect(() => assertConnectorIngestLease(lease, "c1")).toThrow(ConnectorError);
  });
});
