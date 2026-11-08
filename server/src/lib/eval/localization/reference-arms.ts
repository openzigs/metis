/**
 * #1933 — the `--reference` checks against the arms a run reports, shared by
 * the CLI's preflight and the runner. A module of their own: the runner reads
 * no CLI parsing (`cli-args.ts`), and the CLI and runner cannot drift apart.
 */

/**
 * #1819 — the `--reference` ids checked against the arms the run reports,
 * BEFORE the provider is built and the table guard runs: the runner checks them
 * too, but only after a corpus's arms have spent; #1925 — with this function,
 * so the two refusals cannot drift apart. `corpus` names the corpus whose
 * recorded arms `armIds` are, when a merge checks each apart.
 */
export function assertReferenceArms(
  references: readonly string[],
  armIds: readonly string[],
  corpus?: string,
): void {
  for (const ref of references) {
    if (ref === "A0") throw new Error("--reference A0: every arm is already compared with A0");
    if (!armIds.includes(ref)) {
      const whose = corpus === undefined ? "this run's arms" : `the arms ${corpus} recorded`;
      throw new Error(`--reference ${ref} is not one of ${whose} (${armIds.join(", ")})`);
    }
  }
}

/**
 * #1925 — a merge reports each corpus apart, and each report pairs with every
 * reference: a reference recorded in one corpus only would pass a check on the
 * union of their arms, then be refused by the runner after `--table-guard` spent.
 */
export function assertReferenceArmsInEachCorpus(
  references: readonly string[],
  armIdsByCorpus: ReadonlyMap<string, readonly string[]>,
): void {
  for (const [corpus, armIds] of armIdsByCorpus) assertReferenceArms(references, armIds, corpus);
}
