/** #1466 — the operator's managed-identity client-id allowlist. */
import { describe, expect, it } from "vitest";

import { isMsiClientIdAllowed, loadTeamsMsiAllowlist } from "./msi-allowlist.js";

const A = "11111111-2222-3333-4444-555555555555";
const B = "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE";

describe("loadTeamsMsiAllowlist (#1466)", () => {
  it("allows nothing when unset or blank", () => {
    for (const value of [undefined, "", " , ,"]) {
      const list = loadTeamsMsiAllowlist({ TEAMS_MSI_CLIENT_IDS: value });
      expect(list.clientIds.size).toBe(0);
      expect(isMsiClientIdAllowed(list, A, "ws-1")).toBe(false);
    }
  });

  it("parses comma-separated client ids, trimmed and case-insensitively", () => {
    const list = loadTeamsMsiAllowlist({ TEAMS_MSI_CLIENT_IDS: ` ${A} ,${B}` });
    expect(isMsiClientIdAllowed(list, A.toUpperCase(), "ws-1")).toBe(true);
    expect(isMsiClientIdAllowed(list, B.toLowerCase(), "ws-2")).toBe(true);
    expect(isMsiClientIdAllowed(list, "99999999-2222-3333-4444-555555555555", "ws-1")).toBe(false);
    expect(list.invalid).toEqual([]);
  });

  it("an id bound to a workspace is allowed for that workspace only", () => {
    const list = loadTeamsMsiAllowlist({ TEAMS_MSI_CLIENT_IDS: `${A}=ws-b, ${B}` });
    expect(isMsiClientIdAllowed(list, A, "ws-b")).toBe(true);
    expect(isMsiClientIdAllowed(list, A, "ws-a")).toBe(false);
    // Workspace ids are compared exactly.
    expect(isMsiClientIdAllowed(list, A, "WS-B")).toBe(false);
    expect(isMsiClientIdAllowed(list, B, "ws-a")).toBe(true);
  });

  it("reports unusable entries, and they allow nothing", () => {
    const list = loadTeamsMsiAllowlist({
      TEAMS_MSI_CLIENT_IDS: `${A},*,not-a-guid,${B}=`,
    });
    expect(list.invalid).toEqual(["*", "not-a-guid", `${B}=`]);
    expect(isMsiClientIdAllowed(list, "*", "ws-1")).toBe(false);
    expect(isMsiClientIdAllowed(list, B, "ws-1")).toBe(false);
    expect(isMsiClientIdAllowed(list, A, "ws-1")).toBe(true);
  });

  it("refuses an id listed with two different bindings, rather than guessing", () => {
    const list = loadTeamsMsiAllowlist({ TEAMS_MSI_CLIENT_IDS: `${A}=ws-a,${A}=ws-b` });
    expect(isMsiClientIdAllowed(list, A, "ws-a")).toBe(false);
    expect(isMsiClientIdAllowed(list, A, "ws-b")).toBe(false);
    expect(list.invalid).toEqual([A]);
    // Listing it twice the same way is harmless.
    const same = loadTeamsMsiAllowlist({ TEAMS_MSI_CLIENT_IDS: `${A}=ws-a,${A}=ws-a` });
    expect(isMsiClientIdAllowed(same, A, "ws-a")).toBe(true);
  });
});
