/**
 * Epic #486 / Issue #489 — Documentation Discovery Agent.
 *
 * Walks the code graph for a project, identifies documentable symbols
 * (public classes, methods with significant complexity), gathers context
 * (call graph, rationale, method bodies), and produces structured doc
 * sections using the LLM.
 */
import { readFile } from "node:fs/promises";
import { prisma } from "../prisma.js";
import { createChildLogger } from "../logger.js";
import { extractFormulas, type ExtractedFormula } from "../code-graph/formula-extractor.js";
import { buildProvider, loadAIConfig } from "../ai/index.js";
import type { AIProvider, ChatMessage } from "../ai/types.js";
import type { Language } from "../code-graph/parsers.js";
import { resolveSectionMaxOutputTokens } from "./output-caps.js";
import { isSasBusinessSymbol } from "./module-grouping.js";

const log = createChildLogger("docs-gen:discovery");

export const DISCOVERY_SUMMARY_PROMPT_VERSION = 1;

export function resolveDiscoveryGenerationModel(): string {
  return buildProvider({ config: loadAIConfig() }).model;
}

export interface DocSection {
  /** Symbol qualified name */
  symbolName: string;
  /** Symbol kind: class, function, method, interface */
  symbolKind: string;
  /** Module/file path */
  modulePath: string;
  /** Natural-language summary of the symbol */
  summary: string;
  /** Parameters documentation (if function/method) */
  parameters: Array<{ name: string; type: string; description: string }>;
  /** Return type description */
  returns: string | null;
  /** Linked rationale comments (from code comments) */
  rationale: string[];
  /** Call graph — symbols this one calls */
  callsTo: string[];
  /** Call graph — symbols that call this one */
  calledBy: string[];
  /** Extracted formulas within this symbol */
  formulas: ExtractedFormula[];
  /** Complexity indicator */
  complexity: "low" | "medium" | "high";
}

/**
 * Run the discovery agent for a project. Returns structured doc sections.
 */
export async function runDiscoveryAgent(
  projectId: string,
  options?: { codeGraphId?: string },
): Promise<DocSection[]> {
  const codeGraphId = options?.codeGraphId;
  log.info("Starting documentation discovery", { projectId, codeGraphId });

  // Build AI provider for LLM summarization
  const aiProvider = buildProvider({ config: loadAIConfig() });

  // 1. Fetch all symbols for the project
  const symbols = await prisma.codeSymbol.findMany({
    where: { projectId, ...(codeGraphId ? { codeGraphId } : {}) },
    orderBy: [{ filePath: "asc" }, { startLine: "asc" }],
  });

  if (symbols.length === 0) {
    log.warn("No code symbols found — skipping discovery", { projectId });
    return [];
  }

  // 2. Fetch all edges for the project
  const edges = await prisma.codeEdge.findMany({
    where: { projectId, ...(codeGraphId ? { codeGraphId } : {}) },
  });

  // Build adjacency maps (using symbol IDs)
  const callsTo = new Map<string, string[]>();
  const calledBy = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.kind === "calls" || edge.kind === "imports") {
      if (!callsTo.has(edge.fromSymbolId)) callsTo.set(edge.fromSymbolId, []);
      callsTo.get(edge.fromSymbolId)!.push(edge.toSymbolId ?? edge.toQualifiedName ?? "unknown");
      if (edge.toSymbolId) {
        if (!calledBy.has(edge.toSymbolId)) calledBy.set(edge.toSymbolId, []);
        calledBy.get(edge.toSymbolId)!.push(edge.fromSymbolId);
      }
    }
  }

  // 3. Build symbol id -> qualified name lookup
  const symbolById = new Map(symbols.map((s) => [s.id, s]));

  // 4. Filter to documentable symbols
  const documentable = symbols.filter((s) => isDocumentable(s, calledBy));

  log.info("Filtered documentable symbols", {
    projectId,
    total: symbols.length,
    documentable: documentable.length,
  });

  // 5. Generate doc sections (with LLM summarization)
  // Cap at 100 symbols to prevent runaway LLM costs; prioritize high-complexity first
  const prioritized = documentable
    .map((sym) => ({
      sym,
      lineCount: sym.endLine - sym.startLine,
      degree: (calledBy.get(sym.id)?.length ?? 0) + (callsTo.get(sym.id)?.length ?? 0),
    }))
    .sort((a, b) => b.lineCount + b.degree - (a.lineCount + a.degree))
    .slice(0, 100)
    .map((p) => p.sym);

  log.info("Processing top symbols for documentation", {
    projectId,
    prioritized: prioritized.length,
  });

  // Process in concurrent batches of 5
  const CONCURRENCY = 5;
  const sections: DocSection[] = [];

  for (let i = 0; i < prioritized.length; i += CONCURRENCY) {
    const batch = prioritized.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map((sym) =>
        buildDocSection(sym, symbolById, callsTo, calledBy, projectId, aiProvider),
      ),
    );
    for (let j = 0; j < results.length; j++) {
      const result = results[j];
      if (result.status === "fulfilled") {
        sections.push(result.value);
      } else {
        log.warn("Failed to build doc section", {
          err: result.reason,
          symbol: batch[j].qualifiedName,
        });
      }
    }
  }

  log.info("Discovery complete", { projectId, sections: sections.length });
  return sections;
}

/**
 * A SAS-origin business-logic symbol (Issue #200). Defined with the module
 * grouping it gates; re-exported here for existing callers.
 */
export { isSasBusinessSymbol };

/**
 * NEW: Domain-level business requirements synthesis.
 *
 * Instead of generating one doc section per code symbol (which produces an
 * overwhelming class reference), this groups symbols by module/package and
 * asks the LLM to extract **business requirements, rules, and formulas**
 * from each module — producing a small, readable, business-consumable
 * document instead of a 5000-line API reference.
 */
export async function synthesizeBusinessRequirements(projectId: string): Promise<DocSection[]> {
  log.info("Starting business requirements synthesis", { projectId });

  const aiProvider = buildProvider({ config: loadAIConfig() });

  const symbols = await prisma.codeSymbol.findMany({
    where: { projectId },
    orderBy: [{ filePath: "asc" }, { startLine: "asc" }],
  });

  if (symbols.length === 0) {
    log.warn("No code symbols found", { projectId });
    return [];
  }

  // Group symbols by module (directory path)
  const moduleMap = new Map<string, Array<(typeof symbols)[number]>>();
  for (const sym of symbols) {
    if (sym.kind === "module" || sym.kind === "type") continue;
    const dir = sym.filePath.split("/").slice(0, -1).join("/");
    // Skip generated/vendor/test directories
    if (
      dir.includes("/test/") ||
      dir.includes("/tests/") ||
      dir.includes("/generated/") ||
      dir.includes("/node_modules/") ||
      dir.includes("/build/") ||
      dir.includes("/target/")
    ) {
      continue;
    }
    if (!moduleMap.has(dir)) moduleMap.set(dir, []);
    moduleMap.get(dir)!.push(sym);
  }

  // Filter modules with meaningful content.
  //
  // Standard languages (ts/js/py/go/java) require ≥1 class/interface AND ≥3
  // symbols. SAS has no classes/interfaces (it is `%macro` blocks, DATA steps,
  // and PROC steps — all `function` symbols from the SAS parser), so the
  // standard rule rejects every SAS directory. Relax ONLY for SAS-origin
  // symbols (`language === "sas"`): a directory qualifies if it has ≥3 SAS
  // business-logic symbols, regardless of class/interface presence. The
  // non-SAS rule is unchanged. Issue #200.
  const modules = Array.from(moduleMap.entries())
    .filter(([, syms]) => {
      const hasClassLike =
        syms.filter((s) => s.kind === "class" || s.kind === "interface").length >= 1;
      const standard = hasClassLike && syms.length >= 3;
      const sasBusiness = syms.filter(isSasBusinessSymbol).length;
      const sasRelaxed = sasBusiness >= 3;
      return standard || sasRelaxed;
    })
    .map(([dir, syms]) => ({ dir, syms }))
    // Sort by symbol count (largest modules first)
    .sort((a, b) => b.syms.length - a.syms.length)
    // Cap at 30 modules to keep the doc readable and LLM cost bounded
    .slice(0, 30);

  log.info("Synthesizing modules", { projectId, moduleCount: modules.length });

  const sections: DocSection[] = [];
  const CONCURRENCY = 3;

  for (let i = 0; i < modules.length; i += CONCURRENCY) {
    const batch = modules.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map((m) => synthesizeModule(m.dir, m.syms, aiProvider, projectId)),
    );
    for (let j = 0; j < results.length; j++) {
      const r = results[j];
      if (r.status === "fulfilled" && r.value) {
        sections.push(r.value);
      } else if (r.status === "rejected") {
        log.warn("Module synthesis failed", { err: r.reason, dir: batch[j].dir });
      }
    }
  }

  log.info("Synthesis complete", { projectId, sections: sections.length });
  return sections;
}

/**
 * Synthesize one module into a business-requirements DocSection.
 * Reads the most important files, extracts formulas, sends to LLM for
 * business-focused summary.
 */
async function synthesizeModule(
  modulePath: string,
  symbols: Array<{
    id: string;
    qualifiedName: string;
    kind: string;
    filePath: string;
    startLine: number;
    endLine: number;
  }>,
  provider: AIProvider,
  projectId: string,
): Promise<DocSection | null> {
  // Pick top classes/interfaces and the largest methods (these carry the business logic)
  const classes = symbols.filter((s) => s.kind === "class" || s.kind === "interface");
  const methods = symbols
    .filter((s) => s.kind === "method" || s.kind === "function")
    .sort((a, b) => b.endLine - b.startLine - (a.endLine - a.startLine))
    .slice(0, 15);

  // Read source for top methods to give the LLM real code to analyze
  const codeSnippets: string[] = [];
  const allFormulas: ExtractedFormula[] = [];
  const filesRead = new Set<string>();

  for (const sym of methods) {
    if (codeSnippets.join("").length > 12000) break; // Cap context size
    try {
      if (filesRead.has(sym.filePath)) continue;
      filesRead.add(sym.filePath);
      const fullSource = await readFile(sym.filePath, "utf-8");
      const lines = fullSource.split("\n");
      const slice = lines
        .slice(sym.startLine - 1, Math.min(sym.endLine, sym.startLine + 80))
        .join("\n");
      codeSnippets.push(`// ${sym.qualifiedName} (${sym.filePath})\n${slice}`);

      // Extract formulas from this file
      const lang = detectLanguage(sym.filePath);
      if (lang) {
        const f = extractFormulas(slice, sym.filePath, lang);
        allFormulas.push(...f);
      }
    } catch {
      // File unreadable — skip
    }
  }

  // Gather any rationale findings for this module
  const moduleSymbolIds = symbols.map((s) => s.id);
  const rationale = await prisma.finding.findMany({
    where: {
      agentResult: { analysis: { projectId } },
      category: { in: ["rationale", "rationale-todo"] },
      symbolId: { in: moduleSymbolIds },
    },
    take: 10,
    select: { body: true },
  });

  const moduleName = modulePath.split("/").slice(-3).join("/") || modulePath;
  const classList = classes
    .map((c) => `- ${c.qualifiedName.split(/[.:]/).pop()}`)
    .slice(0, 30)
    .join("\n");

  const formulaSummary =
    allFormulas.length > 0
      ? allFormulas
          .slice(0, 20)
          .map((f) => `- ${f.kind}: ${f.expression.slice(0, 200)}`)
          .join("\n")
      : "(none extracted)";

  const rationaleSummary =
    rationale.length > 0
      ? rationale.map((r) => `- ${r.body.slice(0, 200)}`).join("\n")
      : "(no rationale comments found)";

  const systemMessage = `You are a senior business analyst writing requirements documentation. You will receive source code from one module of a software system. Extract and document the BUSINESS REQUIREMENTS the code implements.

ABSOLUTE RULES:
1. Output ONLY the markdown documentation. No preamble. No "I'll analyze...". No "Let me explore...". No closing remarks. Start your response with the literal characters "## Purpose".
2. You have ALL the information you need in the user message. Do NOT ask for more. Do NOT propose to look at other files. Just write the doc.
3. Be concrete and specific. Quote actual constants, thresholds, field names, and rules from the provided code. If you cannot determine business rules from the code, write "(no explicit business rules detected in this module)" — do NOT make things up.
4. Use domain language, not programming language. Say "Generators must be certified" not "the certify() method validates a Generator object".

REQUIRED FORMAT (use these exact headings, in this order):

## Purpose
2-3 sentences on what business problem this module solves.

## Business Rules
Bullet list of rules enforced by the code. Quote specific thresholds and conditions.

## Formulas & Calculations
For each formula or constant found, write it in plain English AND in LaTeX notation. Example:
- **Unit Price Calculation**: Unit price equals total cost divided by quantity: $UnitPrice = \\frac{TotalCost}{Quantity}$
If no formulas, write "(none)".

## Key Workflows
Main business processes implemented. 1-2 sentences each. If unclear, write "(no distinct workflows detected)".

## Data & Domain Concepts
Key business entities this module deals with.

Do NOT describe Java syntax, design patterns, or class hierarchies. Focus exclusively on what the SYSTEM DOES for the BUSINESS.`;

  const userMessage = `Module: \`${moduleName}\`

Classes/interfaces in this module:
${classList || "(none)"}

Sample of business logic code (top methods by size):
\`\`\`
${codeSnippets.join("\n\n---\n\n").slice(0, 12000)}
\`\`\`

Extracted formulas/constants:
${formulaSummary}

Existing developer comments/rationale:
${rationaleSummary}

Write the business requirements documentation for this module following the format in the system prompt.`;

  const messages: ChatMessage[] = [
    { role: "system", content: systemMessage },
    { role: "user", content: userMessage },
  ];

  let summary: string;
  if (provider.offline) {
    summary = `**Module:** \`${moduleName}\`\n\nContains ${classes.length} class(es)/interface(s) and ${methods.length} significant method(s).\n\n${classList ? "**Key components:**\n" + classList : ""}`;
  } else {
    try {
      // Unique sessionId per module, so per-session telemetry and fixture keys
      // (and any provider that caches by session id) never mix two modules'
      // prompts.
      const sessionId = `docs-gen-${projectId}-${modulePath.replace(/[^a-z0-9]/gi, "_")}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      // #1228 sweep — an EXPLICIT output cap. With none, the call silently
      // inherited the provider's 4096 `defaultMaxTokens`, and a module writeup
      // cut off at it was accepted verbatim as the summary (only a THROWN error
      // reaches the fallback below).
      const response = await provider.chat(messages, {
        sessionId,
        maxTokens: resolveSectionMaxOutputTokens(provider.model),
      });
      summary = response.content.trim();
    } catch (err) {
      log.warn("LLM module synthesis failed, using fallback", { err, modulePath });
      summary = `**Module:** \`${moduleName}\`\n\nContains ${classes.length} class(es)/interface(s) and ${methods.length} significant method(s).\n\n${classList ? "**Key components:**\n" + classList : ""}`;
    }
  }

  return {
    symbolName: moduleName,
    symbolKind: "module",
    modulePath,
    summary,
    parameters: [],
    returns: null,
    rationale: rationale.map((r) => r.body),
    callsTo: [],
    calledBy: [],
    formulas: allFormulas.slice(0, 30),
    complexity: methods.length > 30 ? "high" : methods.length > 10 ? "medium" : "low",
  };
}

/**
 * Determines if a symbol is worth documenting.
 */
function isDocumentable(
  sym: { kind: string; qualifiedName: string; startLine: number; endLine: number },
  calledBy: Map<string, string[]>,
): boolean {
  // Skip modules (too broad)
  if (sym.kind === "module" || sym.kind === "type") return false;

  // Document classes, interfaces always
  if (sym.kind === "class" || sym.kind === "interface") return true;

  // Document exported functions/methods
  if (sym.kind === "function" || sym.kind === "method") {
    // Significant size (> 5 lines)
    const lineCount = sym.endLine - sym.startLine;
    if (lineCount > 5) return true;
    // Or widely called
    if ((calledBy.get(sym.qualifiedName)?.length ?? 0) >= 2) return true;
  }

  return false;
}

async function buildDocSection(
  sym: {
    id: string;
    qualifiedName: string;
    kind: string;
    filePath: string;
    startLine: number;
    endLine: number;
  },
  symbolById: Map<string, typeof sym>,
  callsToMap: Map<string, string[]>,
  calledByMap: Map<string, string[]>,
  projectId: string,
  aiProvider: AIProvider,
): Promise<DocSection> {
  // Read the source body for this symbol
  let sourceBody = "";
  try {
    const fullSource = await readFile(sym.filePath, "utf-8");
    const lines = fullSource.split("\n");
    sourceBody = lines.slice(sym.startLine - 1, sym.endLine).join("\n");
  } catch {
    // File may not be accessible
  }

  // Get call relationships
  const callsToIds = callsToMap.get(sym.id) ?? [];
  const calledByIds = calledByMap.get(sym.id) ?? [];
  const callsToNames = callsToIds
    .map((id) => symbolById.get(id)?.qualifiedName)
    .filter(Boolean) as string[];
  const calledByNames = calledByIds
    .map((id) => symbolById.get(id)?.qualifiedName)
    .filter(Boolean) as string[];

  // Get rationale (from findings table)
  const rationaleFindings = await prisma.finding.findMany({
    where: {
      agentResult: { analysis: { projectId } },
      category: { in: ["rationale", "rationale-todo"] },
      OR: [{ symbolId: sym.id }, { body: { contains: sym.qualifiedName } }],
    },
    take: 5,
    select: { body: true },
  });

  // Extract formulas from the symbol's source
  const language = detectLanguage(sym.filePath);
  const formulas = language ? extractFormulas(sourceBody, sym.filePath, language) : [];

  // Compute complexity
  const lineCount = sym.endLine - sym.startLine;
  const complexity: DocSection["complexity"] =
    lineCount > 50 ? "high" : lineCount > 20 ? "medium" : "low";

  // Generate summary via LLM
  const summary = await generateLLMSummary(
    aiProvider,
    sym,
    sourceBody,
    callsToNames,
    calledByNames,
    rationaleFindings.map((f) => f.body),
    formulas,
  );

  // Parse parameters from source (first line of the function)
  const firstLine = sourceBody.split("\n")[0] ?? "";
  const parameters = parseParameters(firstLine);

  // Infer return type
  const returns = inferReturnType(firstLine, sourceBody);

  return {
    symbolName: sym.qualifiedName,
    symbolKind: sym.kind,
    modulePath: sym.filePath,
    summary,
    parameters,
    returns,
    rationale: rationaleFindings.map((f) => f.body),
    callsTo: callsToNames,
    calledBy: calledByNames,
    formulas,
    complexity,
  };
}

function buildSummaryFallback(
  sym: { qualifiedName: string; kind: string },
  sourceBody: string,
  callsTo: string[],
): string {
  const parts: string[] = [];
  const name = sym.qualifiedName.split(".").pop() ?? sym.qualifiedName;

  if (sym.kind === "class") {
    parts.push(`Class \`${name}\``);
  } else if (sym.kind === "interface") {
    parts.push(`Interface \`${name}\``);
  } else if (sym.kind === "function" || sym.kind === "method") {
    parts.push(`${sym.kind === "method" ? "Method" : "Function"} \`${name}\``);
  }

  const firstLine = sourceBody.split("\n")[0] ?? "";
  if (firstLine.includes("(")) {
    parts.push(`with signature: \`${firstLine.trim()}\``);
  }

  if (callsTo.length > 0) {
    parts.push(
      `Depends on: ${callsTo
        .slice(0, 5)
        .map((n) => `\`${n.split(".").pop()}\``)
        .join(", ")}`,
    );
  }

  const commentMatch = sourceBody.match(/\/\*\*\s*\n\s*\*\s*(.+?)(?:\n|\*\/)/);
  if (commentMatch) {
    parts.push(commentMatch[1].trim());
  }

  return parts.join(". ") + ".";
}

/**
 * Generate a natural-language summary of a code symbol via the LLM.
 * Falls back to template-based summary if the AI is offline or errors.
 */
async function generateLLMSummary(
  provider: AIProvider,
  sym: { qualifiedName: string; kind: string },
  sourceBody: string,
  callsTo: string[],
  calledBy: string[],
  rationale: string[],
  formulas: ExtractedFormula[],
): Promise<string> {
  if (provider.offline) {
    return buildSummaryFallback(sym, sourceBody, callsTo);
  }

  const truncatedBody = sourceBody.slice(0, 3000);

  const contextParts: string[] = [];
  if (callsTo.length > 0) {
    contextParts.push(`Calls: ${callsTo.slice(0, 10).join(", ")}`);
  }
  if (calledBy.length > 0) {
    contextParts.push(`Called by: ${calledBy.slice(0, 10).join(", ")}`);
  }
  if (rationale.length > 0) {
    contextParts.push(`Existing rationale/comments:\n${rationale.slice(0, 3).join("\n")}`);
  }
  if (formulas.length > 0) {
    contextParts.push(
      `Formulas found:\n${formulas
        .slice(0, 5)
        .map((f) => `  ${f.expression} (${f.kind})`)
        .join("\n")}`,
    );
  }

  const systemMessage = `You are a technical documentation writer. Given source code, produce a clear, concise explanation of what the code does in business terms. Focus on:
- What business purpose does this code serve?
- What are the key business rules, validations, or formulas?
- What data does it transform and how?
- What domain concepts does it implement?

Write 2-4 sentences of documentation. Use domain terminology. If the code contains mathematical formulas, express them in LaTeX notation (e.g., $Total = Subtotal \\times TaxRate$). Do NOT describe the code mechanically (avoid "this method takes parameters..."). Instead explain WHAT it does for the business.`;

  const userMessage = `Document this ${sym.kind} \`${sym.qualifiedName}\`:

\`\`\`
${truncatedBody}
\`\`\`

${contextParts.length > 0 ? "Context:\n" + contextParts.join("\n\n") : ""}`;

  const messages: ChatMessage[] = [{ role: "user", content: userMessage }];

  try {
    // #1228 sweep — as above: an explicit cap rather than the provider default.
    const response = await provider.chat(messages, {
      systemMessage,
      maxTokens: resolveSectionMaxOutputTokens(provider.model),
    });
    return response.content.trim();
  } catch (err) {
    log.warn("LLM summary failed, using fallback", { err, symbol: sym.qualifiedName });
    return buildSummaryFallback(sym, sourceBody, callsTo);
  }
}

function parseParameters(
  signature: string,
): Array<{ name: string; type: string; description: string }> {
  if (!signature) return [];
  // Match (param: type, param2: type2) or (Type param, Type2 param2)
  const paramMatch = signature.match(/\(([^)]*)\)/);
  if (!paramMatch || !paramMatch[1].trim()) return [];

  const params = paramMatch[1]
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  return params.map((p) => {
    // TypeScript style: name: type
    const tsMatch = p.match(/^(\w+)\s*:\s*(.+)$/);
    if (tsMatch) return { name: tsMatch[1], type: tsMatch[2], description: "" };
    // Java style: Type name
    const javaMatch = p.match(/^(\S+)\s+(\w+)$/);
    if (javaMatch) return { name: javaMatch[2], type: javaMatch[1], description: "" };
    return { name: p, type: "unknown", description: "" };
  });
}

function inferReturnType(signature: string, _sourceBody: string): string | null {
  // TypeScript: ): ReturnType
  const tsReturn = signature.match(/\)\s*:\s*(.+?)$/);
  if (tsReturn) return tsReturn[1].trim();
  // Java: ReturnType methodName(
  const javaReturn = signature.match(
    /^(?:public|private|protected|static|\s)*(\w+(?:<[^>]+>)?)\s+\w+\s*\(/,
  );
  if (javaReturn && javaReturn[1] !== "void") return javaReturn[1];
  return null;
}

function detectLanguage(filePath: string): Language | null {
  if (filePath.endsWith(".ts") || filePath.endsWith(".tsx")) return "ts";
  if (filePath.endsWith(".js") || filePath.endsWith(".jsx")) return "js";
  if (filePath.endsWith(".java")) return "java";
  if (filePath.endsWith(".py")) return "py";
  if (filePath.endsWith(".go")) return "go";
  return null;
}
