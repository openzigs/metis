/** #1466 — the operator's managed-identity client-id allowlist. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock("../logger.js", () => ({
  createChildLogger: () => ({ warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import {
  __resetMsiAllowlistWarnings,
  isMsiClientIdAllowed,
  loadTeamsMsiAllowlist,
} from "./msi-allowlist.js";

const A = "11111111-2222-3333-4444-555555555555";
const B = "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE";

beforeEach(() => {
  warn.mockClear();
  __resetMsiAllowlistWarnings();
});

describe("loadTeamsMsiAllowlist (#1466)", () => {
  it("allows nothing when unset or blank, and warns about nothing", () => {
    for (const value of [undefined, "", " , ,"]) {
      const list = loadTeamsMsiAllowlist({ TEAMS_MSI_CLIENT_IDS: value });
      expect(list.clientIds.size).toBe(0);
      expect(isMsiClientIdAllowed(list, A, "ws-1")).toBe(false);
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it("parses comma-separated client ids, trimmed and case-insensitively", () => {
    const list = loadTeamsMsiAllowlist({ TEAMS_MSI_CLIENT_IDS: ` ${A} ,${B}` });
    expect(isMsiClientIdAllowed(list, A.toUpperCase(), "ws-1")).toBe(true);
    expect(isMsiClientIdAllowed(list, B.toLowerCase(), "ws-2")).toBe(true);
    expect(isMsiClientIdAllowed(list, "99999999-2222-3333-4444-555555555555", "ws-1")).toBe(false);
    expect(list.invalid).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("an id bound to a workspace is allowed for that workspace only", () => {
    const list = loadTeamsMsiAllowlist({ TEAMS_MSI_CLIENT_IDS: `${A}=ws-b, ${B}` });
    expect(isMsiClientIdAllowed(list, A, "ws-b")).toBe(true);
    expect(isMsiClientIdAllowed(list, A, "ws-a")).toBe(false);
    // Workspace ids are compared exactly.
    expect(isMsiClientIdAllowed(list, A, "WS-B")).toBe(false);
    expect(isMsiClientIdAllowed(list, B, "ws-a")).toBe(true);
  });

  it("reports unusable entries by position and reason, and they allow nothing", () => {
    const list = loadTeamsMsiAllowlist({
      TEAMS_MSI_CLIENT_IDS: `${A},*,not-a-guid,${B}=`,
    });
    expect(list.invalid).toEqual([
      { position: 2, reason: "not a client-id GUID" },
      { position: 3, reason: "not a client-id GUID" },
      { position: 4, reason: "empty workspace binding" },
    ]);
    expect(isMsiClientIdAllowed(list, "*", "ws-1")).toBe(false);
    expect(isMsiClientIdAllowed(list, B, "ws-1")).toBe(false);
    expect(isMsiClientIdAllowed(list, A, "ws-1")).toBe(true);
  });

  it("refuses an id listed with two different bindings, rather than guessing", () => {
    const list = loadTeamsMsiAllowlist({ TEAMS_MSI_CLIENT_IDS: `${A}=ws-a,${A}=ws-b` });
    expect(isMsiClientIdAllowed(list, A, "ws-a")).toBe(false);
    expect(isMsiClientIdAllowed(list, A, "ws-b")).toBe(false);
    expect(list.invalid).toEqual([
      { position: 1, reason: "bound to two different workspaces" },
      { position: 2, reason: "bound to two different workspaces" },
    ]);
    // Listing it twice the same way is harmless.
    const same = loadTeamsMsiAllowlist({ TEAMS_MSI_CLIENT_IDS: `${A}=ws-a,${A}=ws-a` });
    expect(isMsiClientIdAllowed(same, A, "ws-a")).toBe(true);
    expect(same.invalid).toEqual([]);
  });

  it("logs unusable entries once per configured value, by position and reason only", () => {
    const value = `${A}=secret-workspace,not-a-guid`;
    loadTeamsMsiAllowlist({ TEAMS_MSI_CLIENT_IDS: value });
    loadTeamsMsiAllowlist({ TEAMS_MSI_CLIENT_IDS: value });
    expect(warn).toHaveBeenCalledTimes(1);
    const [message, meta] = warn.mock.calls[0] as [string, { entries: string[] }];
    expect(message).toContain("TEAMS_MSI_CLIENT_IDS");
    expect(meta.entries).toEqual(["#2: not a client-id GUID"]);
    // Neither the bad entry nor any other configured value is echoed.
    expect(JSON.stringify(warn.mock.calls)).not.toContain("not-a-guid");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("secret-workspace");
    expect(JSON.stringify(warn.mock.calls)).not.toContain(A);

    // A changed configuration is reported again.
    loadTeamsMsiAllowlist({ TEAMS_MSI_CLIENT_IDS: "bad" });
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
