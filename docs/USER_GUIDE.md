# METIS — User Guide

> **METIS** stands for **Master Enterprise Tool for Issue Synthesis**. This guide will walk you through everything you need to know to install, configure, and use METIS — from your very first setup to publishing GitHub issues. No prior technical knowledge is assumed.

---

## Table of Contents

1. [What Is METIS and Why Do I Need It?](#1-what-is-metis-and-why-do-i-need-it)
2. [Key Concepts and Terminology](#2-key-concepts-and-terminology)
3. [Prerequisites — What You Need Before Starting](#3-prerequisites--what-you-need-before-starting)
4. [Installation](#4-installation)
   - 4.1 [Option A: Run Locally (Recommended for Development)](#41-option-a-run-locally-recommended-for-development)
   - 4.2 [Option B: Run with Docker (Recommended for Teams)](#42-option-b-run-with-docker-recommended-for-teams)
5. [Configuration](#5-configuration)
   - 5.1 [Environment Variables Overview](#51-environment-variables-overview)
   - 5.2 [Database Configuration](#52-database-configuration)
   - 5.3 [Authentication Configuration](#53-authentication-configuration)
   - 5.4 [AI Configuration](#54-ai-configuration)
   - 5.5 [GitHub Integration](#55-github-integration)
   - 5.6 [Optional Services](#56-optional-services)
6. [Starting METIS](#6-starting-metis)
7. [Logging In](#7-logging-in)
8. [The Dashboard](#8-the-dashboard)
9. [Managing Projects](#9-managing-projects)
   - 9.1 [What Is a Project?](#91-what-is-a-project)
   - 9.2 [Creating a Project](#92-creating-a-project)
   - 9.3 [Viewing Projects](#93-viewing-projects)
   - 9.4 [Project Detail View](#94-project-detail-view)
   - 9.5 [Project Status Lifecycle](#95-project-status-lifecycle)
   - 9.6 [Archiving a Project](#96-archiving-a-project)
10. [Uploading Documents](#10-uploading-documents)
    - 10.1 [Supported File Types](#101-supported-file-types)
    - 10.2 [What Happens When You Upload](#102-what-happens-when-you-upload)
    - 10.3 [Upload Limits](#103-upload-limits)
11. [Running an Analysis](#11-running-an-analysis)
    - 11.1 [What Happens During Analysis](#111-what-happens-during-analysis)
    - 11.2 [Adding Documents and New Requirements Before a Run](#112-adding-documents-and-new-requirements-before-a-run)
    - 11.3 [Understanding Analysis Results](#113-understanding-analysis-results)
    - 11.4 [Viewing Analysis History](#114-viewing-analysis-history)
12. [Working with Requirements](#12-working-with-requirements)
    - 12.1 [What Is a Requirement?](#121-what-is-a-requirement)
    - 12.2 [Requirement Properties](#122-requirement-properties)
    - 12.3 [Filtering and Searching](#123-filtering-and-searching)
    - 12.4 [The Traceability Matrix](#124-the-traceability-matrix)
    - 12.5 [Editing Requirements](#125-editing-requirements)
    - 12.6 [Approving Requirements](#126-approving-requirements)
    - 12.7 [Linking Requirements to Database Tables (Data Mappings)](#127-linking-requirements-to-database-tables-data-mappings)
    - 12.8 [Linking Requirements to Each Other (Requirement Links)](#128-linking-requirements-to-each-other-requirement-links)
    - 12.9 [Version History & Audit Trail](#129-version-history--audit-trail)
    - 12.10 [Workspace Traceability Rollup](#1210-workspace-traceability-rollup)
13. [Publishing to GitHub](#13-publishing-to-github)
    - 13.1 [Setting Up GitHub Integration](#131-setting-up-github-integration)
    - 13.2 [Generating Issue Drafts](#132-generating-issue-drafts)
    - 13.3 [Reviewing Drafts](#133-reviewing-drafts)
    - 13.4 [Approving Drafts](#134-approving-drafts)
    - 13.5 [Batch Publishing](#135-batch-publishing)
    - 13.6 [Viewing Publish History](#136-viewing-publish-history)
    - 13.7 [Phase 9 Publishing — Advanced Workflow](#137-phase-9-publishing--advanced-workflow)
14. [Using the AI Chat](#14-using-the-ai-chat)
    - 14.1 [Starting a Conversation](#141-starting-a-conversation)
    - 14.2 [What the AI Can Help With](#142-what-the-ai-can-help-with)
    - 14.3 [AI Tools](#143-ai-tools)
    - 14.4 [Token Budget](#144-token-budget)
15. [Managing Git Repositories](#15-managing-git-repositories)
    - 15.1 [Why Connect Repositories?](#151-why-connect-repositories)
    - 15.2 [Adding a Repository](#152-adding-a-repository)
    - 15.3 [Repository Brain](#153-repository-brain)
    - 15.4 [Syncing Repositories](#154-syncing-repositories)
16. [Database Connections](#16-database-connections)
    - 16.1 [Why Connect Databases?](#161-why-connect-databases)
    - 16.2 [Adding a Database Connection](#162-adding-a-database-connection)
    - 16.3 [Inspecting Database Schema](#163-inspecting-database-schema)
17. [Jira Integration](#17-jira-integration)
    - 17.1 [Why Connect Jira?](#171-why-connect-jira)
    - 17.2 [Adding a Jira Connection](#172-adding-a-jira-connection)
    - 17.3 [Browsing Jira Issues](#173-browsing-jira-issues)
    - 17.4 [Security Notes](#174-security-notes)
18. [The Secret Vault](#18-the-secret-vault)
19. [Background Tasks](#19-background-tasks)
20. [Settings](#20-settings)
    - 20.1 [Profile](#201-profile)
    - 20.2 [Appearance](#202-appearance)
    - 20.3 [Notifications](#203-notifications)
    - 20.4 [API & Integrations](#204-api--integrations)
21. [User Roles and Permissions](#21-user-roles-and-permissions)
22. [The Complete Workflow — Start to Finish](#22-the-complete-workflow--start-to-finish)
23. [API Usage (For Developers)](#23-api-usage-for-developers)
24. [Troubleshooting](#24-troubleshooting)
25. [Frequently Asked Questions](#25-frequently-asked-questions)
25. [Closed-Loop PR Reviews (v1.2.0)](#25-closed-loop-pr-reviews-v120)
26. [Spec Kit — Phased Spec-Driven Workflow (v1.2.0)](#26-spec-kit--phased-spec-driven-workflow-v120)
27. [MCP Federation — Discovering External Servers (v1.2.0)](#27-mcp-federation--discovering-external-servers-v120)
28. [Eval Leaderboard — Benchmarking Agent Performance (v1.2.0)](#28-eval-leaderboard--benchmarking-agent-performance-v120)
29. [Code-Execution Sandbox — QA-agent now runs your tests in isolation (v1.2.x)](#29-code-execution-sandbox--qa-agent-now-runs-your-tests-in-isolation-v12x)
30. [Auto Documentation Generator (Epic #486)](#30-auto-documentation-generator-epic-486)
31. [Model Selection — Choosing the Right AI Model (Epic #593)](#31-model-selection--choosing-the-right-ai-model-epic-593)

---

## 1. What Is METIS and Why Do I Need It?

### The Problem

When organizations need to build or modify software systems, someone — usually a Business Analyst — must go through a lengthy process:

1. Read through stacks of business documents, policies, and regulations
2. Examine existing code in software repositories
3. Inspect existing databases to understand current data structures
4. Research industry standards and best practices
5. Write detailed requirements describing what needs to change
6. Create work items (like GitHub issues) for the development team

This process is **manual, time-consuming, and error-prone**. It typically takes weeks of work, important details can be missed, and requirements may be inconsistent.

### The Solution

**METIS** automates this entire process using artificial intelligence. It:

- **Reads** your business documents and extracts important information
- **Analyzes** your existing code to understand the current system
- **Inspects** your databases to understand data structures
- **Researches** industry standards and best practices
- **Synthesizes** all findings into clear, actionable requirements
- **Publishes** requirements directly as GitHub issues for your development team

What would take a team weeks of work, METIS accomplishes in minutes — and it does it with consistency, traceability, and thoroughness that surpasses manual effort.

### Who Is METIS For?

- **Business Analysts** who want to accelerate requirements gathering
- **Project Managers** who need to quickly scope work and create backlogs
- **Development Teams** who want well-structured, traceable issues
- **Enterprise Organizations** that need audit trails and compliance documentation

---

## 2. Key Concepts and Terminology

Before diving in, let's define some terms you'll encounter throughout this guide:

| Term | What It Means |
|---|---|
| **Project** | A container that groups related documents, analyses, and requirements together. For example, "OASIS Market Redesign" would be a project. |
| **Document** | A file you upload to a project for the AI to analyze. Can be PDF, Word, Excel, Markdown, or plain text. |
| **Analysis** | The process where AI agents examine your documents, code, and databases to discover requirements. |
| **Requirement** | A specific thing that needs to be built, changed, or fixed. Has a title, description, priority, and type. |
| **Draft** | A GitHub issue that METIS has prepared but hasn't published yet. You can review and edit it before publishing. |
| **Publishing** | The act of creating actual GitHub issues from approved drafts. |
| **Knowledge Base** | A searchable database of text extracted from your uploaded documents. The AI uses this to answer questions accurately. |
| **Repository** | A Git code repository (like on GitHub) that METIS can analyze. |
| **Brain** | An AI-generated summary of a repository — its architecture, technologies, key files, and dependencies. |
| **Session** | An AI chat conversation. Each session maintains its own context and history. |
| **Task** | A background job submitted to the task engine (like running an analysis). Runs asynchronously while you continue working. |
| **Vault** | A secure, encrypted storage for sensitive information like API keys and passwords. |
| **Token** | The unit of measurement for AI usage. Roughly 4 characters = 1 token. METIS tracks tokens to manage cost. |
| **RAG** | Retrieval-Augmented Generation — a technique where the AI retrieves relevant document chunks before generating answers, making responses much more accurate. |
| **Epic** | A large GitHub issue that represents a major piece of work, containing multiple smaller features. |
| **Feature** | A regular GitHub issue representing a single piece of work. |

---

## 3. Prerequisites — What You Need Before Starting

Before installing METIS, make sure you have the following software on your computer:

### Required

| Software | Minimum Version | What It Is | How to Check |
|---|---|---|---|
| **Node.js** | 22.12.0 | The runtime that executes METIS | Run `node --version` in your terminal |
| **pnpm** | 10.16.0 | The package manager METIS uses for installing dependencies | Run `pnpm --version` in your terminal |
| **Git** | 2.0+ | Version control system | Run `git --version` in your terminal |

> **METIS uses pnpm, not npm.** The repository is a pnpm workspace — `server/` and `ui/`
> depend on `packages/shared` through pnpm's `workspace:*` protocol, and the dependency
> tree is pinned by `pnpm-lock.yaml`. `npm install` does not understand either, so it
> will not produce a working tree. The minimum versions above are enforced by the
> `engines` field in `package.json`: too old a Node or pnpm stops the install with an
> error rather than failing later in a confusing way.

### Optional (for Docker deployment)

| Software | What It Is | How to Check |
|---|---|---|
| **Docker** | Container runtime for running the app in isolated containers | Run `docker --version` |
| **Docker Compose** | Tool for running multi-container Docker applications | Run `docker compose version` |

### Installing Node.js

If you don't have Node.js:

1. Go to [https://nodejs.org](https://nodejs.org)
2. Download the **LTS** (Long Term Support) version — it must be 22.12.0 or higher
3. Run the installer and follow the prompts
4. Open a new terminal window and verify with `node --version`

If you already use a version manager, the repository pins its Node version in `.nvmrc`,
so `nvm use` from the project root selects the right one for you.

### Installing pnpm

pnpm ships with Node.js via Corepack — you do not need a separate download:

```bash
corepack enable
corepack prepare pnpm@10.33.0 --activate
```

Verify with `pnpm --version`. If `corepack` is not on your PATH, install pnpm directly
with `npm install -g pnpm@10.33.0` instead.

### Installing Git

If you don't have Git:

- **macOS**: Open Terminal and run `xcode-select --install`
- **Windows**: Download from [https://git-scm.com](https://git-scm.com)
- **Linux**: Run `sudo apt install git` (Ubuntu/Debian) or `sudo dnf install git` (Fedora)

---

## 4. Installation

You have two options for running METIS:

### 4.1 Option A: Run Locally (Recommended for Development)

This runs METIS directly on your computer. Best for individual developers and day-to-day development work.

**Step 1: Get the code**

Open your terminal and run:

```bash
git clone https://github.com/openzigs/metis.git
cd metis
```

This downloads the METIS source code to your computer and enters the project directory.

**Step 2: Install dependencies**

```bash
pnpm install
```

This reads the project's `package.json` file and downloads all the libraries METIS needs. This may take a minute or two depending on your internet speed. It installs dependencies for the server, UI, and shared packages all at once.

> Use `pnpm`, not `npm` — see the note in [Section 3](#3-prerequisites--what-you-need-before-starting).

Then build the shared types package, which the server imports at startup:

```bash
pnpm --filter @metis/shared build
```

**Do not skip this.** Installing does not build it, and without `packages/shared/dist` the
server exits immediately with `Cannot find module '@metis/shared/dist/index.js'` — while
the UI still starts and looks healthy, so the failure is easy to misread as a UI problem.
Re-run this command whenever you pull changes that touch `packages/shared`.

**Step 3: Set up environment variables**

```bash
cp .env.example .env
```

This creates a `.env` file from the provided template. The default values work out of the box for development. See [Section 5: Configuration](#5-configuration) if you want to customize settings.

**Step 4: Set up the database**

```bash
pnpm db:generate
pnpm db:migrate
```

The first command generates the database client code. The second creates the database tables. By default, this creates a SQLite database file at `server/dev.db` — no database server needed.

**Step 5: (Optional) Seed sample data**

```bash
pnpm db:seed
```

This populates the database with sample data so you can explore METIS right away without creating everything from scratch. It prints a summary of what it wrote, and it is idempotent — running it twice is safe.

**Step 6: Start METIS**

```bash
pnpm dev
```

This starts both the server (port 4000) and UI (port 3000) simultaneously. You'll see output from both in your terminal.

**Step 7: Open METIS**

Open your web browser and go to:

```
http://localhost:3000
```

You should see the METIS landing page!

### 4.2 Option B: Run with Docker (Recommended for Teams)

Docker packages METIS into containers that run the same way on every computer. Best for teams and production-like environments.

> **First time?** Skip the manual steps and run [`docs/LOCAL_QUICKSTART.md`](./LOCAL_QUICKSTART.md) — a single `pnpm bootstrap` does steps 2 & 3 below for you and pre-pulls the MCP wrapper images. ([Epic #359](https://github.com/openzigs/metis-private/issues/359))

**Step 1: Get the code**

```bash
git clone https://github.com/openzigs/metis.git
cd metis
```

**Step 2: Set up environment variables**

```bash
cp .env.example .env
# …or, the recommended path:
pnpm bootstrap                # generates .env + the four required secrets
```

`pnpm bootstrap` is idempotent — running it twice is a no-op and never rotates secrets.

**Step 3: Start with Docker Compose**

For development:
```bash
docker compose up --build
# …or the recommended one-liner that also waits for /readyz=200:
pnpm bootstrap:up
```

For production:
```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up --build -d
```

The `-d` flag runs containers in the background (detached mode). The `--build` flag rebuilds the images if the code has changed.

This starts **five containers** (refreshed for v1.3 — Issue [#364](https://github.com/openzigs/metis-private/issues/364)):

| Container          | Port  | Purpose                                                         |
| ------------------ | ----- | --------------------------------------------------------------- |
| `metis-ui`         | 3000  | Next.js web interface                                           |
| `metis-server`     | 4000  | Express + Socket.IO API server                                  |
| `metis-postgres`   | 5432  | PostgreSQL 16 database (data persisted in `postgres_data` volume) |
| `metis-embeddings` | 5050* | RAG embeddings + cross-encoder reranker (Xenova/bge-small)      |
| `metis-copilot`    | 5060* | Optional GitHub Copilot SDK sidecar — only when the `copilot-native` profile is active |

\* internal-only; reachable from `metis-server` on the `metis` bridge network, not exposed to the host by default.

In addition to the five core containers above, the server **dynamically spawns one wrapper container per registered `runtime: docker-stdio` MCP server** on the auto-created `metis-mcp` bridge network ([Issue #361](https://github.com/openzigs/metis-private/issues/361)). Wrapper images live at `ghcr.io/metis-mcps/{uvx,jbang,node,npx}-runner` (and their `*-sse` variants) — see [`images/mcp-wrappers/README.md`](../images/mcp-wrappers/README.md).

**Step 4: Open METIS**

Open your web browser and go to:

```
http://localhost:3000
```

**Stopping Docker:**

```bash
# Stop containers (preserves data)
docker compose down

# Stop containers and delete all data
docker compose down -v
```

---

## 5. Configuration

METIS is configured through **environment variables** — settings stored in a `.env` file at the root of the project. Think of it like a settings file where each line sets one option.

### 5.1 Environment Variables Overview

When you copied `.env.example` to `.env`, you got a file with sensible defaults for development. Here's what you can customize:

### 5.2 Database Configuration

```dotenv
DATABASE_PROVIDER=sqlite
DATABASE_URL=file:./dev.db
```

**SQLite (default for development):**
- No database server needed — the database is a single file
- Perfect for individual development
- Data is stored in `server/dev.db`

**PostgreSQL (recommended for teams/production):**
```dotenv
DATABASE_PROVIDER=postgresql
DATABASE_URL=postgresql://metis:metis@localhost:5432/metis
```
- Requires a PostgreSQL server (included in Docker Compose)
- Handles multiple concurrent users
- Better performance with large datasets

### 5.3 Authentication Configuration

```dotenv
AUTH_MODE=mock
JWT_SECRET=your-development-jwt-secret-change-in-production
```

**Mock Mode (default for development):**
- Provides 4 test accounts (see [Section 7: Logging In](#7-logging-in))
- No external auth server needed
- **Never use in production!**

**LDAP / Active Directory Mode (direct username+password against AD):**
```dotenv
AUTH_MODE=ldap
AUTH_LDAP_URL=ldaps://ad.example.com:636
AUTH_LDAP_BASE_DN=DC=ad,DC=example,DC=com
AUTH_LDAP_BIND_DN=CN=svcaccount,OU=Service Accounts,DC=ad,DC=example,DC=com
AUTH_LDAP_BIND_PASSWORD=your-service-account-password
AUTH_LDAP_USER_SEARCH_BASE=OU=Standard Users,DC=ad,DC=example,DC=com
AUTH_LDAP_SEARCH_FILTER=(&(objectClass=user)(sAMAccountName={{username}}))
AUTH_LDAP_TLS_SKIP_VERIFY=true
AUTH_LDAP_CONNECTION_TIMEOUT=10000
```
- Connects to your organization's LDAP/Active Directory server
- Users log in with their AD username and password via the standard login form
- Group memberships (`memberOf` attribute) are mapped to METIS roles via the Admin UI
- TLS skip verify is needed for internal/self-signed CA certificates

> **Admin UI alternative:** All LDAP settings can also be configured at runtime via the Admin → SSO & Authentication → LDAP / AD tab. Admin UI settings override environment variables.

**SAML 2.0 Mode (redirect-based SSO via an Identity Provider):**
```dotenv
AUTH_MODE=saml
```
- Users click an SSO button on the login page and are redirected to the IdP (Okta, Azure AD, etc.)
- After authenticating at the IdP, users land back in METIS with an active session
- Configure the SAML provider details (IdP metadata XML, SP Entity ID, ACS URL) in the Admin → SSO & Authentication → SAML 2.0 tab
- See `docs/auth/okta.md`, `docs/auth/azure-ad.md` for IdP-specific setup guides

> **Secret handling (Admin → SSO).** For security (OWASP A09), the admin config-read API never returns stored secrets — the SP private key, certificates, and IdP metadata XML (SAML) and the client secret (OIDC) are masked as "configured" presence flags, not raw values. The corresponding form fields therefore stay **blank** when you reopen the tab. **Leave a secret field blank to keep the stored value**; type a new value only to replace it. Submitting the form blank never wipes an existing secret.

**OIDC Mode (OpenID Connect with PKCE):**
```dotenv
AUTH_MODE=oidc
```
- Users click an SSO button on the login page and are redirected to the OIDC provider
- PKCE (Proof Key for Code Exchange) is always enabled for security
- MFA passthrough: if the IdP's token contains `amr` values indicating MFA, the session is flagged `mfaPassed=true`
- Configure the OIDC provider details (Discovery URL, Client ID, Client Secret, Redirect URI) in the Admin → SSO & Authentication → OIDC tab
- See `docs/auth/google-workspace.md`, `docs/auth/keycloak.md` for provider-specific guides

**SCIM 2.0 Provisioning (automated user/group sync):**

SCIM works alongside any auth mode to allow your IdP to automatically create, update, and deactivate users in METIS:
- Endpoint: `https://your-metis-url/api/scim/v2/Users` and `/Groups`
- Bearer token: generate via Admin → SSO & Authentication → SCIM tab → "Rotate SCIM Token"
- Supports: user provisioning, deprovisioning (soft-disable + session revocation), group-to-role mapping
- Compatible with Okta, Azure AD, and any SCIM 2.0–compliant IdP

**Group-to-Role Mappings:**

All SSO and LDAP modes support mapping IdP group claims to METIS roles. Configure in Admin → SSO & Authentication → Role Mappings tab:
- Map IdP group names (e.g. `METIS-Admins`) to METIS roles (`admin`, `coordinator`, `developer`, `reader`)
- The highest-privilege matching role wins when a user belongs to multiple groups
- A default role (fallback when no mapping matches) can be set per provider

**Explicit assignments and revocation:** Database and SCIM role assignments take
precedence over provider-group mappings; the highest recognized explicit role wins.
Provider-only grants follow the current mapping on each successful login, including
downgrades. Removing all grants from an initialized account leaves it at `reader`:
another provider login cannot silently restore its former administrator access.
SCIM membership changes discard provider grants without converting or removing an
explicit local assignment. Newly SCIM-provisioned users remain `reader` until assigned
a role. Legacy assignments retain `unknown` explicit provenance; SCIM can still
revoke a specifically targeted legacy membership. Generated-document
requests and workers recheck current roles, account status, and workspace membership;
they do not authorize from saved JWT or generation-time role claims.

**Upgrade note:** Existing accounts are marked initialized during migration because
an empty legacy role set cannot be distinguished from intentional revocation.
Existing role-less accounts therefore remain `reader` until explicit administrator
reconciliation (below) or SCIM assignment; only newly created, non-SCIM accounts
bootstrap provider grants. The approved migration policy is **fail closed with
explicit administrator reconciliation**, not automatic recovery from old JWT claims.
Removing an absent SCIM membership is a no-op, not a revocation of unrelated roles.

#### Legacy account access recovery (#1350)

Before upgrading, identify a durable administrator and review the affected account's
METIS ID, exact username, current IdP mapping, and provisioning/revocation history.
Do not infer approval from an old administrator JWT or from an empty role list.
SQLite and PostgreSQL use additive migrations; neither migration deletes role rows.
Known SCIM provenance (including user creation/deletion SCIM audits) is retained
in `authRoleAuthority`, even after the last SCIM role is removed. Historical
generic update audits cannot distinguish profile edits from lifecycle changes,
and group-only audit entries cannot identify former members: verify such ambiguous
accounts against the provisioning system before approving provider management.
Profile-only and redundant same-status SCIM updates preserve provider access; actual lifecycle/membership
decisions establish SCIM authority. Known authority blocks leftover provider rows
at trusted login and live/background authorization, while explicit grants still win.

**Existing administrator: supported API workflow.** Use an authenticated API client
with `Authorization: Bearer <access token>` and `Content-Type: application/json`.
Cookies alone are deliberately refused. The endpoints are rate limited and accept
at most 4 KB; extra JSON fields are rejected. There is no new admin UI screen.

1. POST `/api/admin/auth/role-reconciliation/inspect` with `targetId` and `username`.
  Read `data.state` (identity, status, authority, role sources and timestamps) and
  retain `data.fingerprint`. This request does not change access.
2. POST `/api/admin/auth/role-reconciliation/confirm` with the same `targetId` and
  `username`, `expectedFingerprint` from inspection, a new UUID `requestId`, a
  10–1,000 character `reason` recording the verification, and one `decision`:

  | Decision | Result |
  |---|---|
  | `provider-managed` | Explicitly approve future provider management. Only a provider-sourced **reader** row is installed now. Any explicit assignment or known SCIM authority blocks this decision. |
  | `keep-explicit` | Preserve explicit assignments, remove provider grants, and keep the account outside provider management. An empty set stays reader. |
  | `revoked` | Revoke **provider** grants; preserve all explicit assignments and SCIM authority. This is not account disablement or removal of local/SCIM roles. |

3. Verify the returned state. For `provider-managed`, have the user sign out and
  perform a **fresh trusted login** through their configured provider. Token
  refresh alone does not refresh provider mappings. The next successful login
  records the current trusted role; the approval itself cannot grant elevated
  access. Generated-document requests and workers then read that durable role.

Both inspection and confirmation require a currently active **durable** administrator
inside the transaction. A stale admin JWT, ordinary user, disabled administrator,
or administrator acting on their own account cannot approve. Confirmation is scoped
to both account ID and username. A `409` means re-inspect and review the changed
state; do not blindly replace the fingerprint. Serialization conflicts also fail
closed. An identical request with the same UUID returns `replayed: true` only while
the committed result still matches; changed payloads or intervening changes fail.
State changes and the `admin.auth.role-reconciled` audit entry commit together.

**No remaining durable administrator: trusted host recovery.** A deployment operator
with OS execution and database access can use the supported
[recovery CLI](../server/src/lib/auth/role-reconciliation-cli.ts). This is the
privileged maintenance boundary, not a user self-service bypass. Run from the repo
root with the deployment database environment already loaded and the matching
Prisma client generated; never pass credentials in command arguments or tickets.
Use `pnpm --filter @metis/server exec tsx src/lib/auth/role-reconciliation-cli.ts`
with the following arguments (values shown as placeholders):

| Operation | Required arguments |
|---|---|
| Inspect | `inspect --operator "Named administrator" --acknowledge-host-authority --target-id ID --username USER` |
| Confirm | `confirm --operator "Named administrator" --acknowledge-host-authority --target-id ID --username USER --expected-fingerprint HASH --request-id UUID --decision provider-managed --reason "Verified identity and current IdP ownership" --confirm "ID:USER:provider-managed"` |

The final confirmation must exactly match the selected ID, username and decision.
Inspection prints the fingerprint; use a new UUID for each new decision. Host
approval is audited by operator name and still cannot override explicit or SCIM
authority. First recover only the verified provider-managed administrator, have
them log in freshly, then use the API for other accounts. Never run the general
seed/reset commands as an access-recovery shortcut or manually clear markers.

**Rollback/recovery:** To cancel provider approval, inspect again and confirm
`revoked` with a new UUID and reason; use the same API or host CLI, changing the
CLI's exact `--confirm` suffix accordingly. Explicit grants remain intact and must
be managed at their owning local/SCIM source. An erroneously revoked provider-only
account can be re-inspected and explicitly reapproved. Known SCIM authority is
never cleared by this workflow: recover its roles through SCIM. Do not roll back to
old JWT-trusting authorization code to restore access. Leave the additive schema
and audit history in place; if a full deployment restore is necessary, use the
coordinated database/application backup procedure in the [DR runbook](DR_RUNBOOK.md).

> **More:** see [`docs/auth/`](auth/README.md) for the full authentication docs —
> the authoritative `AUTH_LDAP_*` env-var and admin-API SAML/OIDC config-field
> reference, the SAML security posture (#520), and one-command
> [local IdP test harnesses](auth/local-testing.md) (`make oidc-up`/`saml-up`/`ldap-up`).

**Important**: The `JWT_SECRET` must be changed to a strong, random value in production. This secret is used to sign authentication tokens — if someone knows it, they can forge tokens and impersonate any user.

### 5.4 AI Configuration

```dotenv
AI_TOKEN_BUDGET=100000
```

This controls the maximum number of AI tokens per session. The default (100,000) is enough for several hours of complex analysis. One token ≈ 4 characters of text.

For production with the Copilot SDK:
```dotenv
COPILOT_API_KEY=your-copilot-api-key
COPILOT_MODEL=gpt-4o
```

#### Choosing an Embedding Backend

METIS turns your uploaded documents into searchable vectors using a pluggable
**embedding backend**. The backend is selected with `EMBED_BACKEND` and the
specific model with `EMBED_MODEL`:

| `EMBED_BACKEND` | Runs where | `EMBED_MODEL` (default) | Dimension | Sends your text off-box? |
|---|---|---|---|---|
| `offline` (aka `hash`) | In-process, deterministic stub | `offline-hash` | 384 | No — fully air-gapped |
| `xenova` | In-process ONNX (downloaded weights) | `Xenova/bge-small-en-v1.5` | 384 | No (after one-time model download) |
| `embeddinggemma` | In-process ONNX (downloaded weights) | `onnx-community/embeddinggemma-300m-ONNX` | 768 (Matryoshka: 768/512/256/128 via `EMBED_DIM`) | No (after one-time model download) |
| `sidecar` | In-cluster `metis-embeddings` HTTP service | `Xenova/bge-small-en-v1.5` | 384 | No — stays inside your cluster |
| `bedrock` / `bedrock-sdk` | AWS Bedrock API | `amazon.titan-embed-text-v2:0` | 1024 | **Yes** — text egresses to AWS |
| `openai` | Azure / OpenAI API | `text-embedding-3-small` | 1536 | **Yes** — text egresses to the API |

**Data-egress tradeoff:** `offline`, `xenova`, `embeddinggemma`, and `sidecar`
keep document text on your own infrastructure. The cloud backends (`bedrock`,
`openai`) generally produce higher-quality embeddings but **send the raw chunk
text to a third-party API** — only use them where your data-handling policy
allows it. See [docs/EMBEDDINGS_BACKENDS.md](EMBEDDINGS_BACKENDS.md) for the full
backend matrix, model ids, and air-gapped (`HF_HUB_OFFLINE`) setup.

> ⚠️ **Switching backends REQUIRES a re-index.** Different models emit vectors of
> different dimensions (384 → 768 → 1024 → 1536), and even same-dimension models
> live in different vector spaces, so old vectors are not comparable to new ones.
> After changing `EMBED_BACKEND` or `EMBED_MODEL` you **must** re-index every
> project whose documents were embedded with the previous model. Until you do,
> search for those projects keeps returning results from the **old** model.

**How to re-index:** an admin triggers it per project from
**Admin → Embeddings**, or via the API:

```bash
curl -X POST \
  http://localhost:4000/api/admin/embeddings/projects/<projectId>/reindex \
  -H "Authorization: Bearer <admin-token>"
```

The re-index rebuilds the vector table into a **shadow table** first and only
swaps it in atomically once every chunk has been re-embedded successfully — so
searches keep serving the old index throughout, and a failure mid-run leaves the
live index untouched (never empty). A second re-index of the same project while
one is in flight is rejected with HTTP `409 REINDEX_IN_PROGRESS`.

#### Pre-Downloading Embedding Models (`prefetch:embeddings`)

The `xenova` and `embeddinggemma` backends download their model weights from
HuggingFace on first use. To avoid a slow cold-start (or to bake the cache into
a container image / air-gapped bundle), pre-download the configured model:

```bash
pnpm --filter @metis/server prefetch:embeddings
```

The script loads the model configured by `EMBED_BACKEND` / `EMBED_MODEL` once,
forcing the download into the transformers cache, then prints the resolved cache
path and exits `0`. It is a graceful no-op for non-downloadable backends
(`offline`, `sidecar`, cloud APIs) and, when `HF_HUB_OFFLINE=1` is set, does not
attempt any network access — it just reports the cache the model must already
occupy. It honours `TRANSFORMERS_CACHE` / `HF_HOME` and standard proxy variables
(`HTTPS_PROXY`, `HF_ENDPOINT`). The server and embeddings Dockerfiles can invoke
it at build time to pre-bake the cache (see the comments in
[Dockerfile.server](../Dockerfile.server) and
[Dockerfile.embeddings](../Dockerfile.embeddings)).

#### Point METIS at a local OpenAI-compatible endpoint (PC vLLM / Mac Ollama)

You can run a model **on your own hardware** and have METIS stream from it —
keeping prompt and document content on-prem — by pointing the **`local-gemma`**
provider at any OpenAI-compatible `/v1` server. No new provider code is needed;
it is three env vars:

```dotenv
AI_PROVIDER=local-gemma
LOCAL_GEMMA_BASE_URL=http://localhost:11434/v1   # MUST end in /v1
LOCAL_GEMMA_MODEL=qwen2.5:14b                     # the model your server serves
LOCAL_GEMMA_API_KEY=ollama                        # dummy bearer; some servers (vLLM) enforce a real one
```

`LOCAL_GEMMA_BASE_URL` must be a **loopback or private (RFC-1918)** host — the
validator refuses public LLM hosts so content can never egress. For a model on
another box, use that box's **private LAN IP** or an **SSH tunnel to loopback**.

> **Full operator runbook:** see **[docs/ops/local-serving.md](ops/local-serving.md)**
> for exact start commands and the fallback ladder for the two reference machines
> — the **PC** (2× RTX 3060, vLLM `--tensor-parallel-size 2` with a documented
> PCIe-TP hang fallback) and the **Mac** (Apple M4 Pro 24 GB, Ollama on Metal,
> below the MLX 32 GB threshold). Verify any endpoint with the included smoke test
> `node scripts/local-llm/smoke-test.mjs --base <url> --model <id>`.

> **⚠️ Avoid reasoning models for doc-generation.** The current default
> `gemma4:12b` is a *reasoning* model: over `/v1` it spends the token budget in a
> `reasoning` field and returns **empty** content at low `max_tokens`
> (`finish_reason: length`), and reasoning models hallucinate more on faithful
> extraction. Use a clean **instruct** model — `qwen2.5:14b`, or Qwen3-14B with
> thinking disabled — for local doc-gen. The smoke test flags this trap explicitly.

#### Run Gemma locally on a Windows GPU box

You can run a local Gemma model (chat/stream) on a Windows machine with an
NVIDIA GPU instead of using Copilot or AWS Bedrock — keeping prompt and document
content on-box. This uses the **existing** `local-gemma` provider (Epic #183,
Initiative B): no new provider code, just Ollama + per-machine env overrides.

> **Scope & safety:** every setting below is a **per-machine override**. It does
> **not** change the macOS/Linux defaults (the `gemma4:12b` default in
> `server/src/lib/ai/config.ts` is unchanged). `LOCAL_GEMMA_BASE_URL` must be a
> loopback/private host — the validator refuses public LLM hosts so document
> content can never egress.

**Step 1 — Install and run Ollama as a managed service (B1).**
Install Ollama (`winget install Ollama.Ollama` or the installer from
ollama.com). Ollama exposes an OpenAI-compatible API at
`http://localhost:11434/v1`. Ollama has **no native Windows Service**, so pick
one of these to keep `ollama serve` running:

- **Task Scheduler at logon (recommended, no admin):** create a task that runs
  `ollama serve` "At log on" for your user, "Run only when user is logged on".
  Simplest and survives reboots once you log in.
- **NSSM wrapper (runs without an interactive login):** install
  [NSSM](https://nssm.cc/) and `nssm install Ollama "%LOCALAPPDATA%\Programs\Ollama\ollama.exe" serve`.
  Requires admin to install the service; runs at boot.
- **Manual:** just run `ollama serve` in a terminal for ad-hoc use.

Verify it is up: `curl http://localhost:11434/v1/models` should return a JSON
model list. This is the exact endpoint METIS's `provider.ping()` probes, so
`/readyz` will report AI `ok` when Ollama is running and `degraded` when it is
not (no extra configuration — it uses the existing health path).

**Step 2 — Pull a Gemma model (B2, model-tag verified).**
The Gemma `gemma4` tags verified against Ollama 0.20.4 (June 2026):

| Tag | Size | Class | Where it fits |
|---|---|---|---|
| `gemma4:26b` | ~17 GB (Q4_K_M, 25.8B params, 256k ctx) | large | Split across 2+ GPUs (~24 GB total) |
| `gemma4:12b` | ~7.4 GB, vision-capable | medium | A single 12 GB card — **this is the repo default** |
| `gemma4:e4b` | ~9.6 GB (Q4_K_M, 8B-class) | small | A single smaller card, or CPU fallback |

```powershell
ollama pull gemma4:12b      # single 12 GB card (default)
# or, for the 2× RTX 3060 box below:
ollama pull gemma4:26b
```

**Step 3 — Point METIS at it.** Add to your `.env` (per-machine override only):

```dotenv
AI_PROVIDER=local-gemma
LOCAL_GEMMA_BASE_URL=http://localhost:11434/v1   # /v1 suffix is required
LOCAL_GEMMA_MODEL=gemma4:12b                      # choose per your GPU (see below)
LOCAL_GEMMA_API_KEY=ollama                        # dummy bearer; header required, value ignored
```

Switching back is a one-line `AI_PROVIDER=bedrock-gateway` (or `copilot-native`)
change.

**GPU-aware variant selection (B2).** METIS ships a helper
(`server/src/lib/ai/gemma-variant.ts`) that maps detected VRAM to a recommended
tag. The decision rules:

- **2× NVIDIA RTX 3060 12 GB (24 GB total, CUDA compute 8.6)** — the reference
  box for this epic. Ollama auto-splits a large model across both cards, so
  `gemma4:26b` is recommended. To pin which GPUs Ollama uses, set
  `CUDA_VISIBLE_DEVICES=0,1` (both) before `ollama serve`.
- **Single 12 GB card** → `gemma4:12b`.
- **Single smaller card (≥7 GB)** → `gemma4:e4b`.
- **No GPU / compute capability below 5.0** → `gemma4:e4b` on CPU (works, but
  slow).

CUDA compute capability 8.6 (Ampere, RTX 3060) is well within Ollama's CUDA
build requirement (≥ 5.0). You can detect your profile with
`nvidia-smi --query-gpu=memory.total,compute_cap --format=csv,noheader` and feed
it to `recommendFromNvidiaSmi(...)`, or just pick from the table above.

**Embeddings stay in-process (B3 — explicit non-goal).** `local-gemma` is
**chat/stream only**. Embeddings continue to use the existing embedding backend
(default in-process `xenova`, see the embedding-backend table above) — running
embeddings through local Gemma/Ollama is an **explicit non-goal** by design: the
Gemma provider exposes no embeddings endpoint, and keeping the embedder separate
means switching chat to local Gemma never forces a vector re-index. `local-gemma`
chat and `xenova` embeddings coexist with no config conflict on the same box.

**Docker/Kubernetes note:** the validator accepts only `localhost` and IP
literals, so DNS service names like `http://ollama:11434/v1` are rejected. In
containers, use a loopback/host-network address or the Ollama pod IP (e.g.
`http://10.0.0.12:11434/v1`). See also the Windows onboarding section in
[docs/DEVELOPMENT.md §7.6](DEVELOPMENT.md#76-windows-11-developer-onboarding-epic-183).

<a id="run-gemma-locally-on-a-windows-gpu-box"></a>

### 5.5 GitHub Integration

To publish issues to GitHub, you need a GitHub token:

```dotenv
GITHUB_TOKEN=ghp_your_personal_access_token
```

**How to get a GitHub token:**
1. Go to [GitHub.com](https://github.com) → Settings → Developer settings → Personal access tokens → Tokens (classic)
2. Click "Generate new token (classic)"
3. Give it a name (e.g., "METIS")
4. Select these scopes: `repo` (full control of private repositories)
5. Click "Generate token"
6. Copy the token and paste it in your `.env` file

Alternatively, for organizations, you can use a GitHub App:
```dotenv
GITHUB_APP_ID=your-app-id
GITHUB_APP_PRIVATE_KEY=your-app-private-key
```

### 5.6 Optional Services

**Oracle Database** (for inspecting Oracle databases):
```dotenv
ORACLE_TNS_ADMIN=/opt/oracle/tns
ORACLE_CLIENT_DIR=/opt/oracle/instantclient
```

**Brave Web Search** (for web research during analysis):
```dotenv
BRAVE_API_KEY=your-brave-search-api-key
```

---

## 6. Starting METIS

### Local Development

Run this single command from the project root:

```bash
pnpm dev
```

This starts both the server and UI simultaneously. You'll see colored output in your terminal:

- **Server** messages (Express API, database connections, Socket.IO)
- **UI** messages (Next.js compilation, page routes)

Wait until you see messages indicating both are ready (typically 5-10 seconds).

### Other Useful Commands

| Command | What It Does |
|---|---|
| `pnpm dev` | Start both server and UI in development mode |
| `pnpm build` | Build both for production |
| `pnpm test` | Run all tests (server + UI) |
| `pnpm lint` | Check code for style issues |
| `pnpm format` | Auto-format all code |
| `pnpm db:generate` | Regenerate database client after schema changes |
| `pnpm db:migrate` | Apply database migrations |
| `pnpm db:seed` | Load sample data into the database |
| `pnpm db:studio` | Open a visual database browser |

### Docker

```bash
# Development
docker compose up

# Production
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d

# View logs
docker compose logs -f

# View logs for a specific service
docker compose logs -f server

# Stop
docker compose down
```

---

## 7. Logging In

Open your browser to `http://localhost:3000`. The middleware will redirect you to `/login` if you don't have an active session.

### Development Mode (Mock Authentication)

In development mode (`AUTH_MODE=mock`), METIS provides four test accounts. Sign in with any of:

| Username | Password | Role | What You Can Do |
|---|---|---|---|
| `admin` | `password` | Admin | Everything — full access to all features, settings, and user management |
| `coordinator` | `password` | Coordinator | Manage projects, run analyses, publish issues, but no admin settings |
| `developer` | `password` | Developer | Run analyses, use AI chat, manage repos, but no project deletion or publishing |
| `reader` | `password` | Read-Only | View everything but can't create, modify, or delete anything |

After a successful login the form posts to `/api/auth/login`, which proxies to the upstream Express API and stores your access + refresh tokens as **HttpOnly cookies on the Next.js origin** — your JWT is never accessible to client-side JavaScript. You'll be redirected to the route you were trying to reach (defaults to `/dashboard`).

### Production Mode (LDAP Authentication)

In production with LDAP configured (`AUTH_MODE=ldap`), users authenticate with their organizational AD username and password via the same login form. METIS performs a service-account bind to locate the user, then verifies the password with a user bind. On first login, a local METIS account is automatically created with role determined by group mappings.

### Production Mode (SAML / OIDC SSO)

When `AUTH_MODE=saml` or `AUTH_MODE=oidc` is set and a provider is configured in the Admin UI, the login page displays **SSO buttons** above the standard username/password form:

1. Click the provider button (e.g. "Sign in with Okta")
2. You are redirected to your Identity Provider's login page
3. Authenticate with your corporate credentials (and MFA if required)
4. You are redirected back to METIS with an active session

The buttons are driven by the public `GET /api/auth/sso/providers` endpoint, which the login page calls on load. It returns the **live** list of configured, *enabled* providers — so enabling (or disabling) a provider under **Admin → SSO & Authentication** makes its button appear (or disappear) on `/login` **without a redeploy or restart**. This endpoint is intentionally pre-authentication (the login page is anonymous), so it exposes **only** the minimum each button needs — `{ id, label, type, loginUrl }` — and never returns client secrets, signing keys, certificates, IdP metadata, or any other provider configuration.

If no SSO providers are enabled, the endpoint returns an empty list, **no buttons appear, and no error is shown** — the page renders the standard username/password form alone (which will reject logins when `AUTH_MODE` is set to an SSO mode). The SSO buttons sit alongside the **"Your session expired"** banner (shown when you arrive at `/login?reason=expired`) without any layout collision — both can render together.

### Logging Out

Open the user menu in the top-right of the header and click **Sign out**. The auth proxy clears the HttpOnly cookies and routes you back to `/login`.

---

## 8. The App Shell

After logging in you land on the **Dashboard** inside the persistent app shell:

- **Sidebar** (left, 16 rem) — the 18 destinations are grouped into four labeled sections: **Work** (Dashboard, Projects, Products, Chat, Workbench, Tasks), **Knowledge** (Library, Documents, Repositories, Databases), **Automation** (Skills, Agents, Scheduler, Runs), and **Platform** (Vault, Eval, Settings, Admin). The active route is highlighted and announced via `aria-current="page"`. On viewports smaller than 768 px the sidebar collapses into a slide-in drawer; tap the menu button in the header to open it. The sidebar is the canonical home for Vault, Repositories, and Databases (no longer duplicated under Settings).
- **Header** (top, sticky) — a **Workspace › Project breadcrumb** on the left (each crumb opens a switcher menu; degrades to workspace-only when no project is selected); on the right, the **activity indicator**, theme toggle (light / dark / system), the **notifications bell** (with an unread-count badge), and the user menu.
- **Activity indicator** — a small **"N jobs running"** control that appears in the header **only while something is actually running**, and disappears automatically when everything finishes. It reflects *any* long-running operation — documentation generation, analysis, security scans, PR reviews, imports/syncs, and more — not just one kind. Click it to open a drawer that lists each in-progress job with its type, project, and live progress bar. The count and announcements are accessible to screen readers (announced politely as jobs start and complete). For documentation specifically, you no longer have to open a document to watch it build: a doc that is generating now shows a live progress bar and an "N of M sections" counter **directly on its card in the documentation list**, and clicking **Generate Documentation** takes you straight to the new document's live progress (with a "View progress" toast) instead of leaving you on a static badge. The **Bug Scans** list (`Projects › Scans`) does the same: a running scan now shows a live phase label ("Scanning symbols") and progress bar on its row, and a toast announces the outcome the moment the scan finishes — instead of a status badge that only changed on the next poll. [Epic #406, #422] The **Import Requirements** page (`Projects › Import`) likewise streams live progress: after you click **Import** or **Run now** on a saved source, the page shows a live progress bar with the current step ("Fetched 5/10 issues") for the active run instead of going silent, and a toast announces the result when the run finishes ("Imported 5 new, 2 updated" on success, or a generic "The import sync failed. Please try again." on failure — raw error detail is never shown). The import history below still refreshes on its own as a fallback if the live connection drops, and the ongoing-sync toggle, interval, and **Run now** controls are unchanged. [Epic #406, #424]
- **Consistent completion feedback** — every long-running operation now ends with a clear **success or failure toast**, and you get it **even when you are not on the operation's detail page**. Previously, if you started documentation generation, an analysis, or a test-coverage run and then navigated to a list view (or simply looked away), a *failure* was recorded silently on the row but never announced — you had to notice the badge had changed. Now a single app-wide layer watches the realtime job bus and shows the terminal result wherever you are: a green toast on success (carrying the operation's own message, e.g. the Spec Kit "Generated spec.md (v3) … grounded on N retrieved chunks" line) and a red toast on failure with a **generic, non-revealing message** ("The … operation failed. Please try again.") — raw error detail and stack traces are never shown. Each operation toasts **exactly once**: the surfaces that already announce their own outcome (PR re-review, embeddings reindex, import/sync, Spec Kit, overview regenerate, security scans) are reconciled with this global layer so you never see a duplicate. [Epic #406, #425]
- **Friendly form validation** — forms now guide you instead of dumping raw errors. The **New project** dialog (`Projects › New project`) keeps its **Create** button disabled until the required fields (**Name** and **Slug**) are filled in; leaving **Name** empty shows an inline "Name is required" message right under the field instead of silently doing nothing. The **Import Requirements** page behaves the same way: if a required filter field is missing (for example a GitHub import with no **Owner** or **Repository**), you get a clear inline message beside the offending field — never the previous wall of raw technical error text, and never a generic "something went wrong" page. Behind the scenes, validation problems now come back from the server as a friendly, structured message (a plain "X is required" per field); the application never exposes internal schema details, stack traces, or raw validation arrays to your browser. [Epic #407, #426 — OWASP A09]
- **Main content** — the route's surface (Dashboard widgets by default). The shell owns the page gutter, so pages render with consistent spacing; pending data shows skeleton placeholders and errors show a retry/escape card.
- **Branded "page not found"** — visiting a URL that doesn't exist (for example a mistyped or stale link under a project, such as `/projects/{id}/code`) now shows a **branded 404** with the METIS mark, a clear "Page not found" message, and a **Back to dashboard** button — instead of a bare, unstyled browser-default 404 with no way back. [Epic #407, #430]

A **skip-to-content** link is the first focusable element on every authenticated page so keyboard users can bypass the navigation.

**Project sections.** Inside a project, the tab bar follows the pipeline from left to right: **Overview · Sources · Analyze · Requirements · Docs · Publish · Code · ⚙**. Each tab opens its section's first step in one click, and the section's other pages appear in a row underneath:

| Tab | Pages |
|---|---|
| Overview | Where each stage stands and what to do next; a numbered **Get started** checklist on a new project |
| Sources | Connections (including Deep Ingest), Documents, Import, Jira |
| Analyze | Requirements Analysis, Impact Analysis (this project), Spec Kit |
| Requirements | Review (what is awaiting review), Baselines, Discussions |
| Docs | Documentation, Templates |
| Publish | Issue drafts and publish batches |
| Code | Code Overview, Changes, Pull Requests, Bug Rules, Bug Scans, Test Coverage |
| ⚙ | Project settings, Models, Plugins, Usage |

There is no "More" menu. Project settings (AI provider and model, safety, budget, autopilot, quarantine, archive, …) are behind **⚙**, not on the Overview. Per-project skills are managed from **Library**, which has a project picker. Every existing project URL still works. Below `md` the whole bar collapses into a single dropdown so there's no horizontal scrolling on mobile. **Settings** sub-pages share a persistent left sub-navigation.

Press **⌘K** (or **Ctrl+K** on Windows/Linux) anywhere in the app to open the **command palette**. Type to fuzzy-search navigation targets, recently opened items, and project actions; ↑/↓ to move, **↵** to invoke, **Esc** to dismiss.

---

## 8.1 Dashboard

The Dashboard summarises live activity across four widgets that poll independently:

- **Projects** — your most recent projects with status chips. Empty? Click **Open projects** to create your first one.
- **Active analyses & tasks** — anything currently running, refreshed every 15 seconds.
- **Scheduled jobs** — upcoming and recently fired cron jobs. Open the **Scheduler** surface to add one.
- **Recent activity** — your own recent chat sessions and analyses, drawn from a per-browser `localStorage` log capped at 10 entries per kind.

Each widget shows a skeleton while loading, an actionable empty state with a deep link, and a compact list when populated.

---

## 8.2 Workbench

The Workbench is your hands-on artifact editor. The right rail's **Recent** panel mirrors your most recently touched chat sessions and analyses for quick re-entry. Recent entries are stored client-side and validated against a same-origin allow-list — links are only honoured when they begin with a single `/`, so a poisoned `localStorage` value can never redirect you to an external URL.

---

## 8.3 Library

The **Library** surface is a searchable index of every skill and agent registered in the platform. Filter by kind (skill / agent), type to fuzzy-search, and — when you have a project context (`?projectId=`) — flip the **Enable** / **Enabled** toggles to grant or revoke per-project access. The **Artifacts** tab lists every completed analysis for the active project and lets you download the full snapshot as JSON.

---

## 8.4 Settings

Open **Settings** from the sidebar to see a navigation hub that cards every settings sub-page:

- **Profile** (`/settings/profile`) — view account info.
- **Appearance** (`/settings/appearance`) — theme + density controls.
- **Notifications** (`/settings/notifications`) — per-channel × per-event delivery toggles, synced to your account.
- **API Keys** (`/settings/api-keys`) — provider preferences and admin-only env vars.
- **Integrations** (`/settings/integrations`) — links to repo, DB, MCP, hooks, and trigger surfaces.
- **MCP** (`/settings/mcp`) — server governance with registry/import tabs and an **Add MCP server** action that opens `/admin/mcp` for manual registrations (§27).
- **Vault** (`/vault`) — admin-only encrypted secret management (§17).

See §19 for full details on each sub-page.

---

## 8.5 Notifications

The bell icon in the header opens a side **notifications drawer** with these alerts:

- **Mention** — you were @mentioned in a comment. Click **Open →** to jump directly to that comment.
- **SLA deadline expired** — an assignment's SLA deadline has passed. Click **Open →** to navigate to the requirement.
- **Review lifecycle** — for the formal review workflow (the Reviews page, sidebar → Reviews): as an **assigned reviewer** you are notified when a review is submitted and awaits your decision; as the **requester** you are notified of each reviewer's decision and of the final outcome (approved — including when a baseline was auto-created — or rejected). Each notification deep-links to the review's detail page. These are governed by the **Requirements approved × In-app** toggle in Settings → Notifications.

The badge shows your unread count; opening the drawer marks all items read. Use **Clear all** to dismiss the list. Notifications are **persisted server-side** — they survive page reloads and reconnects, so you never miss an alert even if you were offline. Each notification includes a deep-link to the relevant artifact where one is available.

You control which notifications you receive at all in **Settings → Notifications** (§20.3): disabling a channel × event combination (for example *Mentions × In-app*) stops those notifications at the source — nothing is created for you to dismiss.

---

## 8.5.1 Connection status

Live features (presence avatars, analysis/job progress, notifications) ride a realtime WebSocket connection. When that connection is healthy, METIS shows nothing — you just see live updates. If the connection drops or is retrying, a slim banner appears at the top of the window:

- **"Reconnecting…"** (amber) — the connection dropped and METIS is retrying automatically. Live updates are paused momentarily; no action is needed.
- **"Offline — live updates paused"** (red) — METIS could not re-establish the connection. The app still works for actions you trigger directly, but live updates (presence, progress, notifications) will not arrive until the connection recovers. Check your network; the banner clears itself the moment the connection is restored.

The banner is deliberately quiet: it ignores brief, normal reconnects (it only appears after a short delay) so it never flickers during routine network blips. If a realtime action is refused for permission reasons, you will also see a short toast explaining why.

---

## 8.6 Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| ⌘K / Ctrl+K | Open the command palette |
| ↑ / ↓ | Move between palette results |
| ↵ | Invoke the highlighted command |
| Esc | Close the palette or any open drawer |
| Tab | Move focus through interactive elements |
| Shift+Tab | Move focus backwards |

---

## 9. Managing Projects

### 9.1 What Is a Project?

A **project** in METIS is a container that groups everything related to a specific piece of work. For example, if your team is redesigning a market system, you'd create a project called " Market Redesign" and put all the related documents, analyses, and requirements inside it.


Every project has:
- **Name** — a clear, descriptive title
- **Description** — what this project is about
- **Status** — where it is in the workflow (Draft, Analyzing, Review, Published, Archived)
- **Priority** — how urgent it is (Critical, High, Medium, Low)
- **GitHub Repository** — where issues will be published

### 9.2 Creating a Project

1. Navigate to the **Projects** page (click "Projects" in the sidebar)
2. Click the **"+ New Project"** button in the top-right corner
3. Fill in the project details:
   - **Name**: A clear name (e.g., "Grid Monitoring v3 Upgrade")
   - **Description**: What this project aims to accomplish
   - **GitHub Owner**: The GitHub organization or username (e.g., `openzigs`)
   - **GitHub Repository**: The repo name (e.g., `grid-monitoring`)
4. Click **"Create"**

The project starts in **Draft** status.

### 9.3 Viewing Projects

The **Projects** page shows all your projects as a list of cards. Each card displays:

- **Project name** with a status badge
- **Description** (truncated to 2 lines)
- **Priority** indicator (colored dot: red = critical, orange = high, blue = medium, gray = low)
- **Document count** — how many documents have been uploaded
- **Requirement count** — how many requirements have been generated
- **Last updated** — when any activity last occurred

Click on any project card to view its details.

### 9.4 Project Detail View

Opening a project lands on its **Overview**: one card per pipeline stage — sources connected, ingest status and counts, the last analysis, requirements awaiting review, generated docs, and the last publish — each with the one action that moves it forward ("Connect a source", "Ingest", "Run analysis", "Review 12 requirements", …). Status updates live while an ingest, analysis or doc generation runs. A brand-new project shows a numbered **Get started** checklist instead — connect a source → ingest → run an analysis → review → publish — and each step links straight to the page where it is done. Project settings are behind the **⚙** tab.

The Ingest card reads the newest 100 documents: on a larger project it shows the project's document total, and any failed or processing count from that page reads "at least N". The Publish card shows the last batch only to roles that can preview issues; a read-only role sees that publish history is not available to it.

Beneath the pipeline, **Knowledge search** runs a retrieval query over the project's ingested documents and shows the top matching chunks.

**Settings tab controls** (the project's **⚙** tab, `/projects/{id}/settings`): in addition to the AI provider/model pickers and safety/budget cards, the ⚙ tab includes a **Bedrock inference profile** card (Issue #127). Paste a cross-region inference-profile ARN and model id to use it as the Bedrock model identifier for this project; leave it blank to use the default model. The control only stores the value — it has no effect on non-Bedrock providers (e.g. `local-gemma`).

**Plugins tab** (`/projects/{id}/plugins`, Issue #123): export a portable plugin by entering a name/version and selecting skills, custom agents, and hooks — METIS downloads a `metis-plugin-*.json` envelope. To import, upload a previously-exported envelope; METIS validates it and shows a summary of the skills/agents/hooks installed into the current project (or a human-readable error if the file is malformed).

### 9.4.1 Discussions — collaborate with your team and the AI (Epic #475)

The **Discussions** tab (`/projects/{id}/discussions`) is a shared, realtime room where **multiple analysts and stakeholders** talk through requirements together — and the **AI is a participant**, not a separate single-user chat. Use it to ask questions, brainstorm acceptance criteria, and turn the best ideas into tracked requirements without leaving the conversation.

**Starting a discussion.** Open the **Discussions** tab and click **Start discussion** (an optional title helps others find it). You land in the thread view; everyone with access to the project can join the same thread and see messages appear live.

**Who said what.** Every message is clearly attributed:
- **Human messages** show a colored avatar with the author's initials and a small **human** badge.
- **AI messages** show an **AI** avatar and a badge with the **model id** that produced the reply, so you always know when you're reading the assistant versus a teammate.

Message text is rendered as safe Markdown (code blocks, tables, lists, diagrams) — pasted content can never inject scripts into the page.

**Bringing the AI in.** Whether the AI replies depends on the thread's **AI mode** (configured in the thread settings panel — see the promote/settings guide):
- **On mention** (default) — the AI replies only when you explicitly mention **`@AI`** in your message.
- **Auto** — the AI replies whenever it detects a clear question or request, no mention needed.
- **Off** — the AI stays silent, even if you mention `@AI`.

When the AI responds, you'll see its reply **stream in token-by-token**, live, for everyone in the thread — exactly like watching a teammate type. Your own messages appear instantly (optimistically) and are confirmed by the server a moment later.

**Mentioning people and the AI.** Type **`@`** in the composer to open autocomplete. Keep typing to search teammates by name, or pick the **`@AI`** entry (always offered at the top) to bring the assistant in. Use the arrow keys to move, Enter or Tab to insert, and Esc to dismiss — the selected mention is inserted as `@name` (or `@AI`).

**Who's here and who's typing.** Avatars at the top of the thread show **who is currently viewing** it, updating live as people join and leave. When a teammate is composing a message, a **"… is typing"** indicator appears above the input (you never see your own), so you know a reply is on the way.

**Getting someone's attention (@mentions).** Mention a teammate by name (e.g. `@alex`) in a message and they receive an in-app **notification** — it appears in the bell/notification drawer (see §8.5) with a link straight back to the discussion, and arrives live if they're online. Only **project members** are notified (you can't ping someone outside the project), you're never notified for mentioning yourself, and repeated mentions of the same person in one thread are de-duplicated so nobody gets spammed.

**Turning a message into a requirement.** When the discussion lands on something worth tracking, hover any message and click **Promote to requirement**. A small form opens (title pre-filled from the message, plus type and priority); on save, METIS creates a tracked Requirement and links you straight to it, preserving where it came from (the source message and thread) in the audit trail. (A future enhancement — "Ask AI to draft acceptance criteria" — is noted in the form but not yet available.)

**Configuring the thread.** Click **Settings** (top of the thread) to open the thread settings panel:
- **AI participation** — a 3-way control to set the thread's mode (**Off**, **On mention**, or **Auto**). Your choice takes effect immediately.
- **Anchor (optional)** — attach the discussion to a specific Requirement, Analysis, or Spec Kit feature so it carries that context. (Both controls are available to thread members only.)

**Cost note.** Human-to-human chatter never calls the AI and never incurs any token cost — only an actual AI reply does, and AI replies are rate-limited per person per thread to keep spend predictable.

### 9.5 Project Status Lifecycle

Every project moves through defined states. Only certain transitions are allowed:

```
Draft ──────────→ Analyzing ───────→ Review ──────→ Published
  │                   │                │                │
  │                   │                │                │
  └───────────────────┴────────────────┴────────────────┘
                           │
                           ▼
                       Archived
```

| From | To | When This Happens |
|---|---|---|
| **Draft** → **Analyzing** | You start an analysis |
| **Analyzing** → **Review** | The analysis completes successfully |
| **Analyzing** → **Draft** | You want to add more documents before re-analyzing |
| **Review** → **Published** | You approve and publish the requirements |
| **Review** → **Draft** | You want to go back and refine things |
| **Any** → **Archived** | You're done with this project (it's kept for records but set aside) |

Every transition is recorded in the **audit trail**, so there's always a record of who changed what and when.

### 9.6 Archiving a Project

When you no longer need to actively work on a project, you can **archive** it. This is a "soft delete" — the project isn't destroyed; it's just moved to the Archived status where it won't clutter your active project list. Archived projects can still be viewed for historical reference.

### 9.7 Project Overview (AST-Derived)

After METIS ingests a repository for **Code Discovery**, you can view a deterministic, AI-free summary of the codebase computed straight from the AST CodeGraph.

**How to view it.** Open the project's **Code** tab — it lands on **Code Overview** (the project's own **Overview** tab links to it too). The page shows:

- **Summary** — a 500-word paragraph composed from the rationale comments (`// WHY:`, `// NOTE:`, JSDoc, Python docstrings) attached to the project's most-referenced symbols. If no rationale is available, METIS renders a deterministic three-sentence boilerplate so the section is never blank.
- **Top Symbols by In-Degree** — the top 20 functions/classes/modules sorted by how many other symbols call or reference them. Symbols in test files (`*.test.*`, `*.spec.*`, `tests/`, `e2e/`, `_test.go`, `*Test.java`, …) are not ranked. A call counts toward a symbol only with evidence that it targets that symbol: `items.join(",")` is not a call to a project function named `join`, and `describe`/`beforeEach`/`vi.mock` or a name imported from `node:path` never bind to project code by name.
- **Entry Points** — the top 10 likely application entry points (`bin/`, `cmd/`, `src/index.*`, `src/main.*`, `server.*`, `cli.*` patterns) with file paths and line numbers.

**How to regenerate it.** Click **Regenerate**. METIS recomputes the overview against the current CodeGraph and persists it (so the next viewer sees it instantly). Two consecutive regenerations against the same graph produce byte-identical output. While it runs you now see a live progress bar (instead of a frozen "Regenerating…" label), and on completion a **toast confirms success** ("Overview regenerated from N symbols.") — a confirmation the page previously did not show. [#423, epic #406]

> **Live progress across long operations (Epic #406).** Three operations that used to block and freeze the UI now run in the background and stream progress with a success/failure toast on completion: **regenerating the project overview** (above), **running a Spec Kit command** (`/specify`, `/plan`, `/tasks`, … — §26; the grounded-completion line, e.g. "Generated spec.md (v3) … grounded on 8 retrieved chunks", is shown as the success toast), and **reindexing a project's embeddings** from the admin Embeddings page (which returns immediately and streams "Re-embedded X/Y chunks"). If your realtime connection drops, the surfaces fall back to their existing refresh behavior. Failure toasts are deliberately generic ("The … operation failed. Please try again.") and never expose raw error detail.

**When regenerate fails.**

- **409 NO_GRAPH** — the project hasn't been ingested yet. Run a Code Discovery ingest first.
- **403** — your role lacks `project.update`. Coordinator or admin can regenerate; readers can view but not regenerate.

**Privacy note.** The overview is deterministic and computed from the database — no LLM call. Copy and Download buttons let you export the markdown verbatim for review.

### 9.8 Finding Derivation Badges

Every finding on a project's analysis page now carries a **derivation badge** that tells you how METIS arrived at that finding:

- **EXTRACTED** (green check) — pulled directly from a comment, JSDoc, or docstring in the source. Confidence is implicit at 1.0 and not shown.
- **INFERRED N%** (yellow sparkle) — the LLM inferred this finding; the percentage is the model's reported confidence rounded to a whole number. Hover the badge for the raw confidence to two decimals and the originating agent run id.
- **AMBIGUOUS** (orange question-mark) — METIS could not unambiguously attribute the finding to a single source. Hover for the same metadata, and click **Review** to record an audit acknowledgement that a human looked at it.

The **Review** action only opens the dialog; the underlying finding row is never mutated. METIS records who reviewed it and when via the audit log so you can always reconstruct the chain of custody.

---

## 10. Uploading Documents

Documents are the raw material that METIS analyzes. The more relevant documents you provide, the better the AI's analysis will be.

### 10.1 Supported File Types

| Extension | File Type | Best For |
|---|---|---|
| `.pdf` | PDF Document | Business requirements, policies, regulations, specifications |
| `.docx` | Microsoft Word | Requirements documents, project charters, meeting notes |
| `.xlsx` | Microsoft Excel | Data dictionaries, test matrices, configuration tables |
| `.pptx` | Microsoft PowerPoint | Presentations, slide decks, design reviews |
| `.md` | Markdown | Technical documentation, README files, wiki pages |
| `.txt` | Plain Text | Notes, logs, any unformatted text |

### 10.2 What Happens When You Upload

When you upload a document to a project, METIS processes it through several stages:

1. **Uploading** — the file is transferred to the server
2. **Processing** — the file is:
   - **Converted** to Markdown (PDF → Markdown with heading detection, DOCX → Markdown preserving structure, XLSX → Markdown tables, PPTX → Markdown with slide headings)
   - **Chunked** into small, overlapping pieces (about 512 tokens each)
   - **Embedded** — each chunk is converted into a mathematical representation that captures its meaning
3. **Indexed** — the chunks are stored in the knowledge base, ready for the AI to search

This process is automatic and happens in the background. The document's status changes from `uploading` → `processing` → `indexed`. If something goes wrong (e.g., the file is corrupted), the status shows `failed`.

### 10.3 Upload Limits

| Limit | Value |
|---|---|
| Maximum file size | 50 MB per file |
| Maximum documents per project | 100 |
| Allowed file types | .pdf, .docx, .xlsx, .pptx, .md, .txt |

---

## 11. Running an Analysis

The analysis is where METIS really shines. It unleashes four specialized AI agents to examine your documents, code, and databases simultaneously.

### 11.1 What Happens During Analysis

When you click **"Run Analysis"** on a project, here's what happens behind the scenes:

1. **Four specialist AI agents** start working in parallel:
   - **Document Analyst** — reads through all your uploaded documents, extracting business rules, compliance requirements, and user stories
   - **Code Analyst** — examines your connected code repositories, identifying API changes, architectural patterns, and technical debt
   - **Database Analyst** — inspects your connected databases, discovering schema changes, index requirements, and data migration needs
   - **Web Researcher** — searches for industry standards, best practices, and regulatory compliance information

   > **What analysis reads vs. writes:** Analysis reads from uploaded documents, connected code repositories, connected databases, and live web search. It does **not** read existing Jira or GitHub issues as input. Jira and GitHub are output-only destinations — approved requirements are *published to* them after analysis.

2. **Each agent has 60 seconds** to complete its work. They run simultaneously, so the total time is the time of the slowest agent, not the sum of all four.

3. **Synthesis phase** — after all agents finish, the orchestrator:
   - Merges findings from all four agents
   - Removes duplicates (when multiple agents discover the same thing)
   - Groups findings by category (security, performance, API changes, etc.)
   - Assigns a requirement type to each finding (feature, schema-change, security, etc.)
   - Assigns a priority level (critical, high, medium, low)
   - Generates acceptance criteria (specific conditions for completion)

4. **Requirements are created** — up to 100 requirements per analysis, each fully documented with title, description, type, priority, tags, and acceptance criteria.

### 11.2 Adding Documents and New Requirements Before a Run

You no longer need to leave the Analysis page to feed a run. The **Start a new analysis** card has two optional panels that let you shape what the agents look at.

**Add documents (inline upload)**

Click **Add documents** to expand the panel. You can bring content in three ways without navigating to the Documents page:

- **Upload a file** — drag-and-drop or browse for a file.
- **Paste text** — paste raw text directly (handy for a snippet of a spec or an email).
- **Add from URL** — enter a public URL; METIS fetches it on the server and ingests the content.

Newly added documents start in a `pending` or `processing` state while they are ingested. Their status is shown next to the document in the selection list, and they are **auto-selected** for the run as soon as they appear. A document must reach the `ready` status before it can be analyzed — if you select a document that is still ingesting, a warning appears and the **Run analysis** button stays disabled until ingestion finishes.

**Evaluate new requirements (optional)**

Click **Add requirements** to expand a free-text box where you can describe *new* requirements to evaluate against the **current** implementation — for example, "Support SSO for enterprise tenants" or "Add audit logging to all mutations." The agents treat this as operator guidance and report the **gap**: what already exists, what is missing, and the changes needed to satisfy the new requirements.

The text is capped at **4096 characters** (a live counter shows your usage), and it is passed to every specialist agent as well as the synthesis step. Leaving it blank runs a standard discovery analysis. If a paste exceeds the cap, the panel says so explicitly — *"Your text was cut at 4096 characters — the last N characters were removed and will not be analyzed"* — rather than trimming it behind the counter.

**METIS accounts for every requirement you type.** A run that used this box shows a **Requirements you supplied** section on the results page, leading with a one-line count — *"6 of 7 requirements you supplied were analyzed"* — followed by anything that did not simply go through:

- **Merged** — a requirement that restates one METIS already had is folded into it, and the section names the survivor (*"NR-2 … merged into REQ-003 as a duplicate … It was analyzed under that requirement"*). Merging is normal and is **not** a loss.
- **Not analyzed** — a requirement that never reached the agents, with the reason (over the per-run limit on requirements, or no requirement text could be read from that block). A run that dropped input also raises the amber capability banner (§11.3.1), so it can never look like an unqualified success.

If you see a dropped requirement, re-run it in a shorter, separate submission.

**How METIS decides what counts as one requirement.** Blank lines separate requirements. A bullet list is read as a *set* of requirements when it stands on its own or sits under a heading that names a group (`## Requirements`, `Notification channels:`). A bullet list that *continues the requirement just above it* — either directly, or under a label like **Acceptance criteria:**, **Success criteria:**, **Definition of done:**, **Examples:** or **Notes:** — is read as detail of that requirement: it still reaches the agents, carried by the requirement it qualifies, and does **not** consume one of your per-run requirement slots. So a paste of ten requirements each with three acceptance-criteria bullets counts as **ten**, not forty.

When your project has a **built code graph**, METIS additionally maps each new requirement to the code it most likely affects — deterministically, using the same requirement→code mapper and blast-radius traversal as **Impact Analysis** (§13.9), before the AI agents run. The completed run shows an **Affected code** panel with one collapsible section per requirement: the matched symbols with their `file:line` locator, the relation (a **direct** mapper hit versus a blast-radius **caller**/**importer**), and a confidence score. A requirement that matched no code shows an explicit *"no code matched"* note. This mapping also grounds the AI gap findings, so they anchor to real symbols and files. Projects with no code graph simply skip this step and behave exactly as before.

Just above the **Run analysis** button, a one-line summary confirms what the run will use — for example, *"This run uses 3 documents + requirements provided: yes."*

### 11.3 Understanding Analysis Results


After an analysis completes, you'll see the results on both the project detail page and the analysis page. Key metrics include:

| Metric | What It Means |
|---|---|
| **Status** | `completed` (success), `running` (in progress), `failed` (error occurred) |
| **Requirements Found** | How many distinct requirements the AI discovered |
| **Confidence** | A percentage indicating how confident the AI is in its findings (higher = more certain) |
| **Duration** | How long the analysis took to complete |

#### Citation transparency and requirement grounding

Every finding the agents produce is **grounded** in the documents you selected for the run and in any new requirements you typed into the **Evaluate new requirements** box — not in a generic, fixed query. METIS retrieves the most relevant chunks from your selected documents, and each finding lists the supporting citations (filename and chunk) directly beneath it.

Citations that point at a connector/repo source are shown as a human-readable `basename — repo` label (for example `ShipmentAllocationsVO.java — acmerp`) rather than the long raw connector id. The chunk index (`#3`) — the precise file/line provenance — stays exactly where it was, and the full original id is preserved as a hover tooltip on the label, so you can still copy or deep-link it. The same friendly labels appear in the Analysis document picker and in the Workbench Documents list / chat context chips; legacy or non-connector filenames are shown unchanged.

**Code citations.** When a finding is grounded in your project's **source code** (not just documents), it shows a distinct **code citation** — a `code` badge and a monospace `filePath:startLine-endLine` locator (for example `server/src/auth/session.ts:10-42`) — with a **Copy** button so you can paste it straight into your editor or `git blame`. These appear only when the analysis actually retrieved that code: METIS validates every code citation against what the agents genuinely looked at and **drops** any file/line the model was not grounded in, so a code citation is a location you can trust, never a guess. (There is no in-app code viewer yet, so the locator is shown as copyable text rather than a link.)

When you provide new requirements to evaluate, each finding is tagged with the requirement it addresses:

- **"Grounded in REQ-003"** (blue badge) — the finding is backed by evidence retrieved from your selected documents for that requirement.
- **"Gap for REQ-003"** (amber badge) — METIS could **not** find supporting evidence in the selected documents for that requirement. The finding is marked `info` severity and flagged for manual review, with a "No supporting evidence retrieved from the selected documents" note. This is how METIS tells you a new requirement is likely **not yet implemented** rather than silently omitting it.

Because grounding is driven entirely by *your* document selection, narrowing the selection focuses the analysis (and its citations) on exactly the material you care about.

#### Verification status on finding cards

Before METIS turns findings into requirements, it runs an automated **verifier** that checks each finding's code evidence against the source it actually retrieved. Findings that cite code carry a **verification badge**:

- **Confirmed** (green) — the verifier found the code this finding points to: at least one cited file and line range was really present in the retrieved source. Its code evidence is supported.
- **Unverified** (amber) — the finding claimed a place in the code, but **every** code location it cited was missing from what METIS retrieved. The claim could not be confirmed. The finding is **still shown** — never hidden — but you should review it manually before acting on it, and METIS tells the synthesis step to treat it as weaker evidence so an unproven claim does not quietly become a high-priority requirement.

Findings that make no code claim at all (for example a document-only observation) carry no verification badge. Use the **Verification** filter above the findings list to narrow to just the *Confirmed* or *Unverified* findings — handy when you want to triage exactly the claims METIS could not stand behind. A hover tooltip on each badge explains what it means and what to do.

#### Panel confidence on finding cards

When your deployment enables the multi-lens support panel (`ANALYSIS_LLM_SUPPORT_PANEL`), a second badge appears beside the verification badge. The two answer different questions: verification asks *"was this file really retrieved?"*, the panel asks *"does that file actually back the claim?"*

- **High confidence** (green) — every lens agreed the retrieved evidence backs the finding.
- **Mixed confidence** (blue) — the lenses disagreed, but the supporting ones outnumbered the dissenters.
- **Low confidence** (rose) — more lenses doubted the finding than backed it. Its card is dimmed and dashed and it sorts to the bottom of the list, but it is **never hidden and never filtered out**. METIS down-weights; you decide.
- **Not judged** (slate) — the panel produced no usable verdict, so nothing is known either way. This is *missing information, not doubt*: treat the finding exactly as you would one the panel never looked at. It is deliberately styled and worded differently from *Low confidence*.

Every panelled finding carries a **"Why?"** disclosure. Open it to see each lens's verdict in its own words, plus the `file:line` it based that verdict on — including the dissenting lens, which is usually the most useful thing on the card. Nothing there needs a second lookup; it comes with the analysis you already loaded.

On the **Requirements** tab the same signal appears rolled up per requirement (*"Evidence: Low confidence"*), listing the dissenting lens and its reason for each linked finding. A requirement whose evidence the panel could not judge is reported as such rather than being downgraded.

One caveat travels with every label, and it is shown in the UI too: the panel reads **only the evidence this run retrieved**. "High confidence" means *supported by what we retrieved*, never *true*.

##### When a finding says something is MISSING

A finding that claims something is *not* implemented is the highest-stakes thing METIS emits — it directly drives what someone builds next — and it is the one kind of claim that cites nothing, so the ordinary evidence checks have nothing to check. Those findings therefore carry a **third badge**, telling you which of three very different things happened:

- **Absence checked** (green) — the retrieved code covering that area was read, and the thing really is not there.
- **Absence contradicted** (rose) — METIS **found the thing this finding says is missing**, and names the `file:line`. Treat the claim as wrong until you have looked yourself. The finding drops to *Low confidence*, and it is still shown in full.
- **Absence unexamined** (amber) — **nobody looked.** Nothing this run retrieved covers where the thing would live, so its absence was never actually checked. This is *not* a confirmed gap. It is deliberately worded and coloured so it can never be mistaken for *Absence checked*: "we looked and found nothing" and "we never looked" are different facts, and conflating them is what this check exists to stop.
- **Absence not checked** (slate) — the check itself produced no usable result. Nothing is known either way.

The check reads **only what this analysis retrieved** — it never goes searching for more. That is deliberate: if it went looking, it would be grading a different claim than the one the agent made. So *Absence unexamined* is the honest answer to thin retrieval, not a failure to be worked around.

On the **Requirements** tab, a requirement built on a contradicted or unexamined absence claim carries the same warning in plain words (*"This may already exist…"* / *"Not confirmed missing…"*) — that tab is where work actually gets scheduled.

**Detection has limits, and they are known.** The badge only appears on findings METIS recognises as absence claims, which it does by phrasing. Measured against a labelled set, it catches **12 of 15** — the three it misses assert an absence with no negative words at all (*"only 3 of the 5 formats are produced"*, *"REQ-7 remains open"*). If a finding tells you something is missing and carries **no** absence badge, nothing checked it: verify before you build.

**Published GitHub issues.** When a requirement is graded *low confidence* (or the panel could not judge it at all), the issue METIS publishes carries a short **Confidence** section naming the disagreeing check, its reason and its `file:line`. Confident requirements publish exactly the body they always did — only the doubt crosses the boundary, because the reader of a GitHub issue is furthest from the evidence and least able to judge it for themselves. **One exception:** a requirement built on a contradicted or unexamined absence claim carries its warning into the issue at *any* confidence — an issue saying "build X" needs to say so if X may already exist, or if nobody checked.

#### Persona attribution on finding cards

Each finding is surfaced by one of METIS's named specialist personas rather than an opaque agent key. The card shows a persona chip — avatar, name and role — so you instantly know *who* raised it:

| Persona | Role |
|---|---|
| 🧭 **Mary** | Business Analyst (`document`) |
| 🏛️ **Winston** | Solution Architect (`code`) |
| 🗄️ **Sally** | Data Specialist (`database`) |
| 🌐 **Quinn** | Web Specialist (`web`) |

Unknown or legacy agents fall back to a generic 🤖 glyph plus the raw key, so the chip never renders blank.

#### Deep Dive → Issue (per-finding)

Every finding card has a **Deep Dive → Issue** button that turns a single finding into a publishable issue in three steps:

1. **Deep dive.** METIS makes one bounded LLM call to expand the finding into a fully-formed draft: a clear title, a problem statement, the affected files, related requirements, acceptance criteria and suggested labels.
2. **Review & edit.** The draft opens in a dialog where every field is editable. The originating persona is shown in the dialog header, so the issue you create carries the same attribution as the finding.
3. **Publish.** Clicking **Create Issue** publishes the draft to the project's configured destination(s) — GitHub, Jira, or both — and shows a direct link to each created issue. The issue body includes a footer crediting the persona that surfaced the finding, giving you a back-link from the tracker to the analysis that produced it.

The button is **disabled** when ticket creation is blocked by a pending or rejected approval checkpoint (see the approval gating described above); hover the button to see why. Publishing also requires the `issue.publish` permission. If a publish fails, the dialog stays open with an inline error and your edits are preserved so you can retry without re-typing.

#### 11.3.1 Degraded-mode capability banner

METIS never silently skips code analysis. When a run could not use its full capabilities, the results page shows an amber **"Some analysis capabilities were limited for this run"** banner that spells out, in plain language, what was not analyzed and how to fix it. You may see any of:

| Banner says… | What it means | How to fix it |
|---|---|---|
| **No code graph has been built for this project** | The code agent could not run its deep, multi-turn ("agentic") investigation. | Connect a repository and let indexing build the code graph, then re-run. |
| **Repository source code has not been ingested** | Code gap findings were grounded only in your documents, not in real source. | Connect a repository so its source is indexed as knowledge. |
| **No requirements were extracted from your documents** | Without requirements, the code agent falls back to a shallow single-shot pass. | Add requirement documents, or type new-requirements text on the start form. |
| **Code-graph symbol grounding is turned off** | The deployment has `ANALYSIS_FUSED_CODE_RETRIEVAL` disabled. | Ask an administrator to enable it for deeper, cited code findings. |
| **Live database-schema grounding is turned off** | The deployment has `ANALYSIS_SCHEMA_CONTEXT` disabled. | Ask an administrator to enable it so the database agent grounds in your real data model. |
| **Some content was analyzed from unapproved (quarantined) documents** | No approved knowledge was available, so raw content was used. | Approve the relevant documents and re-run. |
| **Some repositories were skipped** (named) | A multi-repo run dropped repos because the per-repo token budget was too low. | Click **Analyze remaining repositories** on the banner (see below), reduce the number of connected repositories, or analyze the skipped ones separately. |
| **Some of the requirements you supplied were not analyzed** | At least one requirement from the **Evaluate new requirements** box never reached the agents — it was over the per-run limit, unreadable, or your paste was cut at the character limit. | Open **Requirements you supplied** on the same page to see exactly which ones and why, then re-run the dropped requirements as a shorter, separate submission. |

**Analyzing repositories that were skipped for budget.** When a project has more connected repositories than a single run's token budget can cover, METIS analyzes as many as fit and lists the rest by name on the banner. Rather than start a whole new run, click **Analyze remaining repositories** — METIS re-runs the code investigation for **only** the skipped repos (each now getting a full budget) and **merges** their findings into the same analysis, then updates the results. The button is disabled while the resume is in progress, and it disappears once every repository has been analyzed. If there are still more skipped repos than one resume can cover, the banner simply lists whatever remains so you can resume again. (You can only resume a **finished** run — you cannot resume one that is still running or already resuming.)

A **fully-capable run shows no banner at all.** The same information appears as a smaller **hint on the start-analysis form** *before* you run, so you know up front which capabilities the run will have (for example, "This project has no code graph — code gap analysis will be document-grounded only"). The hint respects which agents you have selected.

#### 11.3.2 Traceability matrix (requirement → findings → code → tests)

Once a run completes, the results page shows a **Traceability matrix**: a scannable table with one row per requirement and columns for the **findings** it was grounded in, the **code locations** those findings cite (shown as `filePath:startLine-endLine`), the **tests** METIS could detect for that code, and the requirement's **coverage badge**. It answers, at a glance, "for each requirement, what did we find, where does it live in the code, and is it tested?"

- **Explicit empty cells.** A requirement with no linked code shows **"none"**, and one with no detected tests shows **"none detected"** — never a blank you have to guess about.
- **Tests are best-effort.** METIS detects tests by walking the code graph from the cited code to test files (`*.test.*`, `*.spec.*`, `*_test.*`, files under `tests/` or `__tests__/`). If the analysis didn't resolve a precise code symbol for a requirement, its tests column stays **"none detected"** rather than guessing — a missing test link means "not detected here", not "no tests exist".
- **Export.** Use **Export CSV** or **Export Markdown** to download the whole matrix. The CSV opens cleanly in Excel/Sheets (fields with commas, quotes, or line breaks are properly quoted, and values that look like spreadsheet formulas are neutralized so they can't run); the Markdown table drops straight into a PR description, a wiki, or an audit record.
- **Wide matrices scroll** horizontally within the table's own area, so a project with many code links never breaks the page layout.

#### 11.3.3 Gap report (current implementation → gap → effort)

Below the traceability matrix, the results page shows a **Gap report** — a per-requirement, narrative view aimed at a business analyst. Each requirement gets a card with three parts:

- **Current implementation.** The code that exists today, shown as clickable `filePath:startLine-endLine` code citations gathered from the requirement's grounded findings (strongest, verifier-**confirmed** evidence first). If nothing in the code was linked, the card says so plainly — **"Nothing found in code for this requirement"** — rather than inventing a summary.
- **Gap.** What's missing or needs to change, taken directly from the analysis findings linked to that requirement (each states what the requirement asks for, what the current code does or lacks, and the specific change needed). Each gap item carries its own severity and verification badge, plus any code citations.
- **Effort estimate.** The requirement's existing **story-point** estimate, shown as a badge. A requirement with no estimate shows **"Unestimated"** — METIS never fabricates a number.

The **verdict** badge leads each card and is the field to act on:

- **Implemented** — METIS retrieved and cited code that satisfies the requirement.
- **Gap confirmed** — METIS successfully searched the codebase and the code it read does **not** satisfy the requirement. This is the **only** verdict that means "this needs building".
- **Could not verify** — METIS could **not** tell: its code searches failed, came back empty, or the investigation ran out of budget before reaching this requirement. **This is not a gap.** The functionality may well already exist. These findings are shown in their own **"Could not verify — not a confirmed gap"** block, never mixed into the Gap section, and never exported as gaps. Re-run the analysis (or check the code yourself) before planning work from one.

A requirement with **no verdict** simply means the code agent did not take part in that run.

Expand **Searched scope** at the top of the report to see exactly which queries the code agent ran and which ones returned results — an absence claim only means something relative to what was actually searched. If retrieval was poor, the panel leads with a warning that "not found" results are unreliable for that run (the same signal appears in the analysis banner as *code search returned little usable evidence*).

The **coverage** badge (grounded in code / docs only / no evidence) and the **verification** badge (confirmed / unverified / could not verify) appear inline on each card so you can judge, at a glance, how trustworthy the evidence is. Coverage describes what **kind** of evidence exists, not whether the requirement is done: *grounded in code* means some code was cited, and *no evidence* may simply mean the search failed — read the **verdict** for the actual answer. The whole report is assembled from the completed analysis — there is no extra AI step, so it's fast and reproducible, and **every claim about the current implementation is anchored to a citation or an explicit no-evidence marker**.

**Database changes.** When a requirement touches the database, the card grows a **Database changes** section — the database counterpart of the gap findings. It lists the affected tables and columns, the kind of change (add table, add column, alter column, drop column, or a reference), and, for each, a **Suggested DDL** block. That DDL is always shown under a persistent **“Suggested DDL — for review only, never executed”** label: METIS *never* runs it against any database — it is a starting point for you to review, edit, and apply yourself. Each row also carries a **risk** badge — **Breaking** (loud), **Expanding** (additive), **Neutral**, or **Unclassified** when the risk has not yet been scored — and the label text always states the risk, so it is never conveyed by colour alone.

Objects METIS could match against the live schema appear in the main table. Objects it referenced in code but **could not find** in the live schema are moved into a separate **“Unverified against live schema”** block, so a speculative table or column is never presented as a confirmed change.

If a change touches a table shared with other projects in your workspace, a **cross-project impact** banner lists which projects **read** or **write** it, so you can see the blast radius before you commit. When METIS cannot tell whether a table is shared — because the database identity has not been linked — it says **“cross-project impact unknown — database identity not linked”** (with a link to the connection's identity settings), which is deliberately distinct from confirming that *no* other project uses it.

> For the full picture — how the schema crossing works, how to link database identity, how to read reconciliation confidence and verdicts, and the safety guarantees behind the suggested DDL — see the [Database Impact Analysis](./DATABASE_IMPACT_ANALYSIS.md) guide.

#### 11.3.4 Current vs proposed (diff view for changed requirements)

When you re-run an analysis on the same project, requirements evolve — some are reworded, some added, some dropped. Below the gap report, the **Current vs proposed** panel shows a **side-by-side diff** of only the requirements that actually **changed** between a base ("current") run and the run you're viewing ("proposed").

- Use the **Compare to** picker at the top right to choose the base run. It defaults to **"Previous run (auto)"** — the project's most recent completed run before this one.
- Each changed requirement is one card with a **change type** tag (Added / Removed / Modified), a **severity** badge, and an **impact** score, plus a short summary of what changed.
- **Left = Current.** The base requirement text, plus the code that implements it today, shown as clickable code citations. If no source was linked, the card says so plainly.
- **Right = Proposed.** The new requirement text, plus the gap (the linked findings describing what still needs to change). Changed wording is highlighted word-by-word — additions on the proposed side, removals struck through on the current side — so you can see exactly what moved.
- A **new** requirement shows only a proposed side (nothing existed before); a **removed** requirement shows only a current side. Unchanged requirements are hidden.

If there's no earlier run to compare against, the panel shows an explicit **"No prior run to compare"** message rather than pretending everything is new. Like the gap report, this view is assembled from the completed runs with no extra AI step, so it's fast and reproducible.

#### 11.3.5 Exporting the analysis (markdown + GitHub issue drafts)

Once a run completes you can take the analyst-facing artifacts out of METIS as markdown or as ready-to-paste GitHub issue drafts. Nothing is pushed to GitHub for you — these are **drafts** you review and create yourself.

- **Export report (Markdown).** The **Export report (Markdown)** button on the Gap report panel downloads a single `analysis-report-<id>.md` document that stitches together the whole picture: a coverage summary, one gap section per requirement (current-implementation `filePath:startLine-endLine` citations, the gap findings, effort, coverage and verification), and the full traceability matrix table. It's assembled from the completed analysis with no extra AI step, so it's fast and reproducible — drop it straight into a PR description, a wiki page, or an audit record. (For the matrix on its own as CSV or markdown, use the **Export CSV / Export Markdown** buttons on the Traceability matrix panel described above.)
- **Issue drafts from a finding.** Inside the **Deep Dive → Issue** dialog (see above), two extra actions let you export the draft you're looking at without publishing it: **Export markdown** downloads a paste-ready `issue-draft-<id>.md` with the **acceptance criteria as a task-list checklist** plus the problem statement, affected files, related requirements, and suggested labels; **Copy issue draft** copies the same markdown body to your clipboard so you can paste it into GitHub's "new issue" form or `gh issue create`. Both use the draft **as you've edited it** in the dialog, and both are serialized on the server so the output is consistently formatted and safe — any HTML in the model's text is neutralized and can never break the checklist or inject markup.

### 11.4 Viewing Analysis History

Navigate to the **Analysis** page to see all analysis runs across all projects. Each entry shows:
- The document or project that was analyzed
- The status with a colored badge
- Number of requirements found
- Confidence percentage (color-coded: ≥90% green, <90% yellow)
- How long it took

---

## 12. Working with Requirements

### 12.1 What Is a Requirement?

A **requirement** is a specific, actionable piece of work that was discovered during analysis. It describes something that needs to be built, changed, or fixed. For example:

> **Title**: Implement OAuth 2.0 Authentication Flow  
> **Description**: Replace the current basic authentication with OAuth 2.0 to align with industry security standards and enable single sign-on capability across the platform.  
> **Type**: Security  
> **Priority**: High  
> **Source**: "" API Security Policy v3.2, Section 4.1"

### 12.2 Requirement Properties

Each requirement has these properties:

| Property | Description | Example |
|---|---|---|
| **ID** | Unique identifier (auto-generated) | `REQ-001` |
| **Title** | Brief summary of what's needed | "Add rate limiting to public API" |
| **Description** | Detailed explanation of the requirement | Full paragraph with context and rationale |
| **Type** | Category of work | `feature`, `schema-change`, `api-change`, `security`, `performance` |
| **Priority** | Urgency level | `critical`, `high`, `medium`, `low` |
| **Status** | Where it is in the workflow | `generated`, `reviewing`, `approved`, `published` |
| **Source** | What document/code/database it came from | "API Security Policy v3.2, Section 4.1" |
| **Tags** | Keywords for categorization | `security`, `authentication`, `api` |
| **Acceptance Criteria** | Specific conditions for completion | "Users can log in via OAuth 2.0 provider" |
| **Coverage** | How strongly the requirement is backed by evidence | `Grounded in code`, `Docs only`, `No evidence` |
| **GitHub Issue #** | Linked issue number (after publishing) | `#142` |

**Coverage badge.** Every requirement row shows a small colour-coded **coverage** badge that tells you, at a glance, how well the analysis could back the requirement up with evidence. Metis works this out automatically when it synthesizes the requirements — it looks at the findings each requirement was built from and checks whether they point at real source code, only at documents, or at nothing concrete. Hover the badge for a plain-language explanation.

| Badge | Colour | Meaning | What to do |
|---|---|---|---|
| **Grounded in code** | Green | At least one supporting finding cites a specific place in the source code (a file and line range). This is the strongest evidence. | Nothing — this requirement is well-anchored to the implementation. |
| **Docs only** | Amber | The requirement is backed only by document citations; no finding traced it to actual code. It may still be valid, but its link to the implementation is unverified. | If the requirement should touch code, consider connecting the repository (or building the code graph) and re-running, so the analysis can look for code evidence. |
| **No evidence** | Red | No grounded evidence was linked to this requirement. | **Review it manually:** confirm it is real, gather the supporting documents or code, and re-run the analysis. |

Requirements from analyses run before this feature shipped show no badge (there is nothing to classify). Coverage is recomputed every time you re-run the analysis, so acting on a `No evidence` requirement — adding a document, connecting a repo — and re-running will update the badge.

You can narrow the list to a single coverage state with the **Coverage** filter above the requirements (for example, show only `No evidence` requirements so you can work through the ones that need attention).

### 12.3 Filtering and Searching

The **Requirements** page provides powerful filtering tools to help you find specific requirements:

**Search Bar**: Type any text to search across requirement titles, IDs, and source references. Results update instantly as you type.

**Priority Filter**: Click the Priority dropdown to show only requirements of a specific priority level:
- All Priorities (default)
- Critical
- High
- Medium
- Low

**Status Filter**: Click the Status dropdown to show only requirements in a specific state:
- All Statuses (default)
- Generated (newly created by analysis)
- Reviewing (being reviewed by a human)
- Approved (approved and ready for publishing)
- Published (already sent to GitHub)

The page header shows a count of how many requirements match your current filters.

### 12.4 The Traceability Matrix

The Requirements page has a second tab called **Traceability Matrix**. This is a table that shows the lifecycle of every requirement at a glance:

| Requirement | Analyzed | Approved | Issue Created | Published |
|---|---|---|---|---|
| REQ-001: Add rate limiting | ✅ | ✅ | ✅ | ✅ |
| REQ-002: Schema migration | ✅ | ✅ | ⬜ | ⬜ |
| REQ-003: Update dashboard | ✅ | ⬜ | ⬜ | ⬜ |

- ✅ Green checkmark = this stage is complete
- ⬜ Gray icon = this stage is pending

This matrix gives you instant visibility into where each requirement stands in the pipeline — from initial discovery through final publication.

### 12.5 Editing Requirements

You can edit any requirement that hasn't been published yet:
1. Navigate to the requirement
2. Modify the **title**, **description**, **body**, or **labels** as needed
3. Save your changes

This is useful when the AI's initial wording needs refinement or when you want to add additional context before publishing.

### 12.6 Approving Requirements

Before a requirement can be published to GitHub, it must be **approved**. This is a human-in-the-loop step that ensures nothing gets published without review.

**Individual approval**: Click the **"Approve"** button on any requirement in `generated` or `reviewing` status.

**Bulk approval**: Use the "Approve All" action to approve all drafts for a project at once. Use this when you've reviewed everything and are confident in the batch.

#### 12.6.1 The approval gate (require approved review)

For teams that use the **formal review workflow** (the Reviews page — see the review queue in the sidebar), a project can additionally enforce that nothing is published or exported without a signed-off review:

- **Where:** the **Approval gate** card at the top of the project's **Publishing** page. Tick **"Require approved review to publish/export"**. Only review administrators (coordinator or admin) can change the setting — everyone else sees it read-only. It is **off by default**, so nothing changes until you enable it.
- **What it enforces (when on):** publishing issue drafts (single approve, live batches, and retried/re-published batches — to GitHub and to Jira), pushing test-coverage suggestions to an external test-management system (GitHub, Xray/Jira, Zephyr, TestRail), exporting a generated document (PDF/Word/Markdown), and exporting a requirement's version history (CSV/JSON) are all **blocked** unless each item has an **approved review of its current content**. If a requirement or document changed after its review was approved, the old approval no longer counts — submit it for review again.
- **What you see on a block (#1117):** the draft row you clicked shows an inline message right where you clicked it, and a fuller notice appears **above** the drafts list — it used to render below the list, which on a long list put it off-screen and made a rejected Approve read as a click that did nothing. The notice leads with how many requirements/documents still need review (and any drafts not linked to a requirement at all), shows the first five ids plus *"and N more"* rather than a wall of identifiers, and links to **Create or view reviews**. Dry-run publishes are never blocked — use them to preview what still needs sign-off. Local file downloads (the Excel/Gherkin/Playwright test-coverage exports and the clarify-question CSV/JSON) are also never blocked: they write nothing to external systems, like dry-run previews.
- **Safety behavior:** the gate *fails closed*. If METIS cannot verify approvals (for example, a temporary database problem), the publish/export is blocked rather than allowed — retry once the system recovers.

#### 12.6.2 Baselines (immutable snapshots of approved requirements)

When a review of requirements is **approved**, METIS automatically creates a **baseline**: a named, immutable snapshot recording the exact version of every requirement in the review's scope at sign-off time. This is the same review-to-baseline coupling you may know from IBM DOORS Next or Jama Connect — approval *is* the baselining event, so your audit trail and your requirement snapshots can never drift apart.

- **Where:** the project's **Requirements** tab → **Baselines**. The review detail page also links straight to the baseline a review produced.
- **List:** every baseline in the project, newest first, showing how many requirements it pins and which review produced it (or who created it manually).
- **Contents:** open a baseline to see each requirement **as it was at its pinned version** — even if it has been edited or deleted since. A drift note ("now at v5", "deleted since") tells you where the requirement is today, but the baseline itself never changes.
- **Compare:** with two or more baselines, pick two in the compare picker to see what changed between sign-offs: requirements **added**, **removed**, **unchanged**, and **changed** — the changed ones with a field-by-field before/after diff (title, body, priority, type, story points, …).
- **Manual baselines:** review administrators (coordinator or admin) can also create a baseline directly via the API (`POST /api/projects/:id/baselines`), pinning the current version of all (or a chosen subset of) the project's requirements — useful for milestone freezes outside a formal review.
- **Immutability:** baselines cannot be edited or deleted — there is no such button and no such API. They are audit artifacts: what was approved stays exactly as approved.

### 12.7 Linking Requirements to Database Tables (Data Mappings)

Every requirement can be linked to the specific database tables and columns that implement or relate to it. This **requirement ↔ data traceability** lets you see at a glance which schema objects each business rule touches.

The **Data Mappings** panel appears directly below each requirement card on the **Analysis** page.

#### Two ways to create a mapping

**Manual:**
1. Click **"Add mapping"** on any requirement.
2. Select the database connection, enter the schema name, table name, and (optionally) a specific column.
3. Click **Save**. The mapping is stored with a confidence of 1.0 (manually confirmed).

**AI-suggested:**
1. Click **"Suggest mappings"** on any requirement.
2. METIS queries the RAG knowledge base (populated when your database schema was ingested) and asks the LLM to reason about which tables/columns are relevant to the requirement text.
3. Ranked candidates are returned with a confidence score (0–100%) and a brief rationale.
4. Click **Accept** on any candidate to save it, or dismiss suggestions you don't agree with.

> **Prerequisite:** The database connection must already be set up under the project's **Connections** tab. Schema ingestion happens automatically the first time a connection is tested or saved, so "Suggest mappings" is most useful after the Database Analyst agent has run at least once.

#### Reading the mappings

Saved mappings are shown as badges in the format `schema.table` or `schema.table.column`, each with a confidence percentage. You can remove any mapping at any time using the **Remove** button next to it.

---

### 12.8 Linking Requirements to Each Other (Requirement Links)

Requirements rarely stand alone — one depends on another, duplicates a second, or was derived from a third. The **Linked requirements** panel, directly below each requirement card on the **Analysis** page, lets you record these typed relationships, including links that cross project boundaries within the same workspace.

#### Reading the panel

Each row shows the linked requirement's title and a direction-aware relationship label:

- An **outgoing** `depends_on` link reads **"depends on"**; the same edge, seen from the other requirement, reads **"required by"**.
- `duplicates` ↔ **"duplicated by"**, `derived_from` ↔ **"source of"**, and `relates_to` reads **"relates to"** in both directions.

When the counterpart lives in a **different project**, its row carries a distinct **project badge** — click it to deep-link straight into that project's Analysis view. Same-project links show no badge.

#### Adding a link

1. Click **"Add link"** to open the dialog.
2. Choose a **Link type** (Relates to, Duplicates, Depends on, or Derived from).
3. Start typing in **Search requirements** — METIS searches every requirement across your workspace that you have access to (the current requirement is excluded), debouncing as you type.
4. Click **Link** next to the requirement you want. The panel refreshes in place — no page reload.

> **Workspace required:** linking searches across a workspace, so a project that does not belong to any workspace shows a short notice instead of the search box. Links are only allowed within a single project or between projects that share the same workspace.

METIS guards against invalid links: self-links, duplicates, and `depends_on` cycles are rejected, and you can only link requirements in projects you can access. When the server rejects a link (for example, "This link would create a dependency cycle"), the reason appears as an inline message in the dialog so you can adjust and retry.

#### Removing a link

Click **Unlink** on any row to remove the relationship; the panel updates immediately.

Once links exist, they roll up to a workspace-wide picture — see [Section 12.10](#1210-workspace-traceability-rollup).

---

### 12.9 Version History & Audit Trail

Every edit to a requirement is recorded. The **History** panel lets you see exactly what changed, when, and by whom — and roll back to any earlier version without losing the record.

Click the **"History"** button on any requirement card on the **Analysis** page to expand its version timeline.

#### Comparing versions

1. The timeline lists every version, newest first, showing the time of the change, who made it, and which fields changed.
2. Click any version to select it (entries are keyboard-focusable and toggle with Enter/Space).
3. Select **two** versions to reveal a **side-by-side diff** of the requirement's contents at each version.

#### Restoring a previous version

Restoring is limited to **coordinators and admins**.

1. Click **"Restore"** next to the version you want to bring back.
2. A confirmation dialog asks you to type the exact phrase **`Restore version N`** (where `N` is the version number). This guards against accidental rollbacks.
3. Optionally add a reason, then confirm.

Restoring does **not** overwrite history — it creates a **new** version with the restored contents, so the full trail (including the restore itself) is always preserved.

#### Exporting the history

Use the **Export** dropdown at the top of the History panel to download the **complete** version history (all versions, not just the current page) as **CSV** or **JSON** — handy for compliance records and offline audits.

---

### 12.10 Workspace Traceability Rollup

Individual requirement links (Section 12.8) are most useful when you can see them **all at once**, across every project in a workspace. The **Workspace Traceability** view rolls them up.

Open your workspace and select the **Traceability** tab (`/workspaces/<id>/traceability`). You'll see two panels:

- **Per-project coverage** — a table with one row per project in the workspace, showing its requirement count, how many of those requirements are **linked across projects**, and its **spec** and **code** coverage as percentages. It's a quick read on which projects are well-connected and well-covered, and which are lagging.
- **Cross-project link map** — a diagram of the workspace's cross-project requirement links: each project is a box, each participating requirement a node, and each link a typed arrow between them. When there are no cross-project links yet, the panel says so.

**What you see respects your access.** The rollup only ever includes projects you can access within that workspace, and a cross-project link appears **only when you can access both of its endpoints** — so the view never reveals a requirement, project, or link you aren't entitled to see. Asking for a workspace you don't belong to returns "not found".

> **Following the chain:** on a requirement's traceability view you can also expand **linked** requirements, so a requirement→spec→code chain in one project continues into the chains of the requirements it links to in sibling projects — the same cross-project edges, seen one requirement at a time.

---

## 13. Publishing to GitHub

Publishing is the final step — turning approved requirements into actual GitHub issues that your development team can work on.

### 13.1 Setting Up GitHub Integration

Before you can publish, you need to connect METIS to your GitHub repository:

1. **Get a GitHub token** (see [Section 5.5](#55-github-integration))
2. **Configure the token** — either set it in your `.env` file or enter it on the Settings page under "API & Integrations"
3. **Set the repository** — each project has a GitHub owner and repo name (e.g., `openzigs/metis`)

### 13.2 Generating Issue Drafts

After an analysis produces requirements, you can generate GitHub issue drafts:

1. Go to the project detail page
2. Click **"Generate Drafts"** or use the Publishing API

For each requirement, METIS creates a draft issue with:
- **Epic or Feature label** — critical/high priority items become Epics; others become Features
- **Structured template**:
  - Description (from the requirement body)
  - Acceptance Criteria
  - Technical Notes (implementation guidance)
  - Evidence (source document references)
  - Traceability Footer (links back to METIS IDs for auditing)

### 13.3 Reviewing Drafts

All generated drafts can be viewed and edited before publishing:

1. Navigate to the project's drafts list
2. Click on any draft to see its full content
3. **Edit** the title, body, or labels if needed
4. Move on to approval when satisfied

### 13.4 Approving Drafts

Drafts must be approved before they can be published:

- **Approve individually** — click the Approve button on a single draft
- **Approve all** — bulk-approve all drafts for a project
- **Delete** — remove unwanted drafts

### 13.5 Batch Publishing

When your approved drafts are ready:

1. Click **"Publish Issues"** on the project detail page
2. METIS will:
   - **Sync labels** — ensure all required labels exist in the GitHub repository
   - **Publish Epics first** — larger work items are created before smaller features
   - **Cross-reference** — feature issues link to their parent epic
   - **Rate limit** — respects GitHub's API rate limits
3. Monitor progress — you'll see the batch status update in real time

**Rollback protection**: If more than 50% of publishes fail, METIS automatically closes all already-published issues to prevent a partial, inconsistent state.

### 13.6 Viewing Publish History

Navigate to the project's batches to see the history of all publish operations:

| Batch Status | Meaning |
|---|---|
| `pending` | Batch created but not yet started |
| `in-progress` | Currently publishing issues |
| `completed` | All issues published successfully |
| `partial` | Some issues published, some failed |
| `failed` | All publishes failed |
| `rolled-back` | Issues were automatically closed due to >50% failure rate |

Each batch shows which issues were published, their GitHub issue numbers, and any errors that occurred.

### 13.7 Phase 9 Publishing — Advanced Workflow

Phase 9 adds a fully RBAC-aware, dry-runnable, archivable batch publishing pipeline. Use this section if you need fine-grained control over GitHub publishing.

#### 13.7.1 Configuring the Publishing Target

Two pieces are required: the destination repo and a credential.

1. **Destination repo** — set `targetOwner` and `targetRepo` on the publishing form. For GitHub Enterprise, also set `GHE base URL` to the Enterprise API URL (e.g. `https://github.example.com/api/v3`). Public github.com leaves it blank.
2. **Vault secret reference** — store your Personal Access Token (PAT) in the METIS vault and reference it as `vault:<secret-name>` in the `Vault secret ref` field. Tokens are never logged and are only resolved at the moment of the live publish call.
3. **Cross-project safety** — if a different METIS project has already connected the same `owner/repo`, the API rejects the publish with `REPO_CROSS_PROJECT` (HTTP 409). Set `metadata.confirmCrossProject = true` to acknowledge and proceed.

#### 13.7.2 Generating Drafts From Analysis

On the **Publishing** tab:

1. Enter your **Analysis ID**, target owner, and target repo.
2. Click **Generate** — METIS will create one Epic and N Features (one per requirement) with auto-assigned labels and a traceability footer linking back to the analysis.
3. Re-running generation against the same analysis will **refresh** existing drafts in place rather than duplicating them.

Permission required: `issue.draft` (admin / coordinator / developer).

#### 13.7.3 Previewing a Draft (Diff View)

Click **Preview** next to any draft to open the diff dialog:

- If the draft has a previous version (i.e. it has been published before and METIS has stashed the previous body in metadata), you see a line-by-line diff showing additions (`+`) and removals (`−`).
- Otherwise the dialog renders the current body for inspection.

This is your last sanity check before approving — review every change before pushing it back to GitHub.

#### 13.7.4 Bulk Approve

You can multi-select drafts via the checkboxes in the drafts table, then click **Bulk approve (N)**. A confirmation dialog shows:

| Bucket | What it means |
|---|---|
| **created** | drafts in `draft` state that will transition to `approved` |
| **updated** | drafts already `approved` (re-approval is a no-op but logged) |
| **skipped** | drafts in `published` or `failed` state — left untouched |

Click **Approve N** to confirm. Each approval is audited individually.

Permission required: `issue.draft`.

#### 13.7.5 Dry-Run Preview

Always run a **dry-run** before a live publish:

1. Tick **Dry run (no GitHub writes)** in the publish form.
2. Click **Run dry-run**.
3. METIS computes the exact set of issues it _would_ create or update, including label-sync deltas, dedup matches, and parent/child sub-issue relationships — without ever calling GitHub.
4. The resulting batch is recorded with `dryRun=true` so you can review the full plan in the Recent Batches table.

Permission required: `issue.preview` (everyone except `reader`).

#### 13.7.6 Publishing a Live Batch

Once the dry-run looks correct:

1. Untick **Dry run**.
2. Make sure your **Vault secret ref** is filled in.
3. Click **Publish now**.
4. Watch live progress in the Recent Batches table — click **Watch** on the new batch to stream `publish:status` / `publish:progress` / `publish:completed` events over the WebSocket.

Permission required: `issue.publish` (admin / coordinator only). Developers can dry-run but cannot live-publish.

#### 13.7.7 Archive and Rollback

Every batch can be archived after the fact. Archive does two things:

1. **Hides the batch** from the default Recent Batches view (toggle "Include archived" to see it).
2. **Optionally closes** the GitHub issues that were created by this batch (`closeIssues: true`). Closing only targets issues this batch _created_ — issues that were merely _updated_ by the batch are left alone, so you cannot accidentally close pre-existing tickets.

**Authorization** (Phase 9 hardening):

- Admins can archive any batch.
- The user who started the batch can archive their own batch.
- Anyone else — even another coordinator with `issue.publish` — gets a 403 `PUBLISH_BATCH_FORBIDDEN`.

Every archive (and every denied attempt) is recorded in the audit log.

#### 13.7.8 Rate Limit and Backoff Behavior

The publisher uses Octokit's throttle plugin with a real sleeping backoff:

- **Primary rate limits**: METIS waits the full `Retry-After` interval, then resumes.
- **Secondary rate limits**: METIS waits a jittered backoff but caps total cumulative backoff per request at the configured budget. If the budget is exhausted the request fails fast rather than spinning.
- **Sub-issue API**: if the GitHub Enterprise instance is too old to support the `sub_issues` endpoint (404/410), METIS caches that fact and silently skips parent-linking on subsequent issues in the same process — no retry loops.

You don't have to configure any of this manually; it's tuned for safe, predictable behavior under load.

### 13.8 Change Analysis

Compare two analysis snapshots to see what requirements changed between versions.

1. Navigate to your project and click the **Changes** tab.
2. Select a **Base analysis** (the older snapshot) and a **Head analysis** (the newer one).
3. Click **Run Change Analysis**. METIS compares every requirement in both snapshots and detects:
   - **Added** — new requirements that didn't exist in the base
   - **Removed** — requirements that existed in the base but are gone in the head
   - **Modified** — requirements that changed (body text, priority, type, or title)
4. Each change gets a **severity** (low/medium/high) and **impact score** (0–1) based on the nature of the change.
5. Review each change and **Approve** or **Reject** it to track which changes have been acknowledged.

Past runs appear in the **Analysis History** list. Each run is labeled by a stable
sequence number and the date-time it started — for example **"Run #3 — Jun 22, 2026,
2:14 PM"** — so two runs from the same day are easy to tell apart and you can see at a
glance which is newer. The run's short id is still shown beneath the label as a muted
secondary token for copy / deep-link purposes; it is no longer the primary label.

Permission required: `analysis.run` to trigger, `analysis.read` to view results.

### 13.9 Multi-Project Impact Analysis

See how a change to your requirements ripples through the **code** of two or more
projects at once. METIS maps each new or changed requirement to the affected
files, functions, and symbols in every selected project, then walks the code
graph to include the transitive blast radius (callers, importers, and downstream
dependencies).

1. Open **Impact Analysis** from the **Knowledge** section of the sidebar and
   click **New analysis**.
2. Provide the requirement change — either **Paste text** of the new/changed
   requirements, or pick an existing **document** that has already been ingested.
3. Select **two or more projects** to compare the change against. Each project's
   source must already be ingested into the code graph.
4. Click **Run impact analysis**. METIS starts the run and opens the results
   view, which updates automatically as the analysis completes.
5. The report is grouped **per project**. For each impacted requirement you see a
   **severity** badge and **impact score**, the **directly affected** symbols,
   and the **blast radius** symbols tagged with their relation (caller, importer,
   dependency) and depth.

Only projects you have access to appear in the picker, and you can only open a
report whose projects are all visible to you.

Permission required: `analysis.run` to trigger, `analysis.read` to view results.

> **AI enrichment is ON by default, and it costs money per analysis.** METIS
> enriches every impact analysis with four AI stages (relevance filtering,
> proposed new columns, coverage advisories, and plain-English summaries). On an
> install with an AI provider configured, **each changed requirement costs roughly
> $0.05 and adds around 20 seconds** — measured against Anthropic
> `claude-sonnet-5`; a run that needs an internal retry can reach ~$0.08 and ~28 s.
> Ten changed requirements cost roughly ten times that. If no AI provider is
> configured the analysis still completes, using the deterministic results only,
> and says so in the summary. See
> [13.9.5 AI enrichment: what it costs and how to turn it off](#1395-ai-enrichment-what-it-costs-and-how-to-turn-it-off).

#### 13.9.0 Plain-English impact summary

When enabled, METIS adds a **BA-readable summary** on top of the raw impact
detail: a run-level **Summary** block above the per-project tables that describes,
in plain English, what changed, which tables/DDL are affected, and the overall
severity — plus a short **per-requirement narrative** on each card that leads with
the most-likely-affected tables and calls out the risk. The summary is written by
an AI model, but it is **grounded**: it only ever restates facts the deterministic
analysis already found (affected symbols, tables, and suggested DDL) and is
validated so it cannot introduce a table, column, or file that is not in the
results. Any suggested DDL it mentions is **text only and never executed**.

This feature is **on by default** and **non-blocking** — the deterministic report
always renders, with or without the summary. Operators turn it off with
**`IMPACT_LLM_SUMMARY=0`** (or `false`); `AI_PROVIDER=offline-stub`, or no
provider at all, also leaves the summary off. If the model is unavailable or
returns something ungrounded, METIS simply omits the summary — the impact data is
unaffected. This is the most expensive stage of an analysis: it runs once per
requirement **and** once for the run overview, so switching it off saves two of
the five AI calls a single-requirement analysis makes.

#### 13.9.1 Database Schema Impact

When **Include database schema impact** is enabled on the create form (the
default), each impacted requirement also reports the **database tables and
columns** it touches, per project. METIS derives these from the schema graph:

- **Live DB** — introspected (read-only) from a configured database connection.
  This is the authoritative source of truth.
- **MyBatis** — inferred from MyBatis XML mappers and annotated mapper
  interfaces.
- **ORM** — inferred from JPA/Hibernate entities or Prisma models.
- **jOOQ** — resolved from jOOQ's generated table classes (`TableImpl`
  subclasses) and the `DSLContext` queries that reference them — symbol
  resolution, not SQL parsing.
- **DDL file** — parsed from `.sql` files in the repository.

Each affected table/column shows a **provenance badge** (Live DB vs an inferred
source) and a **suggested DDL** string. Inferred references are **reconciled**
against the live schema when one is available; mismatches are flagged as
`Table not in live schema` or `Column not in live schema`.

> The suggested DDL is **advisory text only** — METIS never executes any DDL and
> never modifies your database. Treat it as a starting point for a reviewed,
> human-authored migration.

**Suggested new columns.** A requirement written the way a business
analyst writes one — *"a cancelled order must record who cancelled it and when"*,
*"each line item must carry its own shipment status and dispatch date"* — implies
**new columns**, but the plain-language wording is an obligation, not the
developer imperative (*"add a cancellation timestamp field to orders"*) METIS's
deterministic detector looks for. With this feature enabled, METIS additionally
asks an AI model which new columns the requirement implies and shows them as
**Proposed column changes** on the table they belong to, e.g.
`ALTER TABLE orders ADD COLUMN cancelled_at TIMESTAMP;`. The proposal is
**grounded**: a column can only ever be proposed on a table the deterministic
analysis already surfaced for that requirement — the model cannot introduce a
table or invent a schema — and a column that already exists is never re-proposed.
The column **name and type are suggestions**, flagged as such inline, and the DDL
is (as everywhere else in METIS) **text only and never executed**.

This feature is **on by default**; operators turn it off with
**`IMPACT_LLM_ADDITIVE_DDL=0`** (or `false`). With it off, or if the model is
unavailable or returns something ungrounded, the report renders exactly as it
would without AI — the proposals are **added** to the deterministic results and
never replace them, so nothing is lost either way.

**Affected procedures & functions.** When the impacted code invokes a stored
**procedure** or **function**, those routines are listed in their own *Affected
procedures & functions* sub-section beneath the tables. METIS introspects routine
existence and signature only — it **never reads or runs the routine body** — so
each routine shows a **verify-only** note rather than a DDL suggestion, and there
is no drop/alter affordance. (Deep analysis of what a routine's body touches is a
later phase; until then, an object reachable only through a routine body is shown
as *uncertain*, never as unused.)

Uncheck **Include database schema impact** when creating an analysis to skip the
schema dimension entirely.

Permission required: `analysis.run` to trigger, `analysis.read` to view results.

#### 13.9.2 Used vs full schema (object usage classification)

On the impact report, each project section shows a **Used objects** panel that
reconciles your **full database schema** (introspected, read-only) against the
code that references it. Every table, column, **procedure, and function** is
classified as:

- **Used** — referenced by analyzed code (a `reads`/`writes`/`persists-to` edge
  points at a table/column, or an `executes` edge points at a procedure/function).
  Hover the badge to see the **evidence** (which code symbol references it, and
  how).
- **Unreferenced** — present in the database but not referenced by any analyzed
  code. This is a **candidate for human review only** — METIS does **not**
  recommend dropping it. Dynamic SQL, reflection, and code outside the analyzed
  repos are invisible to static analysis, so an unreferenced object may still be
  in use.
- **Uncertain** — the reference could not be statically resolved (dynamic SQL,
  or a reference to an object missing from the live schema). Shown with a
  distinct badge and a reason code; **never** treated as unused.

Use the **Only show used** toggle to focus on referenced objects; the full
schema remains accessible by toggling it back off. There is deliberately **no
"drop" action anywhere** — the classification is informational.

Classification is computed per project (it reconciles the project's primary
database connector's introspected schema against the schema graph) and is
viewable with `analysis.read`; recomputing it requires `analysis.run`. The same
classification also appears as a **Used Objects** section in the generated
database schema document (see §30) — the full-schema reference there is retained
unchanged.

#### 13.9.3 Broader SQL extraction and manual overrides

METIS resolves SQL usage from far more than mapper/ORM files. A dedicated
**SQL-lineage service** parses SQL embedded as **string literals in application
code** (TypeScript, JavaScript, Python, Go), **stored-procedure bodies**
(best-effort), and **SAS `PROC SQL` blocks**, and feeds the resulting table and
column references into the same Used/Unreferenced/Uncertain classification. When
your database connector's schema is available, the parser also expands `SELECT *`
and resolves bare column names, which substantially improves column-level
accuracy. SQL the parser cannot resolve statically — typically **dynamic SQL**
(queries built at runtime from strings) — is classified **Uncertain**, never
dropped. This extraction runs as part of normal analysis; no extra setup is
required, and if the service is unavailable, analysis still completes (the
unresolved SQL simply stays Uncertain).

**Correcting a classification (manual override).** Because dynamic SQL is
invisible to static analysis, you can **assert or correct** how an object is
classified. For example, if you know a runtime-built query reads
`orders.total`, record a manual override so the impact report reflects it. A
manual override:

- takes **precedence** over the parser-derived classification (the report shows
  your asserted class, and the badge notes the originally-derived class it
  replaced);
- is **provenance-tagged "Manual override"** so reviewers can see it was a human
  assertion, not a derived fact;
- **never triggers a drop** — like everything in this panel, it is informational
  and only changes how the object is shown for review and impact.

Manual overrides are managed via the API, scoped to a single project:

- `GET    /api/impact-analyses/projects/:projectId/usage-overrides` — list (requires `analysis.read`)
- `POST   /api/impact-analyses/projects/:projectId/usage-overrides` — assert/correct (requires `analysis.run`)
  with body `{ kind, tableName, columnName?, usageClass, access?, note? }`
- `DELETE /api/impact-analyses/projects/:projectId/usage-overrides/:overrideId` — remove (requires `analysis.run`)

Re-asserting the same object updates the existing override in place. Removing an
override restores the parser-derived classification on the next view.

##### Enabling SQL lineage per project

The broader SQL extraction above requires the **`metis-sql-lineage`** sidecar
(a separate Python service, `SQL_LINEAGE_MODE=sidecar` + `SQL_LINEAGE_TOKEN`
configured platform-wide — see the sidecar deployment notes in `docker-compose.yml`).
By default every project follows that platform setting. If you need to turn it
on or off for one project specifically — without an operator changing the
platform env var — open **Project → Settings → SQL lineage** and choose:

- **Auto** (default) — follows the platform default; no change from today.
- **On** — always attempt SQL-lineage extraction for this project, even if the
  platform default is off. If the sidecar itself isn't configured
  (`SQL_LINEAGE_TOKEN` unset), the card shows an explicit "sidecar looks
  unconfigured" warning rather than silently producing no lineage edges.
- **Off** — never attempt it for this project, even if the platform default is on.

The same `GET`/`PATCH /api/projects/:id/sql-lineage` endpoints back the card
(`{ setting, enabled, reason, sidecarConfigured }` on read).

**Oracle Tier-1 dependency lineage.** For Oracle connectors, ingest also reads a
coarse, zero-parse fallback straight from the database's dependency catalog
(`ALL_DEPENDENCIES`) — no SQL is parsed, no procedure body is fetched. This
populates package/procedure/function → referenced-object edges even when the
sidecar path above is unavailable; it is refined by the sidecar's precise
per-statement analysis once that runs. It follows the same per-project setting.

##### Reading the SQL-lineage coverage metric

Static analysis cannot always tell **which** table a statement touches: SQL
built at runtime (MyBatis `${}` substitution, Oracle `EXECUTE IMMEDIATE`, Java
string concatenation with a non-constant piece) and coarse Oracle
`ALL_DEPENDENCIES` rows are recorded but flagged as **unresolved / dynamic** —
never dropped, and never guessed. The **gap report** surfaces this as a coverage
metric at the top of the report (and in the exported markdown):

> **N% of table edges are dynamically resolved / need manual confirmation** —
> *X of Y edges; Z% resolved precisely.*

Read it as: **Z% of the schema surface was pinned to a specific table/column**,
and the remaining **N%** points at a placeholder or a coarse dependency that a
human should confirm (e.g. by adding a manual override, above, or checking the
runtime query). The panel breaks the unresolved edges down **by source**
(`mybatis`, `sqlglot`, `catalog-deps`, …) and lists a bounded sample of them as
copyable `file:line` locators with the reason each could not be resolved
(`dynamic` runtime-built SQL vs a `coarse Tier-1 catalog` object-level edge). A
project with no SQL-lineage edges shows no coverage section. The metric is
computed from already-persisted data — no extra analysis run is needed.

#### 13.9.4 Cross-project impact (shared databases)

When several projects in the **same workspace** connect to the **same physical
database**, METIS recognises them as one shared **database resource** and can
reason about impact **across** those projects. This is automatic: when you create
a database connection in a workspace project, it is linked to a shared resource
keyed by driver + host + port + database. Connections in a project with no
workspace, or without enough identifying detail (no host/database), are simply not
linked — distinct databases are never merged.

Two cross-project views become available:

- **Used by N projects.** For an affected object (table/column/procedure/function),
  the impact report shows how many **other** projects in the workspace also use it,
  with each project's own usage class (Used / Unreferenced / Uncertain) and the
  number of code references. This tells you, before you change a shared table,
  which other teams depend on it.
- **Cross-project impact.** For a requirement change in one project, METIS
  aggregates the **other** projects in the workspace that use the affected objects,
  grouped per project — so the blast radius of a shared-schema change is visible at
  a glance.

Like the rest of the schema panels, these views are **read-only and
informational**: there is **no "drop" action anywhere**, and **Uncertain** usage
is clearly labelled and must be investigated manually — METIS never recommends a
schema change.

**Access control (important).** Cross-project results respect workspace
boundaries. You only ever see resources, objects, and projects within workspaces
you are a **member** of, and only the individual projects you can access — even
within a shared workspace. Asking about a workspace you do not belong to returns
"not found" (your access is never used to confirm that another workspace's data
exists). The underlying endpoints both require `analysis.read`:

- `GET /api/impact-analyses/workspaces/:workspaceId/objects/usage?objectName=…&schemaName=…&objectType=…` — which projects use an object
- `GET /api/impact-analyses/projects/:projectId/cross-project-impact` — aggregated cross-project impact for a source project

#### 13.9.5 AI enrichment: what it costs and how to turn it off

Impact analysis has a **deterministic core** — the code graph and schema crossing
— and an **AI enrichment layer** on top of it. The core makes no AI calls and is
always what you see; the enrichment layer improves it and is what costs money.

**All four enrichment stages are ON by default.** This changed in METIS 0.x
(issue #1025): before, they all shipped off, and the out-of-the-box result was
27 lines of `-- Verify column orders.billaddr1` comments for a requirement like
*"a cancelled order must record who cancelled it and when"* — technically correct
and practically unusable. With enrichment on, the same requirement returns a
short list of genuinely relevant tables, two proposed `ALTER TABLE … ADD COLUMN`
statements, a reason per table, and a note if part of the requirement looks
uncovered.

| Stage | What it adds | Turn off with | AI calls saved |
|---|---|---|---|
| Table relevance filter | Prunes tangential tables; adds the per-table reason | `IMPACT_LLM_TABLE_FILTER=0` | 1 per requirement |
| Proposed new columns | The actionable `ADD COLUMN` suggestions | `IMPACT_LLM_ADDITIVE_DDL=0` | 1 per requirement |
| Coverage advisories | *"this analysis may be incomplete because…"* | `IMPACT_LLM_CLAUSE_RECONCILE=0` | 1 per requirement |
| Plain-English summaries | Run overview + per-requirement narrative | `IMPACT_LLM_SUMMARY=0` | 1 per requirement **plus** the run overview |

Every flag also accepts `false`. Turning a stage off removes only that stage.
Turning all four off restores the pre-#1025 behaviour exactly: **no AI calls, no
cost**, deterministic results only.

**Cost and time.** Measured against Anthropic `claude-sonnet-5` on a
single-requirement analysis: **five AI calls, ~12.4–12.8k tokens, ≈$0.05, ~20
seconds**. A run where the model needs an internal retry reached 6 calls, 21.3k
tokens, **$0.078 and 28 seconds** — treat that as the ceiling for one
requirement. Four of the five calls are **per changed requirement**; the run
overview happens once per analysis however many requirements it covers. So a
10-requirement analysis is about 41 calls, ≈$0.4–0.6, and a few minutes. The
usage is recorded per project in the AI token ledger under the step names
`impact.table-filter`, `impact.additive-ddl`, `impact.clause-reconcile`,
`impact.summary-item` and `impact.summary-run`, so you can see the spend rather than infer it.

**One stage stays off.** `IMPACT_LLM_ENTITY_SEEDS` (an experimental way of
finding *more* code for a requirement) remains opt-in, because measurement showed
it made results **less** precise without finding the things it was meant to find.
Leave it off unless you are deliberately experimenting.

**If you have no AI provider.** Nothing breaks. The analysis completes on the
deterministic results, no stage produces partial or invented output, and the
summary block tells you plainly that *"AI enrichment did not run for this
analysis (no AI provider is configured)"* and lists which stages did not apply —
so an un-enriched report can never be mistaken for an enriched one.

### 13.10 Dual-Destination Publishing

METIS can publish issues to GitHub, Jira, or both simultaneously.

#### Configuring the Destination

1. Go to **Project Settings** or use the API: `PATCH /api/projects/:id/publish-destination`
2. Set the destination:
   - `github` — publish to GitHub only (default)
   - `jira` — publish to Jira only
   - `both` — publish to both GitHub and Jira
3. For Jira destinations, you must also provide:
   - **Jira Connection** — a configured Jira connection (see Section 17 — Jira)
   - **Jira Project Key** — the Jira project key (e.g., `PROJ`)

#### How It Works

When a batch is published:
- **GitHub-only**: works exactly as before (see 13.7)
- **Jira-only**: maps each draft to a Jira issue (Story, Epic, Bug, or Task) and creates it via the Jira API
- **Both**: publishes to GitHub first, then Jira. If Jira fails, GitHub issues are still created — Jira is best-effort in dual mode.

Each `PublishedIssue` record tracks its `destination` ("github" or "jira") so you can see where each issue landed.

---

## 14. Using the AI Chat

The AI Chat is your interactive assistant for asking questions, getting help with analysis, and exploring your project data.

### 14.1 Starting a Conversation

1. Click **"AI Chat"** in the sidebar
2. You'll see a welcome message from METIS
3. Type your question or message in the text box at the bottom
4. Press **Enter** to send (use **Shift+Enter** for a new line within your message)

The AI responds in a chat-bubble format — your messages appear on the right in blue, and the AI's responses appear on the left in gray. While the AI is thinking, you'll see three bouncing dots (a typing indicator).

### 14.2 What the AI Can Help With

You can ask the AI about anything related to your projects:

**Project guidance:**
- "How do I create a new project?"
- "What's the best way to organize my documents?"

**Analysis help:**
- "What should I analyze first?"
- "Explain the analysis results for my project"
- "What do the confidence scores mean?"

**Requirements:**
- "Summarize the requirements for Project X"
- "Which requirements are highest priority?"
- "What's the difference between an epic and a feature?"

**Technical questions:**
- "What's the architecture of our codebase?"
- "Describe the database schema for the EMPLOYEES table"
- "What API changes are needed?"

**General assistance:**
- "Help me write acceptance criteria for this requirement"
- "What are industry best practices for API rate limiting?"

### 14.3 AI Tools

During a conversation, the AI can use tools to take actions:

| Tool | What It Does |
|---|---|
| **Search Knowledge Base** | Searches your uploaded documents for relevant information |
| **Inspect Database** | Examines a connected database's schema |
| **Query Database** | Runs read-only SQL queries to answer data questions |
| **Calculate** | Performs mathematical calculations |
| **Get Current Time** | Returns the current date and time |

When the AI uses a tool, you may see a brief notification. This is normal — it's the AI reaching out to get more information to give you a better answer.

### 14.4 Token Budget

Each AI session has a token budget (default: 100,000 tokens). Think of tokens as "word units" — roughly 4 characters equal 1 token. A typical conversation uses a few thousand tokens. The budget prevents runaway costs.

You can check your token usage for a session via the session's usage endpoint. If you exceed the budget, the AI will let you know, and you can start a new session.

### 14.5 Per-project AI provider and model overrides

By default, every AI session inherits the global provider and model from the server's environment (`AI_PROVIDER`, `AI_MODEL` / `BEDROCK_MODEL` / `COPILOT_MODEL`). Two project-scoped overrides let you steer individual projects to a different backend or model without touching env or restarting the server. Open a project (`/projects/[id]`) and look at the **Settings** card:

- **AI provider** — pick `bedrock-gateway`, `local-gemma`, `copilot-native`, `openai`, `azure`, `anthropic`, or `offline-stub`. Choose **Global default** to clear the override.
- **AI model** — free-form text. Paste any provider-specific model id, e.g. `us.anthropic.claude-sonnet-4-6` for Bedrock, `gemma4:12b` for local Gemma, `gpt-5` for OpenAI, or `claude-sonnet-4-6` for Copilot. Leave blank to use the global default.

Both fields persist on the `Project` row and are read at session-create time. The per-session `model` field on `POST /api/ai/sessions` (e.g. when an agent definition pins its own model) still wins over the project override; the project override only fires when the request body omits `model`. Bedrock model ids are not validated against an allow-list — METIS only enforces ≤ 200 characters and trims whitespace — so any model id your gateway accepts will work. Sessions started before you change a project's overrides keep the provider/model they were created with; new sessions pick up the new values immediately.

> **Running Gemma locally?** Set `AI_PROVIDER=local-gemma` to stream from a local Gemma model via Ollama's OpenAI-compatible server instead of AWS Bedrock — keeping document content on-prem. Install Ollama, run `ollama pull gemma4:12b`, set `LOCAL_GEMMA_BASE_URL=http://localhost:11434/v1` (the `/v1` suffix is required), `LOCAL_GEMMA_MODEL=gemma4:12b`, and `LOCAL_GEMMA_API_KEY=ollama` (a dummy bearer token — the header is required but the value is ignored). Only loopback/private hosts are accepted; public LLM hosts are refused. Switching back to Bedrock is a one-line `AI_PROVIDER=bedrock-gateway` change. `local-gemma` is chat/stream only — embeddings stay on the existing embeddings backend. See the README "Run Gemma locally" quickstart for the full walkthrough.

> **Docker / Kubernetes:** the validator accepts only `localhost` and IP literals, so internal DNS **service names** such as `http://ollama:11434/v1` are intentionally rejected (this keeps the SSRF surface tight). In containers, point `LOCAL_GEMMA_BASE_URL` at a loopback or IP address instead — e.g. host networking with `127.0.0.1`, or the Ollama container/pod IP like `http://10.0.0.12:11434/v1`.


### 14.6 Cross-Project Search

By default, the AI Chat searches only within the current project's knowledge base. With the **Project Scope Selector**, you can search across multiple projects simultaneously.

**Using the scope selector:**

1. In the Chat page, locate the scope pill above the message input (shows "All projects" by default).
2. Click the pill to open the project picker.
3. Select specific projects to scope your search, or choose "All my projects" to search everything you have access to.
4. Your selection is remembered across sessions (stored in your browser).

**How cross-project results appear:**

When the AI retrieves information from multiple projects, each source is tagged with a colored badge showing the project name. This makes it clear which project each piece of information came from — helpful when requirements overlap or conflict across projects.

**Access control:** You can only search projects you have been granted access to. If a project is removed from your access, its results will no longer appear in cross-project searches.

---

## 15. Managing Git Repositories

> **v1.2.0 update.** Repositories are now reachable two ways: (a) the
> per-project **Connections** tab (still the source of truth for connector
> CRUD — see §15.4), and (b) a top-level `/repositories` page in the sidebar
> that aggregates every repo across every project the operator can see, with
> a project-name filter and one-click "open in project" links. Both surfaces
> hit the same `/api/projects/:id/connectors/repos` endpoints — no new
> server routes were added (`#196 / #224`).

### 15.1 Why Connect Repositories?

When METIS analyzes your project, the **Code Analyst** agent can examine your source code to discover technical requirements — things like:
- API endpoints that need updating
- Architectural patterns that should be maintained
- Technical debt that should be addressed
- Dependencies that need upgrading

For this to work, METIS needs access to your code repository.

### 15.2 Adding a Repository

1. Use the Repos API to register a repository:
   - Provide the **GitHub URL** (HTTPS or SSH format)
   - Example: `https://github.com/openzigs/grid-monitoring.git`

2. METIS will:
   - **Clone** the repository to a local cache
   - **Index** all files, detecting 30+ programming languages
   - **Generate a "Brain"** — an AI-readable summary of the entire codebase

### 15.3 Repository Brain

The "Brain" is an AI-generated summary of a repository that includes:

- **Architecture detection** — identifies structural patterns (src/, routes/, lib/, etc.)
- **Key file identification** — entry points (index.ts, main.py), configuration files (package.json, Dockerfile), documentation (README)
- **Dependency extraction** — what libraries and frameworks are used
- **Technology stack** — detected programming languages and frameworks
- **File tree summary** — counts of files by language

The Brain gives the AI instant context about your codebase without needing to read every file. When the AI analyzes your project, it uses the Brain to understand the existing system architecture.

### 15.4 Syncing Repositories

Repositories change over time as new code is committed. METIS keeps up in two ways:

**Automatic sync**: A background scheduler runs every 15 minutes, pulling the latest changes for all registered repositories. This is automatic — you don't need to do anything.

**Manual sync**: You can trigger an immediate sync for a specific repository via the API. Use this when you know important changes were just pushed and you want the AI to see them immediately.

Each sync records:
- Who triggered it (manual, cron schedule, or webhook)
- What changed (new files, modified files, deleted files)
- Whether the sync succeeded or failed
- When it happened

**Rebuild AST cache** (Issue #122): each repository row on the **Connections** tab has a **Rebuild AST cache** button. Clicking it pulls (or clones) the repository and re-indexes its source files into the AST summary cache, showing an explicit status — *Rebuilding…* → completed (with indexed-file / symbol / skipped counts) or a failed status with a parsed error message. Use it after large refactors when you want the code-overview and analysis tooling to reflect the latest structure immediately rather than waiting for the next scheduled ingest.

---

## 16. Database Connections

> **v1.2.0 update.** As with repositories, the per-project **Connections**
> tab remains the source of truth for database connector CRUD, and a new
> top-level `/databases` sidebar page surfaces the full inventory across
> projects with the same filter / link-back pattern (`#196 / #224`). The
> read-only SQL panel still lives only on the per-project page so RBAC
> stays project-scoped.

### 16.1 Why Connect Databases?

Many software projects involve databases. When METIS analyzes a project, the **Database Analyst** agent can examine your existing database to discover:
- Tables that need new columns or modifications
- Missing indexes that affect performance
- Data migration requirements
- Integrity constraint changes
- Stored procedures that need updating

### 16.2 Adding a Database Connection

1. Use the Databases API to register a connection:
   - **Host** — the database server address
   - **Port** — the database port (default for Oracle: 1521)
   - **Service Name** — the Oracle service name
   - **Username** — database login
   - **Password** — database password (stored encrypted in the vault)

2. **Test the connection** to verify the database is reachable

**Important**: METIS only performs **read-only** operations on your database. It will never modify your data. All INSERT, UPDATE, DELETE, DROP, ALTER, CREATE, and TRUNCATE commands are blocked at the application level.

### 16.3 Inspecting Database Schema

Once connected, METIS can inspect the full database schema:

| What It Extracts | Description |
|---|---|
| **Tables** | Name, columns, data types, constraints, row counts |
| **Views** | Regular and materialized views |
| **Stored Procedures** | PL/SQL procedures |
| **Functions** | PL/SQL functions |
| **Packages** | PL/SQL package definitions |
| **Indexes** | Index names, types, associated tables |
| **Sequences** | Auto-incrementing number generators |

This information is used by the Database Analyst agent during analysis and can also be explored by the AI during chat conversations.

### 16.4 Phase 8 — The Connections Tab

Open any project and click **Connections** in the left nav (`/projects/{id}/connections`). You'll see two sections:

**Repository connectors**

1. **Label** — what to call the connector (e.g. `monorepo`, `legacy-svc`).
2. **Owner / org** + **Repo name** — `octocat` / `demo` for `https://github.com/octocat/demo`.
3. **API base URL** — leave blank for `github.com`; for GitHub Enterprise paste the HTTPS URL (e.g. `https://github.example.com/api/v3`). Plain `http://` is rejected.
4. **Secret ref** — write your PAT to the Secret Vault first, then paste its reference here as `${vault:my-token-label}`. Plaintext tokens are never accepted.
5. Click **Add repo connector**, then **Test** to verify reachability, then **Ingest** to feed repo metadata into RAG.

**Database connectors**

1. **Label**, **Driver** (`postgres`, `mysql`, `oracle`, `sqlserver`), **Host**, **Port**, **Database**, **Username**.
2. **Secret ref** — `${vault:my-db-pw-label}`. Same vault flow as repo PATs.
3. Click **Add database connector**, then **Test**, then **Ingest** to capture the schema in RAG, or click **Query** to open the read-only SQL panel.

**Read-only SQL panel.** Only single `SELECT` statements are accepted; everything else is blocked at parse time. A `LIMIT` clause is appended automatically — you cannot disable it. Use it for ad-hoc inspection, not data export.

**What the admin needs to configure first.**

- `REPO_ALLOWED_HOSTS=github.com,*.github.example.com` — restrict which hosts the repo connector may reach.
- `DB_ALLOWED_HOSTS=db1.example.com,db2.example.com` — same for DB connectors.
- `REPO_CLONE_DIR=/var/lib/metis/clones` — where shallow clones live (defaults to a tmp dir).
- `UPLOAD_ARCHIVE_DIR` / `UPLOAD_EXTRACT_DIR` — where folder-upload (`.zip`) connectors store the uploaded archive and its extracted working copy. These default to **persistent** app-data dirs (`<cwd>/data/repo-archives`, `<cwd>/data/repo-extracts`) so an uploaded project survives an OS temp purge and re-ingest can re-extract without re-upload (#329). Override to a mounted volume in production. If the stored archive is missing (e.g. a pre-#329 upload connector whose temp archive was already purged), re-ingest fails with a clear `410 UPLOAD_ARCHIVE_MISSING` — re-upload the folder to re-ingest. Like `REPO_CLONE_DIR`, these are per-pod local dirs and are not shared across replicas.
- `CONNECTOR_ALLOW_LOOPBACK=false` — keep this off in production. Loopback / RFC1918 addresses are blocked unless you flip it.
- `PII_REDACT_DISABLE_PATTERNS=` — empty = redact SSNs, credit cards (Luhn-validated), emails, phone numbers, IPs from any data the connectors return before it reaches RAG. Disable patterns by name only if you have a regulatory reason.

### 16.5 Managing Shared Physical Databases (Identity)

When two projects in the same workspace connect to the **same physical database**, METIS can treat a schema change in one project as affecting the other — the "shared-database blast radius" surfaced in the gap report. The **Physical database identity** panel at the bottom of the **Connections** tab is where operators view and manage that linkage.

**What you see.** Each shared database is shown with its canonical endpoint (`driver · host:port / database`), the connections attached to it, and — under **Also used by** — the other projects in the workspace that share it. A database used by no other project is labelled explicitly ("No other project in this workspace uses this database"), so "not shared" never looks the same as "unknown".

**Unlinked connections** are listed separately, each with the precise reason it is not linked:
- **Insufficient identity** — the connection is missing the host or database name needed to identify a physical database, so METIS never guesses a link for it.
- **No workspace** — the project is not part of a workspace, so shared-database management is unavailable until you add it to one.
- **Not linked yet** — the connection is linkable; use the actions below.

**Actions** (each shows a confirmation that explains the cross-project consequence before it runs):
- **Re-resolve** — safely find-or-create this database's identity from its own `(driver, host, port, database)` key. This never overrides an existing explicit link.
- **Link…** — the escape hatch for the same physical database reached through **two different hostnames**, which the automatic key cannot detect. Pick the target shared database and confirm; impact analysis will then treat the connections as one database. The picker only ever offers databases **in your own workspace** — you cannot link across workspaces.
- **Unlink** — reverse a link. The confirmation names how many other projects currently share the database so you understand what stops being tracked. You can re-link at any time.

If an action fails on the server (for example a resource that no longer exists), the change is rolled back and the error is shown as a toast — nothing is left in a half-applied state.

**Permissions.**

| Role | Can list/get | Can test | Can query | Can create/update/delete |
|---|---|---|---|---|
| Admin | ✅ | ✅ | ✅ | ✅ |
| Coordinator | ✅ | ✅ | ✅ | ❌ |
| Developer | ✅ | ✅ | ✅ | ❌ |
| Reader | ✅ | ❌ | ❌ | ❌ |

Every connector mutation, test, query, and ingest is written to the audit log with actor + target. Secrets and SQL bind values are never logged.

---

## 17. Jira Integration

### 17.1 Why Connect Jira?

Connecting a Jira instance lets you browse and search Jira issues without leaving METIS. This is useful when you need to:

- Reference existing Jira tickets while reviewing generated requirements
- Look up acceptance criteria stored as Jira issue descriptions
- Validate which requirements already have matching Jira items before publishing

METIS supports **Jira Cloud** (hosted at `*.atlassian.net`) and **Jira Data Center** (self-hosted on-premises).

### 17.2 Adding a Jira Connection

1. Open a project and click the **Jira** tab in the project detail view
2. Click **Add Connection**
3. Fill in the form:

| Field | Cloud | Data Center |
|---|---|---|
| **Label** | Friendly name (e.g. "Prod Jira") | Same |
| **Edition** | Cloud | Data Center |
| **Base URL** | `https://yourorg.atlassian.net` | `https://jira.corp.example.com` |
| **Username** | Your Atlassian email | Leave blank |
| **API Token / PAT** | [Create at id.atlassian.com](https://id.atlassian.com/manage-profile/security/api-tokens) | Create a Personal Access Token in Jira |
| **Proxy URL** | Optional HTTP/HTTPS proxy | Same |
| **TLS verify** | Always on for Cloud | Uncheck only if using a private CA |
| **Custom CA cert** | Not needed | Paste the PEM if you have a private CA |

4. Click **Save**, then click **Test** to verify connectivity. The status badge shows **Connected** and the latency on success.

> **Tip:** Store the API token in the Secret Vault first, then reference it as `${vault:your-label}` in the API Token field. This keeps credentials out of the form and out of the database.

### 17.3 Browsing Jira Issues

Once a connection is healthy, the **Jira** tab has two panels:

#### Project Picker

The left panel lists all Jira projects available on the connection. Click any project to pre-fill its key into the search bar.

#### JQL Search

Type a JQL query in the search bar (e.g. `project = ACME AND status = Open`) and press **Enter** or click **Search**. Results appear as cards showing:
- Issue key and summary
- Status, priority, and assignee
- Click the issue key to open it in full detail

If the query fails, an error banner appears with the message returned by Jira. Common causes:
- Typo in a field name (JQL is case-sensitive)
- No permission to access the project
- Connection token expired

#### Issue Detail

Click any issue card to expand the full detail view, which includes:
- Description (Jira Document Format rendered as plain text)
- Labels, components, fix versions
- Reporter and assignee
- Parent epic link (if set)

### 17.4 Security Notes

| Concern | How METIS handles it |
|---|---|
| **SSRF** | Every Jira base URL is validated before the first request. Hostnames are DNS-resolved and any private/RFC1918 address is rejected unless the administrator has added the hostname to `JIRA_ALLOWED_HOSTS`. The attachment proxy applies the same policy to the URL you ask it to fetch: the URL must share the connection's exact origin, the host is re-resolved and re-checked, and redirects are followed only to public hosts — never carrying your Jira credential off the Jira origin. |
| **Attachment rendering** | Proxied attachments are served with a `Content-Type` restricted to a safe image allow-list. Anything else — including HTML, SVG, and PDF — is delivered as a download (`Content-Disposition: attachment`) rather than rendered in the page, so an attachment can never run script in the METIS UI. Inline images embedded in Jira issue descriptions still display normally. |
| **Credential storage** | API tokens are encrypted via AES-256-GCM in the vault. The API never returns the plaintext — the UI only ever sees `••••••••`. |
| **Rate limiting** | All Jira API calls are rate-limited per connection (30 req/min by default) to prevent accidental overload of your Jira instance. |
| **Audit trail** | Every connection create, update, delete, and test is recorded in the project audit log. |

If your Jira server is on a private network and METIS rejects the URL with `HOST_NOT_ALLOWED`, ask your administrator to add the hostname to `JIRA_ALLOWED_HOSTS` in the server environment.

---

## 18. The Secret Vault

> **v1.2.0 update.** The vault is now a top-level admin surface at
> `/vault` (`#196 / #222`) — it used to be buried behind the legacy
> Settings → Vault tab. The hub at `/settings` still cards a link out to
> it. The new HTTP surface lives at `/api/vault` and is gated by the
> existing `vault.read` (list / reveal / audit) and `vault.write` (create
> / rotate / delete) permissions.

The **Secret Vault** is a secure storage for sensitive information that METIS needs to interact with external services — things like API keys, database passwords, and access tokens.

### How It Works

- **Encrypted at rest** — all secrets are encrypted using AES-256-GCM, a military-grade encryption algorithm
- **Key derivation** — the encryption key is derived from a master key using PBKDF2 with 100,000 iterations, making brute-force attacks practically impossible
- **Access controlled** — only users with `vault.read` permission can list, reveal, and view audit history; only `vault.write` can create, rotate, or delete entries
- **Audit logged** — every list, reveal, rotate, and delete is recorded in the audit trail with `source: "vault_ui"` metadata

### Using the Vault

The `/vault` page is split into two panels:

1. **Entries table** — every secret in scope (`global` or `project`), the
   current key version, the algorithm in use, and the last update time.
   Each row has an **Open** action that loads the detail panel.
2. **Detail panel** — opens on the right and exposes:
   - **Reveal** — fetches the plaintext exactly once via
     `GET /api/vault/:id/reveal` and renders a masked preview
     (`first4…last4`). Reveals are audited.
   - **Rotate** — submits a new value via `POST /api/vault/:id/rotate`,
     bumps the key version, and clears any previously revealed plaintext.
   - **Audit** — lists the recent `vault.{read,rotate,delete,write}` rows
     for the entry.
   - **Delete** — soft-removes the entry (terminal — restoring requires a
     fresh `POST /api/vault`).

To create a new entry, use the **Create entry** card at the top of the
page. Labels must match `^[a-zA-Z0-9_.\-:]+$` and values are capped at
64 KiB. Operators without `vault.read` see a friendly forbidden notice
instead of the table.

---

## 19. Background Tasks

METIS keeps a queue of background tasks for anything that takes more than a
moment — re-running an analysis, refreshing a connector, publishing a batch,
or firing a webhook. Two pages drive the experience.

### 19.1 Scheduler (`/scheduler`)

Open **Scheduler** from the sidebar to see every cron-driven job. The page
shows each job's key, name, task type, cron expression, next run time, and
state (enabled / paused). Live updates stream in over Socket.IO — no manual
refresh needed.

Per-row actions:

- **Run now** — fires the job immediately, bypassing the cron schedule. Good
  for testing payload changes.
- **Pause / Resume** — temporarily disables the cron without deleting the job.
- **History** — opens a drawer with the last 50 runs (status, trigger,
  start / completed timestamps).
- **Edit** — change the cron expression, payload, task type, or `maxAttempts`.
- **Delete** — soft-delete the job (history is preserved for audit).

Click **New job** to create one. Pick a task type from the catalogue (the
list comes from `GET /api/scheduler/handlers`), enter a cron expression, and
supply a JSON payload. The server rejects expressions that fire more often
than `SCHEDULER_MIN_CRON_INTERVAL_SEC` (default 60s).

`scheduler.read` is required to view the page; `scheduler.manage` is required
for create / edit / delete / run / pause / resume.

### 19.2 Tasks (`/tasks`)

The **Tasks** page is the per-task queue view. Status tabs filter by:

| Tab        | Status     | Meaning                                              |
| ---------- | ---------- | ---------------------------------------------------- |
| Waiting    | `pending`  | Queued, waiting for a concurrency slot.              |
| In flight  | `running`  | A handler is currently executing the task.           |
| Completed  | `completed`| Handler returned successfully.                       |
| Failed     | `failed`   | Handler exhausted `maxAttempts` retries.             |
| Cancelled  | `cancelled`| Task was cancelled (via UI or `AbortSignal`).        |

Click a task ID to expand its row and see the payload, error message, result,
and progress percentage. From the row you can:

- **Cancel** a `pending` or `running` task. The handler's `AbortSignal` fires
  immediately and the task transitions to `cancelled`.
- **Retry** a `failed` or `cancelled` task. The platform re-enqueues it with
  `trigger=retry` and a fresh attempt counter.

`task.read` is required to view; `task.cancel` and `task.retry` gate the
respective actions.

### 19.3 Task lifecycle

```
       enqueue              dispatch             complete
pending ──────► pending ─────────────► running ─────────► completed
                                          │
                                          ├─► failed (attempts == max)
                                          ├─► retry  (with backoff)
                                          └─► cancelled
```

Tasks run on a fixed-size worker pool (`SCHEDULER_CONCURRENCY`, default 4).
Higher-priority tasks (lower `priority` number) preempt lower-priority ones
at the queue head. Failures retry with exponential backoff up to
`SCHEDULER_RETRY_BACKOFF_MAX_MS`.

### 19.4 Built-in task types

| Type                            | Use case                                              |
| ------------------------------- | ----------------------------------------------------- |
| `refresh-repo-connector`        | Re-pull and re-ingest a repo connector.               |
| `refresh-db-connector-schema`   | Re-introspect schema + samples for a DB connector.    |
| `rerun-analysis`                | Run Phase 7 analysis on a project's documents.        |
| `publish-batch`                 | Re-run a Phase 9 publish (idempotent).                |
| `http-webhook`                  | POST a JSON payload to a vetted external URL.         |

The `http-webhook` handler is locked down: hosts must appear on the
`WEBHOOK_ALLOWED_HOSTS` list, payload size is capped at `WEBHOOK_MAX_BYTES`,
the request is timed out after `WEBHOOK_TIMEOUT_MS`, and the
`Authorization` header may be a `${vault:label}` reference resolved at fire
time so secrets never sit in the saved payload.

---

## 20. Settings

The **Settings** hub at `/settings` is now a navigation index that cards
every settings sub-page. None of the previous functionality was removed —
it was redistributed into focused sub-pages so each surface owns one
responsibility (`#196 / #220`).

```mermaid
graph TD
  HUB[/"/settings (hub)"/]
  HUB --> PROF[/"/settings/profile"/]
  HUB --> APP[/"/settings/appearance"/]
  HUB --> NOT[/"/settings/notifications"/]
  HUB --> KEY[/"/settings/api-keys"/]
  HUB --> INT[/"/settings/integrations"/]
  HUB --> VAULT[/"/vault"/]
  HUB --> MCP[/"/settings/mcp"/]
  HUB --> AGT[/"/settings/agents"/]
  HUB --> ACP[/"/settings/acp"/]
  HUB --> HK[/"/settings/hooks"/]
  HUB --> TR[/"/settings/triggers"/]
```

> _Screenshot placeholder: settings hub card grid._

### 20.1 Profile (`/settings/profile`)

View and edit your account information:
- **Username** — your login name (read-only, set by the system)
- **Display Name** — how your name appears in the UI (read-only in v1.2)
- **Email** — your account email (read-only)
- **Role** — your permission level (read-only, assigned by an administrator)

### 20.2 Appearance (`/settings/appearance`)

Customize how METIS looks:
- **Theme** — Light / Dark / System (also surfaced as the sun/moon toggle in the header).
- **Density** — Comfortable or Compact. Persisted to `metis.settings.density` in `localStorage`; takes effect immediately and survives reloads.
- **Reset** — clears any local appearance overrides.

### 20.3 Notifications (`/settings/notifications`)

Control which notifications you receive as a **per-channel × per-event matrix** — one checkbox per combination of channel (Email, In-app, Webhook, Microsoft Teams) and event (Analysis completed, Requirements approved, Issues published, System alerts, Mentions, SLA deadlines).

- Preferences are **stored server-side on your account** and sync across browsers and devices (defaults: Email, In-app, and Teams on; Webhook off). If loading or saving fails, the page shows an error — it never falls back to browser-local storage.
- **Save** is disabled until the form is dirty and writes only the cells you changed; **Discard changes** reverts unsaved edits.
- **One-time import:** if you had toggles saved by the older browser-local version of this page (`metis.settings.notifications`) and haven't customized anything server-side yet, they are imported automatically on your first visit and the local key is removed.
- **Toggles are enforced at the source.** Disabling a cell stops that notification from being created for you at all — e.g. turning off *Mentions × In-app* means an @mention no longer produces an in-app notification (nothing appears in the bell drawer), and turning it back on restores delivery immediately.
- **Ops-critical alerts are exempt by design.** Preferences govern notifications addressed to *you personally*. They never suppress PagerDuty on-call paging, workspace-level budget alerts, or Teams cards broadcast to a whole workspace channel — those are operational alerts without an individual recipient, so no personal toggle applies.

### 20.4 Configuration (`/settings/api-keys`)

Single admin home for AI provider preferences and runtime configuration. The route name is preserved for back-compat; the page itself, the H1, and the sidebar entry all read **Configuration**.

- **Provider preferences** — pick the active provider (`bedrock-gateway`, `openai`, `azure`, `anthropic`, `offline-stub`) and default model. Local-only — never sent to the server. Persisted to `metis.settings.providerPrefs`.
- **Security evaluation** — kicks off the Phase-15 red-team harness via `POST /api/security-eval/run` and renders the report inline. Admin only.
- **Runtime configuration** (Epic #249) — three tiers, all backed by the unified `GET/PUT/DELETE /api/admin/config/:key` surface:
    - **Runtime secrets** (Tier 2): vault-backed credentials such as `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, and `GITHUB_TOKEN`. Save rotates the secret in the vault; Clear deletes the override and falls back to the env value. Audit entries are always redacted.
    - **Runtime tunables** (Tier 3): non-sensitive knobs persisted to `runtime_config`. Changes take effect on the **next request** with no server restart — the in-memory cache is invalidated and the `config.changed` event fires for every subscriber. Includes provider/model selection (`AI_PROVIDER`, `AI_DEFAULT_MODEL`, `AI_MODE`), token caps (`ANALYSIS_MONTHLY_TOKEN_CAP`, `ANALYSIS_AGENT_TOKEN_CAP`), publishing rate limits, scheduler controls, MCP partial-health, and SSRF allowlists.
    - **Bootstrap configuration** (Tier 1): read-only values loaded from `.env` at boot — `DATABASE_URL`, `JWT_SECRET`, `PORT`, etc. Restart the server to change them.
- **Audit log** — every Tier-2 / Tier-3 write produces a `config_audit` row with actor, key, old/new value (sensitive values masked as `[REDACTED]`), scope, and timestamp. The Audit log tab paginates this view.
- **Runtime environment** — admin-only table that mirrors `GET /api/settings/env-vars`. Secrets are returned redacted; unset variables show `[unset]`.

### 20.5 Integrations (`/settings/integrations`)

A navigation index that cards every third-party integration surface:
**Repositories**, **Databases**, **MCP servers**, **Hooks**, **Triggers**,
**Notifications** (Slack + PagerDuty), and the **Vault**. Connections
themselves remain project-scoped (see §15 and §16); the Integrations page just
gives operators a single jumping-off point.

#### Notification integrations (`/settings/integrations/notifications`, #69)

A workspace-scoped page (pick the workspace from the selector) for connecting
Slack + PagerDuty and choosing which alert events route to which channel. Only
workspace **admins/owners** (and system admins) can change anything; members
see a read-only view.

- **Slack** — shows the connection status and linked team. Click **Connect with
  Slack** to run the OAuth install, or use the advanced "install with a bot
  token" path. Disconnect removes the install. The bot token is write-only:
  it is entered once, stored encrypted server-side, and is **never shown back**.
- **PagerDuty** — register one or more per-service routing keys for sev-1
  incident alerting, and delete them. The routing key is write-only and never
  rendered after entry.
- **Event routing** — view/add/remove the alert channels (`email`, `webhook`,
  `slack`, `pagerduty`) that budget/alert rules deliver to. This is the same
  channel selection surfaced on the workspace FinOps page (see §"FinOps").

Secrets are managed server-side (see §17 Vault); this page never displays the
Slack bot token or PagerDuty routing key.

### 20.6 Vault (`/vault`)

Linked from the hub. Full coverage in §17.

### 20.7 MCP servers / Custom agents / ACP / Hooks / Triggers

Pre-existing sub-pages — see the v1.1.0 release notes for `/settings/mcp`,
`/settings/agents`, `/settings/acp`, `/settings/hooks`, and
`/settings/triggers`. The hub now exposes them as cards alongside the new
v1.2 sub-pages.

> **First MCP in 5 minutes** — for a step-by-step "fresh clone → tool call in the audit log" walkthrough, see [`docs/LOCAL_QUICKSTART.md`](./LOCAL_QUICKSTART.md) (Issue [#364](https://github.com/openzigs/metis-private/issues/364)).

#### MCP runtime selection (epics #271, #272)

When adding or editing an MCP server, admins can pick the **Runtime** that
will host the server's stdio process:

| Runtime | What METIS does | When to use |
|---|---|---|
| **Native** (default) | Spawns `command + args` directly on the METIS pod, same as before. | Local dev, trusted commands, back-compat for existing rows. |
| **Docker (stdio)** | Wraps the spawn into `docker run -i --rm <wrapper-image>` with memory/CPU caps and a dedicated `metis-mcp` bridge network. Secrets are passed via `-e KEY` (no values in `ps`). | AWS hosts where you don't want every runtime (uvx/jbang/npx) baked into the METIS image. |
| **K8s (SSE)** | Provisions a per-server K8s `Deployment` + `Service` + `NetworkPolicy` (and optionally a per-server `ServiceAccount` with IRSA). MCP exposes HTTP+SSE on :8080; METIS connects via `http://mcp-<id>.metis-mcp.svc.cluster.local:8080/sse`. | Production EKS. Strongest isolation: non-root pods, read-only root FS, no API token mount unless IRSA, deny-all egress except an explicit per-server allowlist. |

Wrapper images live under `images/mcp-wrappers/` (`uvx-runner`,
`jbang-runner`, `node-runner`, `npx-runner` for stdio; `*-runner-sse`
variants bridge stdio→SSE via `mcp-proxy` for the K8s runtime).

#### MCP scope hardening (epic #270)

Six runtime-config tunables on the **Configuration** page (§19.5) gate
how MCP servers can be registered. All default to off in dev; ops should
flip them on in prod via the UI:

| Tunable | Effect when `true`/non-empty |
|---|---|
| `MCP_REQUIRE_VAULT_ENV` | Reject env values that aren't `${vault:...}` references. |
| `MCP_REQUIRE_CATALOG` | Project-scope MCPs must come from the federated catalog (§27); raw `command` strings rejected with `403`. Global scope still allows admin raw-register. |
| `MCP_IMAGE_ALLOWLIST` | CSV of segment-aware glob patterns (e.g. `ghcr.io/metis-mcps/*`); container runtimes (`docker-stdio`, `k8s-sse`) only accept matching images. `*` matches one path segment, `**` matches any number of segments (issue #304). |
| `MCP_ALLOW_USER_SCOPE` | Enables a `scope: 'user'` on MCP rows (per-user MCPs). When off, `scope: 'user'` writes return `400 USER_SCOPE_DISABLED`. Capped per-user by `MCP_USER_MAX_CONCURRENT` and reaped after `MCP_USER_IDLE_TIMEOUT_MIN`. |

Trust-level promotion to `trusted` is admin-only (`mcp.manage`); coordinators
registering project servers can only set `trustLevel: 'untrusted'`.

---

## 21. User Roles and Permissions

METIS uses a **role-based access control** system. Your role determines what you can see and do.

### Role Hierarchy

Roles are hierarchical — higher roles can do everything lower roles can, plus more:

```
Admin (Level 4)
  └── Coordinator (Level 3)
       └── Developer (Level 2)
            └── Read-Only (Level 1)
```

### What Each Role Can Do

| Feature | Read-Only | Developer | Coordinator | Admin |
|---|---|---|---|---|
| View projects | ✅ | ✅ | ✅ | ✅ |
| View documents | ✅ | ✅ | ✅ | ✅ |
| View analyses | ✅ | ✅ | ✅ | ✅ |
| View requirements | ✅ | ✅ | ✅ | ✅ |
| View repositories | ✅ | ✅ | ✅ | ✅ |
| Use AI chat | ❌ | ✅ | ✅ | ✅ |
| Start analysis | ❌ | ✅ | ✅ | ✅ |
| Upload documents | ❌ | ✅ | ✅ | ✅ |
| Add repositories | ❌ | ✅ | ✅ | ✅ |
| Create projects | ❌ | ❌ | ✅ | ✅ |
| Update projects | ❌ | ❌ | ✅ | ✅ |
| Delete projects | ❌ | ❌ | ❌ | ✅ |
| Update requirements | ❌ | ❌ | ✅ | ✅ |
| Publish to GitHub | ❌ | ❌ | ✅ | ✅ |
| Manage vault secrets | ❌ | ❌ | ❌ | ✅ |
| Manage users | ❌ | ❌ | ❌ | ✅ |
| System settings | ❌ | ❌ | ❌ | ✅ |

---

## 22. The Complete Workflow — Start to Finish

Here's the full end-to-end workflow for using METIS, from nothing to published GitHub issues:

### Step 1: Create a Project
1. Log in to METIS
2. Go to Projects → New Project
3. Give it a name, description, and link it to your GitHub repository

### Step 2: Upload Documents
1. Open your project
2. Upload all relevant business documents (requirements, policies, specifications, data dictionaries)
3. Wait for processing to complete (status changes from "uploading" to "indexed")

### Step 3: Connect Repositories (Optional)
1. Via the Repos API, add your code repository URL
2. METIS clones and indexes the code
3. The AI generates a "Brain" summary of the codebase

### Step 4: Connect Databases (Optional)
1. Via the Databases API, register your database connection
2. Test the connection
3. The AI can now inspect the schema during analysis

### Step 5: Run Analysis
1. Go to your project detail page
2. Click **"Run Analysis"**
3. Four AI agents work in parallel:
   - Document Analyst reads your uploaded documents
   - Code Analyst examines your repositories
   - Database Analyst inspects your databases
   - Web Researcher finds industry best practices
4. Wait for completion (typically 1–5 minutes)

### Step 6: Review Requirements
1. Go to the Requirements page
2. Filter and search through generated requirements
3. Check the Traceability Matrix for a lifecycle overview
4. Edit any requirements that need refinement

### Step 7: Approve Requirements
1. Review each requirement carefully
2. Click **"Approve"** on requirements you're satisfied with
3. Or use "Approve All" if the entire batch looks good

### Step 8: Generate GitHub Issue Drafts
1. Generate drafts from approved requirements
2. Review the generated issue templates
3. Edit titles, descriptions, or labels as needed

### Step 9: Publish to GitHub
1. Click **"Publish Issues"** on the project
2. METIS creates the issues in your GitHub repository
3. Monitor the batch progress
4. Verify the issues appear in GitHub

### Step 10: Track and Iterate
1. Check the Traceability Matrix to see full lifecycle coverage
2. Start new analyses as documents or code change
3. Use the AI Chat for ongoing questions and assistance

---

## 23. API Usage (For Developers)

If you're a developer who wants to integrate with METIS programmatically, you can use the REST API directly.

### Base URL

```
http://localhost:4000/api
```

### Authentication

Include the JWT token in your request headers:

```
Authorization: Bearer <your-access-token>
```

Or, if using cookies (the default for the web UI), cookies are sent automatically.

### Example: Create a Project

```bash
curl -X POST http://localhost:4000/api/projects \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{
    "name": "My New Project",
    "description": "An analysis project for the new system",
    "githubOwner": "my-org",
    "githubRepo": "my-repo"
  }'
```

### Example: Start an Analysis

```bash
curl -X POST http://localhost:4000/api/analysis/PROJECT_ID/analyze \
  -H "Authorization: Bearer YOUR_TOKEN"
```

### Example: Search the Knowledge Base

```bash
curl -X POST http://localhost:4000/api/knowledge/search \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{
    "query": "authentication requirements",
    "projectId": "PROJECT_ID",
    "limit": 10
  }'
```

### Health Check (No Auth Required)

```bash
curl http://localhost:4000/api/health
```

Response:
```json
{
  "status": "healthy",
  "uptime": 3600,
  "version": "1.0.0"
}
```

For the complete API reference with all 56 endpoints, see [ARCHITECTURE.md](ARCHITECTURE.md#22-complete-api-reference).

---

## 24. Troubleshooting

### The application won't start

**Problem**: `pnpm dev` fails with errors.

**Solution**:
1. Make sure you're using Node.js 22.12.0 or higher: `node --version`
2. Delete `node_modules` and reinstall: `rm -rf node_modules && pnpm install`
3. Build the shared package: `pnpm --filter @metis/shared build`. If the error mentions
   `Cannot find module '@metis/shared/dist/index.js'`, this is the fix — installing does
   not build it, and the UI starts normally even when the server cannot.
4. Make sure your `.env` file exists: `cp .env.example .env` (if missing)
5. Run database migrations: `pnpm db:generate && pnpm db:migrate`

### "Cannot connect to database" error

**Problem**: The server can't connect to the database.

**Solution**:
- **SQLite**: The database file is auto-created. Make sure the `server/` directory is writable.
- **PostgreSQL**: Check that the database server is running:
  - Docker: `docker compose ps` — the postgres container should be "Up"
  - Local: `pg_isready` — should report the server is accepting connections
- Check your `DATABASE_URL` in `.env`

### Login doesn't work

**Problem**: You get "Invalid credentials" when trying to log in.

**Solution**:
- **Mock mode**: Use username `admin` and password `password` (or any of the 4 test accounts)
- **LDAP mode**: Check that your LDAP configuration is correct in `.env` and that the LDAP server is reachable
- Check the server logs for more details: look at the terminal running `pnpm dev`

### The UI loads but shows "Disconnected" in the header

**Problem**: The red dot in the header says "Disconnected."

**Solution**:
- Make sure the **server** is running (port 4000). The UI (port 3000) needs the server to be running.
- Check that `NEXT_PUBLIC_SOCKET_URL` in your `.env` points to the correct server URL
- Check for CORS errors in your browser's developer console (F12 → Console tab)

### Analysis takes too long or fails

**Problem**: An analysis runs for a long time or returns a failure status.

**Solution**:
- Check the task engine stats for queue depth
- Ensure the AI token budget hasn't been exceeded
- In development (mock mode), analyses should complete in seconds. If they don't, check server logs for errors.
- Try cancelling the stuck task and retrying

### GitHub publishing fails

**Problem**: Issues are not being created in GitHub.

**Solution**:
1. Verify your `GITHUB_TOKEN` is valid and not expired
2. Make sure the token has the `repo` scope
3. Confirm the project has the correct `githubOwner` and `githubRepo` set
4. Check that the repository exists and your token has write access
5. Look at the batch details for specific error messages

### Docker containers won't start

**Problem**: `docker compose up` fails.

**Solution**:
1. Make sure Docker is running: `docker info`
2. Check for port conflicts: `lsof -i :3000` and `lsof -i :4000` — make sure nothing else is using those ports
3. Remove old containers and rebuild: `docker compose down -v && docker compose up --build`
4. Check container logs: `docker compose logs server` or `docker compose logs ui`

### Styles look broken

**Problem**: The UI appears unstyled or layout is wrong.

**Solution**:
1. Clear your browser cache (Ctrl+Shift+R or Cmd+Shift+R)
2. Make sure the UI build completed without errors in the terminal
3. Try a different browser to rule out browser-specific issues

---

## 25. Frequently Asked Questions

### General

**Q: Is METIS free?**  
A: METIS ???. Not known yet. However, if you use production AI services (like GitHub Copilot), those may have their own costs.

**Q: Can I use METIS offline?**  
A: In development mode with mock providers, yes — everything runs locally without internet access. In production mode, you need internet access for AI services, GitHub publishing, web research, and LDAP authentication.

**Q: How many users can use METIS simultaneously?**  
A: With SQLite, METIS is best for individual use. With PostgreSQL, METIS can handle many concurrent users. The task engine processes up to 3 AI tasks simultaneously (configurable).

### Data & Privacy

**Q: Where is my data stored?**  
A: In development, all data is stored locally — the SQLite database file (`server/dev.db`), the in-memory knowledge store, and local file storage. In production with PostgreSQL, data is stored in the PostgreSQL database. No data is sent to external services unless you explicitly configure them (like GitHub for publishing).

**Q: Is my data secure?**  
A: Yes. METIS uses AES-256-GCM encryption for secrets, JWT tokens for authentication, HTTPS headers for transport security, and role-based access control for authorization. See [ARCHITECTURE.md](ARCHITECTURE.md#19-security-architecture) for the complete security architecture.

**Q: Can I delete my data?**  
A: Yes. You can delete individual documents, projects, requirements, secrets, database connections, and repositories. Projects can be archived (soft delete) or their associated data can be removed entirely.

### Analysis

**Q: How accurate are the AI-generated requirements?**  
A: The accuracy depends on the quality of your input documents and the AI model used. In mock mode, the AI generates placeholder requirements for demonstration. In production with GPT-4o, results are significantly more detailed and accurate. Always review AI-generated requirements before publishing.

**Q: Can I re-analyze a project?**  
A: Yes. You can run multiple analyses on the same project. Each analysis creates a new set of requirements. You can compare analyses over time to see how requirements evolve as you add more documents.

**Q: Why are there four separate AI agents?**  
A: Specialization leads to better results. Each agent has a domain-specific system prompt that makes it an expert in its area. Running them in parallel also makes the analysis faster — four agents working simultaneously instead of one doing everything sequentially.

### Publishing

**Q: What happens if I modify a published issue on GitHub?**  
A: METIS doesn't sync back from GitHub. Changes you make directly on GitHub won't be reflected in METIS. Consider METIS as a one-way publishing tool — it creates issues, and from there, your normal GitHub workflow takes over.

**Q: Can I publish to multiple repositories?**  
A: Each project is linked to one GitHub repository. If you need to publish to different repositories, create separate projects for each.

**Q: What if publishing partially fails?**  
A: If more than 50% of publishes in a batch fail, all already-published issues are automatically rolled back (closed) to prevent an inconsistent state. You can review the error details and retry.

---

*This guide was created for the METIS project. For detailed technical architecture documentation, see [ARCHITECTURE.md](ARCHITECTURE.md).*

## 25. Closed-Loop PR Reviews (v1.2.0)

When the **Closed Loop** is enabled, METIS treats your GitHub pull requests as the canonical signal that a requirement has been implemented, and an AC-aware reviewer agent posts a structured review on every PR.

### Enable it

1. On a project, set `autoReviewPrs = true` (Project Settings → Closed Loop).
2. Configure the GitHub webhook on your repository to `POST` `pull_request` events to `https://<your-metis-host>/api/webhooks/github/pr`. Use a secret matching `GITHUB_WEBHOOK_SECRET`.
3. (Optional) Set `SANDBOX_MODE=sidecar`, run the `copilot-svc` sidecar with `E2B_API_KEY`, and the agent will re-run AC-mapped tests inside an E2B Firecracker microVM before approving.

### What you'll see

- When a PR is **merged**, every requirement linked via `Closes #N` (and friends — `Fixes`, `Resolves`) is stamped with `implementedAt`, the merge commit SHA, and the PR number. Each touched file/line range is recorded in the requirement's "Implemented by" trail.
- When a PR is **opened or updated**, the PR-reviewer agent posts a GitHub review:
  - **Approve** when every AC is satisfied and no risk-severity comments are emitted.
  - **Request changes** when any AC is unsatisfied OR any sandbox test fails OR a risk-severity comment is emitted.
  - **Comment** otherwise.
- Open `/runs/[id]/review` for the agent's full record: per-AC verdict matrix with reasoning + evidence files, severity-toned inline comment list, and sandbox test stdout/stderr if applicable.

### Manual triggers

`POST /api/run-reviews` lets operators run the reviewer on demand for any PR — useful for re-running after CI fixes or when GitHub didn't deliver a webhook. The result is persisted as a `pr_review` step on the resulting `AgentRun`, so `/runs/[id]/review` works for both manual and automatic invocations.

### PR-review history page (v1.2 P2 / Epic #394)

Open `/projects/[id]/pulls` to see every PR review the agent has ever posted for the project's connected repositories. Each row shows:

- **PR** — `owner/repo#N` linking to the GitHub PR
- **Verdict** — `approve`, `request_changes`, or `comment` (with a colour-coded badge)
- **AC pass-rate** — `<satisfied>/<total>` plus a percentage
- **SHA** — short head SHA the review was run against
- **Updated** — local timestamp of the most recent review
- **Run** — pivot to `/runs/[runId]` for the live conversation that produced the verdict

The page reads from the `PrReviewState` table, which is upserted on every webhook delivery. Empty until the first PR is reviewed.

Click any row to open the **PR-review detail page** (`/projects/[id]/pulls/[prNumber]`), which lists every acceptance-criterion verdict (with reasoning and evidence files) plus a **Re-run review** button (requires the `pr.review.manage` permission). Re-running now shows **live progress** instead of asking you to refresh: a spinner and progress bar track the review in real time over the realtime job bus, and the moment it finishes the new verdict appears **automatically** — no manual reload. If the re-review fails, a clear error toast is shown (with a generic, non-revealing message). [Epic #406, #421]

### Per-repository configuration (`.metis/pr-review.yaml`)

Each connected repository can override the project's defaults by committing a `.metis/pr-review.yaml` at the PR head:

```yaml
# .metis/pr-review.yaml — all fields are optional
maxDiffBytes: 50000        # cap diff size (bytes) before review is skipped
skipGlobs:                 # additional skip globs (merged with project defaults)
  - "**/*.snap"
  - "vendor/**"
model: "gpt-4o-mini"       # override the judge model for this repo
severityFloor: "warning"   # only post comments at or above this severity
                           #   one of: info | minor | warning | major | risk
skipDraftPrs: true         # skip review when pr.draft === true
skipAuthors:               # skip these GitHub usernames (case-insensitive)
  - "dependabot[bot]"
  - "renovate[bot]"
```

The file is loaded from the PR's head SHA (so per-branch overrides work), capped at **32 KiB**, and parsed with a strict schema. **Failures never block the review** — invalid YAML, schema violations, oversized files, or fetch errors all fall back to the project defaults plus a warning recorded in the run.

### Async webhook processing (v1.2 P2)

GitHub PR webhooks are now ACKed in <100 ms and the review runs asynchronously on an in-memory queue:

- **Delivery dedup** — every `X-GitHub-Delivery` UUID is recorded once. Re-deliveries (GitHub retries on transient receiver errors) short-circuit with HTTP 200 + `reason: "DUPLICATE_DELIVERY"` instead of double-posting a review.
- **Per-repo concurrency cap** — at most 2 reviews run in parallel per `${owner}/${repo}` lane (configurable). Other PRs in the same repo wait their turn so we never blow up the LLM rate limit.
- **Retry with backoff** — failed jobs retry up to 3 times with exponential backoff `[1s, 4s, 16s]`, then land in a dead-letter sink for inspection.

### Incremental re-review on `synchronize` events

When a PR is updated (force-pushed, new commit), the agent only **re-judges acceptance criteria whose evidence files actually changed** between the last reviewed SHA and the new HEAD. Whitespace-only diffs skip the review entirely. Verdicts for unchanged criteria are inherited unchanged, dramatically reducing token cost on long-lived PRs. The agent's review body includes an `<incremental_review>` block listing which AC IDs were re-judged vs. inherited.

### Existing-comment dedup

Before posting a review, the agent fetches the PR's existing review comments and drops any new candidate whose Jaccard similarity (over a tokenised body, lowercased + stop-words removed) exceeds **0.7** vs. an existing comment. The judge prompt also receives an `<existing_comments>` block so it knows what's already been said. End result: no more duplicate "consider extracting this into a helper" comments after every push.

---

## 26. Spec Kit — Phased Spec-Driven Workflow (v1.3 / Epic #396)

The **Spec Kit** turns METIS into a structured specification tool. Rather than free-form chat, Spec Kit guides you through a phased workflow that produces a complete `.specify/` artifact set. v1.3 (Epic #396) brings METIS in line with upstream Spec Kit conventions: namespaced commands, per-feature `specs/<NNN-slug>/` directories, filesystem materialization, and phased status gates.

### Where to find it: the BA/PM "author the intent" front-door

Spec Kit is the **business-analyst / product-manager front-door** for authoring intent. It sits under the **Analyze** tab beside Requirements Analysis — not under "Docs" — because it is a planning/requirements surface, not documentation. Open a project, click **Analyze**, then **Spec Kit**.

The mental model is **author the intent here, then hand it off**:

```
Spec Kit (BA/PM authors intent)              METIS analysis pipeline (downstream consumer)
  /specify → spec.md   (what & why)   ──┐
  /plan    → plan.md   (the approach) ──┼──►  Analysis → Requirements → code-issue → reviewed PR
  /tasks   → tasks.md  (atomic backlog)─┘
```

`/specify` and `/plan` are **grounded in your project's own code & docs** (project-scoped RAG), so the generated spec/plan describe the real system rather than generic boilerplate. When no project knowledge can be retrieved (for example a brand-new project, or the local hash-embedder fallback), generation still succeeds — it just proceeds **ungrounded**, and the run message says so.

The handoff to the Analysis pipeline is **manual**: `/implement` returns an orchestrator handoff payload and points you at the project's **Analysis** tab — it does **not** auto-run the analysis → requirements → code-issue → reviewed-PR pipeline. You decide when to start that pipeline from the Analysis surface.

### Enabling Spec Kit

1. Open the project and click the **Spec Kit** primary tab (beside Analysis), or navigate directly to `/projects/[id]/spec-kit` — the URL is unchanged.
2. Toggle **Enable Spec Kit** at the top of the page. While enabled with no artifacts yet, an onboarding panel walks you through the spec → plan → tasks flow and links to the adjacent **Analysis** surface as the downstream consumer.
3. You can now use slash commands in the Chat surface or the command palette on the Spec Kit page.

### The Six Phases

| Phase | Slash Command | Agent | Produces |
|---|---|---|---|
| **Specify** | `/specify` | Business Analyst | `spec.md` — stakeholders, in-scope, out-of-scope, Given/When/Then ACs, NFRs |
| **Plan** | `/plan` | Architect | `plan.md` — architecture plan with at least one Mermaid diagram |
| **Tasks** | `/tasks` | Product Owner | `tasks.md` — topologically-ordered task table with Fibonacci sizing |
| **Clarify** | `/clarify` | — | `clarify.md` — Q&A log; empty input asks a question, non-empty input answers the latest |
| **Analyze** | `/analyze` | Cross-phase | `analysis.md` — consistency check across spec + plan + tasks |
| **Implement** | `/implement` | Dispatcher | Returns the orchestrator handoff payload (no AI call) |

Each command runs through the governance chain: FinOps budget check (402 if exceeded), inbound + outbound safety filters (422 if denied), usage recording, and audit logging.

### Constitution

METIS reads your `.github/instructions/*.md` files (sorted alphabetically) and merges them with optional project-level overrides into a **constitution** that is prepended to every agent system prompt. Use `POST /api/projects/:id/spec-kit/constitution` to regenerate it.

### The UI

The Spec Kit page has three columns:
1. **Artifact tree** — lists all six `.specify/` files with their version number and last-modified time.
2. **Viewer/Editor** — displays the selected artifact with syntax highlighting and a manual override toggle.
3. **Command palette** — slash-command autocomplete, run button, and output panel.

### v1.3 additions (Epic #396)

**Namespaced `speckit.*` commands.** All commands now live under the `speckit.` namespace (e.g., `/speckit.specify`, `/speckit.plan`, `/speckit.tasks`, `/speckit.constitution`, `/speckit.checklist`, `/speckit.taskstoissues`). The legacy bare aliases (`/specify`, `/plan`, etc.) still work but respond with `Deprecation: true` + `Link: <speckit.{cmd}>; rel="successor-version"` headers.

**Per-feature directories.** Every `/speckit.specify` invocation creates a new `Feature` with a monotonic `NNN-kebab-title` slug. Artifacts now live under `specs/<slug>/` instead of one project-wide artifact set, so multiple features can be drafted in parallel.

**Phased status gates.** `GET /api/projects/:projectId/spec-kit/features/:slug/status` returns `{specGate, planGate, tasksGate, implementGate}`. Commands enforce their preconditions (e.g., `/speckit.plan` requires `specGate`); a violation returns 412 Precondition Failed. Operators can break-glass with `X-Speckit-Force: true` — the bypass emits a `severity: 'high'` audit row.

**Filesystem installer.** `POST /api/projects/:projectId/spec-kit/install` materialises the `.specify/` skeleton + `specs/<slug>/` artifacts + per-host prompt files (Copilot `.github/prompts/*`, Claude `.claude/commands/*`, Cursor `.cursor/commands/*`, Pi `.pi/prompts/*`) onto an attached workspace root. Modes: `skip` (default — never overwrite), `overwrite`, `dryRun`. Requires explicit `consent: true` body flag and passes every write through a path-traversal guard (403 `PATH_NOT_ATTACHED` on any escape).

**`/speckit.constitution`.** Replaces the v1.2 `.github/instructions/*.md` merge model with a first-class artifact tracked under semver. METIS detects added/removed principles vs prior versions and bumps MAJOR/MINOR/PATCH automatically. The structured preamble (with version + ratification date) is prepended to every Spec Kit agent system prompt — no agent runs without governance once a constitution exists.

**`/speckit.checklist`.** Generates per-domain quality checklists (`security`, `performance`, `accessibility`, `observability`, `testability` by default; override via `SpecKitConfig.checklistDomains`). `mode: "merge"` (default) preserves `[x]` check states across re-runs.

**`/speckit.taskstoissues`.** Bridges `tasks.md` → GitHub issues with idempotent upsert keyed on `(featureSlug, taskId)`. Repo resolution: explicit `repo` arg → `SpecKitConfig.tasksToIssuesRepo` → attached `RepoConnection` → `SPECKIT_TASKS_DEFAULT_REPO` env. Optional `parentEpicNumber` links sub-issues under a parent epic.

**Expanded `/speckit.plan`.** Now emits five artifacts per Spec Kit Phase 0 + Phase 1: `research.md`, `data-model.md`, `contracts/api.openapi.yaml`, `quickstart.md`, `plan.md`. The OpenAPI body is post-processed to ensure it lints clean.

### v1.3 Phase 2 additions

**`metis-speckit-mcp` stdio MCP server.** Editors that speak the Model Context Protocol (Claude Desktop, Cursor MCP, Gemini CLI) can drive Spec Kit phases without copy-pasting prompts. The server lives at [`server/src/mcp/speckit/server.ts`](../server/src/mcp/speckit/server.ts) and exposes nine tools (`speckit_constitution`, `speckit_specify`, `speckit_clarify`, `speckit_plan`, `speckit_checklist`, `speckit_tasks`, `speckit_analyze`, `speckit_implement`, `speckit_taskstoissues`). Each tool dispatches to the existing REST surface as `POST /api/projects/:projectId/spec-kit/commands/:command` using a per-host bearer token. Sample `mcp.json` for Claude Desktop:

```json
{
  "mcpServers": {
    "metis-speckit": {
      "command": "node",
      "args": ["./server/dist/mcp/speckit/server.js"],
      "env": {
        "METIS_API_BASE_URL": "https://metis.example.com",
        "METIS_PROJECT_ID": "your-project-id",
        "METIS_SERVICE_TOKEN": "svc_xxx"
      }
    }
  }
}
```

**Codex host (`--ai codex`).** The installer (`POST /api/projects/:projectId/spec-kit/install`) now accepts `"codex"` alongside Copilot/Claude/Cursor. It writes `speckit-{cmd}.md` skill files under `.codex/skills/speckit/` and merges a `<!-- speckit:start --> / <!-- speckit:end -->`-bounded section into the workspace `AGENTS.md` listing every `$speckit-*` alias and its REST endpoint. The merge is idempotent (re-runs replace only the marked block) and `AGENTS.md` is preserved across `mode: "skip"` runs.

**GitHub issues → `tasks.md` sync.** Configure your GitHub repo's webhook to `POST` to `https://<your-metis>/api/webhooks/github/issues` for `Issues` events. METIS verifies the HMAC signature, looks up the matching `SpecKitTaskExport` row by `(repoOwner, repoName, issueNumber)`, and:
- **Closes** an issue → ticks the bullet form (`- [ ] T01` → `- [x] T01`) or appends `<!-- closed via #N -->` to the table row.
- **Reopens** an issue → unticks the checkbox / appends `<!-- open -->`.
- **Edits** the title → rewrites the task title in place (table row is preferred over bullet for the same task ID).

Replays of the same event are no-ops. The mutation is audited as `speckit.tasks_md.synced_from_issue`.

**Feature archive / restore.** Old features clutter the listing. Archive one with `POST /api/projects/:projectId/spec-kit/features/:slug/archive` (audited as `speckit.feature.archived` with `previousStatus` metadata). Archived features disappear from `GET /features` by default; pass `?includeArchived=true` to surface them. Restore with `POST /api/projects/:projectId/spec-kit/features/:slug/restore` (optional `{restoreTo: "specified"}` body; defaults to `draft`). Both routes require `project.update`. Restore on a non-archived feature returns 409 `SPECKIT_FEATURE_NOT_ARCHIVED`.

---

## 27. MCP Federation — Discovering External Servers (v1.2.0)

The MCP (Model Context Protocol) server registry now supports **federated discovery** from two external catalogues: **Smithery** (`registry.smithery.ai`) and the **Official MCP Registry** mirror.

### How to use it

1. Navigate to `/settings/mcp` and click the **Federated** tab.
2. Click **Refresh** to fetch the latest entries from Smithery and the Official Registry. Results are cached for 10 minutes.
3. Use the **source filter** to narrow results (federated, smithery, official, local).
4. Click **Install** on any entry to create a local MCP server with `trustLevel: "untrusted"`. Admins only.
5. Already-installed entries show "Installed" instead of an Install button.

### What gets stored

Each federated entry is cached in the `mcp_registry_entries` table with:
- Source, external ID, name, publisher, description
- Downloads, stars, last update time
- A SHA-256 digest of the install manifest
- 10-minute TTL; stale entries are refreshed on the next `POST /api/mcp/federation/refresh`

### Security

- Untrusted servers force every tool to `risk: high` — the approval gate always fires.
- Per-project allow-lists are re-checked at invocation time, not just at registration.
- Plaintext secrets are never stored — env values are auto-vaulted during import.

---

## 28. Eval Leaderboard — Benchmarking Agent Performance (v1.2.0)

The Eval surface lets operators run standardized benchmarks against METIS's agent fleet and track performance over time.

### Supported Benchmarks

| Benchmark | What It Tests | Scoring |
|---|---|---|
| **SWE-bench-Pro** | Code generation tasks from real GitHub issues | Sandbox exit code + Jaccard line overlap (threshold 0.4) |
| **TAU-bench** | Tool-call trace accuracy | Per-position name+args match + final-state deep-equal (50/50 blend) |
| **Docs-gen local harness** | Generated-document cold/warm ingest, synthesis, retrieval latency, RAM, claim support, and missed behavior on pinned synthetic fixtures | Measured timings plus answer-correctness-derived missed-behavior rate; token/cost only on explicit live runs |

### Running Benchmarks

- **Automatic**: A nightly cron (`.github/workflows/eval-nightly.yml`, `0 2 * * *`) runs both harnesses when `EVAL_NIGHTLY_ENABLED=true`.
- **Manual**: Admin users can click **Run now** on the `/eval/leaderboard` page, which hits `POST /api/eval/leaderboard/run`. Returns `202 disabled` when the env flag is unset.
- **Local generated-doc benchmark**: Run `pnpm --filter @metis/server eval:docs-gen` for the default single-repo deterministic fixture, or pass `--fixture docsgen-02-multi-repo` for the multi-repo fixture. Add `--live-model-run` only when real provider credentials and the real embedder are configured; otherwise token/cost stays not reported by design.

### Viewing Results

- `/eval/leaderboard` — table with bench filter, days filter, score-over-time SVG sparkline per benchmark, and status pills.
- `/eval/leaderboard/[id]` — per-run detail page with `BenchDiffViewer` showing expected vs actual for failing tasks.
- Non-admin users see scores and metadata but `expected`/`actual` payloads are redacted to `null`.

### FinOps Integration

Both runners respect the existing FinOps cost cap — they stop the loop early when cumulative spend would exceed the budget. Each task's token/cost data rolls into the standard usage pipeline.

---

## 29. Code-Execution Sandbox — QA-agent now runs your tests in isolation (v1.2.x)

When the **QA-agent** generates tests for your project, it no longer asks
you to run them yourself. It now executes them inside an **isolated,
ephemeral sandbox** (a micro-VM with its own filesystem, CPU/RAM cap, and
network policy) and reports the result back to you in the run timeline.

What this means for you, the user:

- **Faster feedback** — generated tests are validated automatically. The
  QA-agent's verdict (`passed` / `failed` / `timed out`) appears in the
  run history without you running anything locally.
- **Safer execution** — generated code never touches your host. Each run
  creates a fresh sandbox, executes the test command, and is destroyed.
  Nothing persists between runs.
- **Default-deny network** — the sandbox can only reach package
  registries (npm, PyPI) and GitHub by default. Project admins may
  *tighten* this allow-list per-project but cannot widen it.
- **Resource caps you can trust** — every sandbox is hard-capped at
  4 vCPUs, 8 GiB RAM, and a 5-minute wall-clock. A runaway test triggers
  a watchdog kill and surfaces a `timed out` outcome.
- **Full audit trail** — every sandbox lifecycle event (create / exec /
  pause / destroy / timeout) is recorded in the `sandbox_audit_events`
  table with sensitive payload fields automatically redacted.

For local development the sandbox runs against the built-in `noop`
provider (zero external dependencies — uses a temp directory + child
process). In production, ops sets `SANDBOX_PROVIDER=e2b` and supplies an
`E2B_API_KEY` to back it with the hosted E2B fleet. See
[`docs/ARCHITECTURE.md` §24](./ARCHITECTURE.md) and
[`docs/SECURITY.md` §9](./SECURITY.md) for the technical and security
deep-dives.

### Run-page sandbox status badge + sessions table (#419)

Every run-detail page (`/runs/[id]`) now surfaces sandbox usage inline
so you don't have to dig through the `sandbox_audit_events` table to
see what executed.

- **Sandbox status badge** — a coloured pill rendered next to the run
  heading. The badge is computed from the most recent `SandboxSession`
  row tied to the run:
  - `PASSED` (green) — the latest session finished with `outcome=completed`.
  - `FAILED` (red) — the latest session ended in `error` or `killed`.
  - `TIMED OUT` (amber) — the latest session was terminated by the
    wall-clock watchdog.
  - `RUNNING` (blue) — at least one session is still in flight
    (`destroyedAt` is null).
  - The badge is hidden entirely when the run produced no sandbox
    sessions, so non-sandbox runs render exactly as they did before.

- **Sandbox sessions table** — a collapsed disclosure block under the
  run timeline. Expanding it lists every `SandboxSession` for the run
  in chronological order with provider, vendor sandbox id, vCPU /
  memory caps, wall-clock duration, cost (in USD micro-cents), and
  outcome. The data is paginated server-side and capped at 50 rows
  per request.

- **Cross-tenant isolation** — both the badge and the table are fed
  by `GET /api/runs/:id/sandbox-sessions`, which enforces the same
  project-membership check as `GET /api/runs/:id`: callers who cannot
  read the parent run get a 403 and zero sandbox metadata leaks. Admin
  users see every project; non-admin roles see only the projects they
  created.

---

## Appendix: MCP local-dev troubleshooting

> Issue [#365](https://github.com/openzigs/metis-private/issues/365) (Epic [#359](https://github.com/openzigs/metis-private/issues/359)). When something fails during local MCP setup it almost always boils down to one of the four errors below. Run `pnpm bootstrap:check` first — it surfaces every prerequisite the bootstrap flow assumes — then look up the specific error message verbatim here.

### `network metis-mcp not found`

**Where you'll see it**: in the METIS server logs when the lifecycle manager tries to spawn a `runtime: docker-stdio` MCP wrapper container, e.g.:

```
Error response from daemon: network metis-mcp not found
```

**Why**: the `metis-mcp` Docker bridge network does not exist on this host. As of Issue [#361](https://github.com/openzigs/metis-private/issues/361) it is declared in both `docker-compose.yml` and `docker-compose.prod.yml`, so `docker compose up` (or `pnpm bootstrap:up`) auto-creates it. If you are running METIS outside compose, you must create it manually.

**Fix**:

```bash
# If running METIS via compose:
docker compose up -d            # auto-creates the network
# …or run the bootstrap flow which creates it eagerly:
pnpm bootstrap

# If running METIS outside compose (legacy):
docker network create metis-mcp
```

Verify with `pnpm bootstrap:check` — the `metis-mcp network present` row should turn green.

---

### `image not in MCP_IMAGE_ALLOWLIST`

**Where you'll see it**: as a 4xx error when you click **Save** on the **Settings → MCP Servers → Add** form, e.g.:

```
{
  "error": "MCP_IMAGE_NOT_ALLOWED",
  "message": "image ghcr.io/example/foo:1.0 is not in MCP_IMAGE_ALLOWLIST"
}
```

**Why**: the `MCP_IMAGE_ALLOWLIST` runtime config is a glob list (segment-aware as of Issue [#304](https://github.com/openzigs/metis-private/issues/304) — `*` does NOT span `/`, use `**` for that) that gates which container images the docker-stdio / k8s-sse provisioners are allowed to spawn. The default ships with `ghcr.io/metis-mcps/*` so the standard wrapper images work out of the box; anything else must be added explicitly.

**Fix**: open **Settings → Configuration**, find `MCP_IMAGE_ALLOWLIST`, add the registry path (or a glob covering it), and save. Examples:

| Goal                                           | Pattern to add                  |
| ---------------------------------------------- | ------------------------------- |
| Allow all images under `ghcr.io/metis-mcps`    | `ghcr.io/metis-mcps/*`          |
| Allow nested paths under `ghcr.io/metis-mcps`  | `ghcr.io/metis-mcps/**`         |
| Allow a specific image                         | `ghcr.io/myorg/myrunner:1.2.3`  |
| Allow an internal registry                     | `registry.internal.example.com/mcp/*` |

The provisioner re-validates the image at provision time, so an off-allowlist image is rejected before any container starts.

---

### `docker socket not mounted`

**Where you'll see it**: the METIS server logs an error such as:

```
Cannot connect to the Docker daemon at unix:///var/run/docker.sock.
Is the docker daemon running?
```

…even though the host's daemon is clearly running. This typically only affects rootless Docker / Podman setups where the socket path differs from the default.

**Why**: METIS spawns sibling containers via the host's Docker socket. Compose mounts it by default (`/var/run/docker.sock`), but rootless Docker uses `${XDG_RUNTIME_DIR}/docker.sock` and Podman uses `${XDG_RUNTIME_DIR}/podman/podman.sock`. The METIS container has no way of finding those automatically.

**Fix**:

1. **Rootless Docker**: export `DOCKER_HOST=unix://${XDG_RUNTIME_DIR}/docker.sock` in your shell before `docker compose up`, OR add a volume override in a `docker-compose.override.yml`:

   ```yaml
   services:
     server:
       volumes:
         - ${XDG_RUNTIME_DIR}/docker.sock:/var/run/docker.sock
   ```

2. **Podman**: enable the user socket (`systemctl --user enable --now podman.socket`) and bind-mount it into the server container at `/var/run/docker.sock` via the same override.

3. **Rootful Docker** (the common case): no action needed — the default mount works.

---

### `wrapper image not present locally`

**Where you'll see it**: the lifecycle manager logs a `docker pull` failure followed by:

```
Unable to find image 'ghcr.io/metis-mcps/npx-runner:1.0.0' locally
docker: Error response from daemon: pull access denied …
```

**Why**: the wrapper images are not cached on this host AND your Docker is unable to pull them from `ghcr.io/metis-mcps/*` — usually because the image hasn't been published yet for this version (Issue [#363](https://github.com/openzigs/metis-private/issues/363) wires the multi-arch GHCR publish on `mcp-wrappers/v*` tags), or because you're on a registry that needs a `docker login`.

**Fix** — pick one:

```bash
# Best: pull what's published.
pnpm bootstrap                        # pulls all 9 wrappers from GHCR

# If pull still fails, fall back to a local build (the bootstrap script
# does this automatically; you can also invoke it directly):
./images/mcp-wrappers/build.sh        # builds all 9 locally with REGISTRY=ghcr.io/metis-mcps

# If you publish to a private registry, add it to MCP_IMAGE_ALLOWLIST and
# log into it:
docker login registry.internal.example.com
REGISTRY=registry.internal.example.com/mcp ./images/mcp-wrappers/build.sh push
```

Verify with `pnpm bootstrap:check` — the `wrapper images cached: N/9` row should report `9/9`.

---

## 30. Auto Documentation Generator (Epic #486)

METIS can automatically generate living business documentation from your project's source code. The documentation includes business rules, formulas, data flow diagrams, and cross-references — all in rich Markdown with Mermaid diagrams and LaTeX-rendered math.

### 30.1 What It Does

When you connect a code repository, METIS builds a **code graph** — a map of all classes, methods, and their relationships. The Documentation Generator walks this graph and produces human-readable documentation that explains:

- **Business rules** — conditional logic, validation, and domain constraints
- **Formulas** — arithmetic expressions rendered as LaTeX (e.g., $\text{Total} = \text{Subtotal} \times \text{TaxRate}$)
- **Data flow** — Mermaid diagrams showing how data moves between modules
- **Constants** — magic numbers, thresholds, and configuration values with their context
- **Cross-references** — links between related classes and methods

### 30.2 Navigating to the Documentation Tab

1. Open a project from the dashboard
2. Click the **Documentation** tab in the project navigation
3. You'll see a list of previously generated documents (if any) and a **Generate** button

### 30.3 Generating Documentation

Click the **Generate** button to open the generation form:

| Field | Description |
|-------|-------------|
| **Title** | A name for your document (e.g., "Orders Module Reference") |
| **Scope** | `Full` — entire codebase · `Module` — specific package/namespace · `Symbol` — single class/method |
| **Scope Filter** | When scope is Module or Symbol, specify which module/class to document |
| **Auto Update** | Toggle ON to check for changed inputs after successful repository Deep Ingest or refresh (manual or scheduled); database-scope documents are excluded |

After clicking **Generate**, METIS will:
1. Analyze the code graph for the selected scope
2. Extract business rules, formulas, and relationships
3. Call the AI to produce natural-language summaries
4. Assemble the final document with diagrams and formatting
5. Queue a background publication job that indexes the generated markdown through the same approval/ACL-aware knowledge pipeline as other trusted content

Generation and indexing are reported separately. A document can be `ready` or `degraded` to read while indexing remains `pending` (with a processing status of `pending` or `processing`), `quarantined` awaiting approval, or `reconciling` after approval while index cleanup is incomplete. Only completed indexing and cleanup report `indexed`. Rejection reports `rejected`; failed or explicitly cancelled publication without a synthetic document reports indexing `failed` with an error, not a separate cancelled badge. Complex codebases may take 30–60 seconds to generate, and indexing may continue afterwards.

**Live progress (Epic #238).** You no longer need to refresh to see completion. While a document is generating, the panel shows **live per-section progress** — each section appears as it moves from `Generating…` to `Done`, `Degraded`, or `Failed`, with any degraded/failed-section warnings surfaced inline as they happen rather than only after the run finishes. When generation completes, the document list and preview update automatically. The same push-driven live status applies to **Running an Analysis** (§11) and **Impact Analysis** — their status updates in real time over the websocket, with polling kept only as a fallback if the connection drops. Every action you take (start analysis, generate docs, submit clarifications, run impact analysis, edit a requirement) now shows a spinner/disabled button while in flight and a success-or-error toast on completion, so failures are never silent.

**Interrupted generation (#50).** Documentation generation runs inside the server process. If the server restarts or stops while a document is generating (a deploy, a crash, a dev reload), the document no longer spins as "Generating" forever: within about five minutes of the server coming back it is marked **Failed** with an "interrupted" explanation and a **Regenerate** button that reruns the same document in place. Modules already analysed before the interruption are reused from the fact cache, so they are not paid for twice.

**Source-unavailable degraded state (#330).** If a project's source files can't be read when documentation is generated — the connector's clone or uploaded-archive directory is missing or was purged (see `UPLOAD_ARCHIVE_DIR`/`UPLOAD_EXTRACT_DIR` in the operator guide) — METIS no longer ships a clean-looking but unreliable document. Instead the document is marked **Degraded output** with an explicit `source-unavailable` warning telling you exactly N of M code modules could not be read and that any content generated for them is effectively 0% grounded. The remedy is to **re-ingest** (re-clone or re-upload) the project and then regenerate. Previously this surfaced silently as sections quietly dropping to 0% grounding with no clear cause.

**Truncated-section degraded state (#1226).** A section whose prose is longer than the model is allowed to emit in one response does not fail — the model simply stops, and some gateways replace the whole body with a `[No response text was returned by the model (stopReason=max_tokens)…]` placeholder. METIS used to store whichever of those it got and still mark the document `ready`, so a Business Requirements Document could end mid-sentence, or lose an entire section group, with nothing to indicate it. Now each affected section raises a **`section-truncated`** warning naming the group, the gateway placeholder is stripped rather than saved into the document, and the document is marked **Degraded output** instead of ready. A section group that disappears from the assembled document entirely raises a **`section-missing`** warning. The room to emit long sections was also raised roughly fourfold, so most documents that previously truncated now simply complete; if one still truncates, an operator can raise `DOCS_GEN_SECTION_MAX_OUTPUT_TOKENS` (bounded by whatever the selected model itself supports) and regenerate.

**Database schema documents count what was actually written (#1228).** A database-scope document reports AI prose descriptions for the tables it really described, not the tables it tried to describe — the note above the table reference is derived from the same descriptions the sections and the schema explorer show, so it cannot overstate them. When a batch of descriptions returns nothing usable (the model errored, was cut off by its output cap, returned something no description could be read from, or no AI provider could be reached), the document is marked **Degraded output** with a warning instead of appearing complete — and the Schema Graph explorer stays available, because the graph is complete even when the prose is not. Two things are deliberately *not* degradations: stopping early because the configured generation budget was reached, and a batch that describes most of its tables but skips one or two. Both are recorded in the server log and reflected in the count above the table reference; every table is fully documented with its column schema regardless. If descriptions are being cut off, raise `DOCS_GEN_DB_SCHEMA_MAX_OUTPUT_TOKENS` or lower `DB_SCHEMA_SYNTH_BATCH_SIZE` and regenerate.

### 30.4 Viewing Generated Documentation

**Evidence access and repository scope (#1353).** Generation and background execution
use the initiating user's current active account, effective role, and workspace access.
Workers resolve current durable role assignments; generation-time SSO role claims are
not an authorization fallback. Unknown legacy role-less accounts remain reader until
audited administrator reconciliation (see [Legacy account access recovery](#legacy-account-access-recovery-1350)); a provider-managed recovery still
requires a fresh trusted login before provider permissions become available. Revoked
permissions/memberships and older documents without a trusted generation policy fail
closed. A repository request with a missing/deleted/foreign graph fails instead of silently
using other repositories. Repository-grounding queries exclude other-repo chunks and require
both document and chunk access. API clients can explicitly allow non-repository project
references through `sharedReferenceDocumentIds`; this does not bypass ACLs. Web research
remains opt-in. Generated documents, including prior versions of the current artifact,
cannot be used as primary evidence to validate generated claims. Generated-document RAG
publication also preserves a conservative derived ACL on the synthetic document instead of
broadening access to every project reader. Per-section grounding and live progress remain
enabled. Auto-update uses this same original-user authorization, independently of who
refreshes the connector; see §30.7.

Deleting a generated document now enqueues cleanup for every published revision of its
synthetic RAG artifact. That cleanup no longer depends on the original generator account
still being available at delete time, so a soft-deleted document cannot leave older
generated chunks behind in sparse or vector indexes.

Publication and deletion-cleanup tasks survive graceful scheduler shutdown. Startup
and minute recovery passes resume pending work and replay interrupted running publication
after its handler timeout; explicitly user-cancelled and exhausted failed tasks are not
automatically revived. Sparse-index errors remain retryable failures, not successful
indexing. A selected publication remains `reconciling` until cleanup succeeds; failures
remain visible with an error while retries preserve the selected chunks. Each revision
owns separate SQL, vector, and sparse-index identities, so a
superseded worker's cleanup cannot erase a newer published revision.

**Manual approval recovery.** An approval that saved
its selected chunks but failed index cleanup stays in the project's **Quarantine**
panel after refresh. The row explains **Approval saved. Index cleanup is incomplete**,
shows the saved error, and offers **Retry indexing** using the existing approval
permissions. Retry failures remain visible; successful cleanup removes the row.
Reject/trust controls are not offered while reconciliation is pending. Generated
revisions are retryable only while they remain the latest live version and their
original initiating user still has the required access. The approving operator does
not replace that original authority; stale, deleted, revoked, or unversioned legacy
revisions fail closed. The button reconciles selected approval chunks; it does not
restart cancelled or exhausted publication tasks.

**Multiple repositories (#1354).** Full-project generation reads each repository
from its own checkout. Modules with the same directory or filename remain separate,
including cached facts and citations, and module labels identify their repository.
If one checkout is missing, a repository-specific **source-unavailable** warning
marks the document degraded; other repositories still contribute their valid output.
Restore/re-ingest the affected connector and regenerate. Missing source is never
replaced with another repository's files or silently recovered from cached facts.

Click any document card to open the rich preview. The previewer renders:

- **Mermaid diagrams** — call-flow and data-flow diagrams rendered as interactive SVGs
- **Math formulas** — LaTeX rendered with KaTeX for clear formula display
- **Syntax-highlighted code** — extracted code snippets with language-appropriate highlighting
- **GFM tables** — structured data in clean table format
- **Table of Contents** — sidebar navigation auto-generated from headings

Each card and detail view also shows a separate **Indexing** badge. This reflects whether the generated markdown has been published into the searchable knowledge base yet. If indexing is still queued or running, the document remains readable in the preview, but retrieval freshness may lag until indexing completes.

### 30.5 Using the TOC Sidebar

The left sidebar shows a navigable table of contents extracted from the document's headings. Click any heading to scroll directly to that section. The current section is highlighted as you scroll.

### 30.6 Exporting to PDF and Word

Above the document preview, you'll find export buttons:

| Format | Details |
|--------|---------|
| **PDF** | Full-fidelity export with diagrams, formulas, and syntax highlighting. Requires Chrome on the server (included in Docker images) |
| **Word (.docx)** | Professional Word document with Table of Contents, styled headings, and code blocks. Best for sharing with stakeholders who prefer Office formats |

> **Note:** If you're running locally without Chrome installed, PDF export returns a styled HTML file instead. Run `npx puppeteer browsers install chrome` to enable full PDF support.

### 30.7 Living Documents (Auto-Update)

When you enable **Auto Update** on a document:

1. After successful **Deep Ingest** or **Refresh** (including background Deep
  Ingest and configured scheduled repository refresh), METIS checks the document's
  inputs. The graph, source-knowledge, and applicable metadata steps must succeed;
  a partial ingest does not trigger regeneration. This is not a watcher on every
  commit, and there is no fixed 15-minute documentation timer.
2. The check includes the full scoped symbol inventory, additions/deletions,
  relationships, source/rationale, eligible supporting evidence, and generation
  settings—not just previously cited symbols. An unchanged inventory creates no
  task or version. Refreshing another repository does not regenerate a document
  scoped to an unrelated repository. Evidence/settings changes are checked on the
  next successful ingest, not immediately when edited.
3. Changed inputs queue a durable job identified by the document, expected version,
  and input fingerprint. With the scheduler enabled, pending jobs resume after
  restart; recovery runs every minute and can reclaim running jobs stale for over
  **two hours**. Jobs allow three attempts. A later successful ingest can retry an
  exhausted failed job for the same inputs, but does not resurrect a cancelled job.
4. Full-project/repository documents reuse cached module facts and section output
  only when complete records prove the actual section prompts and all their inputs
  unchanged. Reused sections keep their original grounding warnings; reuse does
  not turn degraded output into verified output. Changed sections run the normal
  synthesis and grounding checks. Older/incomplete records, shared escalation,
  changed global dependencies, or settings can require **full regeneration**.
  Module/symbol scopes use their normal discovery/assembly pipeline. No Graphify
  installation or developer graph is required.
5. METIS saves a new **version** with a diff summary and queues shared publication
  under a new immutable revision ID. If the source inventory changed but every
  section prompt is unchanged, the summary says **Source inventory updated; all
  section dependencies unchanged**. This still records/publishes a new inventory
  revision; it is different from the unchanged-inventory no-op in step 2.

**Benchmarking note (#1357/#1358).** The local docs-gen benchmark is a bounded
evaluation harness, not a measurement of production Deep Ingest throughput. Its
ingestion timings start after fixture repositories have already been seeded and
cover local embedder warm-up plus retrieval setup in the throwaway benchmark
process. The optional typed-symbol comparison is off by default and must be
enabled explicitly for an exploratory A/B run. All current runs, including explicit
live-model runs, remain exploratory: a reference-answer description is not validated
judge calibration. Comparisons report raw metric movement with `keep-disabled`
(or exploratory `insufficient-evidence` when the experiment cannot complete safely).
The harness has no validated calibration admission path; it makes no release-quality
or live-model improvement claim. Reference/judge validation under #1319/#1320 and
publication constraints under #1308 remain required before such claims.

**Access and scope caveats.** Auto-update rechecks the original initiating user's
current permissions before generation and before saving; the task carries no
authorization policy of its own. Revoked access or a missing trusted legacy policy
blocks the work. Deletion, a newer revision, changed inputs, or switching auto-update
off fences out stale in-flight results. Database-scope documents are **not**
automatically refreshed by repository ingestion; use their schema-generation flow.

Each new full or incremental version also records an immutable provenance snapshot:
a stable revision id, the effective evidence policy, the generation pipeline, the
model/prompt identities used for generation, repository/code-graph fingerprints,
selected evidence IDs, and per-section metadata. Historical citation availability is
reported honestly rather than inferred: legacy versions remain `legacy-unknown`, and
new versions without retained citation evidence are marked unavailable until later
indexing and freshness work can re-resolve them.

Generated-document indexing is retryable and idempotent. METIS does not require a manual reindex step after generation or auto-update: the queued publication worker uses the latest version number plus revision id as its fence, skips deleted or superseded revisions, and republishes only the current version into the searchable store.

### 30.8 Version History

Below the document preview, the **Versions** panel shows the history of all regenerations:

- **Version number** and timestamp
- **Diff summary** — a natural-language description of what changed
- **Changed symbols** — which classes/methods triggered the update

Newer versions also carry a machine-readable provenance manifest behind the scenes.
It includes the immutable revision id for that version, the evidence and repository
fingerprints that backed the generation, and the exact model/prompt contract used at
the time. Historical rows created before this feature remain readable, but METIS now
labels their historical-citation state honestly as legacy/unknown instead of implying
that older versions had captured evidence snapshots when they did not.

The same revision id is also stamped onto the indexed chunks for that version, along with the generated-document id, version number, and section metadata. This lets later cleanup and freshness work distinguish which searchable chunks came from which generated revision.

Click any version to view its content, or compare two versions side-by-side.

### 30.9 Rate Limits

Documentation generation is compute-intensive (it calls the AI for each documentable symbol). To prevent overload:

- **5 generation requests per 15 minutes** per user
- Exports (PDF/Word) are not rate-limited

If you hit the limit, wait 15 minutes or ask an administrator to generate on your behalf.

### 30.10 Cost Optimization

For large codebases (500+ files), documentation generation can be surprisingly expensive in AI tokens. METIS implements two strategies to keep costs under control.

#### Two-Model Split (Phase 1 vs Phase 2)

Generation runs in two distinct phases, each using the most cost-appropriate model:

| Phase | What It Does | Model | Why |
|-------|-------------|-------|-----|
| **Phase 1** — Fact Extraction | Reads each module's code and extracts structured facts: business rules, formulas, class summaries | **Claude Haiku 4.5** (`global.anthropic.claude-haiku-4-5`) | Structured extraction is a well-defined task — Haiku produces equivalent quality at ~1/4 the price of Sonnet |
| **Phase 2** — Synthesis | Combines all extracted facts into long-form prose, Mermaid diagrams, and LaTeX formulas | **Claude Sonnet 4.6** (`us.anthropic.claude-sonnet-4-6`) | Long-form narrative quality, accurate diagram syntax, and faithful cross-module aggregation benefit from the stronger model |

#### Approximate Cost Estimates

For a **large Java monolith (~1,500 files, 150 modules)** such as a legacy ERP:

| Scenario | Phase 1 | Phase 2 | Total |
|----------|---------|---------|-------|
| First run (Haiku + Sonnet) | ~$1.50 | ~$1.00 | **~$2.50** |
| First run (Sonnet + Sonnet — before Haiku IAM) | ~$5.50 | ~$1.00 | **~$6.50** |
| Cached run (no code changes) | ~$0.00 | ~$1.00 | **~$1.00** |
| Cached run + new modules only | proportional | ~$1.00 | **~$1–2** |

For a **mid-size service (~200 files, 40 modules)**:

| Scenario | Total |
|----------|-------|
| First run (Haiku + Sonnet) | **~$0.50** |
| Cached run | **~$0.25** |

> Estimates assume [Anthropic's current pricing](https://www.anthropic.com/pricing): Haiku 4.5 at $0.80/MTok input · $4.00/MTok output · $0.08/MTok cache read; Sonnet 4.6 at $3.00/MTok input · $15.00/MTok output · $0.30/MTok cache read.

#### Dynamic Snippet Budgets

Phase 1 also applies tiered context budgets so tiny utility modules don't consume the same tokens as large domain classes:

| Module size | Code context sent | Methods read |
|-------------|------------------|--------------|
| ≤ 10 symbols | 18,000 chars | up to 25 |
| 11–50 symbols | 36,000 chars | up to 50 |
| > 50 symbols | 60,000 chars | up to 80 |

This alone reduces Phase 1 cost by 30–40% compared to sending a fixed maximum budget to every module.

### 30.11 Phase 1 Fact Cache

The most powerful cost-reduction feature is the **Phase 1 Fact Cache** — METIS remembers the structured facts it extracted from each module and reuses them on subsequent runs without making any AI calls.

#### How It Works

1. Before calling the AI for a module, METIS computes a **SHA-256 cache key** from:
   - The module's directory path
   - A SHA-1 fingerprint of every source file in the module
   - A fingerprint of any mined business rules for the module
   - The current **prompt version** (bumped when the extraction prompt changes significantly)
   - The **model name** being used

2. If a matching cache row exists, the stored facts are returned instantly — no AI call, zero cost.

3. If the cache misses (new module, changed files, different model, or prompt upgrade), the AI call runs and the result is stored for next time.

#### Important: Cache is Model-Specific

The model name is part of the cache key. This means:

- Facts extracted by **Haiku** and facts extracted by **Sonnet** have **separate cache entries**.
- If you switch from Sonnet to Haiku (by setting `DOCS_GEN_PHASE1_MODEL`), the first run after the switch will call the AI for all modules — building a new Haiku cache.
- Subsequent runs (same model, no code changes) will be served entirely from cache, costing effectively nothing for Phase 1.

#### Cache Hit Behaviour

| Run | Files changed? | Model changed? | Phase 1 AI calls |
|-----|---------------|---------------|------------------|
| First run | — | — | All modules |
| Second run, no changes | No | No | **0 (100% cache)** |
| After code change | Some files | No | Only affected modules |
| After model switch | No | Yes | All modules (rebuilds cache) |
| After prompt version bump | No | No | All modules (cache invalidated) |

#### Cache Persistence

The cache is stored in the METIS database (`DocsGenFactCache` table) and persists across server restarts, `pnpm dev` cycles, and across different document titles. As long as the code and model are the same, even a freshly titled document benefits from cached facts.

---

## 31. Model Selection — Choosing the Right AI Model (Epic #593)

METIS can automatically choose between two AI models for each task:

| Model | Strengths | Cost |
|-------|-----------|------|
| **Claude Haiku 4.5** | Fast responses, great for simple extraction and formatting tasks | Lower (~$0.001 per 1K tokens) |
| **Claude Sonnet 4.6** | Deep reasoning, multi-step analysis, complex synthesis | Higher (~$0.015 per 1K tokens) |

By default, METIS uses **Auto** mode — it analyzes each task's complexity and picks the most cost-effective model. Simple tasks route to Haiku; complex reasoning routes to Sonnet.

### 31.1 The Recommendation Indicator

When you start an analysis, the **Model Selection** card on the analysis page shows:

- **Recommended model** — which model METIS chose and why
- **Reasoning depth badge** — `simple`, `moderate`, or `complex`
- **Token estimate** — how many tokens the task will likely use
- **Estimated cost** — approximate cost for this run
- **Override dropdown** — lets you force a different model

If the model was automatically downgraded due to budget limits, a notice appears explaining the change.

### 31.2 Overriding the Model

You can override the automatic selection at two levels:

1. **Per-request override** — Use the dropdown in the Model Selection card on the analysis page to force Haiku or Sonnet for that specific run.
2. **Per-project default** — Go to your project's **Settings** page and click **Configure model preferences →** to set a persistent default.

### 31.3 Configuring Per-Project Model Preferences

Navigate to **Projects → [Your Project] → Settings → Configure model preferences** to access the Model Preferences page. You can configure:

- **Default Model** — Choose `Auto`, `Claude Haiku 4.5`, or `Claude Sonnet 4.6` as the default for all tasks in this project.
- **Budget Downgrade Threshold** — Set a monthly token limit. When usage exceeds this threshold, METIS automatically switches from Sonnet to Haiku to control costs. Set to 0 to disable.
- **Task Type Overrides** (Advanced) — Force a specific model for certain task types (e.g., always use Sonnet for code review, always use Haiku for document analysis).

Click **Save Preferences** to apply your changes.

#### Via the API

You can also configure preferences programmatically:

```bash
# Read current preferences
curl -H "Authorization: Bearer $TOKEN" \
  https://your-metis/api/projects/{projectId}/model-preferences

# Update preferences
curl -X PUT -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"defaultModel": "us.anthropic.claude-haiku-4-5-20251001-v1:0", "budgetDowngradeThreshold": 500000}' \
  https://your-metis/api/projects/{projectId}/model-preferences
```

Valid `defaultModel` values:
- `"auto"` — let METIS decide (same as `null`)
- `"us.anthropic.claude-haiku-4-5-20251001-v1:0"` — always use Haiku
- `"us.anthropic.claude-sonnet-4-6"` — always use Sonnet

### 31.4 Cost Implications

Choosing the right model matters for both quality and cost:

- **Haiku is ~15× cheaper** than Sonnet per token. For high-volume projects with many simple tasks, defaulting to Haiku can dramatically reduce costs.
- **Sonnet produces higher-quality output** for complex tasks like synthesizing requirements across multiple documents or analyzing intricate code patterns. Using Haiku for these tasks may produce lower-quality results.
- **Auto mode** gives you the best of both worlds — it uses Haiku where it's sufficient and reserves Sonnet for tasks that need it.
- **Budget downgrade** acts as a safety net — even if your default is Sonnet, METIS will switch to Haiku once you hit your token threshold, preventing unexpected cost overruns.

## 32. Token Usage Tracking & Cost Management (Epic #594)

### 32.1 Overview

METIS provides comprehensive token usage tracking and cost allocation tools for managing AI costs across projects and users. This includes per-project budgets, usage dashboards, cost estimation, and optional CloudWatch metrics integration.

### 32.2 Usage Dashboard

Navigate to **Projects → [Your Project] → Usage** to view the project usage dashboard. The page shows:

1. **Headline tiles** — Month-to-date tokens, window cost, projected monthly cost
2. **Budget gauge** — Visual meter showing current budget utilization with soft/hard threshold indicators
3. **Tokens per day chart** — Daily token consumption visualized as a bar chart
4. **By provider breakdown** — Table showing usage by AI provider and model
5. **Detailed analytics** — Time range filter (7d/30d/90d), group-by selector (day/model/user), and CSV export

#### Unpriced usage

METIS prices usage from published list prices for the models it knows. Usage from a model it has no price for — for example a DeepSeek model reached through `ANTHROPIC_BASE_URL` — is recorded as **unpriced**: it is left out of every dollar figure and shown separately, with its input and output token counts, in an **Unpriced usage** card, an **Unpriced tokens** figure, and as `Unpriced` in the cost column. In CSV exports its cost cell is empty and an `unpricedTokens` column carries the tokens. It is never shown as `$0.00`.

An administrator can price such a model under **Settings → Configuration** (`/settings/api-keys`) with the `MODEL_PRICES` setting — a JSON object of USD-per-million-token prices keyed by model id, or `provider:model` for one provider only:

```json
{ "deepseek-v4-pro": { "inputPerMTok": 1.32, "outputPerMTok": 3.96, "cacheReadPerMTok": 0.044 } }
```

`cacheReadPerMTok` and `cacheWritePerMTok` are optional and default to the input price. A price applies to usage recorded after it is saved; earlier rows keep the cost they were recorded with, except that the **Projected month** figure — like the autopilot cost ceiling below — re-prices the month's earlier unpriced rows with the current prices, so the two always agree. When `ANTHROPIC_BASE_URL` points at a provider other than Anthropic, Anthropic's own list prices are not applied even to `claude-*` model names, because such a provider bills its own prices — set them here. If `ANTHROPIC_BASE_URL` is instead a proxy or AI gateway that relays to Anthropic (a corporate egress proxy, LiteLLM), set `ANTHROPIC_BASE_URL_BILLS_AS` to `anthropic` in the same place and the built-in Claude prices apply again. Self-hosted `local-gemma` usage is recorded at $0, since it has no per-token charge.

An **autopilot cost ceiling** cannot be checked against spend it cannot price, so while the month has unpriced usage a project with a ceiling refuses autopilot runs (`AUTOPILOT_COST_CEILING`, naming the unpriced token count). Pricing those models with `MODEL_PRICES` clears it — the ceiling check re-prices the month's earlier unpriced rows with the current prices — or remove the ceiling.

#### Time Range & Grouping

Use the **range selector** to view usage over 7, 30, or 90 days. The **group-by** selector lets you aggregate by day, model, or user.

#### CSV Export

Click **Export CSV** to download usage data as a CSV file for external analysis or reporting.

### 32.3 Token Budgets

Token budgets enforce cost limits at the project level. Navigate to **Projects → [Your Project] → Settings** or use the API to configure:

- **Daily token limit** — Maximum tokens allowed per calendar day (UTC). When exceeded, requests are rejected with HTTP 429.
- **Monthly token limit** — Maximum tokens allowed per calendar month.
- **Downgrade model** — When usage reaches 80% of the limit (soft threshold), METIS automatically switches to this cheaper model (e.g., "haiku") instead of rejecting requests.

#### Budget Thresholds

| Utilization | Behavior |
|-------------|----------|
| 0-79% | Normal operation |
| 80-99% | ⚠️ Soft threshold — auto-downgrades to configured cheaper model, logs warning |
| 100%+ | 🛑 Hard limit — rejects requests with HTTP 429, logs error |

### 32.4 Inference Profiles (Bedrock)

If your project uses AWS Bedrock, you can configure an **Inference Profile** to enable AWS cost allocation tagging. Navigate to **Settings → AI** or use the API:

- **ARN** — The Bedrock application inference profile ARN, using a PLACEHOLDER account/profile (e.g., `arn:aws:bedrock:us-east-1:ACCOUNT:application-inference-profile/PROFILE_ID`)
- **Model ID** — The Bedrock model identifier
- **Cost Center** — Optional cost center tag for AWS billing
- **Environment** — Optional environment tag (prod/staging/dev)
- **Tags** — Arbitrary key-value tags passed to Bedrock for cost allocation

When configured, the inference profile ARN is used instead of the raw model ID when invoking Bedrock, enabling precise cost attribution in AWS Cost Explorer.

> **Cost attribution only — not region pinning; profiles wrap a foundation model.**
> Swapping the raw model ID for the application inference profile ARN changes only
> how spend is *attributed*; it does not pin a region and it does not change the
> model. Cross-region routing (us-east-1 / us-east-2 / us-west-2) via the
> `us.anthropic.*` system inference profiles is **intentional** and permitted by the
> gateway IAM — there is no us-east-1 residency lock. The two env-level profiles
> (`BEDROCK_SONNET_PROFILE` / `BEDROCK_HAIKU_PROFILE`, mapped by
> `BedrockDirectProvider.resolveModel`) activate the same swap for the global
> chat/analysis/docs-gen paths. Metis routes to Claude **Sonnet 4.6** (general/default)
> and Claude **Haiku 4.5** (faster/cheaper). Bedrock's prompt-cache **minimum token
> threshold is model-specific** (Sonnet 4.6 = 1,024 tokens, no 1h TTL; Haiku 4.5 =
> 4,096 tokens, 1h TTL), so a profile that wraps an older foundation model can change
> whether caching fires. If a cross-region (`us.` / `global.`) model ID with no
> matching profile reaches the gateway while a profile map is configured, the request
> still succeeds but its spend bypasses cost attribution and the provider logs a
> structured warning (model id + `profileMapConfigured` only). See the full profile →
> model → cache-min-token mapping in
> [`docs/OPERATIONS.md` §7.5 Prompt Caching](./OPERATIONS.md#75-prompt-caching-epic-647)
> (Issues #386/#387). Use placeholder ARNs in examples — never commit real ARNs or
> account IDs.

### 32.5 Admin Usage Dashboard

Administrators can view cross-project usage analytics at **Admin → Usage**. This dashboard shows:

- Total tokens and estimated cost across all projects
- Usage grouped by project, day, model, or user
- Time range filter and CSV export
- User-level budget management

### 32.6 Cost Estimation

METIS estimates costs automatically based on known model pricing:

| Model | Input (per 1M tokens) | Output (per 1M tokens) |
|-------|----------------------|----------------------|
| Claude Haiku | $1.00 | $5.00 |
| Claude Sonnet | $3.00 | $15.00 |
| Claude Opus | $15.00 | $75.00 |

Cost estimates are stored with each token usage record and rolled up in the usage dashboards.

### 32.7 CloudWatch Metrics (Optional)

Set `ENABLE_CLOUDWATCH_METRICS=true` to publish real-time usage metrics to AWS CloudWatch. The `@aws-sdk/client-cloudwatch` package must be installed. Metrics are published under the `metis` namespace with dimensions for project, model, user, and environment.

## 33. Issue Templates — Customizing AI-Generated Issues (Epic #595)

Issue templates let you control the structure of AI-generated issue drafts. Each project gets 4 default templates out of the box, and you can create custom ones to match your team's conventions.

### 33.1 Accessing the Template Editor

1. Navigate to your project
2. Click **Settings** in the project sidebar
3. Select the **Templates** tab

You'll see a list of all templates for this project. Default templates are marked with a badge and cannot be deleted.

### 33.2 Built-in Templates

Every new project is seeded with 4 default templates:

| Template | Platform | Type | Description |
|----------|----------|------|-------------|
| GitHub Epic | GitHub | Epic | Structured epic with goal, scope, acceptance criteria, and technical notes |
| GitHub Feature | GitHub | Feature | Standard feature issue with description, acceptance criteria, and tags |
| Jira Story | Jira | Story | Jira story with mapped custom fields (story points, priority, labels) |
| Jira Bug | Jira | Bug | Jira bug report with reproduction steps, expected/actual behavior, and severity |

### 33.3 Creating a Custom Template

1. Click **New Template** on the templates page
2. Fill in the template details:
   - **Name**: A descriptive name (e.g., "Security Review Template")
   - **Platform**: `github` or `jira`
   - **Type**: `epic`, `feature`, `story`, `bug`, or `task`
3. Add **sections** to define the issue structure. Each section has:
   - **Key**: Machine-readable identifier (e.g., `acceptance_criteria`)
   - **Label**: Human-readable heading (e.g., "Acceptance Criteria")
   - **Type**: One of `text`, `markdown`, `checklist`, `number`, `select`, or `tags`
   - **Required**: Whether the AI must fill this section
   - **Placeholder**: Example text shown in the editor and used as hints for the AI
4. Click **Save**

### 33.4 Section Types

| Type | Best For | Example |
|------|----------|---------|
| `text` | Short fields (titles, labels) | Issue title, component name |
| `markdown` | Rich descriptions | Description, technical notes |
| `checklist` | Actionable items | Acceptance criteria, review checklist |
| `number` | Numeric values | Story points, estimated hours |
| `select` | Fixed choices | Priority (Low/Medium/High), severity |
| `tags` | Flexible labels | Component tags, technology tags |

### 33.5 Live Preview

The template editor includes a live preview pane. Toggle between **GitHub** and **Jira** views to see how your template will render:

- **GitHub view**: Shows the issue body as rendered Markdown
- **Jira view**: Shows the mapped Jira field structure

### 33.6 Cloning Templates

To create a variation of an existing template (including defaults), click the **Clone** button. This creates an editable copy with "(Copy)" appended to the name.

### 33.7 How Templates Affect Draft Generation

When the AI generates issue drafts, it uses the matching template for the target platform and issue type:

1. The template schema is converted into an LLM prompt fragment via `buildTemplatePrompt()`
2. The AI produces structured JSON output matching the schema
3. The output is validated against the template's section rules
4. Valid output is rendered to platform-specific format (Markdown or Jira fields)

If no matching custom template is found, the system falls back to the project's default templates.

## 34. Agent & Skill Token Optimization (Epic #596)

METIS now optimizes token usage during AI-powered code analysis by caching code structure summaries, compressing context windows, and intelligently routing to specialist agents.

### 34.1 AST Cache Rebuild

When repository code changes, you can rebuild the AST summary cache to keep token-saving summaries current. Navigate to a project's repository settings and trigger a cache rebuild, or use the API:

```
POST /api/projects/:projectId/repositories/:repoId/rebuild-cache
```

The cache extracts lightweight summaries (function signatures, class outlines, interface/type declarations) from TypeScript, JavaScript, and Python files, reducing the need to send full source files to the LLM.

### 34.2 Per-Agent-Step Usage Tracking

The usage dashboard now supports grouping token consumption by **agent step**. Select "By Agent Step" from the group-by dropdown on a project's usage page to see which analysis phases (planning, code-reading, summarization, etc.) consume the most tokens. This helps identify optimization opportunities.

### 34.3 How Optimization Works

- **Code-Graph-First Strategy**: When an agent requests a file, the system first checks the AST summary cache. If a cached summary exists, it returns a compact representation instead of the full source — often reducing tokens by 80%+.
- **Context Window Manager**: Monitors the running context size. When it exceeds the token threshold, the oldest context segments are automatically summarized to free space while preserving recent context.
- **Agent Skill Router**: Scores candidate specialist agents against the task keywords and selects the best matches, respecting token budget constraints.

---

## 35. Requirements Enhancement (Web Search & Clarification)

METIS can now enrich extracted requirements with external evidence and resolve ambiguities through a guided clarification dialog before creating tickets.

### 35.1 Enabling Enhancement Options

On the **Analysis** page for a project, you'll see an **Enhancement Options** section with two toggles:

- **Enable Web Research** — When checked, METIS searches the web for supporting evidence (standards, regulations, best practices) related to your requirements. Results include domain trust badges (🟢 High / 🟡 Medium / 🔴 Low) so you can quickly assess source quality.
- **Enable Clarification** — When checked, METIS identifies ambiguities in the extracted requirements and asks clarifying questions before generating tickets. You can answer up to 3 rounds of questions.

A **pipeline status indicator** shows progress through the enhancement steps: Extraction → Web Research → Clarification → Approval → Complete.

### 35.2 Web Research Evidence

When web research is enabled, METIS:

1. Identifies evidence needs in each requirement (e.g., "needs industry standard reference for auth timeout")
2. Generates targeted search queries
3. Fetches results and produces concise evidence digests
4. Scores source trustworthiness by domain (government, academic, and standards bodies rate highest)

The **Evidence Review** panel shows each digest with:
- Source URLs and excerpts
- A domain trust badge (High/Medium/Low)
- Approve or Reject buttons for human review

### 35.3 Clarification Dialog

When clarification is enabled, METIS:

1. Identifies ambiguities in each requirement (e.g., "priority not specified", "scope unclear")
2. Generates targeted clarifying questions
3. Presents a Q&A interface where you type answers
4. Incorporates your answers to refine the requirements

If more than 60% of ambiguities remain unresolved after a round, the system automatically escalates to a more powerful model (Claude Sonnet) for better question generation.

**Your progress is saved.** As of Epic #201, an in-flight clarification dialog is stored durably on the server: if you reload the page (or the server restarts) the dialog resumes exactly where you left off, showing how many ambiguities are already resolved versus still remaining. Your submitted answers are persisted with the analysis and feed directly into the generated requirements/specs — changing an answer changes the regenerated output.

**"Addressed" counts your answers, not METIS's opinion of them (#1117).** The progress badges used to count only the ambiguities the resolution model reported it had closed. That model is often stingy — one run answered 14 questions and had exactly one confirmed — so the panel read *"1 resolved / 13 remaining"* and asked all 14 questions again in the next round, which looks exactly like your work being thrown away. The badge now reads **N addressed** and counts every question you answered, whether or not the model agreed it had enough to close the ambiguity. A question you have answered is never re-asked, the dialog finishes when you have answered everything, and when the model confirmed fewer than you answered the panel says so on its own line instead of reporting the shortfall as your progress. Your answers are carried into the analysis either way. Submitting also no longer blanks the form while the page refreshes — the text stays visible throughout.

**Your answers reach the published issue (#1116).** Until this fix, answering questions improved only the requirement text shown on the Approvals panel: the saved requirements — and therefore the drafts and the GitHub issues published from them — still carried the wording METIS synthesized *before* it asked you anything. Answers submitted after a run are now written into the saved requirements themselves, verbatim, under a **Clarifications** heading that is published with the issue. A short note above the questions tells you exactly what happened: how many of your answers were written into the saved requirements, how many could not be matched to one (those refine only the on-screen text), and that METIS's own re-worded requirement summary is *not* copied into published issues — only your answers are. If the approval gate is still holding the requirements back, the note says so, and your answers are applied the moment the requirements are promoted.

### 35.4 Approval Checkpoints

Before tickets are created, METIS creates approval requests for:
- **Evidence items** — Approve or reject each evidence digest
- **Requirements** — Approve or reject each refined requirement

View approvals at **Analysis → Approvals** tab. Each item shows its status (Pending / Approved / Rejected) and supports adding reviewer notes. Tickets can only be created once all required approvals are resolved.

### 35.5 Web Search Configuration

To enable live web search (instead of the offline stub), set the `WEB_SEARCH_API_KEY` environment variable with your [Tavily](https://tavily.com/) API key. Without this key, the system uses a stub provider that returns no results but allows the pipeline to continue.

---

## 36. Repository Ingestion UX (Epic #663)

METIS automatically ingests your first connected repository so you can start analysis immediately without manual steps.

### 36.1 Auto-Ingest on First Repository

When you connect your first Git repository to a project, METIS automatically begins deep ingestion:
1. **Cloning** — A shallow clone of the repository is created.
2. **Code Graph** — Source files are parsed into symbols, edges, and rationale.
3. **RAG Ingestion** — File content is indexed into the knowledge base for retrieval.
4. **Metadata** — Repository metadata (languages, contributors, structure) is indexed.
5. **Connection Discovery** — Source code is scanned for database connection strings and references.

Subsequent repositories can be ingested manually or by checking "Auto-ingest" during creation.

### 36.2 Progress Indicator

While ingestion is running, a progress bar appears below the repository card on the **Connections** page showing:
- The current step name (e.g., "Building code graph")
- A progress fraction (e.g., 2/5)

The progress bar automatically disappears 2 seconds after completion. If ingestion fails, the progress bar is dismissed and an error is indicated.

### 36.3 Connection Discovery Toasts

If the ingestion pipeline discovers database connection references in your source code (e.g., PostgreSQL connection strings, MongoDB URIs), a toast notification appears:

> "2 database connections discovered in backend-api"
> *Review suggested connectors in the Connections tab.*

Click **View** to jump to the suggested connectors section and review/confirm the discovered databases.

### 36.4 Multi-Repository Analysis

When your project has multiple repository connectors, analysis runs against each repo sequentially with a split token budget. A minimum of 50,000 tokens is guaranteed per repository — if you have more repos than can be served at this minimum, only the first N repos (that fit within budget) are analyzed per run.

---

## 37. Auto-Configure Database Connections (Epic #701)

METIS can promote a discovered database reference into a real, vault-backed
connector through a four-step **Configure** wizard on the Connections page.
No credentials are ever persisted in Prisma columns; everything sensitive
flows through the vault.

### 37.1 When it triggers

After a repository ingestion completes, the connection-discovery pipeline
scans the code graph and, when allowed, a curated list of dev-environment
files for database references. The list is intentionally narrow — only
files matching the dev-file classifier (`.env.development`, `.env.local`,
`docker-compose.dev.yml`, etc.) are eligible for credential extraction.
Production files, secret-scanning false positives, and ambiguous matches
are skipped.

### 37.2 Admin opt-in: `allowCredentialScan`

Credential extraction is **off by default**. To enable it for a project,
open the **Connections** tab and tick **Allow credential scan during repo
discovery** in the page header. The toggle:

- Requires the `project.update` permission (admins/owners).
- Is audit-logged as `project.allowCredentialScan.update`.
- Takes effect on the *next* discovery run; existing rows are not
  retroactively re-scanned.

### 37.3 Wizard walkthrough

1. **Review** — Confirm the driver, host, port, database, source file/line,
   and confidence label. If credentials were detected in source, a green
   badge reads *"Dev credentials found in source — pre-loaded from the
   vault."*
2. **Configure** — Edit the label, driver, host, port, database, username
   and password. Click the eye icon to toggle password visibility. The
   password is fetched one-shot from the vault and is never written to the
   DOM as plaintext outside this dialog.
3. **Test** — Click **Run test** to perform a credential-explicit liveness
   probe. The pool is opened, pinged, and closed in a single request — no
   row is persisted unless the test passes. A failed test displays the
   server's error message and blocks advancing.
4. **Provision** — Click **Provision** to atomically (a) create or rotate
   the vault entry tagged
   `provisioned-cred:project:<id>:suggestion:<id>` and (b) create a real
   DB connector that references it as `${vault:<id>}`. If the connector
   write fails *and* the vault entry was just created, the vault entry is
   rolled back automatically.

### 37.4 What's audited

- `project.allowCredentialScan.update` — toggle flip
- `suggested_connector.credential_read` — wizard opened for a suggestion
- `suggested_connector.test` — test attempt (ok/fail)
- `suggested_connector.provisioned` / `.failed` — provisioning outcome

See [SECURITY.md §11](SECURITY.md#11-credential-discovery-epic-701) for the
threat-model entry.

---

*This guide was created for the METIS project. For detailed technical architecture documentation, see [ARCHITECTURE.md](ARCHITECTURE.md).*


## Test Coverage Gap Analysis (Phase 1 — Backend Only)

> **Phase 4 update:** The Test Coverage workbench is now available in-app
> at `Projects → <your project> → Test Coverage`. See the next section for the UI walkthrough.
> The backend API documented here remains unchanged and is the basis for the UI.

### What It Does

METIS can ingest your existing test suite — CSV, Excel, DOCX, Markdown, or Gherkin — and
compare it to your project's requirements to identify which requirements are tested, which
are not, and (in Phase 2) propose AI-generated test cases for the gaps.

### Importing Test Cases

Upload a file:

```bash
curl -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -F "label=smoke-suite-may-27" \
  -F "file=@tests/smoke.csv;type=text/csv" \
  https://metis.example.com/api/projects/$PROJECT_ID/test-coverage/imports
# → 201 { "data": { "importId": "...", "count": 42, "confidence": 0.98 } }
```

Or paste raw text (handy for Markdown or Gherkin):

```bash
curl -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"source":"gherkin","label":"login.feature","text":"Feature: Login\n  Scenario: ..."}' \
  https://metis.example.com/api/projects/$PROJECT_ID/test-coverage/imports/paste
```

When the importer can't confidently map a column header (e.g. `"Steps to Reproduce"`), the
API returns `422 COLUMN_MAPPING_REQUIRED` with a suggested mapping. Re-submit with
`columnOverrides`, e.g. `{"steps to reproduce":"steps"}`.

### Running Coverage Analysis

```bash
curl -X POST \
  -H "Authorization: Bearer $TOKEN" \
  https://metis.example.com/api/projects/$PROJECT_ID/test-coverage/runs
# → 202 { "data": { "runId": "..." } }
```

Poll the run for progress:

```bash
curl -H "Authorization: Bearer $TOKEN" \
  https://metis.example.com/api/projects/$PROJECT_ID/test-coverage/runs/$RUN_ID
# → { "data": { "status": "running", "phaseProgress": { "index": "done", ... } } }
```

Fetch the report once `status: "completed"`:

```bash
curl -H "Authorization: Bearer $TOKEN" \
  https://metis.example.com/api/projects/$PROJECT_ID/test-coverage/runs/$RUN_ID/report
# → { "data": { "totalRequirements": 120, "covered": 78, "coveragePct": 65, "gaps": [...] } }
```

### Reviewer Overrides

If the automated matcher (Phase 2) gets a mapping wrong, mark it `OVERRIDDEN` with a reason:

```bash
curl -X PATCH \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"status":"COVERED","reason":"manual review confirms"}' \
  https://metis.example.com/api/projects/$PROJECT_ID/test-coverage/mappings/$MAPPING_ID
```

Overridden mappings count toward `covered` in the report.

### Limits

- **File size:** 25 MB per upload (multer cap).
- **Paste body:** 2 MB of text per request.
- **Supported types:** `text/csv`, `text/markdown`, `application/json` (gherkin),
  `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` (xlsx),
  `application/vnd.openxmlformats-officedocument.wordprocessingml.document` (docx).

## Test Coverage Workbench (Phase 4 — Epic #856)

The Test Coverage page lives at `Projects → <your project> → Test Coverage`. It
replaces the script-only Phase 1 workflow with a guided UI: import → run →
review the matrix → accept suggestions → export.

### Mode A — You already have a test suite

1. **Import** — click *Upload file* (CSV, Excel, DOCX, Markdown, or `.feature`)
   or paste raw text via *Paste text*.
2. **Run** — click *Start new run*. The page subscribes to the WebSocket and
   updates the run table as the analysis progresses through index → match →
   judge → suggest → score.
3. **Review the matrix** — the requirement × test-case grid is virtualised
   so it stays smooth even past 500×500. Each cell is colour-coded:
   - **green** (fused score ≥ 0.80) — covered
   - **amber** (≥ 0.50) — partial / ambiguous
   - **red** (< 0.50) — uncovered
4. **Accept AI suggestions** — the *Suggested tests* card lists draft cases
   for any uncovered requirements. *Review* opens a drawer with the
   Given/When/Then breakdown. *Accept* / *Reject* commits your verdict.
5. **Export** — *Export…* downloads the run as an Excel workbook
   (`.xlsx`) or a Gherkin feature file. Suggestions flagged
   `low-confidence` (faithfulness < 0.6) are excluded by default. If you
   need to ship them anyway, tick *Override low-confidence guard* — the
   override is recorded in the audit log
   (`test-coverage.export.low-confidence-override`).

### Mode B — Empty project (suggestion-first)

If you skip the import step and start a run on a project that has only
requirements, the matcher will produce zero coverage and the AI will
generate suggestions for every requirement. Use the export dialog to
ship the suggestions to Gherkin or your test-management system via the
Phase 3 connectors (Jira, Xray, Zephyr Scale, TestRail).

### Budget guard

Every run is capped by `TESTCOVERAGE_BUDGET_CENTS` (default 20¢). The
budget tile turns amber at the warn threshold and red when the cap is
hit. The orchestrator aborts before exceeding the limit and surfaces a
`BUDGET_EXCEEDED` error in the run record.

Judge and suggestion calls are recorded under the provider and model that
served them. If that model has no price (see [Unpriced usage](#unpriced-usage)),
its spend is unknown, so the run cannot show it is under the cap: after the
call that reveals it, no further judge batches or LLM phases run, and the
budget line reads `$x + N unpriced tokens` rather than `$0.00`. Pricing the
model with `MODEL_PRICES` lets later runs proceed.

The budget is checked before every judge batch and before every suggestion
cluster, so a run stops part-way through either phase once the cap is reached.

Embedding usage is recorded under the embedder that ran — every call a run
makes: the indexing pass over your test cases and their steps, the requirement
and test-case batches the matcher needs, the judge's per-batch cache keys, and
the suggestion phase's cluster prompts and deduplication. On a cold run the
indexing pass is the largest of those. The built-in local embedders cost $0; Amazon
Titan Text Embeddings V2 and OpenAI's `text-embedding-3-small`,
`text-embedding-3-large` and `text-embedding-ada-002` are priced at their
published prices.

Any other cloud embedding model is **unpriced**, and its tokens are reported in
the `+ N unpriced tokens` figure — so the budget line reads as the lower bound
it is. Unlike an unpriced judge or suggestion model, an unpriced *embedder* does
not stop the run. Embedding spend is bounded, input-only and already incurred by
the time it is recorded, whereas LLM spend is the open-ended part the cap exists
to control. Because embedding is a run's first recorded usage, stopping there
would have ended every run on a Cohere model, an Azure deployment name or an
OpenAI-compatible endpoint before the judge had started. Price the model with a
`MODEL_PRICES` key of the form `embed:<backend>:<model>` — for example
`embed:bedrock-sdk:cohere.embed-english-v3` — to bring it back onto the cap.

**Priced embedding spend from the indexing pass counts against the run's cap.**
The indexing pass over your test cases and their steps runs *before* judging, and
its cost is charged to the same `TESTCOVERAGE_BUDGET_CENTS` budget as the judge
and suggestion phases — it is not a free preamble. On a large cold corpus and a
*priced* cloud embedder (Amazon Titan V2, OpenAI's `text-embedding-3-*`) that pass
alone can consume the cap, and the run then stops before the judge has looked at
anything, reporting `BUDGET_EXCEEDED` with a near-zero judged-requirement count.
Two things avoid it: raise `TESTCOVERAGE_BUDGET_CENTS` for the first (cold) run of
a large corpus, or use one of the built-in local embedders, which cost $0. Later
runs over the same corpus skip cases that are already indexed, so the indexing
share drops sharply after the first run.

### Permissions

- **`project.read`** — view the page, runs, report, and budget tiles.
- **`analysis.run`** — kick off a new run, import test cases.
- **`project.update`** — accept/reject suggestions, override mappings,
  download exports.

## 38. Formal Reviews & Approvals — Reviewer Walkthrough (Epic #609)

METIS supports formal sign-off on requirements and spec documents: a
requester bundles artifacts into a **review request**, assigns reviewers,
and each reviewer approves or rejects. When the review's policy is
satisfied (everyone approves, or a quorum is reached), the review is
approved and — if it contains requirements — a **baseline** (an immutable
set of requirement-version pins) is created automatically.

### Finding your reviews

Open **Reviews** in the sidebar (Work section). The queue has two tabs:

- **Assigned to me** — reviews where you are a reviewer. Each row shows a
  status badge (`Draft`, `In review`, `Approved`, `Rejected`, `Closed`),
  a due-date badge (red **Overdue** if the due date passed while the
  review is still open), the scope size, and decision progress
  (e.g. "1/2 decisions").
- **Requested by me** — reviews you created, so you can track progress.

Click a row to open the review.

### Reading a review

The detail page shows:

- **Header** — title, status, due date, decision policy ("All reviewers
  must approve" or "Quorum: N of M approvals required"), the requester,
  and — after approval — the baseline that was created.
- **Scope** — one card per artifact. Requirements are shown **at the
  version pinned when the review was submitted** (not the live version),
  together with a field-level diff of what that version changed —
  old values in red, new values in green. This reuses the requirement
  version history, so what you approve is exactly what was submitted,
  even if the requirement has been edited since. Spec documents show
  their title and pinned version.
- **Reviewers** — every assignment with its decision, note, and
  timestamp. Your own row is marked "(you)".

### Recording your decision

If you are an assigned reviewer, the review is **In review**, and you
have not decided yet, a **Your decision** panel appears with an optional
note field and **Approve** / **Reject** buttons. Your decision applies
immediately in the UI and the review's status updates in place when your
decision completes the round — no reload needed. If the request fails
(for example the review was withdrawn concurrently), the panel restores
and shows the error so you can retry.

Notes are visible to the requester and the other reviewers — use them to
explain a rejection or record conditions of an approval.

### Rules to know

- **You cannot review your own request** — the server refuses to assign
  the requester as a reviewer and blocks self-approval outright.
- **One decision per round.** If the requester withdraws and resubmits,
  all decisions reset and the scope is re-pinned to the artifacts'
  current versions — you review the fresh content.
- **Permissions**: viewing reviews requires `review.read` (all roles);
  deciding requires `review.decide` (developer and above). Requester
  actions (submit/withdraw/close) run over the API (#617); creating
  reviews from the UI arrives with a later sub-issue of epic #609.

### Requesting a review (the BA side)

As the business analyst who authored the requirements, you drive the
requester side of the workflow. Today the create/submit steps run over
the REST API (#617); the reviewer decision, baselines, and publish gate
are all in the UI.

1. **Request the review.** Bundle the requirements (and/or spec
   documents) you want signed off into a review request, assign one or
   more reviewers (not yourself — self-review is blocked), and choose a
   policy: **all** reviewers must approve, or a **quorum** of N. This
   creates the review in **Draft**.
2. **Submit it.** Submitting moves the review to **In review** and
   **pins** every item to its current version — that exact snapshot is
   what reviewers see and approve, even if you keep editing afterward.
   Each assigned reviewer receives a **Review requested** notification.
3. **Track decisions.** Watch progress under **Requested by me**. Every
   reviewer decision sends you a notification (open the bell in the top
   bar); when the policy is met you get a **Review approved** or
   **Review rejected** notification that deep-links back to the review.

### When a review is approved → the baseline

The moment a review of requirements is approved, METIS automatically
creates an **immutable baseline** — a named set of
`(requirement, version)` pins capturing exactly what was signed off. The
review header links straight to it. Baselines live under the project's
**Baselines** tab:

- The **list** shows every baseline with its pin count and the review
  (or manual creator) that produced it.
- Opening one shows each requirement **as of its pinned version**, with a
  drift note ("now at v3", "deleted since") when the live requirement has
  moved on — the baseline itself never changes.
- Pick **two** baselines in the compare picker to see what changed
  between sign-offs: requirements **added**, **removed**, **unchanged**,
  and **changed** — with a field-level diff (old in red, new in green)
  for each changed requirement.

Baselines are audit evidence, so there is deliberately no way to edit or
delete one.

### When a review is rejected → revise and resubmit

A rejection notifies you with the reviewer's note. Revise the
requirement to address the feedback, then open a **new review round** and
submit again — the scope re-pins to the freshly edited content and the
reviewers decide on the new version. Repeat until it is approved.

### Gating publishing on approval

A project admin (coordinator/admin) can require sign-off before anything
leaves METIS. On the **Publishing** page, the **Approval gate** card has
a **Require approved review to publish/export** toggle. With it on:

- Publishing an issue draft, or exporting a requirement/spec, is
  **blocked** unless an **approved, up-to-date** review pins that exact
  version. The block is an explanatory notice listing the offending items
  with a **Create or view reviews** link — approve the listed items (or
  re-approve them if the content changed after sign-off) and try again.
- A **stale** approval does not count: if you edit a requirement after it
  was approved, the pin no longer matches the current version and the
  gate blocks again until it is re-reviewed.
- **Dry-run** previews are always allowed — that is how you discover what
  still needs review before a real publish.

## 39. Linking Requirements Across Projects (Epic #610)

Big initiatives span more than one project. When a requirement in one
project *depends on*, *duplicates*, or is *derived from* a requirement in
another, you can record that relationship as a **cross-project link** —
provided both projects live in the **same workspace**.

### Adding a link

1. Open a project's **Analysis** page and find the requirement you want to
   link from. Under it, the **Linked requirements** panel shows any
   existing links; click **Add link**.
2. Pick the relationship **type** — *Relates to*, *Duplicates*, *Depends
   on*, or *Derived from*.
3. Start typing in **Search requirements**. The search covers every
   project in your workspace that you can access, so you can pull in a
   requirement from a *different* project. Click **Link** next to the match.

The new link appears immediately in the panel. Because it points at another
project, the row carries that project's **badge**, which is a shortcut into
the counterpart project.

### Seeing it from both sides

A link is bidirectional. Open the **linked** requirement's Analysis page and
its **Linked requirements** panel shows the reciprocal edge with a badge back
to the project you started from — with direction-aware wording (a *Depends
on* link reads as **required by** on the other side). Remove a link from
either end with **Unlink**.

### What is (and isn't) allowed

- Both requirements must sit in the **same workspace**. The search never
  offers a requirement outside your workspace, and an attempt to force one
  through is rejected — linking is a within-tenant relationship.
- A requirement can't link to **itself**, and a *Depends on* link that would
  create a **dependency cycle** is refused.
- You only ever see — and can only link to — requirements in projects you
  have access to. A link touching a project you can't see is never revealed.

### Workspace traceability rollup

To see the whole picture, open a workspace and go to its **Traceability**
tab. It shows:

- A **per-project coverage table**: how many requirements each project has,
  how many participate in cross-project links, and each project's spec and
  code coverage.
- A **cross-project link map** — a diagram of the workspace's requirement
  links, grouped by project — so you can spot how initiatives thread across
  project boundaries at a glance.

Everything on this page is scoped to the projects you can access, so the
rollup is a safe, shareable overview of your workspace's traceability posture.
