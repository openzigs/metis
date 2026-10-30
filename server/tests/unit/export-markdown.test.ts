/**
 * #1571 — the footnote and formula handling the PDF and Word exporters share.
 * The formulas below are taken from the run-10 walkthrough's BRD.
 */
import { describe, expect, it } from "vitest";
import {
  extractFootnotes,
  extractInlineMath,
  FOOTNOTE_REF_CLOSE,
  FOOTNOTE_REF_OPEN,
  latexToText,
} from "../../src/lib/docs-gen/export-markdown.js";

const ref = (n: number) => `${FOOTNOTE_REF_OPEN}${n}${FOOTNOTE_REF_CLOSE}`;

describe("extractFootnotes", () => {
  it("numbers references by first use, takes the definitions out, and keeps their text", () => {
    const md = [
      "Alpha[^src-7] and beta[^src-2], alpha again[^src-7].",
      "",
      "[^src-2]: `internal/ui` (module facts)",
      "[^src-7]: `api.html` (retrieved excerpt)",
    ].join("\n");
    const { body, notes } = extractFootnotes(md);
    expect(body).toBe(`Alpha${ref(1)} and beta${ref(2)}, alpha again${ref(1)}.\n`);
    expect(notes).toEqual([
      { number: 1, text: "`api.html` (retrieved excerpt)" },
      { number: 2, text: "`internal/ui` (module facts)" },
    ]);
  });

  it("leaves a reference with no definition as written, and drops an unreferenced definition", () => {
    const { body, notes } = extractFootnotes("A[^nope] b[^a].\n\n[^a]: one\n[^b]: two");
    expect(body).toBe(`A[^nope] b${ref(1)}.\n`);
    expect(notes).toEqual([{ number: 1, text: "one" }]);
  });

  it("keeps the first of two definitions of one label", () => {
    const { notes } = extractFootnotes("x[^a]\n\n[^a]: first\n[^a]: second");
    expect(notes).toEqual([{ number: 1, text: "first" }]);
  });

  it("does not touch fenced code or inline code spans", () => {
    const md = [
      "Regex `[^a]` and ``x [^a] y`` stay; prose[^a] does not.",
      "```",
      "[^a]: inside a fence",
      "match[^a]",
      "```",
      "~~~~",
      "[^a] in a tilde fence ```",
      "~~~~",
      "[^a]: the definition",
    ].join("\n");
    const { body, notes } = extractFootnotes(md);
    expect(body.split("\n")).toEqual([
      `Regex \`[^a]\` and \`\`x [^a] y\`\` stay; prose${ref(1)} does not.`,
      "```",
      "[^a]: inside a fence",
      "match[^a]",
      "```",
      "~~~~",
      "[^a] in a tilde fence ```",
      "~~~~",
    ]);
    expect(notes).toEqual([{ number: 1, text: "the definition" }]);
  });

  it("returns markdown without definitions unchanged", () => {
    const md = "No notes [^here].";
    expect(extractFootnotes(md)).toEqual({ body: md, notes: [] });
  });

  it("closes a code span only on a backtick run of its own length", () => {
    const { body } = extractFootnotes("``a```b[^a]`` c[^a]\n\n[^a]: n");
    expect(body).toBe(`\`\`a\`\`\`b[^a]\`\` c${ref(1)}\n`);
    // "``" never closes on the first two of "```", so no span opens at "` [^a] `".
    expect(extractFootnotes("``a``` [^a] `z`\n\n[^a]: n").body).toBe(
      `\`\`a\`\`\` ${ref(1)} \`z\`\n`,
    );
  });

  it("does not run an unterminated code span into the rest of the line", () => {
    const { body } = extractFootnotes("a ` b[^a]\n\n[^a]: n");
    expect(body).toBe(`a \` b${ref(1)}\n`);
  });
});

describe("extractInlineMath", () => {
  const formulas = (md: string) => extractInlineMath(md).formulas;

  it("takes inline formulas out whole, backslashes and all", () => {
    const { body, formulas: found } = extractInlineMath(
      String.raw`Count $\text{feed\_count}(c)$ for $score_{final} = s$.`,
    );
    expect(found).toEqual([String.raw`\text{feed\_count}(c)`, "score_{final} = s"]);
    expect(body).toBe("Count 0 for 1.");
  });

  it("takes formulas in LaTeX's own \\(…\\) delimiters too", () => {
    expect(
      formulas(
        String.raw`Shown when \(\text{total} - \text{offset} > n\), and \(n\) is the count.`,
      ),
    ).toEqual([String.raw`\text{total} - \text{offset} > n`, "n"]);
  });

  it("takes a formula that ends in an escaped brace", () => {
    expect(formulas(String.raw`Unread: $\#\{e : e.user = u\}$.`)).toEqual([
      String.raw`\#\{e : e.user = u\}`,
    ]);
  });

  it.each([
    ["prices", "It costs $5 and $10 a month."],
    ["a price range", "Seats cost $5-$10 each."],
    ["a lone dollar", "The builder emits e.status = ANY($n) with values bound."],
    ["escaped dollars", String.raw`From \$5 to \$10.`],
    ["a space inside the opener", "a $ x$ b"],
    ["a space before the closer", "a $x $ b"],
    ["a code span", "Regex `^[a-z]{2,}$` and `$x$`."],
    ["a price before a code span", "From $10. Code: `$x$`."],
    ["display math", "$$x^2$$"],
  ])("leaves %s alone", (_name, md) => {
    expect(formulas(md)).toEqual([]);
  });

  it("does not look inside fenced code", () => {
    expect(formulas("```\n$x$\n```\n$y$")).toEqual(["y"]);
  });
});

describe("latexToText", () => {
  it.each([
    [String.raw`\text{now} + \text{interval}`, "now + interval"],
    [
      String.raw`score_{final} = score \times (1 - linkDensity)`,
      "score_final = score × (1 - linkDensity)",
    ],
    [String.raw`\text{username}_{\text{stored}}`, "username_stored"],
    [String.raw`x^{n+1} + y^2`, "x^(n+1) + y^2"],
    [
      String.raw`\text{interval} = \frac{7 \times 24\,\text{h}}{\text{weeklyCount} \times \text{factor}}`,
      "interval = (7 × 24 h) / (weeklyCount × factor)",
    ],
    [
      String.raw`\text{halfWidth} = \frac{\text{window.innerWidth}}{2}`,
      "halfWidth = window.innerWidth / 2",
    ],
    [
      String.raw`tx = \left(\sqrt{abs - 75} + 75\right) \times \operatorname{sign}(distance)`,
      "tx = (√(abs - 75) + 75) × sign(distance)",
    ],
    [
      String.raw`\text{rank} = ts\_rank(v,\ q(\$N)) - \big(epoch(now) \times 0.1\big)`,
      "rank = ts_rank(v, q($N)) - (epoch(now) × 0.1)",
    ],
    [
      String.raw`\#\{e : e.status = \text{unread} \land \neg f.hide\_globally\}`,
      "#{e : e.status = unread ∧ ¬ f.hide_globally}",
    ],
    [
      String.raw`L(z) = \begin{cases} \text{time.LoadLocation}(z) & \text{if no error} \\ \text{time.Local} & \text{otherwise} \end{cases}`,
      "L(z) = { time.LoadLocation(z), if no error; time.Local, otherwise }",
    ],
    [String.raw`\min(\max(p, -2), 2) \le \infty`, "min(max(p, -2), 2) ≤ ∞"],
    [String.raw`\begin{aligned} a &= b \\ c &= d \end{aligned}`, "a = b; c = d"],
    [String.raw`a \\`, "a"],
    [String.raw`\alpha\!\beta \quad \unknown{x}`, "αβ unknownx"],
    ["\\frac12", "1 / 2"],
    [String.raw`\frac{(a) + (b)}{(c + d)}`, "((a) + (b)) / (c + d)"],
    ["x^", "x^"],
    ["\\", ""],
    ["a } b", "a b"],
    ["\\mathbb R~x", "R x"],
  ])("%s", (latex, text) => {
    expect(latexToText(latex)).toBe(text);
  });
});
