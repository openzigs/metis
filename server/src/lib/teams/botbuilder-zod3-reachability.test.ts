/**
 * #1453 — evidence behind the scoped `GHSA-mrhx-c7xc-m3w5` waiver in
 * `.github/workflows/sast.yml`.
 *
 * zod < 4.6.6 can exhaust memory validating an oversized collection: the parser
 * accumulates one issue per failing element. The zod 4 line in this tree is
 * upgraded; botbuilder 4.23.3 still resolves zod@3.25.76 (no patched 3.x exists,
 * and botbuilder fails to import on zod 4). The waiver rests on one claim: an
 * unauthenticated caller of `POST /api/integrations/teams/messages` cannot drive
 * that per-element issue growth, because before Bot Framework JWT validation
 * `CloudAdapter.process` only runs `z.record(z.unknown())` over `req.body` and
 * `z.string()` over the Authorization header.
 *
 * These arms pin that claim to the installed code, so a botbuilder bump that
 * changes either the zod copy or the pre-auth validation fails here first.
 */
import { createRequire } from "node:module";

import { CloudAdapter } from "botbuilder";
import { describe, expect, it, vi } from "vitest";

import { buildCloudAdapter } from "./bot-adapter.js";

const requireFromBotbuilder = createRequire(createRequire(import.meta.url).resolve("botbuilder"));

/** The exact zod copy botbuilder loads at runtime — not the one server/ declares. */
const botbuilderZodVersion = (requireFromBotbuilder("zod/package.json") as { version: string })
  .version;
const bz = requireFromBotbuilder("zod") as typeof import("zod");

const CREDS = {
  appId: "11111111-2222-3333-4444-555555555555",
  appPassword: "bot-password",
  appType: "MultiTenant",
  tenantId: null,
};

/** An attacker-sized collection: well past what a 10 MiB JSON body can carry in elements. */
const ELEMENTS = 200_000;

describe("botbuilder's zod@3 is not reachable with per-element issues before auth (#1453)", () => {
  it("botbuilder still resolves the zod copy the sast.yml waiver is scoped to", () => {
    // If this moves, the waiver's `packages` scope is stale: re-check the advisory and
    // delete the waiver when botbuilder is on a patched zod.
    expect(botbuilderZodVersion).toBe("3.25.76");
  });

  it("the pre-auth body schema yields one issue, not one per element, for an oversized array", () => {
    const body = Array.from({ length: ELEMENTS }, (_, i) => i);
    const result = bz.record(bz.unknown()).safeParse(body);
    expect(result.success).toBe(false);
    expect(result.error?.issues).toHaveLength(1);
  });

  it("the pre-auth body schema accepts an object with an oversized collection without issues", () => {
    const body = {
      type: "message",
      entities: Array.from({ length: ELEMENTS }, () => ({ type: 1 })),
      attachments: Array.from({ length: ELEMENTS }, () => "not-an-attachment"),
    };
    expect(bz.record(bz.unknown()).safeParse(body).success).toBe(true);
  });

  it("control: a schema that validates elements does accumulate one issue per element", () => {
    // The vulnerable shape, on the same zod copy. Without this arm the two above could
    // pass on a zod that never accumulated per-element issues at all.
    const perElement = bz.array(bz.string()).safeParse(Array.from({ length: 1000 }, () => 1));
    expect(perElement.error?.issues).toHaveLength(1000);
  });

  it("a real CloudAdapter rejects an unsigned oversized activity with 401 before running the turn", async () => {
    const adapter = buildCloudAdapter(CREDS);
    expect(adapter).toBeInstanceOf(CloudAdapter);

    let status = 0;
    const res = {
      status: (code: number) => {
        status = code;
      },
      send: () => undefined,
      end: () => undefined,
      header: () => undefined,
    };
    const req = {
      method: "POST",
      headers: {},
      body: {
        type: "message",
        channelId: "msteams",
        serviceUrl: "https://smba.trafficmanager.net/emea/",
        conversation: { id: "c" },
        from: { id: "u" },
        recipient: { id: "b" },
        entities: Array.from({ length: ELEMENTS }, () => ({ type: 1 })),
      },
    };
    let turnRan = false;
    // botbuilder console.errors the AuthenticationError it maps to 401; keep it quiet.
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await adapter.process(req as never, res as never, async () => {
      turnRan = true;
    });
    quiet.mockRestore();
    expect(status).toBe(401);
    expect(turnRan).toBe(false);
  });
});
