/**
 * Medium-depth repo crawler (Epic #544 / Issue #550).
 *
 * Crawls a repository at medium depth: API specs, route handlers, and shared
 * type declarations. Does NOT do full AST of every file. This feeds the
 * cross-repo relationship detector.
 */

export interface CrawlSpec {
  format: "openapi" | "swagger" | "graphql" | "protobuf";
  filePath: string;
  content: string;
}

export interface CrawlRoute {
  method: string;
  path: string;
  filePath: string;
  lineNumber?: number;
  handler?: string;
  framework: string;
}

export interface CrawlTypeDecl {
  name: string;
  kind: "interface" | "type" | "enum" | "class" | "struct" | "message";
  filePath: string;
  lineNumber?: number;
  exported: boolean;
  properties?: string[];
}

export interface CrawlMetadata {
  repoConnectionId: string;
  commitSha?: string;
  filesScanned: number;
  totalBytes: number;
  crawledAt: string;
  duration: number;
}

export interface CrawlResult {
  specs: CrawlSpec[];
  routes: CrawlRoute[];
  types: CrawlTypeDecl[];
  metadata: CrawlMetadata;
}

/** File patterns for API spec discovery. */
const SPEC_PATTERNS: Array<{ pattern: RegExp; format: CrawlSpec["format"] }> = [
  { pattern: /openapi\.(ya?ml|json)$/i, format: "openapi" },
  { pattern: /swagger\.(ya?ml|json)$/i, format: "swagger" },
  { pattern: /\.graphql$/i, format: "graphql" },
  { pattern: /\.gql$/i, format: "graphql" },
  { pattern: /schema\.gql$/i, format: "graphql" },
  { pattern: /\.proto$/i, format: "protobuf" },
];

/** Directories to skip during crawl. */
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "__pycache__",
  "vendor",
  "target",
  ".gradle",
  "coverage",
  ".nyc_output",
  "test",
  "tests",
  "__tests__",
  "__fixtures__",
  "fixtures",
]);

/** Maximum files to scan per repo. */
const MAX_FILES = 500;

/** Maximum total content bytes per repo. */
const MAX_BYTES = 50 * 1024 * 1024; // 50MB

/** Route handler patterns for common frameworks. */
const ROUTE_PATTERNS: Array<{
  framework: string;
  pattern: RegExp;
  methodGroup: number;
  pathGroup: number;
}> = [
  // Express / Fastify: router.get('/path', handler)
  {
    framework: "express",
    pattern:
      /(?:router|app|r)\.(get|post|put|patch|delete|options|head)\s*\(\s*["'`]([^"'`]+)["'`]/g,
    methodGroup: 1,
    pathGroup: 2,
  },
  // NestJS decorators: @Get('/path')
  {
    framework: "nestjs",
    pattern: /@(Get|Post|Put|Patch|Delete|Options|Head)\s*\(\s*["'`]([^"'`]*)["'`]?\s*\)/gi,
    methodGroup: 1,
    pathGroup: 2,
  },
  // Next.js App Router: export async function GET/POST/PUT/DELETE
  {
    framework: "nextjs",
    pattern: /export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\b/gi,
    methodGroup: 1,
    pathGroup: 0, // path derived from file location
  },
  // Go chi/gin: r.Get("/path", handler)
  {
    framework: "go",
    pattern:
      /(?:r|router|e|g|group)\.(Get|Post|Put|Patch|Delete|Options|Head|Handle|HandleFunc)\s*\(\s*["'`]([^"'`]+)["'`]/g,
    methodGroup: 1,
    pathGroup: 2,
  },
];

/** Type/interface extraction patterns. */
const TYPE_PATTERNS: Array<{
  pattern: RegExp;
  kind: CrawlTypeDecl["kind"];
  nameGroup: number;
  exportedCheck: RegExp;
}> = [
  {
    pattern: /(?:export\s+)?interface\s+(\w+)/g,
    kind: "interface",
    nameGroup: 1,
    exportedCheck: /^export\s/,
  },
  {
    pattern: /(?:export\s+)?type\s+(\w+)\s*=/g,
    kind: "type",
    nameGroup: 1,
    exportedCheck: /^export\s/,
  },
  {
    pattern: /(?:export\s+)?enum\s+(\w+)/g,
    kind: "enum",
    nameGroup: 1,
    exportedCheck: /^export\s/,
  },
  {
    pattern: /(?:export\s+)?class\s+(\w+)/g,
    kind: "class",
    nameGroup: 1,
    exportedCheck: /^export\s/,
  },
  // Protobuf messages
  {
    pattern: /message\s+(\w+)\s*\{/g,
    kind: "message",
    nameGroup: 1,
    exportedCheck: /^/,
  },
];

/** Paths where shared types are typically found. */
const TYPE_PATHS = [
  "src/types",
  "packages/shared",
  "lib/contracts",
  "lib/types",
  "shared",
  "types",
  "src/shared",
  "src/contracts",
  "proto",
  "api/types",
];

/** Paths where route handlers are typically found. */
const ROUTE_PATHS = [
  "src/routes",
  "src/controllers",
  "src/api",
  "app/api",
  "routes",
  "controllers",
  "api",
  "src/handlers",
  "handlers",
];

export interface FileEntry {
  path: string;
  content: string;
  size: number;
}

export interface RepoCrawlerOptions {
  /** Override default spec patterns. */
  specPatterns?: Array<{ pattern: RegExp; format: CrawlSpec["format"] }>;
  /** Override default type paths. */
  typePaths?: string[];
  /** Override default route paths. */
  routePaths?: string[];
  /** Override max files. */
  maxFiles?: number;
  /** Override max bytes. */
  maxBytes?: number;
}

/**
 * Crawls a list of files for API specs, route handlers, and shared types.
 * This is the core logic separated from I/O for testability.
 */
export function crawlFiles(
  files: FileEntry[],
  repoConnectionId: string,
  options?: RepoCrawlerOptions & { commitSha?: string },
): CrawlResult {
  const startTime = Date.now();
  const maxFiles = options?.maxFiles ?? MAX_FILES;
  const maxBytes = options?.maxBytes ?? MAX_BYTES;
  const specPatterns = options?.specPatterns ?? SPEC_PATTERNS;
  const typePaths = options?.typePaths ?? TYPE_PATHS;
  const routePaths = options?.routePaths ?? ROUTE_PATHS;

  const specs: CrawlSpec[] = [];
  const routes: CrawlRoute[] = [];
  const types: CrawlTypeDecl[] = [];

  let filesScanned = 0;
  let totalBytes = 0;

  for (const file of files) {
    if (filesScanned >= maxFiles) break;
    if (totalBytes + file.size > maxBytes) break;

    // Skip directories that shouldn't be crawled
    const pathParts = file.path.split("/");
    if (pathParts.some((part) => SKIP_DIRS.has(part))) continue;

    filesScanned++;
    totalBytes += file.size;

    // Check for API specs
    for (const { pattern, format } of specPatterns) {
      if (pattern.test(file.path)) {
        specs.push({ format, filePath: file.path, content: file.content });
        break;
      }
    }

    // Check for route handlers
    const isRoutePath = routePaths.some((rp) => file.path.toLowerCase().includes(rp.toLowerCase()));
    if (isRoutePath) {
      const fileRoutes: CrawlRoute[] = [];
      for (const { framework, pattern, methodGroup, pathGroup } of ROUTE_PATTERNS) {
        // Reset regex state
        const re = new RegExp(pattern.source, pattern.flags);
        let match: RegExpExecArray | null;
        while ((match = re.exec(file.content)) !== null) {
          const method = match[methodGroup].toUpperCase();
          const routePath = pathGroup === 0 ? derivePathFromFile(file.path) : match[pathGroup];
          const lineNumber = getLineNumber(file.content, match.index);
          fileRoutes.push({
            method,
            path: routePath,
            filePath: file.path,
            lineNumber,
            framework,
          });
        }
      }
      // Deduplicate routes by method+path+lineNumber, keeping the first match
      const seen = new Set<string>();
      for (const route of fileRoutes) {
        const key = `${route.method}:${route.path}:${route.lineNumber}`;
        if (!seen.has(key)) {
          seen.add(key);
          routes.push(route);
        }
      }
    }

    // Check for type declarations
    const isTypePath = typePaths.some((tp) => file.path.toLowerCase().includes(tp.toLowerCase()));
    if (isTypePath || file.path.endsWith(".proto")) {
      for (const { pattern, kind, nameGroup, exportedCheck } of TYPE_PATTERNS) {
        pattern.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(file.content)) !== null) {
          const name = match[nameGroup];
          const lineStart = file.content.lastIndexOf("\n", match.index) + 1;
          const lineContent = file.content.slice(lineStart, match.index + match[0].length);
          const exported = exportedCheck.test(lineContent) || kind === "message";
          const lineNumber = getLineNumber(file.content, match.index);
          types.push({
            name,
            kind,
            filePath: file.path,
            lineNumber,
            exported,
          });
        }
      }
    }
  }

  return {
    specs,
    routes,
    types,
    metadata: {
      repoConnectionId,
      commitSha: options?.commitSha,
      filesScanned,
      totalBytes,
      crawledAt: new Date().toISOString(),
      duration: Date.now() - startTime,
    },
  };
}

/** Derive API path from file location (for Next.js App Router). */
function derivePathFromFile(filePath: string): string {
  // e.g., app/api/users/[id]/route.ts -> /api/users/[id]
  const match = filePath.match(/app\/(api\/.*?)\/route\.\w+$/);
  if (match) return `/${match[1]}`;
  return filePath;
}

/** Get 1-based line number for a character offset. */
function getLineNumber(content: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < content.length; i++) {
    if (content[i] === "\n") line++;
  }
  return line;
}

/**
 * Check if a file path should be skipped during crawl.
 */
export function shouldSkipPath(filePath: string): boolean {
  const parts = filePath.split("/");
  return parts.some((part) => SKIP_DIRS.has(part));
}
