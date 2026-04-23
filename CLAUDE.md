## Project Overview

**Archon — Remote Agentic Coding Platform**: Control AI coding assistants (Claude Code SDK, Codex SDK, Pi community) remotely via Web UI, CLI, and GitHub. Built with **Bun + TypeScript + SQLite/PostgreSQL**. Single-developer tool, no multi-tenancy.

## Engineering Principles

Behavioral guidelines to reduce common LLM coding mistakes. Bias toward caution over speed. For trivial tasks, use judgment.

### 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

- State assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them — don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

### 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If 200 lines could be 50, rewrite it.
- No config keys, interface methods, feature flags, or workflow branches without a concrete use case.
- Extract shared utilities only after the pattern appears 3+ times and stabilizes.

Test: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

### 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor what isn't broken.
- Match existing style, even if you'd do it differently.
- Notice unrelated dead code? Mention it — don't delete it.
- Remove orphans YOUR changes created; leave pre-existing dead code alone.

Test: Every changed line should trace directly to the user's request.

### 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals: "Fix the bug" → "Write a test that reproduces it, then make it pass." For multi-step work, state a brief plan with per-step verify checks.

### Archon-Specific Constraints

- **SRP + ISP**: Extend via narrow existing interfaces (`IPlatformAdapter`, `IAgentProvider`, `IDatabase`, `IWorkflowStore`). Don't add unrelated methods — define a new interface.
- **Fail fast in agent runtimes**: Never silently swallow errors or broaden permissions. Throw early with clear errors. Document intentional fallbacks.
- **No autonomous lifecycle mutation across process boundaries**: If a process can't distinguish "running elsewhere" from "orphaned," do NOT auto-mark work as failed/cancelled. Surface the ambiguity with a user action. Reference: #1216, `packages/cli/src/cli.ts:256-258`.
- **Determinism**: `bun run validate` must map 1:1 to CI.
- **Reversibility**: Small blast radius. Define the rollback path for risky changes.

## Git Workflow

- `main` is the release branch — never commit directly.
- `dev` is the working branch — all features branch off `dev` and merge back.
- Release via `/release` skill (patch by default; `minor`/`major`). It diffs `dev` vs `main`, updates `CHANGELOG.md` (Keep a Changelog format), bumps the single `version` in root `package.json`, and opens a PR to `main`.
- Use `@archon/git` functions for git ops; `execFileAsync` (not `exec`) when calling git directly.
- **NEVER run `git clean -fd`** — it permanently deletes untracked files. Use `git checkout .` instead.
- Worktrees enable parallel development per conversation; workspaces auto-sync with origin before worktree creation.

## Type Safety + Zod Schema Conventions

- Strict TS. No `any` without explicit justification. Interfaces for all major abstractions.
- Schema naming: camelCase with descriptive suffix (`workflowRunSchema`, `errorSchema`).
- Always derive types via `z.infer<typeof schema>` — never hand-write parallel interfaces.
- Import `z` from `@hono/zod-openapi` (not `zod` directly).
- All new/modified API routes use `registerOpenApiRoute(createRoute({...}), handler)` — handles the TypedResponse bypass.
- Route schemas: `packages/server/src/routes/schemas/` (one file per domain).
- Engine schemas: `packages/workflows/src/schemas/` (one file per concern; `index.ts` re-exports).
- `TRIGGER_RULES` and `WORKFLOW_HOOK_EVENTS` derive from schema `.options` — never duplicate as plain arrays (exception: `@archon/web` needs a local const since `api.generated.d.ts` is type-only).
- `loader.ts` uses `dagNodeSchema.safeParse()` for node validation; graph-level checks (cycles, deps, `$nodeId.output` refs) stay imperative in `validateDagStructure()`.

## Essential Commands

```bash
# Dev — starts server (3090) + Web UI (5173)
bun run dev
bun run dev:server  # backend only
bun run dev:web     # frontend only

# Regenerate frontend API types (server must be running at :3090)
bun --filter @archon/web generate:types

# Tests — always use `bun run test`, never `bun test` from repo root
bun run test                # per-package isolated processes
bun test packages/core/src/handlers/command-handler.test.ts  # single file

# Type check / lint / format
bun run type-check
bun run lint           # CI enforces --max-warnings 0
bun run format:check

# Pre-PR — MUST pass (runs check:bundled, type-check, lint, format, tests)
bun run validate

# After editing any file under packages/workflows/src/defaults/, regenerate embedded bundle
bun run generate:bundled
```

### Test Isolation (CRITICAL)

Bun's `mock.module()` is **process-global and irreversible** — `mock.restore()` does NOT undo it ([oven-sh/bun#7823](https://github.com/oven-sh/bun/issues/7823)).

- **Never run `bun test` from repo root** — discovers all files in one process, causing ~135 mock pollution failures. Use `bun run test`.
- Packages with conflicting `mock.module()` calls split into batched invocations (see each `package.json`): `@archon/core` (7), `@archon/workflows` (5), `@archon/adapters` (3), `@archon/isolation` (3).
- Don't add `afterAll(() => mock.restore())` for `mock.module()` — it's a no-op.
- Prefer `spyOn()` for internal modules other tests also import — `spy.mockRestore()` DOES work.
- When adding a new test file with `mock.module()`, ensure its `package.json` test script runs it in a separate `bun test` invocation from conflicting files.

### ESLint

Zero-tolerance: `--max-warnings 0`. Inline `// eslint-disable-next-line` is almost never acceptable — fix the issue. Only allowed when external SDK types are incorrect (document which SDK/why) or for intentional type assertions after validation (with explanatory comment). Never bulk-disable at file level.

## Database

**Auto-detection**: SQLite at `~/.archon/archon.db` by default (zero setup). Set `DATABASE_URL` to use PostgreSQL instead:

```bash
docker-compose --profile with-db up -d postgres
# PostgreSQL migrations are manual: psql $DATABASE_URL < migrations/000_combined.sql
```

Tables are prefixed `remote_agent_*`. Sessions are immutable — transitions create new linked sessions with explicit `TransitionTrigger` reasons and `parent_session_id` audit trail.

## CLI

Workflow and isolation commands require running from within a git repository.

```bash
bun run cli workflow list [--json]
bun run cli workflow run <name> [--cwd <path>] [--branch <name>] [--no-worktree] [message]
bun run cli workflow status
bun run cli workflow resume <run-id>      # re-runs, skipping completed nodes
bun run cli workflow abandon <run-id>
bun run cli workflow cleanup [days]        # default 7
bun run cli workflow event emit --run-id <uuid> --type <type> [--data <json>]

bun run cli isolation list
bun run cli isolation cleanup [days]
bun run cli isolation cleanup --merged [--include-closed]

bun run cli validate workflows [name] [--json]
bun run cli validate commands [name]

bun run cli complete <branch> [--force]    # remove worktree + local + remote branches
bun run cli serve [--port N] [--download-only]  # web UI server (binary only)
bun run cli version
```

## Architecture

### Packages (Bun workspaces)

Package dependency layering (strict — don't cross):

- **@archon/paths** — path utils, Pino logger, CWD env strip. Zero `@archon/*` deps.
- **@archon/git** — git ops, worktrees, branches, exec wrappers. Depends on `@archon/paths`.
- **@archon/providers** — AI provider registry + SDK deps. `@archon/providers/types` is the contract subpath (zero SDK deps) imported by `@archon/workflows`. Core providers: `claude/`, `codex/`. Community: `community/pi/` (`builtIn: false`).
- **@archon/isolation** — worktree providers, resolver, `classifyIsolationError`. Deps: `@archon/git`, `@archon/paths`.
- **@archon/workflows** — loader, router, executor, DAG, logger, bundled defaults. Deps: `@archon/git`, `@archon/paths`, `@archon/providers/types`, `@hono/zod-openapi`, `zod`. DB/AI/config injected via `WorkflowDeps`.
- **@archon/core** — business logic, DB, orchestration. Depends on `@archon/providers`. Provides `createWorkflowStore()` bridging core DB → `IWorkflowStore`.
- **@archon/adapters** — platform adapters (currently GitHub). Depends on `@archon/core`.
- **@archon/cli** — CLI entry. Depends on `@archon/server` + `@archon/adapters` for `serve`.
- **@archon/server** — OpenAPIHono HTTP server (`@hono/zod-openapi`), Web SSE adapter, API routes, static serving.
- **@archon/web** — React + Vite + Tailwind v4 + shadcn/ui + Zustand. SSE to server. Types derived from `src/lib/api.generated.d.ts` (generated via `bun generate:types`) — **never import from `@archon/workflows`**.

### Import Patterns

```typescript
// ✅ Typed imports — never `import *` for main packages
import type { IPlatformAdapter } from '@archon/core';
import { handleMessage } from '@archon/core';
import * as conversationDb from '@archon/core/db/conversations';  // namespace OK for submodules
import type { WorkflowDeps } from '@archon/workflows/deps';
import { executeWorkflow } from '@archon/workflows/executor';

// ❌ In @archon/web, never import from @archon/workflows — use `@/lib/api` re-exports
import type { DagNode, WorkflowDefinition } from '@/lib/api';
```

### Platform Adapters

Implement `IPlatformAdapter`. Auth checks live **inside** adapters (co-located `auth.ts`), parse whitelist from env vars in constructor, silently reject unauthorized users, log masked user IDs. Adapters expose `onMessage(handler)`; errors handled by caller.

Conversation IDs are platform-specific: Web = user string, GitHub = `owner/repo#number`.

### AI Providers

Implement `IAgentProvider`. Providers receive raw `nodeConfig` + `assistantConfig` and translate to SDK-specific options internally. See `packages/providers/src/`.

### Slash Commands

Only these are deterministic (handled without AI): `/help`, `/status`, `/reset`, `/workflow`, `/register-project`, `/update-project`, `/remove-project`, `/commands`, `/init`, `/worktree`. `/workflow` subcommands: `list`, `run`, `status`, `cancel`, `resume`, `abandon`, `approve`, `reject`.

## Configuration

`.archon/config.yaml` (repo-level) and `~/.archon/config.yaml` (home-level):

```yaml
assistants:
  claude:
    model: sonnet  # or opus, haiku, claude-*, inherit
    settingSources: [project]   # optional: add 'user' to also load ~/.claude/CLAUDE.md
    claudeBinaryPath: /abs/path # optional — required in compiled binaries if CLAUDE_BIN_PATH unset
  codex:
    model: gpt-5.3-codex
    modelReasoningEffort: medium  # minimal | low | medium | high | xhigh
    webSearchMode: live           # disabled | cached | live
    additionalDirectories: [/abs/path/to/other/repo]
    codexBinaryPath: /usr/local/bin/codex  # optional
# docs:
#   path: docs  # default: docs/
```

**Priority**: workflow YAML options > `.archon/config.yaml` > SDK defaults. Model validation at load time enforces provider/model compatibility.

## Archon Directories

```
~/.archon/
├── workspaces/<owner>/<repo>/
│   ├── source/      # cloned repo or symlink
│   ├── worktrees/
│   ├── artifacts/   # $ARTIFACTS_DIR ← NEVER in git
│   └── logs/
├── workflows/ commands/ scripts/   # home-scoped (global); 1-level subfolders only
├── vendor/codex/        # binary builds
├── web-dist/<version>/  # archon serve (binary only)
├── archon.db            # SQLite default
└── config.yaml

<repo>/.archon/
├── commands/ workflows/ scripts/
├── state/       # cross-run; gitignored
└── config.yaml
```

Override base with `ARCHON_HOME` (default `~/.archon`). Docker: `/.archon/`.

Load priority: **bundled < global < project** (repo overrides global by filename). Pre-0.x migration: if `~/.archon/.archon/workflows/` exists, a one-time WARN is emitted with the exact `mv` command.

## Workflows

YAML in `.archon/workflows/` (recursive). DAG format (`nodes:` with `depends_on`) — independent nodes in the same topological layer run concurrently.

**Node types**:
- `command:` — named command file
- `prompt:` — inline AI prompt
- `bash:` — shell script; stdout → `$nodeId.output`; no AI; gets project env vars
- `loop:` — iterative AI prompt until completion signal
- `approval:` — human gate; pauses until approve/reject; `capture_response: true` stores comment as `$<node-id>.output`
- `script:` — inline or named TS/Python from `.archon/scripts/`; runs via `bun` or `uv`; stdout → `$nodeId.output`; supports `deps:` + `timeout:`; requires `runtime: bun|uv`

**Per-node features**: `when:` conditions, `trigger_rule` join semantics, `$nodeId.output` substitution, `output_format` (Claude/Codex SDK-enforced; Pi best-effort), `allowed_tools`/`denied_tools` (Claude), `hooks` (Claude), `mcp` (Claude; env expanded at runtime), `skills` (Claude via AgentDefinition), `agents` (Claude inline sub-agents via Task tool), `effort`/`thinking`/`maxBudgetUsd`/`systemPrompt`/`fallbackModel`/`betas`/`sandbox` (Claude).

**Workflow-level**: `interactive: true` forces foreground execution on web (required for approval gates in Web UI).

**Router**: `resolveWorkflowName()` (4-tier fallback: exact → case-insensitive → suffix `-name` → substring, with ambiguity detection). If no `/invoke-workflow` produced, falls back to `archon-assist`. Claude routing uses `tools: []`; Codex tool bypass detected and triggers fallback.

**Defaults**: bundled in `packages/workflows/src/defaults/bundled-defaults.generated.ts`. After editing any default file under that directory, run `bun run generate:bundled`. `check:bundled` in `bun run validate` (and CI) fails loud if stale.

Opt-out: `defaults.loadDefaultCommands: false` / `defaults.loadDefaultWorkflows: false` in `.archon/config.yaml`.

## Variable Substitution

- `$1`, `$2`, `$3` — positional arguments
- `$ARGUMENTS` — all args as a single string
- `$ARTIFACTS_DIR` — external artifacts dir for this run (pre-created by executor)
- `$WORKFLOW_ID` — the run ID
- `$BASE_BRANCH` — auto-detected when `worktree.baseBranch` unset; only throws if referenced and auto-detection also fails
- `$DOCS_DIR` — from `docs.path` in `.archon/config.yaml`; defaults to `docs/`; never throws
- `$LOOP_USER_INPUT` — feedback from `/workflow approve <id> <text>`; populated only on the first iteration of a resumed interactive loop
- `$REJECTION_REASON` — from `/workflow reject <id> <reason>`; populated only in `on_reject` prompts

## Port Allocation in Worktrees

- Main repo: `3090`. Worktrees: deterministic unique port in `3190-4089` (hash-based). Override via `PORT=4000 bun dev`.
- Same worktree always gets the same port.
- Database is shared across worktrees (same conversations/codebases).
- Use the web API (`curl http://localhost:<port>/api/...`) or the CLI for manual validation — avoid running multiple platform adapters at once.
- Kill when done: `pkill -f "bun.*dev"`.

## Logging

Structured Pino logs via `createLogger(domain)` from `@archon/paths`.

**Event naming**: `{domain}.{action}_{state}` — e.g. `workflow.step_started`, `isolation.create_failed`. Always pair `_started` with `_completed` or `_failed`. Include IDs, durations, error details. No generic events like `processing`.

**Levels**: `fatal > error > warn > info (default) > debug > trace`.

**CLI verbosity**: `archon --quiet` (errors only), `archon --verbose` (debug + tool-level events). Server: `LOG_LEVEL=debug`.

**Never log**: API keys/tokens (mask with `token.slice(0, 8) + '...'`), user message content, PII.

## Error Handling

Use `classifyIsolationError()` (from `@archon/isolation`) to map git errors (permission, timeout, no space, not a git repo) to user-friendly messages. Always log the raw error AND send a classified message to the user.

For DB UPDATEs, rely on `updateConversation`-style helpers that throw on zero rowCount — catch and re-throw after logging.

## SDK Types

Import and use SDK types directly — never duplicate them:

```typescript
import { query, type Options } from '@anthropic-ai/claude-agent-sdk';
const options: Options = { cwd, permissionMode: 'bypassPermissions' };
```

Use type assertions for SDK response structures (`msg as { message: { content: ContentBlock[] } }`) rather than `as any`.

## Webhooks + Security

- `POST /webhooks/github` — verify `X-Hub-Signature-256` (HMAC SHA-256), use `c.req.text()` for raw body, return 200 immediately + process async.
- Parse `@archon` in issue/PR **comments only** (event `issue_comment`), not descriptions (see #96).
- Never log or expose tokens in responses.
