/**
 * #2488 review — the admin page shows an unset flag by its registered default,
 * so the registry must name the default the readers apply (on).
 */
import { describe, expect, it } from "vitest";
import { getKeyDef } from "../../config/key-registry.js";
import { CHANGE_HISTORY_DEFAULT, CHANGE_HISTORY_FLAG } from "./history-repo.js";

describe("CHAT_CHANGE_HISTORY_TOOL registry default (#2488)", () => {
  it("registers the default the readers fall back to", () => {
    expect(getKeyDef(CHANGE_HISTORY_FLAG)?.default).toBe(String(CHANGE_HISTORY_DEFAULT));
  });
});
