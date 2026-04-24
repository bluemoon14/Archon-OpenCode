# Archon cheatsheet — Claude, OpenCode, Pydantic

The 5-minute "what do I actually type" reference. For deeper coverage see
`docs/skills-and-agents.md`, `docs/litellm.md`, and `docs/mcp.md`.

---

## 0. One-time setup (pick the runtimes you use)

```bash
# Clone + link the archon CLI
git clone https://github.com/bluemoon14/Archon-OpenCode
cd Archon-OpenCode
make install             # bun deps + link `archon` globally

# Add runtimes (any subset)
make claude              # installs or updates the claude binary
make opencode            # installs or updates opencode
make pydantic            # installs or updates uv (for BYO Python agents)

# Interactive configurator — walks you through each runtime you have
archon setup
```

`archon setup` writes `~/.archon/.env` + prints YAML snippets to paste into
`.archon/config.yaml`. **No secrets ever go into YAML** — only env-var
names. Keep keys in `~/.archon/.env` or your shell.

---

## 1. The cheatsheet — daily commands

### Discovery

| Task | Command |
|---|---|
| List every skill (bundled + your overrides) | `archon skills list` |
| Read a skill's full body + resolved model | `archon skills show systematic-debugging` |
| List every agent | `archon agents list` |
| Read an agent's full body | `archon agents show code-reviewer` |
| See the full skill/agent → model assignment table | `archon models list` |
| Sanity-check models.yaml schema + routing | `archon models validate` |

### Per-skill / per-agent model tuning

```bash
# Project-scope override (writes .archon/models.yaml — commit it)
archon models set skill systematic-debugging openai/gpt-4o
archon models set agent code-reviewer anthropic/claude-opus-4-5
archon models set default skill anthropic/claude-haiku-4-5
archon models set alias cheap novita/deepseek/deepseek-r1-turbo

# User-scope override (writes ~/.archon/models.yaml — personal)
archon models set skill brainstorming openai/gpt-4o-mini --global

# Remove an override (falls back to the next tier down)
archon models reset skill systematic-debugging

# See where each model came from (which tier won)
archon models list
```

**Precedence order** (highest wins):
1. Explicit node-level override in a workflow
2. `.archon/models.yaml` (project)
3. `~/.archon/models.yaml` (global)
4. Bundled `models.yaml` (shipped in the binary)
5. Frontmatter `model:` in the SKILL.md / agent file
6. Category default (`defaults.skill`, `defaults.agent`)
7. Owning node's model (when value is literal `inherit`)
8. Caller's default assistant model

### Workflows

```bash
archon workflow list                    # list every workflow
archon workflow run feature "add dark mode"
archon workflow run feature "..." --branch feature-dark-mode
archon workflow run feature "..." --no-worktree
archon workflow status                  # what's in flight
archon workflow resume <run-id>         # restart paused/failed
archon workflow abandon <run-id>
```

### MCP server (for hosts like Claude Code / OpenCode)

```bash
archon mcp serve                        # stdio MCP server, listens on stdin/stdout
                                         # diagnostics on stderr
```

---

## 2. Claude Code integration

### 2a. Use Archon from inside a Claude Code session (MCP)

Register the MCP server once per project (or globally):

```bash
# Per project (from inside the repo)
claude mcp add archon -- archon mcp serve

# OR globally
claude mcp add archon --scope user -- archon mcp serve

# Verify it's registered
claude mcp list
# expected:  archon: archon mcp serve - ✓ Connected
```

**Restart Claude Code.** MCP servers are loaded at session start — an
already-running session won't see them.

Inside the session, 10 tools become available:

| Tool | What it does |
|---|---|
| `archon_skills_list` | Every skill + resolved model + source |
| `archon_skills_show` | Full SKILL.md body for one skill |
| `archon_agents_list` | Every agent + resolved model |
| `archon_agents_show` | Full agent body |
| `archon_models_list` | Defaults + aliases + full assignment table |
| `archon_workflow_run` | Run a workflow to completion (BLOCKING) |
| `archon_workflow_status` | Poll running / paused workflows |
| `archon_workflow_resume` | Resume a paused run |
| `archon_skill_invoke` | One-shot: run a skill on a prompt, optional `model` override |
| `archon_agent_invoke` | One-shot: run an agent on a prompt, optional `model` override |

### 2b. Use Claude as the runtime for Archon workflows

Claude is the default runtime; no extra setup. Model names on workflow
nodes:

```yaml
# Bare shorthand → routes through Claude SDK directly (preferred when the
# `claude` binary is installed).
model: sonnet
model: opus
model: haiku
model: claude-sonnet-4-5

# Canonical anthropic/* → ALSO routes through Claude SDK by default.
# Override with `provider: litellm` to force LiteLLM routing.
model: anthropic/claude-opus-4-5
```

### 2c. Claude Code settings tweaks to consider

- **`settingSources` in `.archon/config.yaml`**: controls which CLAUDE.md
  files the Claude SDK loads when running a workflow node.
  ```yaml
  assistants:
    claude:
      model: sonnet
      settingSources: [project]          # default — only the repo's CLAUDE.md
      # settingSources: [project, user]  # also loads ~/.claude/CLAUDE.md
  ```
  Add `user` when you want your personal Claude Code instructions to apply
  to Archon workflows too.

- **`claudeBinaryPath`**: only needed if `claude` isn't on `PATH` (or when
  running as a compiled Archon binary — `CLAUDE_BIN_PATH` env var is the
  other way).

- **Keep CLAUDE.md short** where Archon workflows hit it. Superpowers
  skills + Archon's resolved-content injection do most of the heavy
  lifting — bloated CLAUDE.md competes with the skill body for context.

---

## 3. OpenCode integration

### 3a. Use Archon with OpenCode as the runtime

```bash
# archon setup will detect opencode and offer a LiteLLM fast-path
archon setup
# → "Route OpenCode through your LiteLLM proxy? (recommended)"
#    yes: one master key, all upstreams through the proxy
#    no:  per-upstream env vars (classic OpenCode flow)
```

Then on workflow nodes, use OpenCode-flavored models:

```yaml
provider: opencode
model: opencode/gpt-4o-mini          # through OpenCode's provider plugins
model: opencode/anthropic/claude-sonnet-4-5
```

Or with the LiteLLM fast-path, keep canonical model names:

```yaml
# OpenCode's baseUrl points at LiteLLM; any model the proxy knows works.
provider: opencode
model: openai/gpt-4o                 # LiteLLM routes, OpenCode sees openai-compatible responses
```

### 3b. Use Archon from inside an OpenCode session (MCP)

OpenCode supports MCP servers via its config. Add to `opencode.json`:

```json
{
  "mcp": {
    "archon": {
      "type": "local",
      "command": ["archon", "mcp", "serve"]
    }
  }
}
```

Restart OpenCode. The same 10 `archon_*` tools become available inside
OpenCode's chat UI.

### 3c. OpenCode settings tweaks to consider

- **`baseUrl`** (in `.archon/config.yaml` under `assistants.opencode`):
  points OpenCode at a specific OpenCode server. Default is the spawned
  subprocess. Set when you're running a long-lived OpenCode instance
  elsewhere and want Archon to reuse it instead of spawning its own.
  ```yaml
  assistants:
    opencode:
      baseUrl: http://localhost:1234
      # when baseUrl is set, Archon skips the subprocess spawn entirely
  ```

- **`providers.<id>.authTokenEnv`**: maps OpenCode provider IDs to env-var
  NAMES (secrets stay in shell, not YAML).
  ```yaml
  assistants:
    opencode:
      providers:
        litellm:
          authTokenEnv: LITELLM_MASTER_KEY   # fast-path: one key, all upstreams
        # or, without LiteLLM:
        # openai:
        #   authTokenEnv: OPENAI_API_KEY
        # anthropic:
        #   authTokenEnv: ANTHROPIC_API_KEY
  ```

- **Tool allow-list pass-through**: OpenCode honors `allowed_tools` /
  `denied_tools` on workflow nodes. Use these when you want a specific
  step sandboxed. `denied_tools` is OpenCode-only; LiteLLM warns + drops it.

---

## 4. Pydantic AI integration

### 4a. Write a BYO Pydantic agent

Create `.archon/agents/my_agent.py` exporting a module-level `agent`:

```python
# .archon/agents/my_agent.py
#
# BYO Pydantic AI agent. Archon's bridge (archon_pydantic_bridge.py)
# spawns this via `uv run --script ...` when a workflow node sets
# `provider: pydantic` + `agent: my_agent`.
import os
from pydantic_ai import Agent
from pydantic_ai.models.openai import OpenAIModel

# Fast-path: route through the local LiteLLM proxy — one API key covers
# every upstream (Anthropic, OpenAI, Azure, Novita) that your
# ~/.archon/litellm_config.yaml exposes.
model = OpenAIModel(
    "gpt-4o",
    base_url=os.environ["LITELLM_BASE_URL"],           # http://localhost:4000
    api_key=os.environ["LITELLM_MASTER_KEY"],
)

agent = Agent(
    model,
    system_prompt=(
        "You are a helpful assistant. Archon may prepend [Archon context] "
        "with skill + agent content before the user prompt — incorporate it."
    ),
)
```

### 4b. Register it in Archon

```yaml
# .archon/config.yaml
assistants:
  pydantic:
    agents:
      my_agent:
        entry: .archon/agents/my_agent.py
        # optional extra pip deps:
        # deps: ['httpx', 'beautifulsoup4']
```

### 4c. Use it in a workflow

```yaml
nodes:
  - id: my-step
    provider: pydantic
    agent: my_agent
    prompt: |
      Summarize the repo structure.
    # resolvedSkills + resolvedAgents flow through as [Archon context]
    # the agent remains free to shape/strip them before model invocation.
    skills: [systematic-debugging]
```

### 4d. Pydantic doesn't have "settings tweaks" to fuss with

The BYO model is the knob. Use `ModelSettings` (temperature, max_tokens)
in the agent constructor if you want per-agent controls. Archon doesn't
override them.

---

## 5. Illustrated workflows

### The bundled `feature` workflow — full lifecycle

```
$ archon workflow run feature "add a dark-mode toggle"
```

```
┌─────────────────────────────────────────────────────────────────┐
│  archon workflow run feature "..."                              │
│                                                                 │
│  ┌───────────┐                                                  │
│  │ brainstorm│ skill: brainstorming           model: haiku      │
│  │           │ → clarifying questions,                          │
│  │           │   writes spec to $ARTIFACTS_DIR/spec.md           │
│  └─────┬─────┘                                                  │
│        ▼                                                        │
│  ┌───────────┐                                                  │
│  │   plan    │ skill: writing-plans           model: opus       │
│  │           │ → reads spec, writes plan.md                     │
│  └─────┬─────┘                                                  │
│        ▼                                                        │
│  ┌───────────┐                                                  │
│  │ approval  │ human gate — approve or reject with comments     │
│  │   gate    │ → $approval-gate.output flows to next step       │
│  └─────┬─────┘                                                  │
│        ▼                                                        │
│  ┌───────────┐                                                  │
│  │ implement │ skills: executing-plans + TDD model: sonnet      │
│  │           │ → RED/GREEN/REFACTOR loop                        │
│  │           │ → incorporates approval feedback                 │
│  └─────┬─────┘                                                  │
│        ▼                                                        │
│  ┌───────────┐                                                  │
│  │  review   │ agent: code-reviewer           model: opus       │
│  │           │ → reviews diff vs plan, writes review.md         │
│  └─────┬─────┘                                                  │
│        ▼                                                        │
│  ┌───────────┐                                                  │
│  │  finish   │ skill: finishing-a-branch      model: haiku      │
│  │           │ → opens PR, cleans worktree                      │
│  └───────────┘                                                  │
└─────────────────────────────────────────────────────────────────┘
```

Every model comes from `models.yaml`. Override any step with
`archon models set skill <name> <model>` or by editing the file directly.

### Skill override flow

```
  Your request: "run systematic-debugging on this bug, but use haiku to save cost"

  ┌─ Workflow node or archon_skill_invoke ──────────────────────┐
  │ model: haiku          ← tier 1 override                     │
  │ skill: systematic-debugging                                 │
  └─────────────────────────────────┬───────────────────────────┘
                                    ▼
  ┌─ 8-tier model resolver ─────────────────────────────────────┐
  │ 1. override:            haiku   ✓ WINS                      │
  │ 2. .archon/models.yaml:      (not checked)                  │
  │ 3. ~/.archon/models.yaml:    (not checked)                  │
  │ 4. bundled models.yaml:      (not checked)                  │
  │ ...                                                         │
  └─────────────────────────────────┬───────────────────────────┘
                                    ▼
  ┌─ Provider router (inferProviderFromModel) ──────────────────┐
  │ "haiku" matches Claude shorthand                            │
  │ → claude provider                                           │
  └─────────────────────────────────┬───────────────────────────┘
                                    ▼
  ┌─ ClaudeProvider.sendQuery ──────────────────────────────────┐
  │ resolvedSkills = [{ name, description, body, model: haiku }]│
  │ → Claude SDK with systematic-debugging body as system prompt│
  │   + haiku model                                             │
  └─────────────────────────────────────────────────────────────┘
```

### MCP tool call from inside Claude Code

```
    You (Claude Code session)
         │
         │ "Check our skills, then review this diff with code-reviewer on opus"
         ▼
    Claude reasons, decides to call tools
         │
         ├─► archon_skills_list            ── returns 14 skills + models
         │
         ├─► archon_skills_show systematic-debugging  ── returns full body
         │
         └─► archon_agent_invoke
             name: code-reviewer
             prompt: "Review this diff: <paste>"
             model: anthropic/claude-opus-4-5        ← per-call override
                          │
                          ▼
             MCP server resolves agent body + model
                          │
                          ▼
             Claude SDK runs with the code-reviewer
             system prompt + opus
                          │
                          ▼
             Stream folds into {assistantText, tokens, ...}
                          │
                          ▼
             Claude (the outer AI) reads the review text
```

### LiteLLM proxy lifecycle

```
   First call to a model like openai/gpt-4o
        │
        ▼
   LiteLLMProvider.sendQuery
        │
        ▼
   getOrStartProxy(opts)
        │
        ├─ cachedHandle match? ── yes ──► return it (subsequent calls share)
        │
        ├─ pendingSpawn in flight? ── yes ──► await it (concurrency-safe)
        │
        └─ spawn `litellm --config … --port 4000`
                │
                ▼
           poll /health/liveliness until 200 or 30s timeout
                │
                ▼
           ref-count + cache; returns http://127.0.0.1:4000

   OpenAI SDK client points at the proxy baseUrl + LITELLM_MASTER_KEY
        │
        ▼
   Proxy routes anthropic/ → Anthropic, openai/ → OpenAI, …
        │
        ▼
   Stream translator folds chunks into MessageChunks

   On process exit: SIGINT / SIGTERM / beforeExit → child.kill('SIGTERM')
```

---

## 6. Common settings tweaks — one-pager

### Workflow node knobs

```yaml
# .archon/workflows/my-flow.yaml
nodes:
  - id: my-step
    prompt: "..."

    # Which runtime
    provider: claude | opencode | pydantic | litellm

    # Model (and its override precedence)
    model: sonnet                        # Claude SDK shorthand
    model: anthropic/claude-opus-4-5     # → Claude SDK (claude binary present) or LiteLLM
    model: openai/gpt-4o                 # → LiteLLM
    model: opencode/anthropic/claude-*   # → OpenCode's own upstream
    fallbackModel: haiku                 # provider forwards on primary failure

    # Content (injected into system prompt for every runtime)
    skills: [brainstorming, writing-plans]
    agents:
      code-reviewer: {}                  # empty = pull body from registry

    # Tool gating (Claude SDK native; OpenCode native; LiteLLM = allow-list only)
    allowed_tools: [Read, Grep, Bash]
    denied_tools: [Edit]

    # Pydantic only
    agent: my_agent                      # registered under assistants.pydantic.agents

    # Cost + iteration limits
    maxBudgetUsd: 0.50                   # LiteLLM forwards to proxy as max_budget
    idle_timeout: 60000                  # ms

    # System prompt add-on (merged with resolved skill/agent bodies)
    systemPrompt: "Be terse."

    # DAG structure
    depends_on: [prior-step]
    trigger_rule: all_success | one_success
    when: "$prior.output != ''"
```

### Global config (`~/.archon/config.yaml`)

```yaml
botName: Archon
defaultAssistant: claude
assistants:
  claude:
    model: sonnet
    settingSources: [project]
  opencode:
    baseUrl: http://localhost:1234     # skip-spawn mode
    providers:
      litellm: { authTokenEnv: LITELLM_MASTER_KEY }
  pydantic:
    uvBinaryPath: /opt/homebrew/bin/uv
    agents:
      my_agent: { entry: .archon/agents/my_agent.py }
  litellm:
    configPath: ~/.archon/litellm_config.yaml
    port: 4000
    masterKeyEnv: LITELLM_MASTER_KEY
```

### Project config (`.archon/config.yaml`)

Same shape as global; project wins on overlap. Use project config to pin a
repo to a specific Claude model, override skill/agent assignments via
`.archon/models.yaml`, etc.

---

## 7. Ideas to make this better

Honest assessment of rough edges + what could land next:

### Critical-ish

1. **Add `archon setup` to the Makefile pipeline.** `make claude` installs
   claude + prints "Next: run `archon setup`" but nothing runs it. A new
   `make bootstrap` target could chain `install → <runtime> → setup --<runtime>`
   so a new contributor gets a working config in one command.

2. **LiteLLM proxy auto-restart on config change.** Today the proxy
   singleton is spawned on first query and reused for the process lifetime.
   If a user edits `~/.archon/litellm_config.yaml` to add a new upstream
   mid-session, they have to restart Archon. A filesystem watcher +
   graceful proxy restart would close that gap.

3. **`archon_workflow_run` MCP tool is blocking.** Claude Code tool calls
   have timeouts — a 10-minute workflow will cut off. Option: convert the
   tool to fire-and-return-runId semantics, document the pattern, add
   `archon_workflow_tail(runId)` that streams updates. Complexity: need
   to hand off the execution from the MCP request context to a background
   task without losing the workflow store handle.

4. **CI Windows runners fail the whole matrix.** Platform-scope memory
   says macOS + Ubuntu only. Either drop `windows-latest` from the matrix
   or gate it behind `continue-on-error: true` so a Windows flake doesn't
   block a clean Ubuntu build.

### Nice-to-haves

5. **Per-workflow cost ceiling.** `maxBudgetUsd` is per-node. A whole-
   workflow cap + rollup (tokens + cost across all nodes) would help
   avoid runaway experiments.

6. **`archon skills create <name>`.** Scaffolds a new SKILL.md with the
   correct frontmatter + opens `$EDITOR`. Lower the barrier to project-
   local skills vs. copy-paste from a superpowers example.

7. **MCP `archon_skills_assign` / unassign.** Deliberately omitted for
   security (outer AI silently rewriting routing). But a `--confirm`
   parameter that forces human approval would thread the needle. Claude
   Code could call "I want to change this skill's model — ok to proceed?"
   and the user sees the diff before it happens.

8. **`archon doctor`.** One command that checks: claude binary, opencode
   binary, uv, litellm proxy, LITELLM_MASTER_KEY, every env var
   referenced in `authTokenEnv` configs, models.yaml schema across all
   3 tiers. One-shot health check vs. running 5 different commands.

9. **Skill chain composition.** Today a node picks N skills and each
   contributes a system prompt section. What if `skills: [a, b, c]` had
   optional ordering + gating (run skill B only if skill A "succeeds")?
   Turns skills into mini-pipelines without needing a whole workflow.

10. **`archon models diff <other-repo>`.** Compares model assignments
    between two repos. Useful when onboarding a new repo — "why is
    sonnet used for X here but opus in the other repo?"

11. **LiteLLM proxy — embedded mode.** Shipping `litellm[proxy]` as a
    separate pip-installed dep is friction. A long-term play: embed the
    routing logic in TypeScript directly (skip the proxy). Large effort;
    LiteLLM's upstream-adapter catalog is substantial.

12. **Feature workflow template parameterization.** One-line "build a
    feature" is great; sometimes you want "build a feature matching our
    API-style-guide skill" or "skip the approval gate for trivial
    refactors". A workflow-argument system beyond `$ARGUMENTS` would
    help (named params with defaults).

### Testing + DX

13. **Live integration test suite.** Every path I tested by hand should
    have an opt-in integration test: `LITELLM_SMOKE=1 bun test …` that
    actually spawns the proxy, hits a real model, asserts tool_use round
    trip. Kept out of CI by default, runnable on demand.

14. **`archon models why <skill>`.** Explains resolution tier-by-tier:
    "brainstorming → bundled models.yaml says haiku; no project
    override; no global override". Helps users understand the 8-tier
    resolver without reading the docs.

15. **MCP tool `archon_plan_session`.** Reads the session's current
    context + suggests which skill(s) would be most useful next. A meta-
    tool that makes the other tools more discoverable.

### Spec + protocol hardening

16. **Stronger frontmatter schema.** Today SKILL.md frontmatter accepts
    `name` + `description` + optional `model`. Extending to
    `examples: [...]` (discovery hints) or `requires: [<other-skill>]`
    (auto-include dependencies) would lean further into the "skill as a
    first-class unit".

17. **MCP `sampling/*` support.** The MCP spec has a `sampling/createMessage`
    method — clients can ask the server to run a model. Archon's invoke
    tools are the manual version; sampling is the spec-native way. Would
    let other MCP clients use Archon's models.yaml transparently.

18. **models.yaml alias chains.** Today aliases are one-hop. Supporting
    chains (`cheap → fast → haiku`) with cycle detection would be user-
    friendly but low-priority.

---

## 8. Troubleshooting

| Symptom | Likely cause + fix |
|---|---|
| `archon: command not found` | `make install` hasn't run, or `bun link` didn't produce a PATH entry. Use `bun run cli` from the repo. |
| Claude Code doesn't see `archon_*` tools | MCP loads at session start. Restart Claude Code after `claude mcp add archon`. |
| `MCP server archon: Connection closed` | Usually means Archon's subprocess crashed or wrote to stdout before ready. Check stderr of `archon mcp serve` manually. Pre-68b8db3 this was the stdout-pollution bug — upgrade to the latest dev. |
| `LiteLLM master key not found` | Fill in `LITELLM_MASTER_KEY=…` in `~/.archon/.env` (match `general_settings.master_key` in `~/.archon/litellm_config.yaml`). |
| `litellm proxy did not become ready within 30000ms` | Usually upstream auth issue. Last 4KB of proxy stderr is attached to the error — look for 4xx/5xx responses. |
| `Skill '<name>' not found` | Run `archon skills list` to see available names. Custom skills go under `.archon/skills/<name>/SKILL.md`. |
| `archon models validate` flags a model string | Fix the typo or add it to the alias table. |
