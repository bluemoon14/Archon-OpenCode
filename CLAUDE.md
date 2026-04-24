## Project Overview

**Archon — Remote Agentic Coding CLI**: Drive AI coding assistants (Claude Code SDK, OpenCode, Pydantic AI, and LiteLLM) from the command line. Built with **Bun + TypeScript + SQLite**. Single-developer tool, no server, no multi-tenancy.

Ships with the **obra/superpowers** skills + agents library vendored into bundled defaults — 14 skills (brainstorming, systematic-debugging, test-driven-development, writing-plans, writing-skills, etc.) plus the `code-reviewer` agent, available out of the box on every runtime. Per-skill / per-agent model selection via a central `models.yaml` manifest.

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
- **No autonomous lifecycle mutation across process boundaries**: If a process can't distinguish "running elsewhere" from "orphaned," do NOT auto-mark work as failed/cancelled. Surface the ambiguity with a user action.
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
- Engine schemas: `packages/workflows/src/schemas/` (one file per concern; `index.ts` re-exports).
- `TRIGGER_RULES` and `WORKFLOW_HOOK_EVENTS` derive from schema `.options` — never duplicate as plain arrays.
- `loader.ts` uses `dagNodeSchema.safeParse()` for node validation; graph-level checks (cycles, deps, `$nodeId.output` refs) stay imperative in `validateDagStructure()`.

## Essential Commands

```bash
# Dev
bun run dev                 # runs the CLI directly
bun run cli <command>       # same entry, convenient short form

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

- **Never run `bun test` from repo root** — discovers all files in one process, causing mock pollution failures. Use `bun run test`.
- Packages with conflicting `mock.module()` calls split into batched invocations (see each `package.json`): `@archon/core` (7), `@archon/workflows` (5), `@archon/isolation` (3).
- Don't add `afterAll(() => mock.restore())` for `mock.module()` — it's a no-op.
- Prefer `spyOn()` for internal modules other tests also import — `spy.mockRestore()` DOES work.
- When adding a new test file with `mock.module()`, ensure its `package.json` test script runs it in a separate `bun test` invocation from conflicting files.

### ESLint

Zero-tolerance: `--max-warnings 0`. Inline `// eslint-disable-next-line` is almost never acceptable — fix the issue. Only allowed when external SDK types are incorrect (document which SDK/why) or for intentional type assertions after validation (with explanatory comment). Never bulk-disable at file level.

## Database

SQLite at `~/.archon/archon.db`. Zero configuration. Tables prefixed `remote_agent_*`. Sessions are immutable — transitions create new linked sessions with explicit `TransitionTrigger` reasons and `parent_session_id` audit trail. Schema is created/migrated in code by the SQLite adapter on first run.

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
bun run cli version
```

## Architecture

### Packages (Bun workspaces)

Strict dependency layering (don't cross):

- **@archon/paths** — path utils, Pino logger, CWD env strip. Zero `@archon/*` deps.
- **@archon/git** — git ops, worktrees, branches, exec wrappers. Depends on `@archon/paths`.
- **@archon/providers** — AI provider registry + SDK deps. `@archon/providers/types` is the contract subpath (zero SDK deps) imported by `@archon/workflows`.
- **@archon/isolation** — worktree providers, resolver, `classifyIsolationError`. Deps: `@archon/git`, `@archon/paths`.
- **@archon/workflows** — loader, router, executor, DAG, logger, bundled defaults. DB/AI/config injected via `WorkflowDeps`.
- **@archon/core** — business logic, DB, orchestration. Depends on `@archon/providers`. Provides `createWorkflowStore()` bridging core DB → `IWorkflowStore`.
- **@archon/cli** — CLI entry point. Depends on `@archon/core`, `@archon/workflows`, `@archon/isolation`, `@archon/providers`.

### Import Patterns

```typescript
// ✅ Typed imports — never `import *` for main packages
import type { IPlatformAdapter } from '@archon/core';
import { handleMessage } from '@archon/core';
import * as conversationDb from '@archon/core/db/conversations';  // namespace OK for submodules
import type { WorkflowDeps } from '@archon/workflows/deps';
import { executeWorkflow } from '@archon/workflows/executor';
```

### Platform Adapter

The CLI implements a single `IPlatformAdapter` (`packages/cli/src/adapters/cli-adapter.ts`) that prints to stdout and persists messages to SQLite.

### AI Providers

Four built-ins, all implementing `IAgentProvider`. Providers receive raw `nodeConfig` + `assistantConfig` and translate to SDK-specific options internally. See `packages/providers/src/`.

| Provider | How it routes | Accepted model shapes |
|---|---|---|
| `claude` | Claude Code SDK direct | `sonnet`, `opus`, `haiku`, `claude-*`, `inherit` |
| `opencode` | Spawns `opencode serve` subprocess | `opencode/*`, any `<id>/<model>` not claimed by litellm |
| `pydantic` | JSONL stdio bridge to user Python agent | explicit `provider: pydantic` + `agent: <name>` (no model routing) |
| `litellm` | OpenAI-compatible HTTP proxy (spawned) | `anthropic/*`, `openai/*`, `azure/*`, `azure_ai/*`, `novita/*` |

Claude SDK wins `anthropic/*` by default (registered first in the provider registry). Users force LiteLLM routing with explicit `provider: litellm` on the node.

### Skills + Agents

Vendored superpowers library — 14 skills + 1 agent bundled into the binary at `packages/workflows/src/defaults/bundled-defaults.generated.ts` (source: `.archon/{skills,agents}/defaults/`). Users can override per-repo (`.archon/skills/<name>/SKILL.md`, `.archon/agents/<name>.md`) or globally (`~/.archon/...`) — 3-tier merge with project > global > bundled.

Per-skill / per-agent model selection via `models.yaml`:
- Bundled defaults: `.archon/models.defaults.yaml` (assigns haiku/sonnet/opus per skill + `fast`/`balanced`/`smart` aliases).
- User-editable: `~/.archon/models.yaml` (global) or `.archon/models.yaml` (project).
- 8-tier resolver (see `packages/workflows/src/model-resolution.ts`): override > project > global > bundled > frontmatter > category-default > owner-node > defaultAssistant.

CLI: `archon skills list|show <name>`, `archon agents list|show <name>`, `archon models list`.

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
# docs:
#   path: docs  # default: docs/
```

**Priority**: workflow YAML options > `.archon/config.yaml` > SDK defaults. Model validation at load time enforces provider/model compatibility.

### Sentry (error reporting)

Off by default. Enables stack-trace capture for uncaught exceptions, unhandled rejections, and `logger.fatal(...)` only — ordinary `logger.error(...)` is **not** forwarded. To turn it on, set a DSN in `~/.archon/config.yaml` or via env var:

```yaml
sentry:
  dsn: https://<key>@<org>.ingest.sentry.io/<project>
  environment: production   # optional, defaults to 'production'
```

Env-var precedence (highest first): `ARCHON_DISABLE_SENTRY=1` kill-switch > `ARCHON_SENTRY_DSN` > `SENTRY_DSN` > `sentry.dsn` in YAML. No DSN → Sentry is silently disabled and `@sentry/node` is never loaded.

## Archon Directories

```
~/.archon/
├── workspaces/<owner>/<repo>/
│   ├── source/      # cloned repo or symlink
│   ├── worktrees/
│   ├── artifacts/   # $ARTIFACTS_DIR ← NEVER in git
│   └── logs/
├── workflows/ commands/ scripts/   # home-scoped (global); 1-level subfolders only
├── archon.db            # SQLite database
└── config.yaml

<repo>/.archon/
├── commands/ workflows/ scripts/
├── state/       # cross-run; gitignored
└── config.yaml
```

Override base with `ARCHON_HOME` (default `~/.archon`).

Load priority: **bundled < global < project** (repo overrides global by filename).

## Workflows

YAML in `.archon/workflows/` (recursive). DAG format (`nodes:` with `depends_on`) — independent nodes in the same topological layer run concurrently.

**Node types**:
- `command:` — named command file
- `prompt:` — inline AI prompt
- `bash:` — shell script; stdout → `$nodeId.output`; no AI; gets project env vars
- `loop:` — iterative AI prompt until completion signal
- `approval:` — human gate; pauses until approve/reject; `capture_response: true` stores comment as `$<node-id>.output`
- `script:` — inline or named TS/Python from `.archon/scripts/`; runs via `bun` or `uv`; stdout → `$nodeId.output`; supports `deps:` + `timeout:`; requires `runtime: bun|uv`

**Per-node features**: `when:` conditions, `trigger_rule` join semantics, `$nodeId.output` substitution, `output_format` (Claude SDK-enforced), `allowed_tools`/`denied_tools`, `hooks`, `mcp` (env expanded at runtime), `skills` (via AgentDefinition), `agents` (inline sub-agents via Task tool), `effort`/`thinking`/`maxBudgetUsd`/`systemPrompt`/`fallbackModel`/`betas`/`sandbox`. (All Claude-only today; OpenCode + Pydantic AI planned.)

**Router**: `resolveWorkflowName()` (4-tier fallback: exact → case-insensitive → suffix `-name` → substring, with ambiguity detection). If no `/invoke-workflow` produced, falls back to `archon-assist`.

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

## Logging

Structured Pino logs via `createLogger(domain)` from `@archon/paths`.

**Event naming**: `{domain}.{action}_{state}` — e.g. `workflow.step_started`, `isolation.create_failed`. Always pair `_started` with `_completed` or `_failed`. Include IDs, durations, error details. No generic events like `processing`.

**Levels**: `fatal > error > warn > info (default) > debug > trace`.

**CLI verbosity**: `archon --quiet` (errors only), `archon --verbose` (debug + tool-level events). Override log level with `LOG_LEVEL=debug`.

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

## Containers

A minimal `Containerfile` (Podman-native, Docker-compatible) builds the CLI into a reproducible image:

```bash
podman build -f Containerfile -t archon .
podman run --rm archon workflow list
```

The container is optional — the binary runs fine on the host.
