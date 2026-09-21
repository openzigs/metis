/**
 * Regex/blocklist SafetyHook — the fallback used when the project's AI
 * provider is not `bedrock-gateway`.
 *
 * Detects:
 *   • Prompt-injection / role-override patterns
 *     ("ignore previous instructions", "you are now …", system-prompt
 *     extraction). These cause `verdict = "blocked"` regardless of mode.
 *   • PII — SSN, credit card (Luhn-validated), US phone, email
 *     (email is only flagged in `strict` mode). PII is always redacted in
 *     the rewritten output rather than blocked, mirroring how Bedrock
 *     guardrails behave with the `MASK` action.
 *   • Custom blocklist regex from env var `SAFETY_BLOCKLIST_REGEX` (CSV).
 *     Custom blocklist hits cause `verdict = "blocked"`.
 *
 * Mode handling:
 *   • `off` — short-circuit; always returns `{ allowed: true, findings: [] }`.
 *   • `standard` — injection + custom blocklist only; SSN/CC redacted; phone
 *     flagged but not redacted.
 *   • `strict` — adds email + phone redaction.
 */
import type { SafetyFinding } from "@metis/shared";
import type { SafetyContext, SafetyHook, SafetyResult } from "./safety-hook.js";

const INJECTION_PATTERNS: ReadonlyArray<{ kind: string; rx: RegExp }> = [
  {
    kind: "prompt_injection",
    rx: /\bignore\s+(?:all\s+)?(?:previous|prior|above|the)\s+(?:instructions?|prompts?|rules?|system\s+messages?)\b/i,
  },
  {
    kind: "role_override",
    rx: /\byou\s+are\s+now\s+(?:a|an)\s+(?:new\s+)?(?:assistant|persona|character|model|developer|admin|root)\b/i,
  },
  {
    kind: "system_prompt_extraction",
    rx: /\b(?:show|reveal|print|repeat|output|leak|dump|disclose)\s+(?:me\s+)?(?:the\s+)?(?:system\s+prompt|hidden\s+instructions?|developer\s+message|initial\s+prompt)\b/i,
  },
  {
    kind: "jailbreak",
    rx: /\b(?:dan\s+mode|jailbreak|do\s+anything\s+now|developer\s+mode\s+enabled|sudo\s+mode)\b/i,
  },
];

// Strict-formatted SSN — digits only with dashes/spaces. We deliberately do
// NOT match arbitrary 9-digit blobs because that catches every order id.
const SSN_RX = /\b\d{3}[-\s]\d{2}[-\s]\d{4}\b/g;
// 13–19 digit numbers, optionally separated by spaces/dashes in groups of
// four. Final filter via Luhn keeps false positives down.
const CC_RX = /\b(?:\d{4}[-\s]){2,4}\d{1,4}\b|\b\d{13,19}\b/g;
// US phone: optional country code, area code in parens or not.
const PHONE_RX = /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g;
const EMAIL_RX = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;

function luhnValid(digits: string): boolean {
  // Luhn checksum — used to filter false-positive credit card matches.
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (n < 0 || n > 9) return false;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum > 0 && sum % 10 === 0;
}

interface RedactionRule {
  kind: string;
  rx: RegExp;
  /** Custom filter (e.g. Luhn) — `false` rejects the match. */
  filter?: (match: string) => boolean;
}

function buildPiiRules(mode: "strict" | "standard"): RedactionRule[] {
  const rules: RedactionRule[] = [
    { kind: "ssn", rx: SSN_RX },
    {
      kind: "credit_card",
      rx: CC_RX,
      filter: (m) => luhnValid(m.replace(/[-\s]/g, "")),
    },
  ];
  if (mode === "strict") {
    rules.push({ kind: "phone", rx: PHONE_RX });
    rules.push({ kind: "email", rx: EMAIL_RX });
  } else {
    // standard mode — phone is detected but only flagged, not redacted.
    rules.push({ kind: "phone", rx: PHONE_RX });
  }
  return rules;
}

function compileBlocklist(): ReadonlyArray<{ kind: string; rx: RegExp }> {
  const raw = process.env.SAFETY_BLOCKLIST_REGEX?.trim();
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((pattern, i) => {
      try {
        // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp -- pattern comes from the operator-only SAFETY_BLOCKLIST_REGEX env var (trusted config), not end-user input, and compilation is try/catch guarded.
        return { kind: `blocklist_${i}`, rx: new RegExp(pattern, "i") };
      } catch {
        return null;
      }
    })
    .filter((r): r is { kind: string; rx: RegExp } => r !== null);
}

export class RegexBlocklistSafetyHook implements SafetyHook {
  readonly name = "regex-blocklist";

  async applyInput(text: string, ctx: SafetyContext): Promise<SafetyResult> {
    return this.evaluate(text, ctx);
  }

  async applyOutput(text: string, ctx: SafetyContext): Promise<SafetyResult> {
    return this.evaluate(text, ctx);
  }

  private evaluate(text: string, ctx: SafetyContext): SafetyResult {
    if (ctx.mode === "off") return { allowed: true, findings: [] };

    const findings: SafetyFinding[] = [];
    let blocked = false;
    let redactedOut = text;
    let mutated = false;

    // 1. Injection / jailbreak — always blocking.
    for (const p of INJECTION_PATTERNS) {
      const matches = text.match(new RegExp(p.rx.source, p.rx.flags + "g"));
      if (matches && matches.length > 0) {
        findings.push({
          kind: p.kind,
          count: matches.length,
          message: `Pattern matched ${matches.length}x`,
        });
        blocked = true;
      }
    }

    // 2. Custom env blocklist — blocking.
    for (const p of compileBlocklist()) {
      const matches = text.match(new RegExp(p.rx.source, p.rx.flags + "g"));
      if (matches && matches.length > 0) {
        findings.push({ kind: p.kind, count: matches.length, message: "Custom blocklist match" });
        blocked = true;
      }
    }

    // 3. PII — redact, never block.
    const piiMode = ctx.mode === "strict" ? "strict" : "standard";
    for (const rule of buildPiiRules(piiMode)) {
      const matches = redactedOut.match(rule.rx);
      if (!matches || matches.length === 0) continue;
      const validMatches = rule.filter ? matches.filter(rule.filter) : matches;
      if (validMatches.length === 0) continue;
      findings.push({ kind: rule.kind, count: validMatches.length });
      // Only redact SSN/CC in standard mode; in strict, redact email + phone too.
      const shouldRedact = ctx.mode === "strict" ? true : rule.kind !== "phone";
      if (shouldRedact) {
        // Iterate manually so we only swap the validated matches.
        const pattern = new RegExp(rule.rx.source, rule.rx.flags);
        redactedOut = redactedOut.replace(pattern, (m) =>
          rule.filter && !rule.filter(m) ? m : `[REDACTED:${rule.kind.toUpperCase()}]`,
        );
        mutated = true;
      }
    }

    if (blocked) {
      return { allowed: false, findings };
    }
    if (mutated) {
      return { allowed: true, redacted: redactedOut, findings };
    }
    return { allowed: true, findings };
  }
}

let singleton: RegexBlocklistSafetyHook | null = null;
export function getRegexSafetyHook(): RegexBlocklistSafetyHook {
  if (!singleton) singleton = new RegexBlocklistSafetyHook();
  return singleton;
}

export function __resetRegexSafetyHookSingleton(): void {
  singleton = null;
}
