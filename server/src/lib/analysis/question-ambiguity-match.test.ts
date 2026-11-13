/**
 * #2451 — each generated clarifying question is filed under one open
 * ambiguity of its requirement, at most one question per ambiguity, so that
 * answering a question closes exactly the ambiguity it asked about.
 *
 * The fixture is the reported run's: every ambiguity on `description`, and a
 * model that filed its questions under field names of its own.
 */
import { describe, expect, it } from "vitest";
import { matchQuestionsToAmbiguities } from "./question-ambiguity-match.js";

const RESET = {
  id: "r-request",
  ambiguities: [
    {
      field: "description",
      description: "It is not specified how the reset link is delivered (email, in-app, SMS).",
      suggestedQuestion: "",
    },
    {
      field: "description",
      description:
        "The term 'customer' is not defined. It is unclear whether other user types (admins) are covered.",
      suggestedQuestion: "",
    },
    {
      field: "description",
      description: "No mention of rate limiting or the behaviour when many requests arrive.",
      suggestedQuestion: "",
    },
    {
      field: "description",
      description: "The flow after the link is clicked (password entry, complexity) is undefined.",
      suggestedQuestion: "",
    },
  ],
};

const q = (requirementId: string, ambiguityField: string, question: string) => ({
  id: `${ambiguityField}-${question.length}`,
  requirementId,
  ambiguityField,
  question,
  context: "",
});

describe("matchQuestionsToAmbiguities (#2451)", () => {
  it("files questions under invented field names on the ambiguity they ask about", () => {
    const questions = [
      q("r-request", "delivery_mechanism", "How is the password reset link delivered: email?"),
      q("r-request", "email_validation", "What happens on a malformed address in the form?"),
      q("r-request", "user_scope", "Which user types are eligible, including admins?"),
      q("r-request", "rate_limiting", "Should there be rate limiting on repeated requests?"),
      q("r-request", "post_link_flow", "What is the flow after the link is clicked?"),
    ];
    const matched = matchQuestionsToAmbiguities(questions, [RESET], new Set());
    expect(matched.map((m) => [m.question.slice(0, 20), m.ambiguityField])).toEqual([
      ["How is the password ", "description"],
      ["Which user types are", "description#2"],
      ["Should there be rate", "description#3"],
      ["What is the flow aft", "description#4"],
    ]);
  });

  it("asks one question per ambiguity: a surplus question is left out", () => {
    const questions = [
      q("r-request", "description", "How is the reset link delivered?"),
      q("r-request", "description", "Is the reset link delivered by email or SMS?"),
    ];
    const one = { ...RESET, ambiguities: RESET.ambiguities.slice(0, 1) };
    expect(matchQuestionsToAmbiguities(questions, [one], new Set())).toHaveLength(1);
  });

  it("takes a key echoed exactly, whatever the wording", () => {
    const questions = [
      q("r-request", "description#3", "Anything else?"),
      q("r-request", "description#2", "Something?"),
    ];
    const matched = matchQuestionsToAmbiguities(questions, [RESET], new Set());
    expect(matched.map((m) => m.ambiguityField)).toEqual(["description#3", "description#2"]);
  });

  it("reads a bare duplicated field as no more than a hint, and goes by the wording", () => {
    // Round 2 of the live run: every question filed under plain `description`.
    const questions = [
      q("r-request", "description", "Should there be rate limiting per address?"),
      q("r-request", "description", "Is the reset link delivered by email only?"),
    ];
    const matched = matchQuestionsToAmbiguities(questions, [RESET], new Set());
    expect(matched.map((m) => m.ambiguityField)).toEqual(["description#3", "description"]);
  });

  it("never asks again about an ambiguity already addressed", () => {
    const questions = [
      q("r-request", "delivery", "Is the reset link delivered by email only?"),
      q("r-request", "rate", "Should there be rate limiting per address?"),
    ];
    const matched = matchQuestionsToAmbiguities(
      questions,
      [RESET],
      new Set(["r-request:description", "r-request:description#2", "r-request:description#4"]),
    );
    expect(matched.map((m) => [m.question.slice(0, 11), m.ambiguityField])).toEqual([
      ["Should ther", "description#3"],
    ]);
  });

  it("does not file by guesswork a question that names no ambiguity and shares no word", () => {
    const two = {
      id: "r1",
      ambiguities: [
        { field: "scope", description: "Scope unclear.", suggestedQuestion: "" },
        { field: "owner", description: "Approver unnamed.", suggestedQuestion: "" },
      ],
    };
    expect(matchQuestionsToAmbiguities([q("r1", "zzz", "Who?")], [two], new Set())).toEqual([]);
    // One shared word is enough.
    const matched = matchQuestionsToAmbiguities([q("r1", "zzz", "Whose scope?")], [two], new Set());
    expect(matched.map((m) => m.ambiguityField)).toEqual(["scope"]);
  });

  it("pairs the one leftover question with the one leftover open ambiguity (recall-first, #1101)", () => {
    // A paraphrase under an invented field that shares no content word.
    const one = {
      id: "r1",
      ambiguities: [
        {
          field: "description",
          description: "Delivery mechanism of the reset link is not specified.",
          suggestedQuestion: "",
        },
      ],
    };
    const matched = matchQuestionsToAmbiguities(
      [q("r1", "zzz", "Which channel sends it?")],
      [one],
      new Set(),
    );
    expect(matched.map((m) => m.ambiguityField)).toEqual(["description"]);
  });

  it("pairs the leftover after the greedy pass, when exactly one of each is left", () => {
    const two = {
      id: "r1",
      ambiguities: [
        { field: "scope", description: "Scope of the export is unclear.", suggestedQuestion: "" },
        { field: "owner", description: "Nobody named approves it.", suggestedQuestion: "" },
      ],
    };
    const matched = matchQuestionsToAmbiguities(
      [q("r1", "a", "What does the export scope cover?"), q("r1", "b", "Who signs off?")],
      [two],
      new Set(),
    );
    expect(matched.map((m) => m.ambiguityField)).toEqual(["scope", "owner"]);
  });

  it("still files nothing by guesswork when two questions share no word with two ambiguities", () => {
    const two = {
      id: "r1",
      ambiguities: [
        { field: "scope", description: "Scope unclear.", suggestedQuestion: "" },
        { field: "owner", description: "Approver unnamed.", suggestedQuestion: "" },
      ],
    };
    expect(
      matchQuestionsToAmbiguities([q("r1", "a", "Who?"), q("r1", "b", "When?")], [two], new Set()),
    ).toEqual([]);
  });

  it("ignores the words every open sibling ambiguity shares when choosing between them", () => {
    // `reset`, `link` and `password` are in both: they say nothing about which
    // one a question is about. Counted, they made the generic question outrank
    // the specific one and take the expiry ambiguity, so answering it closed
    // the wrong one and the expiry question came back (#2451's symptom).
    const siblings = {
      id: "r1",
      ambiguities: [
        {
          field: "description",
          description: "The password reset link expiry window is not given.",
          suggestedQuestion: "",
        },
        {
          field: "description",
          description: "Whether a password reset link email goes to secondary addresses.",
          suggestedQuestion: "",
        },
      ],
    };
    const matched = matchQuestionsToAmbiguities(
      [
        q("r1", "x", "Is the password reset link needed at all?"),
        q("r1", "y", "What expiry applies?"),
      ],
      [siblings],
      new Set(),
    );
    expect(matched.map((m) => [m.question.slice(0, 7), m.ambiguityField])).toEqual([
      ["Is the ", "description#2"],
      ["What ex", "description"],
    ]);
  });

  it("leaves a question about an unknown requirement as it was", () => {
    const stray = q("not-listed", "whatever", "Who decides?");
    expect(matchQuestionsToAmbiguities([stray], [RESET], new Set())).toEqual([stray]);
  });

  it("keeps the order the questions were generated in", () => {
    const other = {
      id: "r2",
      ambiguities: [{ field: "scope", description: "Scope unclear.", suggestedQuestion: "" }],
    };
    const questions = [
      q("r2", "scope", "What is the scope?"),
      q("r-request", "description#4", "What happens after the click?"),
    ];
    const matched = matchQuestionsToAmbiguities(questions, [RESET, other], new Set());
    expect(matched.map((m) => m.requirementId)).toEqual(["r2", "r-request"]);
  });
});
