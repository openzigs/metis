/**
 * #2156 — the in-memory stand-ins for the dialog store's compare-and-set
 * writers (`replaceDialogState`, `commitDialogState`), over a suite's own map.
 *
 * Six suites mock `clarification-dialog-store.js` wholesale and once carried a
 * verbatim copy of these two each; they now spread this into their `vi.mock`
 * factory so the copies cannot drift. The revision is the stored JSON, as
 * `readDialogStateRevision`'s fake in each suite returns it. The real store's
 * proof (Prisma, one transaction) is `clarification-dialog-store.test.ts` and
 * the SQLite suite `clarify-transaction-2142.sqlite.test.ts`; this is for
 * everything else.
 *
 * The map must exist when the factory runs, which is before the suite's
 * top-level code: declare it with `vi.hoisted`, and import this module inside
 * an async factory.
 */
import { vi } from "vitest";

export function dialogStoreCasFakes(store: Map<string, unknown>) {
  return {
    replaceDialogState: vi.fn(async (id: string, revision: string | undefined, state: unknown) => {
      // #2142 — no revision: created only while there is no row.
      const held = store.get(id);
      if (revision === undefined ? held !== undefined : JSON.stringify(held) !== revision) {
        return null;
      }
      store.set(id, structuredClone(state));
      return JSON.stringify(state);
    }),
    // #2142 — one transaction: `alongside` throwing rolls the state write back.
    commitDialogState: vi.fn(
      async (
        id: string,
        revision: string,
        state: unknown,
        alongside: (tx: unknown) => Promise<void>,
      ) => {
        const held = store.get(id);
        if (JSON.stringify(held) !== revision) return null;
        store.set(id, structuredClone(state));
        try {
          await alongside({});
        } catch (err) {
          store.set(id, held);
          throw err;
        }
        return JSON.stringify(state);
      },
    ),
  };
}
