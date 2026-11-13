/**
 * #2451 — the key that names one ambiguity of a structured requirement:
 * `requirementId:fieldKey`. The clarification dialog records what was answered,
 * resolved or set aside under these keys, and every count of open questions
 * (the Questions tab, the Summary, Home, the checkpoint cards and the dialog's
 * own "remaining") is the ambiguities whose key is not among them.
 *
 * An ambiguity's `field` names the part of the requirement it is about, so one
 * requirement can carry several on the same field: in the reported run every
 * ambiguity was on `description`. Keyed on the field alone, answering one of
 * them credited all of them, and a question the model filed under a field name
 * of its own credited none. So the key is the field made unique within its
 * requirement: the first ambiguity on a field keeps the field as its key, which
 * every key stored before #2451 already is, and each later one on the same
 * field gets `#2`, `#3`, and so on, in the order the requirement lists them.
 *
 * The `#n` keys are positional, so a stored key names the same ambiguity only
 * while the requirement's ambiguities keep their order and length. The
 * clarification round rewrites a requirement's description, never its
 * ambiguities (pinned in server `clarify-duplicate-fields-2451.test.ts`). Any
 * new writer of a requirement's `ambiguities` must keep that, or re-key what
 * the dialog has stored.
 */

interface HasField {
  field: string;
}

/** The field keys of `ambiguities`, in order, each one different. */
export function ambiguityFieldKeys(ambiguities: readonly HasField[]): string[] {
  // A raw field that already reads like a numbered key (`a#2`) is never
  // handed to another ambiguity.
  const raw = new Set(ambiguities.map((a) => a.field));
  const used = new Set<string>();
  return ambiguities.map(({ field }) => {
    let key = field;
    for (let n = 2; used.has(key); n++) {
      key = `${field}#${n}`;
      if (raw.has(key) && key !== field) key = field;
    }
    used.add(key);
    return key;
  });
}

/** `requirementId:fieldKey` for each of the requirement's ambiguities, in order. */
export function ambiguityKeys(requirement: {
  id: string;
  ambiguities?: readonly HasField[] | null;
}): string[] {
  return ambiguityFieldKeys(requirement.ambiguities ?? []).map((k) => `${requirement.id}:${k}`);
}

/** How many ambiguities across `requirements` are not in `addressed`. */
export function openAmbiguityCount(
  requirements: readonly { id: string; ambiguities?: readonly HasField[] | null }[],
  addressed: ReadonlySet<string>,
): number {
  return requirements.reduce(
    (sum, r) => sum + ambiguityKeys(r).filter((k) => !addressed.has(k)).length,
    0,
  );
}
