---
name: research-gather
description: "Gathers and synthesizes background material from local files, web pages, and library documentation via Context7 into one structured research summary. Use when asked to research a topic, read through a folder of documents, or compile prior art before deciding anything — typically the step before epic-planner when a request names doc paths or URLs to review first."
argument-hint: "[topic or path] — describe what to research or provide a local directory path"
---

# Research Gather

## Purpose

This skill collects and converts research material from multiple sources into a structured summary for use by the **Research**, **Code Planner**, and **Epic Planner** workflows.

## When to Use

- Before epic planning, to gather requirements and context
- The user has local documents or files to analyze
- The user provides web URLs with reference material, specs, or designs
- The user says "research", "gather requirements", "pull in docs", or "analyze documents"

## Tools

The `research` agent that runs this skill declares a `tools:` allowlist naming no MCP
pattern, which strips **every** MCP tool from it (#1146, measured) — so Tavily and
Context7 are not reachable on that path and this table names what is (#1180):

| Tool | Purpose |
|------|---------|
| `Read` | Read local files directly |
| `WebSearch` | Web search — queries against the live web, for discovery |
| `WebFetch` | Fetch and convert a specific URL to markdown, then answer a prompt over it |
| `Bash` (`find`, `grep`) | Locate local material and search the codebase |

`WebFetch` fails on authenticated or private URLs; for anything behind GitHub auth use
`gh` in `Bash` instead. For library documentation there is no MCP docs server on this
path — search for the official docs URL with `WebSearch`, then read it with `WebFetch`,
and **cite the URL** so a later reader can check the version you saw.

The main session, which does hold MCP tools, may substitute `mcp__tavily__*` for search and `mcp__context7__*` for library docs. <!-- mcp: main-session only -->

## Workflow

### Step 1: Ask the User About Sources

Present this menu:

> **Where should I gather research material from?** (Choose all that apply)
>
> 1. 📁 **Local files** — Read documents from a folder on disk
> 2. 🌐 **Web URLs** — Fetch content from web pages you provide
> 3. 📚 **Library docs** — Look up framework/library documentation via Context7
>
> *Provide paths, URLs, or topics for each source.*

### Step 2: Local Documents (if selected)

#### 2a. Get the Path
If not already provided:
> *"What is the path to your local documents?"*

#### 2b. Read Documents
Use `read_file` to read files from the provided path. For text-based files (Markdown, plain text, JSON, YAML, code files), read them directly. For binary formats (DOCX, PDF, XLSX, PPTX), inform the user that structured conversion is not available and do your best to extract readable content.

#### 2c. Read and Analyze
- Read the generated Markdown files
- Extract requirements, business rules, data models, and specifications
- Note the source file for each finding

### Step 3: Web Research (if selected)

#### 3a. Get URLs or Search
Ask the user for URLs, or infer from the project context:
> *"What URLs should I fetch? (documentation, design specs, API references, etc.)"*

#### 3b. Fetch and Parse
```
WebSearch → for open-ended queries where you need to discover the right sources
WebFetch  → to pull a specific URL and answer a question over its content
```

`WebFetch` returns cross-host redirects instead of following them — call it again with
the redirect URL rather than treating the response as the page.

#### 3c. Extract Insights
- Summarize relevant content
- Extract patterns, best practices, and technical requirements
- Note URLs for citation in epic bodies

### Step 4: Library Documentation (if selected)

#### 4a. Identify Libraries
From the project tech stack and user description, identify key libraries to research.

#### 4b. Find and Read the Docs
```
WebSearch → "<library> <version> docs <topic>" to locate the official page
WebFetch  → read that page and answer the specific question
```

Prefer the library's own documentation site over aggregators, and **check the version**
against this repo's `package.json` before quoting an API — a doc page for a different
major version is the most common way a research summary poisons an epic.

Never state an SDK or dependency fact from memory: verify it against `package.json`,
the lockfile or an import, and cite that path.

### Step 5: Compile Research Summary

Produce a structured research summary that the epic-planner skill can consume:

```markdown
## Research Summary

### Sources Consulted
| Source | Type | Key Findings |
|--------|------|-------------|
| {document/URL name} | Local/Web/Docs | {1-line summary} |

### Requirements Extracted
#### Functional Requirements
1. {FR-001}: {description} *(Source: {document})*
2. {FR-002}: {description} *(Source: {document})*

#### Non-Functional Requirements
1. {NFR-001}: {description} *(Source: {document})*

#### Business Rules
1. {BR-001}: {description} *(Source: {document})*

### Data Model Insights
{Any schema, entity relationships, or data structures identified}

### Integration Points
{External systems, APIs, or services identified}

### User Roles & Permissions
{User types and their access levels}

### Technology Recommendations
{Based on library docs research — frameworks, tools, patterns}

### Open Questions
1. {Question needing user clarification}
2. {Ambiguity found in documents}

### Constraints & Assumptions
- {Constraint or assumption identified during research}

### Security Considerations
- {Any security requirements, compliance needs, or sensitive data handling noted in the source documents}
```

Present the summary to the user and ask:
> *"Here's what I found. Are there any corrections, additions, or questions you'd like me to address before I start planning the epics?"*

### Step 6: Handoff to Epic Planner

Pass the research summary to the epic-planner skill as context for issue creation.

## Error Recovery

| Scenario | Action |
|----------|--------|
| Local path doesn't exist | Ask user to verify the path |
| File conversion fails | Log error, skip file, continue with others |
| Web fetch fails | Note URL as inaccessible, continue with other sources |
| Tavily unavailable | Fall back to `fetch_webpage` |
| Context7 unavailable | Skip library docs, use Tavily or web research as fallback |

## Tips

- For large document sets, prioritize the most recent and most relevant
- Cross-reference findings across multiple sources for accuracy
- Flag contradictions between documents for user resolution
- Keep the research summary concise — detail goes into the individual epic/issue bodies
