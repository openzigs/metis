/**
 * #778 — condensed module digests for a single-call section whose relevant
 * facts exceed the provider's `factsCharCap`.
 *
 * Before this, such a section read the top-ranked modules in full and dropped
 * the rest to a name-only catalog: Miniflux's architecture doc wrote every
 * section from 3–14 of 103 modules. Raising the cap would multiply the Phase-2
 * and judge cost of every section (docs generation was already 80% of the
 * walkthrough's spend), so the budget is kept and SPENT differently: the
 * highest-ranked modules keep their full entry, and a reserved share of the
 * cap holds a digest of every other module — its slice headings and leading
 * bullets, sampled round-robin across the slices the section reads.
 *
 * Deterministic and model-free: a digest costs no tokens to produce, and the
 * section's facts input stays within the same cap.
 *
 * Pure: no I/O.
 */

/**
 * Most of the cap a section may reserve for digests. The rest keeps the
 * highest-ranked modules in full, which is where a section's depth comes from.
 */
export const DIGEST_SHARE = 0.4;

/** Digest size the reserve is planned around, per module that did not fit. */
export const TARGET_DIGEST_CHARS = 800;

/**
 * Smallest digest worth sending: a header and roughly two bullets. Below this
 * a module is omitted (and reported) rather than sent as a bare name.
 */
export const MIN_DIGEST_CHARS = 200;

/** Largest digest; a module that needs more is better read in full. */
export const MAX_DIGEST_CHARS = 2_000;

/** Room below which a truncated line is not worth adding. */
const MIN_TRUNCATED_LINE = 40;

/** Cut `text` to at most `max` characters at a word boundary, marking the cut. */
export function truncateAtWord(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max < 2) return "…".slice(0, Math.max(0, max));
  let cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  if (space > max / 2) cut = cut.slice(0, space);
  return `${cut.trimEnd()}…`;
}

/**
 * Plan how a section's cap is split between full entries and digests.
 * `leftover` is the number of modules that would not fit in full at the whole
 * cap. The reserve is no larger than those modules need at
 * {@link TARGET_DIGEST_CHARS}, so a section that only just overflows keeps
 * nearly all of its full entries.
 */
export function digestReserveChars(cap: number, leftover: number): number {
  if (leftover <= 0) return 0;
  return Math.min(Math.floor(cap * DIGEST_SHARE), leftover * TARGET_DIGEST_CHARS);
}

/**
 * The per-module digest budget for the next of `remaining` modules sharing
 * `left` characters: a fair share, clamped to the digest bounds and never more
 * than what is left. A result below {@link MIN_DIGEST_CHARS} means the module
 * cannot be read at all.
 */
export function digestBudget(left: number, remaining: number): number {
  const fair = Math.floor(left / Math.max(1, remaining));
  return Math.min(left, Math.max(MIN_DIGEST_CHARS, Math.min(MAX_DIGEST_CHARS, fair)));
}

/**
 * Condense one module's entry to at most `budget` characters.
 *
 * `header` is the module's (digest) header; `body` is its rendered slices, in
 * order. Lines are taken round-robin — every slice's heading and first item,
 * then every slice's next line, and so on — so the digest samples each topic
 * the section reads rather than exhausting the first. In the first round a
 * slice's opening is cut to a fair share of the room so one long summary line
 * cannot starve the others. The kept lines are emitted in their original order.
 */
export function condenseFactsEntry(
  header: string,
  body: readonly string[],
  budget: number,
): string {
  const queues = body
    .map((text) =>
      text
        .split("\n")
        .map((l) => l.trimEnd())
        .filter((l) => l.trim().length > 0),
    )
    .filter((q) => q.length > 0);
  if (queues.length === 0 || header.length >= budget) return header.slice(0, budget);

  const chosen: string[][] = queues.map(() => []);
  const cursor = queues.map(() => 0);
  const open = queues.map(() => true);
  let used = header.length;

  // Round 0: each slice's opening (its heading and first item), at a fair share.
  const share = Math.floor((budget - used) / queues.length);
  queues.forEach((q, i) => {
    const opening = q.slice(0, 2).join("\n");
    const room = Math.min(share, budget - used) - 2;
    if (room < MIN_TRUNCATED_LINE && opening.length > room) {
      open[i] = false;
      return;
    }
    const unit = truncateAtWord(opening, room);
    chosen[i].push(unit);
    used += 2 + unit.length;
    cursor[i] = 2;
    if (unit !== opening) open[i] = false;
  });

  // Later rounds: one whole line per slice per round, while it fits.
  let progressed = true;
  while (progressed) {
    progressed = false;
    queues.forEach((q, i) => {
      if (!open[i] || cursor[i] >= q.length) return;
      const line = q[cursor[i]];
      const cost = (chosen[i].length > 0 ? 1 : 2) + line.length;
      if (used + cost > budget) {
        open[i] = false;
        return;
      }
      chosen[i].push(line);
      used += cost;
      cursor[i] += 1;
      progressed = true;
    });
  }

  const parts = chosen.filter((c) => c.length > 0).map((c) => c.join("\n"));
  return parts.length > 0 ? `${header}\n\n${parts.join("\n\n")}` : header;
}
