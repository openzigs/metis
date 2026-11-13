/**
 * #2451 — file each generated clarifying question under the open ambiguity of
 * its requirement that it asks about, one question per ambiguity.
 *
 * A question's `requirementId:ambiguityField` is the key its answer is credited
 * under (`answeredAmbiguities`), and every count of open questions is the
 * ambiguities whose key has not been credited (`openAmbiguityCount`). The model
 * that writes the questions is told each ambiguity's key, but in the reported
 * run it filed them under field names of its own (`delivery_mechanism`), so no
 * answer was credited, the counts never fell and the next round asked the same
 * things again. It also wrote 13 questions for 12 ambiguities, so the dialog
 * and the Summary disagreed from the start.
 *
 * So the dialog does not trust the model's key. Per requirement, each pairing of
 * a question with an open ambiguity is scored: the exact key wins outright, a
 * bare field name the requirement uses more than once is a weak hint, and
 * otherwise the words the question shares with the ambiguity decide. A word
 * every open ambiguity of the requirement has (its own vocabulary: `reset`,
 * `link`) says nothing about which one a question is about, so it does not
 * count. Pairs are taken best first, each question and each ambiguity once.
 *
 * Recall-first (#1101): when that leaves exactly one question and exactly one
 * open ambiguity of a requirement unpaired, they are paired, since there is
 * nothing else either could be about. Otherwise a question left over (more
 * questions than open ambiguities, or one that names none and shares no word
 * with any while several are open) is not asked: filed by guesswork, its
 * answer could close the wrong ambiguity (the #1104 guard), and the count
 * would not fall. Its ambiguity stays open, and the dialog never shows a round
 * with nothing to answer while one is open (`fallbackQuestionsFor`).
 * A question about a requirement not in the list is left as it is.
 */
import { ambiguityFieldKeys } from "@metis/shared";
import type { Ambiguity } from "./types/requirements.js";

interface MatchableQuestion {
  requirementId: string;
  ambiguityField: string;
  question: string;
  context?: string;
}

/** Words too common in a requirement to say which ambiguity a question is about. */
const STOP_WORDS = new Set(
  (
    "the and for are but not you all any can had has her was one our out its use how what when " +
    "where which who why will with this that from they them then than there their these those " +
    "should would could does did into only also each other more most some such about after " +
    "before being been have just over under while whether unclear specified defined undefined " +
    "requirement mention mentioned clear"
  ).split(" "),
);

function words(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3 || STOP_WORDS.has(raw)) continue;
    // A plural and its singular are one word here.
    out.add(raw.length > 3 && raw.endsWith("s") ? raw.slice(0, -1) : raw);
  }
  return out;
}

function shared(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  let n = 0;
  for (const w of a) if (b.has(w)) n++;
  return n;
}

/** The exact key: chosen over any wording. */
const EXACT = 1_000_000;
/** The bare field of several ambiguities: preferred to a stranger, decided by wording. */
const SAME_FIELD = 1_000;

export function matchQuestionsToAmbiguities<Q extends MatchableQuestion>(
  questions: readonly Q[],
  requirements: readonly { id: string; ambiguities: readonly Ambiguity[] }[],
  addressed: ReadonlySet<string>,
): Q[] {
  const byId = new Map(requirements.map((r) => [r.id, r]));
  /** Question index → the field key it is filed under; `null` = left out. */
  const filed = new Map<number, string | null>();

  for (const requirement of requirements) {
    const asked = questions.flatMap((q, at) => (q.requirementId === requirement.id ? [at] : []));
    if (asked.length === 0) continue;
    const keys = ambiguityFieldKeys(requirement.ambiguities);
    const fieldUses = new Map<string, number>();
    for (const a of requirement.ambiguities) {
      fieldUses.set(a.field, (fieldUses.get(a.field) ?? 0) + 1);
    }
    const open = requirement.ambiguities.flatMap((a, i) =>
      addressed.has(`${requirement.id}:${keys[i]}`)
        ? []
        : [
            {
              key: keys[i]!,
              field: a.field,
              words: words([a.description, a.suggestedQuestion, a.term ?? ""].join(" ")),
            },
          ],
    );

    // A word every open sibling has is no evidence for any one of them.
    if (open.length > 1) {
      const common = [...open[0]!.words].filter((w) => open.every((o) => o.words.has(w)));
      for (const o of open) for (const w of common) o.words.delete(w);
    }

    const pairs: Array<{ question: number; ambiguity: number; score: number }> = [];
    for (const at of asked) {
      const q = questions[at]!;
      const field = q.ambiguityField.trim();
      const qWords = words([q.question, q.context ?? "", field.replace(/[_-]/g, " ")].join(" "));
      open.forEach((o, ambiguity) => {
        const exact = field === o.key && (o.key !== o.field || fieldUses.get(o.field) === 1);
        const score = exact
          ? EXACT
          : (field === o.field ? SAME_FIELD : 0) + shared(qWords, o.words);
        pairs.push({ question: at, ambiguity, score });
      });
    }
    pairs.sort((a, b) => b.score - a.score || a.question - b.question || a.ambiguity - b.ambiguity);

    const taken = new Set<number>();
    for (const p of pairs) {
      // A question that names no open ambiguity and shares no word with one
      // is not filed by guesswork: a set-aside or reused answer filed on the
      // wrong ambiguity would close it (the #1104 guard).
      if (p.score === 0) break;
      if (filed.has(p.question) || taken.has(p.ambiguity)) continue;
      filed.set(p.question, open[p.ambiguity]!.key);
      taken.add(p.ambiguity);
    }
    // Recall-first: one question and one ambiguity left can only be about each other.
    const unfiled = asked.filter((at) => !filed.has(at));
    const untaken = open.flatMap((o, i) => (taken.has(i) ? [] : [o]));
    if (unfiled.length === 1 && untaken.length === 1) filed.set(unfiled[0]!, untaken[0]!.key);
    for (const at of asked) if (!filed.has(at)) filed.set(at, null);
  }

  return questions.flatMap((q, at) => {
    if (!byId.has(q.requirementId)) return [q];
    const key = filed.get(at);
    if (key == null) return [];
    return [key === q.ambiguityField ? q : { ...q, ambiguityField: key }];
  });
}

/**
 * #2451 — a question for each open ambiguity, in its own words, filed under its
 * own key. The dialog asks these only when a round would otherwise have nothing
 * to answer while ambiguities are still open (every question the model raised
 * was dropped, set aside or answered before, or it raised none): a round with
 * no question showed "N remaining" and no box to answer in. Recall-first
 * (#1101): the analyst sees every open question rather than none.
 */
export function fallbackQuestionsFor(
  requirements: readonly { id: string; ambiguities: readonly Ambiguity[] }[],
  addressed: ReadonlySet<string>,
  newId: () => string,
): Array<{
  id: string;
  requirementId: string;
  ambiguityField: string;
  question: string;
  context: string;
}> {
  return requirements.flatMap((requirement) => {
    const keys = ambiguityFieldKeys(requirement.ambiguities);
    return requirement.ambiguities.flatMap((a, i) => {
      if (addressed.has(`${requirement.id}:${keys[i]}`)) return [];
      const description = (a.description ?? "").trim();
      const question =
        (a.suggestedQuestion ?? "").trim() ||
        (description ? `Can you clarify: ${description}` : "");
      if (!question) return [];
      return [
        {
          id: newId(),
          requirementId: requirement.id,
          ambiguityField: keys[i]!,
          question,
          context: description,
        },
      ];
    });
  });
}
