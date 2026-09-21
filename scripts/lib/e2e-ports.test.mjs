import { describe, expect, it } from "vitest";

import {
  API_PORT_BASE,
  SLOT_COUNT,
  UI_PORT_BASE,
  allocateE2ePorts,
  formatGithubEnv,
  portSlot,
} from "./e2e-ports.mjs";

/** Every port is free. */
const allFree = async () => true;

/** @param {number[]} busy */
const busySet = (busy) => async (/** @type {number} */ port) => !busy.includes(port);

describe("portSlot", () => {
  it("derives a stable slot from the run id", () => {
    expect(portSlot({ runId: "12345", runAttempt: "1" })).toBe(46);
    expect(portSlot({ runId: 12345, runAttempt: 1 })).toBe(46);
  });

  it("gives different slots to different concurrent runs", () => {
    const a = portSlot({ runId: "17000000001", runAttempt: "1" });
    const b = portSlot({ runId: "17000000002", runAttempt: "1" });
    expect(a).not.toBe(b);
  });

  it("shifts the slot on a re-run so a retry cannot inherit a squatted port", () => {
    expect(portSlot({ runId: "500", runAttempt: "1" })).not.toBe(
      portSlot({ runId: "500", runAttempt: "2" }),
    );
  });

  it("stays inside [0, slotCount)", () => {
    for (const runId of ["0", "99", "100", "123456789012", "999999999999999"]) {
      const slot = portSlot({ runId, runAttempt: "3" });
      expect(slot).toBeGreaterThanOrEqual(0);
      expect(slot).toBeLessThan(SLOT_COUNT);
    }
  });

  it("falls back to slot 0 outside Actions (no run id) instead of throwing", () => {
    expect(portSlot({ runId: undefined, runAttempt: undefined })).toBe(0);
    expect(portSlot({ runId: "not-a-number", runAttempt: "nope" })).toBe(0);
  });

  it("ignores negative values rather than producing a negative slot", () => {
    expect(portSlot({ runId: "-7", runAttempt: "-1" })).toBe(0);
  });

  it("honours a custom slot count", () => {
    expect(portSlot({ runId: "11", runAttempt: "0", slotCount: 4 })).toBe(3);
  });
});

describe("allocateE2ePorts", () => {
  it("returns the run-derived pair when both ports are free", async () => {
    const result = await allocateE2ePorts({
      env: { GITHUB_RUN_ID: "12345", GITHUB_RUN_ATTEMPT: "1" },
      isFree: allFree,
    });
    expect(result).toMatchObject({
      slot: 46,
      startSlot: 46,
      apiPort: API_PORT_BASE + 46,
      uiPort: UI_PORT_BASE + 46,
      skipped: [],
    });
  });

  it("allocates disjoint pairs for two concurrent runs", async () => {
    const first = await allocateE2ePorts({
      env: { GITHUB_RUN_ID: "17000000001", GITHUB_RUN_ATTEMPT: "1" },
      isFree: allFree,
    });
    // Simulate the first run now holding its ports.
    const second = await allocateE2ePorts({
      env: { GITHUB_RUN_ID: "17000000002", GITHUB_RUN_ATTEMPT: "1" },
      isFree: busySet([first.apiPort, first.uiPort]),
    });
    expect(second.apiPort).not.toBe(first.apiPort);
    expect(second.uiPort).not.toBe(first.uiPort);
  });

  it("walks forward when the derived API port is busy", async () => {
    const result = await allocateE2ePorts({
      env: { GITHUB_RUN_ID: "10", GITHUB_RUN_ATTEMPT: "0" },
      isFree: busySet([API_PORT_BASE + 10]),
    });
    expect(result.startSlot).toBe(10);
    expect(result.slot).toBe(11);
    expect(result.skipped).toEqual([10]);
  });

  it("walks forward when only the UI port of the pair is busy", async () => {
    const result = await allocateE2ePorts({
      env: { GITHUB_RUN_ID: "10", GITHUB_RUN_ATTEMPT: "0" },
      isFree: busySet([UI_PORT_BASE + 10, UI_PORT_BASE + 11]),
    });
    expect(result.slot).toBe(12);
    expect(result.skipped).toEqual([10, 11]);
  });

  it("wraps around the top of the range", async () => {
    const result = await allocateE2ePorts({
      env: { GITHUB_RUN_ID: String(SLOT_COUNT - 1), GITHUB_RUN_ATTEMPT: "0" },
      isFree: busySet([API_PORT_BASE + SLOT_COUNT - 1]),
    });
    expect(result.startSlot).toBe(SLOT_COUNT - 1);
    expect(result.slot).toBe(0);
  });

  it("keeps every allocated port below the ephemeral floor and above 1024", async () => {
    for (const runId of ["1", "58", "99", "17000000123"]) {
      const { apiPort, uiPort } = await allocateE2ePorts({
        env: { GITHUB_RUN_ID: runId, GITHUB_RUN_ATTEMPT: "1" },
        isFree: allFree,
      });
      for (const port of [apiPort, uiPort]) {
        expect(port).toBeGreaterThan(1024);
        expect(port).toBeLessThan(32768);
      }
      expect(apiPort).not.toBe(uiPort);
    }
  });

  it("throws a diagnosable error when the whole range is squatted", async () => {
    await expect(
      allocateE2ePorts({
        env: { GITHUB_RUN_ID: "5", GITHUB_RUN_ATTEMPT: "0" },
        isFree: async () => false,
        maxAttempts: 3,
      }),
    ).rejects.toThrow(/No free e2e port pair found after 3 slots starting at 5/);
  });

  it("never probes more slots than exist", async () => {
    /** @type {number[]} */
    const probed = [];
    await expect(
      allocateE2ePorts({
        env: { GITHUB_RUN_ID: "0", GITHUB_RUN_ATTEMPT: "0" },
        slotCount: 3,
        maxAttempts: 99,
        isFree: async (port) => {
          probed.push(port);
          return false;
        },
      }),
    ).rejects.toThrow(/after 3 slots/);
    expect(probed).toHaveLength(3); // one API probe per slot, UI never reached
  });

  it("defaults env to process.env", async () => {
    const previous = process.env.GITHUB_RUN_ID;
    process.env.GITHUB_RUN_ID = "7";
    try {
      const result = await allocateE2ePorts({ isFree: allFree });
      expect(result.startSlot).toBe(
        portSlot({ runId: "7", runAttempt: process.env.GITHUB_RUN_ATTEMPT }),
      );
    } finally {
      if (previous === undefined) delete process.env.GITHUB_RUN_ID;
      else process.env.GITHUB_RUN_ID = previous;
    }
  });
});

describe("formatGithubEnv", () => {
  it("emits exactly the two variables the Playwright config reads", () => {
    const block = formatGithubEnv({
      slot: 3,
      apiPort: 21003,
      uiPort: 22003,
      startSlot: 3,
      skipped: [],
    });
    expect(block).toBe("E2E_API_PORT=21003\nE2E_UI_PORT=22003\n");
  });
});
