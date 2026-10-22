/**
 * #1385 — the signed client-address message is one definition shared by the UI
 * (signer) and the API (verifier). This pins its bytes: changing them is a
 * protocol change, and a UI and API on different versions would ignore every
 * signed address.
 */
import { describe, expect, it } from "vitest";
import { clientAddressSignedMessage } from "./constants.js";

describe("clientAddressSignedMessage", () => {
  it("is versioned, minute-bound and address-bound", () => {
    expect(clientAddressSignedMessage("203.0.113.7", 29_000_000)).toBe(
      "metis-client-address/v2\n29000000\n203.0.113.7",
    );
  });
});
