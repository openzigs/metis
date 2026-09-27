/**
 * COBOL business rule miner (#160).
 *
 * Legacy COBOL keeps its business rules in a few structural shapes that an
 * LLM skims past in a dense source dump. This miner surfaces them
 * deterministically for Phase 1 of docs generation:
 *
 *   1. `IF <condition>` — every branch condition, whatever its line layout.
 *      One whose first statement leaves (`GO TO`, `GOBACK`, `STOP RUN`,
 *      `EXIT PROGRAM`) is a guard; one that tests a class (`NUMERIC`,
 *      `ALPHABETIC`) or a file status is a validation.
 *   2. `EVALUATE <subject> WHEN ...` — state dispatch on a value, one rule with
 *      every WHEN label; `EVALUATE TRUE` contributes each WHEN condition as a
 *      branch of its own.
 *   3. `COMPUTE <target> [ROUNDED] = <expression>` — calculation formulas.
 *   4. Level-88 condition names — `88 VIP-CUSTOMER VALUE 'V' 'P'.` names a
 *      business state of its parent data item.
 *
 * Multi-line constructs (#170): conditions, WHEN arms, COMPUTE expressions
 * and 88-level value lists are read from the token stream, not line by line,
 * so a condition split across lines is one rule anchored at its first line.
 * A read stops at the next statement verb, scope terminator or period — and
 * every construct the miner starts reading at is itself a statement verb — so
 * reads never overlap and mining a file touches each token a bounded number
 * of times (O(N)). A read is also capped at {@link MAX_CONTINUATION_LINES}
 * lines and {@link MAX_LOGICAL_CHARS} characters, as the other miners' joiner
 * is; a construct cut by the cap keeps what was read, marked with `…`.
 * No regular expression runs over source text (ReDoS-free by construction).
 */
import { MAX_CONTINUATION_LINES, MAX_LOGICAL_CHARS } from "./rule-miner-continuation.js";
import { isStatementBoundary, lexCobol, renderTokens, type CobolToken } from "./cobol-source.js";

export interface MinedCblRule {
  kind:
    | "guard"
    | "validation"
    | "condition"
    | "evaluate"
    | "when-condition"
    | "compute"
    | "condition-name";
  /** The construct as written (tokens re-joined on one line, sequence areas dropped). */
  expression: string;
  /** Human-readable summary of what the rule enforces. */
  summary: string;
  /** Source file path (relative). */
  filePath: string;
  /** 1-based line where the construct starts. */
  line: number;
  /** Containing paragraph/program qualified name when known. */
  context: string | null;
}

const MAX_EXPR = 200;
const MAX_RULES = 400;

/** Statements whose first appearance in an IF body makes the IF a guard. */
const EXIT_VERBS = new Set(["GOBACK", "STOP", "EXIT", "GO"]);
/** Class conditions — record/field validation. */
const CLASS_TESTS = new Set([
  "NUMERIC",
  "ALPHABETIC",
  "ALPHABETIC-LOWER",
  "ALPHABETIC-UPPER",
  "DBCS",
  "KANJI",
]);

function truncate(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
}

interface Read {
  tokens: CobolToken[];
  /** Index of the token the read stopped at (not consumed). */
  end: number;
  /** True when the cap cut the construct short. */
  capped: boolean;
}

/**
 * Tokens from `from` up to (not including) the first token for which `stop`
 * holds, within the line/character cap measured from `anchorLine`.
 */
function readUntil(
  tokens: readonly CobolToken[],
  from: number,
  anchorLine: number,
  stop: (t: CobolToken) => boolean,
): Read {
  const out: CobolToken[] = [];
  let chars = 0;
  let k = from;
  for (; k < tokens.length; k++) {
    const t = tokens[k];
    if (stop(t)) return { tokens: out, end: k, capped: false };
    chars += t.text.length + 1;
    if (t.line - anchorLine >= MAX_CONTINUATION_LINES || chars > MAX_LOGICAL_CHARS) {
      return { tokens: out, end: k, capped: true };
    }
    out.push(t);
  }
  return { tokens: out, end: k, capped: false };
}

const text = (r: Read): string => `${renderTokens(r.tokens)}${r.capped ? " …" : ""}`;

/** `WS-STATUS`, `CUST-FILE-STATUS`, `WS-FS` — a file-status field by naming convention. */
function isStatusField(t: CobolToken): boolean {
  return t.kind === "word" && (t.upper.endsWith("STATUS") || t.upper.endsWith("-FS"));
}

interface EvaluateFrame {
  subject: string | null;
  labels: string[];
  line: number;
  expression: string;
}

/**
 * Mine COBOL business rules from a source slice.
 *
 * @param source   Raw source text (a whole file, a paragraph, or any slice).
 * @param filePath Relative path — stored on each rule for traceability.
 * @param baseLine 1-based line number that source[0] corresponds to.
 * @param context  Optional symbol qualified name.
 * @param maxRules Most rules returned (default {@link MAX_RULES}). Docs-gen
 *                 Phase 1 passes `Infinity`: it must not lose any rule.
 */
export function mineCblRules(
  source: string,
  filePath: string,
  baseLine: number,
  context: string | null = null,
  maxRules: number = MAX_RULES,
): MinedCblRule[] {
  return mineCblTokens(lexCobol(source).tokens, filePath, baseLine, context, maxRules);
}

/**
 * {@link mineCblRules} over an already-tokenised source. Exported so the
 * linear-time bound can be asserted by counting token reads.
 */
export function mineCblTokens(
  tokens: readonly CobolToken[],
  filePath: string,
  baseLine: number,
  context: string | null = null,
  maxRules: number = MAX_RULES,
): MinedCblRule[] {
  const rules: MinedCblRule[] = [];
  const push = (kind: MinedCblRule["kind"], expression: string, summary: string, line: number) => {
    rules.push({
      kind,
      expression: truncate(expression, MAX_EXPR),
      summary,
      filePath,
      line: baseLine + line,
      context,
    });
  };

  const evaluates: EvaluateFrame[] = [];
  const closeEvaluate = (): void => {
    const f = evaluates.pop();
    if (!f || f.subject === null || f.labels.length === 0) return;
    push(
      "evaluate",
      `${f.expression} WHEN ${f.labels.join("; ")}`,
      `State dispatch on \`${truncate(f.subject, 100)}\` with ${f.labels.length} branches: ${f.labels.slice(0, 8).join(", ")}${f.labels.length > 8 ? ", ..." : ""}`,
      f.line,
    );
  };
  // The data item an 88-level condition name belongs to.
  let parentItem: string | null = null;

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];

    // A period ends every open scope.
    if (t.kind === "period") {
      while (evaluates.length > 0) closeEvaluate();
      continue;
    }

    // ---- data items: track the parent, mine level-88 condition names ----
    if (t.kind === "number" && t.first && tokens[i + 1]?.kind === "word") {
      const level = Number(t.text);
      const name = tokens[i + 1];
      if (level === 88) {
        let j = i + 2;
        if (tokens[j]?.upper === "VALUE" || tokens[j]?.upper === "VALUES") j++;
        if (tokens[j]?.upper === "IS" || tokens[j]?.upper === "ARE") j++;
        // Values run to the period (or the next level number on a new line).
        const values = readUntil(
          tokens,
          j,
          t.line,
          (v) => v.kind === "period" || (v.first && v.kind === "number"),
        );
        const vals = text(values);
        if (vals.length > 0) {
          push(
            "condition-name",
            `88 ${name.text} VALUE ${vals}`,
            `\`${name.upper}\`${parentItem ? ` (of \`${parentItem}\`)` : ""} holds when the value is ${truncate(vals, 140)}`,
            t.line,
          );
        }
        i = values.end - 1;
        continue;
      }
      if ((level >= 1 && level <= 49) || level === 66 || level === 77) {
        parentItem = name.upper === "FILLER" ? parentItem : name.upper;
      }
      continue;
    }

    if (t.kind !== "word") continue;

    // ---- IF <condition> ----
    if (t.upper === "IF") {
      const cond = readUntil(
        tokens,
        i + 1,
        t.line,
        (c) => c.upper === "THEN" || isStatementBoundary(c),
      );
      if (cond.tokens.length === 0) continue;
      let k = cond.end;
      if (tokens[k]?.upper === "THEN") k++;
      const body = tokens[k];
      const condText = text(cond);
      const expression = `IF ${condText}`;
      if (body && body.kind === "word" && EXIT_VERBS.has(body.upper)) {
        const target =
          body.upper === "GO"
            ? tokens[k + 1]?.upper === "TO"
              ? tokens[k + 2]
              : tokens[k + 1]
            : undefined;
        const exit = target ? `transfers control to ${target.upper}` : "exits";
        push("guard", expression, `Rejects/${exit} when ${truncate(condText, 140)}`, t.line);
      } else if (cond.tokens.some((c) => CLASS_TESTS.has(c.upper) || isStatusField(c))) {
        push("validation", expression, `Validates ${truncate(condText, 140)}`, t.line);
      } else {
        push("condition", expression, `Branches when ${truncate(condText, 140)}`, t.line);
      }
      // Resume at the terminator: the statements in the body are mined too.
      i = cond.end - 1;
      continue;
    }

    // ---- EVALUATE <subject> ----
    if (t.upper === "EVALUATE") {
      const subj = readUntil(tokens, i + 1, t.line, (c) => isStatementBoundary(c));
      const subjText = text(subj);
      const bare = subj.tokens.every((c) => c.upper === "TRUE" || c.upper === "ALSO");
      evaluates.push({
        subject: bare || subjText.length === 0 ? null : subjText,
        labels: [],
        line: t.line,
        expression: `EVALUATE ${subjText}`,
      });
      i = subj.end - 1;
      continue;
    }
    if (t.upper === "END-EVALUATE") {
      closeEvaluate();
      continue;
    }

    // ---- WHEN <label | condition> ----
    if (t.upper === "WHEN") {
      const frame = evaluates[evaluates.length - 1];
      const arm = readUntil(
        tokens,
        i + 1,
        t.line,
        (c) => c.upper === "THEN" || isStatementBoundary(c),
      );
      const armText = text(arm);
      if (frame && armText.length > 0 && arm.tokens[0].upper !== "OTHER") {
        if (frame.subject !== null) {
          frame.labels.push(armText);
        } else {
          push(
            "when-condition",
            `WHEN ${armText}`,
            `Branches when ${truncate(armText, 140)}`,
            t.line,
          );
        }
      }
      i = arm.end - 1;
      continue;
    }

    // ---- COMPUTE <target> [ROUNDED] = <expression> ----
    if (t.upper === "COMPUTE") {
      const stmt = readUntil(
        tokens,
        i + 1,
        t.line,
        (c) =>
          isStatementBoundary(c) ||
          (c.kind === "word" && (c.upper === "ON" || c.upper === "SIZE" || c.upper === "NOT")),
      );
      const eq = stmt.tokens.findIndex((c) => c.text === "=" || c.upper === "EQUAL");
      if (eq > 0 && eq < stmt.tokens.length - 1) {
        const targets = stmt.tokens.slice(0, eq);
        const rounded = targets.some((c) => c.upper === "ROUNDED");
        const target = renderTokens(targets.filter((c) => c.upper !== "ROUNDED"));
        const formula = `${renderTokens(stmt.tokens.slice(eq + 1))}${stmt.capped ? " …" : ""}`;
        push(
          "compute",
          `COMPUTE ${text(stmt)}`,
          `Calculates ${truncate(target, 60)} = ${truncate(formula, 140)}${rounded ? " (rounded)" : ""}`,
          t.line,
        );
      }
      i = stmt.end - 1;
      continue;
    }
  }
  while (evaluates.length > 0) closeEvaluate();

  // EVALUATE rules are emitted when their scope closes; report in line order.
  rules.sort((a, b) => a.line - b.line);
  return rules.length > maxRules ? rules.slice(0, maxRules) : rules;
}

/**
 * Render mined COBOL rules as a compact block for an LLM prompt. Mirrors
 * {@link renderMinedKtRules}: one `- L<line>: <summary>` line per rule, grouped
 * by kind; only rule lines count against `maxChars`.
 */
export function renderMinedCblRules(rules: MinedCblRule[], maxChars = 8000): string {
  if (rules.length === 0) return "";
  const groups = new Map<MinedCblRule["kind"], MinedCblRule[]>();
  for (const r of rules) {
    if (!groups.has(r.kind)) groups.set(r.kind, []);
    groups.get(r.kind)!.push(r);
  }
  const order: MinedCblRule["kind"][] = [
    "condition-name",
    "validation",
    "guard",
    "condition",
    "evaluate",
    "when-condition",
    "compute",
  ];
  const parts: string[] = [];
  let total = 0;
  for (const kind of order) {
    const list = groups.get(kind);
    if (!list || list.length === 0) continue;
    parts.push(`### ${cblKindLabel(kind)} (${list.length})`);
    for (const r of list) {
      const line = `- L${r.line}: ${r.summary}`;
      if (total + line.length > maxChars) {
        parts.push(`- (... more COBOL rules truncated for prompt budget)`);
        return parts.join("\n");
      }
      parts.push(line);
      total += line.length;
    }
  }
  return parts.join("\n");
}

function cblKindLabel(k: MinedCblRule["kind"]): string {
  switch (k) {
    case "condition-name":
      return "Condition names (level 88)";
    case "validation":
      return "Validations (class tests, file status)";
    case "guard":
      return "Guards (exit / transfer of control)";
    case "condition":
      return "Branch conditions (IF)";
    case "evaluate":
      return "State dispatch (EVALUATE)";
    case "when-condition":
      return "Decision table arms (EVALUATE TRUE)";
    case "compute":
      return "Formulas (COMPUTE)";
  }
}
