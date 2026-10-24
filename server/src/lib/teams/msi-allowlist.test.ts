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
      expect(isMsiClientIdAllowed(list, A)).toBe(false);
    }
  });

  it("parses comma-separated client ids, trimmed and case-insensitively", () => {
    const list = loadTeamsMsiAllowlist({ TEAMS_MSI_CLIENT_IDS: ` ${A} ,${B}` });
    expect(isMsiClientIdAllowed(list, A.toUpperCase())).toBe(true);
    expect(isMsiClientIdAllowed(list, B.toLowerCase())).toBe(true);
    expect(isMsiClientIdAllowed(list, "99999999-2222-3333-4444-555555555555")).toBe(false);
    expect(list.invalid).toEqual([]);
  });

  it("reports entries that are not client-id GUIDs, and they allow nothing", () => {
    const list = loadTeamsMsiAllowlist({ TEAMS_MSI_CLIENT_IDS: `${A},*,not-a-guid` });
    expect(list.invalid).toEqual(["*", "not-a-guid"]);
    expect(isMsiClientIdAllowed(list, "*")).toBe(false);
    expect(isMsiClientIdAllowed(list, "not-a-guid")).toBe(false);
    expect(isMsiClientIdAllowed(list, A)).toBe(true);
  });
});
