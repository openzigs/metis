/**
 * Bedrock Guardrails SafetyHook — used when project provider is
 * `bedrock-gateway`. Calls `bedrock-runtime:ApplyGuardrail` and translates
 * the response into the canonical `SafetyResult`.
 *
 * The AWS SDK is loaded lazily so non-Bedrock deployments don't need it on
 * the dependency tree. When `BEDROCK_GUARDRAIL_ID` is unset, this hook is
 * a no-op (returns allowed) and the fallback regex hook is used instead by
 * `apply-safety.ts`.
 */
import type { SafetyFinding } from "@metis/shared";
import { createChildLogger } from "../logger.js";
import type { SafetyContext, SafetyHook, SafetyResult } from "./safety-hook.js";

const log = createChildLogger("safety-bedrock");

interface ApplyGuardrailResponse {
  action?: string; // "GUARDRAIL_INTERVENED" | "NONE"
  outputs?: Array<{ text?: string }>;
  assessments?: Array<Record<string, unknown>>;
}

interface BedrockClientLike {
  send(command: unknown): Promise<ApplyGuardrailResponse>;
}

export interface BedrockGuardrailHookOptions {
  /** Override the SDK client (tests). */
  client?: BedrockClientLike;
  /** Override the guardrail id (env `BEDROCK_GUARDRAIL_ID`). */
  guardrailId?: string;
  /** Override the guardrail version (env `BEDROCK_GUARDRAIL_VERSION`). */
  guardrailVersion?: string;
}

export class BedrockGuardrailSafetyHook implements SafetyHook {
  readonly name = "bedrock-guardrails";
  private readonly clientOverride: BedrockClientLike | null;
  private readonly guardrailIdOverride: string | undefined;
  private readonly guardrailVersionOverride: string | undefined;

  constructor(opts: BedrockGuardrailHookOptions = {}) {
    this.clientOverride = opts.client ?? null;
    this.guardrailIdOverride = opts.guardrailId;
    this.guardrailVersionOverride = opts.guardrailVersion;
  }

  async applyInput(text: string, ctx: SafetyContext): Promise<SafetyResult> {
    return this.invoke(text, "INPUT", ctx);
  }

  async applyOutput(text: string, ctx: SafetyContext): Promise<SafetyResult> {
    return this.invoke(text, "OUTPUT", ctx);
  }

  private async invoke(
    text: string,
    source: "INPUT" | "OUTPUT",
    ctx: SafetyContext,
  ): Promise<SafetyResult> {
    if (ctx.mode === "off") return { allowed: true, findings: [] };
    const id = this.guardrailIdOverride ?? process.env.BEDROCK_GUARDRAIL_ID?.trim();
    if (!id) {
      // No guardrail configured — fall through to "allowed" so the orchestrator
      // can still run the regex fallback as a second pass.
      return { allowed: true, findings: [] };
    }
    const version =
      this.guardrailVersionOverride ?? process.env.BEDROCK_GUARDRAIL_VERSION?.trim() ?? "DRAFT";
    try {
      const client = this.clientOverride ?? (await loadBedrockClient());
      const command = await buildApplyGuardrailCommand({
        guardrailIdentifier: id,
        guardrailVersion: version,
        source,
        content: [{ text: { text } }],
      });
      const res = await client.send(command);
      const findings = extractFindings(res);
      const blocked = res.action === "GUARDRAIL_INTERVENED" && hasBlocking(res);
      const redacted = pickRedactedText(res, text);
      if (blocked) return { allowed: false, findings };
      if (redacted !== null && redacted !== text) {
        return { allowed: true, redacted, findings };
      }
      return { allowed: true, findings };
    } catch (err) {
      // R-S-2: never let a guardrail failure crash the chat path. Log + allow.
      log.error("Bedrock ApplyGuardrail failed", {
        projectId: ctx.projectId,
        error: (err as Error).message,
      });
      return { allowed: true, findings: [] };
    }
  }
}

function extractFindings(res: ApplyGuardrailResponse): SafetyFinding[] {
  const findings: SafetyFinding[] = [];
  for (const a of res.assessments ?? []) {
    for (const [k, v] of Object.entries(a)) {
      if (Array.isArray(v)) {
        findings.push({ kind: k, count: v.length });
      }
    }
  }
  return findings;
}

function hasBlocking(res: ApplyGuardrailResponse): boolean {
  for (const a of res.assessments ?? []) {
    for (const v of Object.values(a)) {
      if (Array.isArray(v)) {
        for (const entry of v as Array<Record<string, unknown>>) {
          if (entry?.action === "BLOCKED") return true;
        }
      }
    }
  }
  return false;
}

function pickRedactedText(res: ApplyGuardrailResponse, original: string): string | null {
  const o = res.outputs?.[0]?.text;
  if (typeof o === "string" && o.length > 0 && o !== original) return o;
  return null;
}

// ── SDK loading (lazy + test-overridable) ─────────────────────────────────

let bedrockClientLoader: (() => Promise<BedrockClientLike>) | null = null;
let commandBuilder: ((input: Record<string, unknown>) => Promise<unknown>) | null = null;

export function __setBedrockSdkLoaderForTests(
  loader: (() => Promise<BedrockClientLike>) | null,
  cmd: ((input: Record<string, unknown>) => Promise<unknown>) | null,
): void {
  bedrockClientLoader = loader;
  commandBuilder = cmd;
}

async function loadBedrockClient(): Promise<BedrockClientLike> {
  if (bedrockClientLoader) return bedrockClientLoader();
  // Real SDK — only loaded when production callers need it. The package is
  // an optional peer dep; we use a dynamic string import so non-Bedrock
  // deployments don't need to install it.
  type Mod = {
    BedrockRuntimeClient: new (cfg: { region?: string }) => BedrockClientLike;
  };
  const moduleName = "@aws-sdk/client-bedrock-runtime";
  const mod = (await import(/* @vite-ignore */ moduleName)) as unknown as Mod;
  return new mod.BedrockRuntimeClient({ region: process.env.AWS_REGION ?? "us-east-1" });
}

async function buildApplyGuardrailCommand(input: Record<string, unknown>): Promise<unknown> {
  if (commandBuilder) return commandBuilder(input);
  type Mod = { ApplyGuardrailCommand: new (input: Record<string, unknown>) => unknown };
  const moduleName = "@aws-sdk/client-bedrock-runtime";
  const mod = (await import(/* @vite-ignore */ moduleName)) as unknown as Mod;
  return new mod.ApplyGuardrailCommand(input);
}
