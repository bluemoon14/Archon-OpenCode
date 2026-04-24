<p align="center">
  <img src="assets/logo.png" alt="Archon" width="160" />
</p>

<h1 align="center">Archon</h1>

<p align="center">
  A CLI that turns AI coding into deterministic, repeatable workflows.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License: MIT" /></a>
  <a href="https://github.com/coleam00/Archon/actions/workflows/test.yml"><img src="https://github.com/coleam00/Archon/actions/workflows/test.yml/badge.svg" alt="CI" /></a>
</p>

---

Archon is a workflow engine for AI coding agents. Define your development processes as YAML workflows — planning, implementation, validation, code review, PR creation — and run them reliably across all your projects from the command line.

## Why Archon?

When you ask an AI agent to "fix this bug," what happens depends on the model's mood. It might skip planning. It might forget to run tests. It might write a PR description that ignores your template. Every run is different.

Archon fixes this. Encode your development process as a workflow. The workflow defines the phases, validation gates, and artifacts. The AI fills in the intelligence at each step, but the structure is deterministic and owned by you.

- **Repeatable** — same workflow, same sequence, every time. Plan, implement, validate, review, PR.
- **Isolated** — every workflow run gets its own git worktree. Run parallel fixes with no conflicts.
- **Fire and forget** — kick off a workflow, come back to a finished PR.
- **Composable** — mix deterministic nodes (bash scripts, tests, git ops) with AI nodes (planning, code generation, review). The AI only runs where it adds value.
- **Portable** — define workflows once in `.archon/workflows/`, commit them to your repo.

## What It Looks Like

An Archon workflow that plans, implements in a loop until tests pass, gets your approval, then creates the PR:

```yaml
# .archon/workflows/build-feature.yaml
nodes:
  - id: plan
    prompt: "Explore the codebase and create an implementation plan"

  - id: implement
    depends_on: [plan]
    loop:                                      # AI loop — iterate until done
      prompt: "Read the plan. Implement the next task. Run validation."
      until: ALL_TASKS_COMPLETE
      fresh_context: true

  - id: run-tests
    depends_on: [implement]
    bash: "bun run validate"                   # Deterministic — no AI

  - id: review
    depends_on: [run-tests]
    prompt: "Review all changes against the plan. Fix any issues."

  - id: approve
    depends_on: [review]
    loop:
      prompt: "Present the changes for review. Address any feedback."
      until: APPROVED
      interactive: true

  - id: create-pr
    depends_on: [approve]
    prompt: "Push changes and create a pull request"
```

Invoke a workflow from the command line:

```
$ archon workflow run archon-idea-to-pr "Add dark mode to the settings page"
→ Creating isolated worktree on branch archon/task-dark-mode...
→ Planning...
→ Implementing (task 1/4)...
→ Tests failing — iterating...
→ Tests passing after 2 iterations
→ Code review complete — 0 issues
→ PR ready: https://github.com/you/project/pull/47
```

## Getting Started

### Prerequisites

- **Bun** — [bun.sh](https://bun.sh)
- At least one supported AI runtime — **Claude Code** ([claude.ai/code](https://claude.ai/code)) is the default; **OpenCode** and **custom Pydantic AI agents** are also supported (see [Supported agent runtimes](#supported-agent-runtimes)).
- **GitHub CLI** (optional, used by workflows that create issues/PRs) — [cli.github.com](https://cli.github.com/)

### Install

**Quick install (binary)**

```bash
# macOS / Linux
curl -fsSL https://archon.diy/install | bash

# Windows (PowerShell)
irm https://archon.diy/install.ps1 | iex

# Homebrew (macOS / Linux)
brew install coleam00/archon/archon
```

**From source**

```bash
git clone https://github.com/coleam00/Archon
cd Archon
bun install
bun run cli --help
```

> Compiled binaries need a `CLAUDE_BIN_PATH` pointing at your Claude Code install
> (the binary does not bundle Claude Code). Set it to `$HOME/.local/bin/claude`
> after running Anthropic's installer, or set `assistants.claude.claudeBinaryPath`
> in `~/.archon/config.yaml`.

### Use It

From any git repository:

```bash
archon workflow list                  # see available workflows
archon workflow run <name> "<task>"   # run one
archon workflow status                # show active/recent runs
```

## Supported agent runtimes

Archon drives three AI runtimes, selectable per workflow node:

- **Claude Code** (default) — uses the [`@anthropic-ai/claude-agent-sdk`](https://docs.claude.com/claude-code). No extra config when `claude` is on PATH.
- **OpenCode** — Archon spawns `opencode serve` per session and talks to it via [`@opencode-ai/sdk`](https://opencode.ai/docs/sdk/). Install `opencode`, then write `provider: opencode` on a node. See [`packages/providers/src/opencode/README.md`](./packages/providers/src/opencode/README.md).
- **Pydantic AI (BYO)** — you write a Python file exporting a `pydantic_ai.Agent`; Archon invokes it over a JSONL stdio bridge spawned with `uv`. See [`packages/providers/src/pydantic/README.md`](./packages/providers/src/pydantic/README.md).

## Default Workflows

Archon ships with ready-to-run workflows for common development tasks.

| Workflow | What it does |
|----------|-------------|
| `archon-assist` | General Q&A, debugging, exploration — full Claude Code agent with all tools |
| `archon-idea-to-pr` | Feature idea → plan → implement → validate → PR → parallel reviews → self-fix |
| `archon-plan-to-pr` | Execute existing plan → implement → validate → PR → review → self-fix |
| `archon-smart-pr-review` | Classify PR complexity → run targeted review agents → synthesize findings |
| `archon-comprehensive-pr-review` | Multi-agent PR review (5 parallel reviewers) with automatic fixes |
| `archon-validate-pr` | Thorough PR validation testing both main and feature branches |
| `archon-resolve-conflicts` | Detect merge conflicts → analyze both sides → resolve → validate → commit |
| `archon-feature-development` | Implement feature from plan → validate → create PR |
| `archon-architect` | Architectural sweep, complexity reduction, codebase health improvement |
| `archon-refactor-safely` | Safe refactoring with type-check hooks and behavior verification |
| `archon-ralph-dag` | PRD implementation loop — iterate through stories until done |
| `archon-piv-loop` | Guided Plan-Implement-Validate loop with human review between iterations |

Run `archon workflow list` to see the full set on your install.

**Or define your own.** Defaults live in `.archon/workflows/defaults/` — copy one and customize. Workflows are YAML in `.archon/workflows/`, commands are markdown in `.archon/commands/`. Same-named files in your repo override the bundled defaults.

## Architecture

```
┌──────────────────────────────────────────────────┐
│                       CLI                        │
└──────────────────────┬───────────────────────────┘
                       ▼
┌──────────────────────────────────────────────────┐
│                 Orchestrator                     │
│      (Message Routing & Context Management)      │
└──────────┬──────────────────────┬────────────────┘
           │                      │
           ▼                      ▼
   ┌──────────────┐       ┌───────────────────┐
   │   Workflow   │       │ AI Assistant SDKs │
   │   Executor   │       │     (Claude)      │
   │    (YAML)    │       │                   │
   └──────┬───────┘       └─────────┬─────────┘
          └──────────────────────────┘
                       │
                       ▼
         ┌──────────────────────────┐
         │  SQLite (~/.archon/...)  │
         └──────────────────────────┘
```

## Containers

A minimal `Containerfile` (Podman-native, Docker-compatible) is included for users
who want to run the CLI from a container:

```bash
podman build -f Containerfile -t archon .
podman run --rm archon workflow list
```

## Contributing

Contributions welcome. See open [issues](https://github.com/coleam00/Archon/issues) for things to work on, and read [CONTRIBUTING.md](CONTRIBUTING.md) before submitting a pull request.

## License

[MIT](LICENSE)
