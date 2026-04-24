# Skills + Agents in Archon

Archon ships with the [obra/superpowers](https://github.com/obra/superpowers)
library vendored as bundled defaults — 14 skills and 1 agent embedded in the
binary. Users can override any of them per-repo or globally, author their
own, and pick a specific LLM model per skill or agent. This doc covers how
to find, author, and assign models to skills + agents.

---

## What is a skill? What is an agent?

**Skill** — a `SKILL.md` markdown file with YAML frontmatter. The body is a
system-prompt contribution; the frontmatter names the skill and tells Archon
when to load it. A workflow node references skills by name:

```yaml
nodes:
  - id: debug
    prompt: "Find the bug in login.ts"
    skills: [systematic-debugging]
```

When the node runs, Archon loads `systematic-debugging/SKILL.md`, folds its
body into the system prompt, and the model treats the skill's guidance as
context.

**Agent** — a `<name>.md` file with YAML frontmatter. Same shape as a skill,
but used for full-turn sub-agents (e.g. a code reviewer). Referenced via
`agents:` on a node:

```yaml
nodes:
  - id: review
    prompt: "Review the diff"
    agents:
      code-reviewer: {}   # reuse the bundled superpowers code-reviewer
```

On Claude SDK, agents are native sub-agents invokable via the `Task` tool.
On OpenCode / LiteLLM / Pydantic, agents are folded into the system prompt
as sub-persona context (no native subagent runtime on those platforms).

---

## Where do skills + agents live?

Three-tier override chain (project > global > bundled):

| Tier | Path | Source of content |
|---|---|---|
| Bundled | Embedded in the binary via `bundled-defaults.generated.ts` | `packages/workflows/src/defaults/superpowers/` |
| Global | `~/.archon/skills/<name>/SKILL.md`, `~/.archon/agents/<name>.md` | User-authored |
| Project | `<repo>/.archon/skills/<name>/SKILL.md`, `<repo>/.archon/agents/<name>.md` | Repo-authored, usually checked in |

When multiple tiers define the same name, project wins. List what's
resolved:

```bash
archon skills list
archon agents list
archon skills show systematic-debugging
archon agents show code-reviewer
```

Add `--json` for machine-readable output.

---

## Authoring a new skill

```markdown
---
name: our-api-style
description: Use when writing or reviewing code that calls our internal API.
model: anthropic/claude-sonnet-4-5   # optional — see models.yaml below
---

# Our API style guide

Always use the typed client from `packages/api-client/`. Never construct
URLs by hand. Error responses are JSON:API shaped — surface the `errors[0].
detail` field to the user.
```

Save as `.archon/skills/our-api-style/SKILL.md`. `archon skills list` will
show it immediately (no restart).

Rules (enforced by the loader):
- `name` must be lowercase kebab-case and match the directory name.
- `description` should start with "Use when..." so Claude's skill discovery
  ranks it correctly.
- `model` is optional. When omitted the resolver falls back to the
  `models.yaml` tier chain (see below).

---

## Per-skill / per-agent model selection

### The central manifest

`models.yaml` is the single place to audit + change which LLM runs each
skill and agent. Lives at three scopes:

- `packages/workflows/src/defaults/models.yaml` — shipped with the binary.
- `~/.archon/models.yaml` — user-scope override.
- `<repo>/.archon/models.yaml` — project-scope override.

Example:

```yaml
version: 1

defaults:
  node: sonnet                        # default for workflow nodes with no model
  skill: anthropic/claude-haiku-4-5   # default for any skill not named below
  agent: anthropic/claude-sonnet-4-5  # default for any agent not named below

skills:
  systematic-debugging: anthropic/claude-opus-4-5
  test-driven-development: anthropic/claude-sonnet-4-5
  brainstorming: anthropic/claude-haiku-4-5
  writing-skills: inherit             # use the owning node's model

agents:
  code-reviewer: anthropic/claude-opus-4-5

aliases:
  fast: anthropic/claude-haiku-4-5
  balanced: anthropic/claude-sonnet-4-5
  smart: anthropic/claude-opus-4-5
```

### Resolution order

For any skill/agent invocation, the resolver walks 8 tiers (highest wins):

1. Runtime override — `skills: [{name: X, model: Y}]` sugar in a workflow node.
2. Project `models.yaml` entry.
3. Global `~/.archon/models.yaml` entry.
4. Bundled `models.yaml` entry.
5. Frontmatter `model:` field on the SKILL.md / agent file.
6. Category default — `defaults.skill` or `defaults.agent` (from whichever
   file has one first: project > global > bundled).
7. Owning node's model (when the winning value is literal `inherit`).
8. Caller's default assistant model (last resort).

`archon models list` prints the full table with the winning source per
entry — audit in one shot.

### Changing a model

```bash
# Edit .archon/models.yaml directly:
vi .archon/models.yaml

# Or just re-run — next invocation picks up the change.
archon workflow run feature "...task..."
```

A guided setter (`archon models set skill <name> <model>`) is on the
roadmap; today users edit YAML + the resolver picks up changes on the next
run.

### Canonical model names

LiteLLM canonical form is the standard (`provider/model-name`):

| Provider | Shape | Example |
|---|---|---|
| Claude SDK direct | bare shorthand | `sonnet`, `opus`, `haiku`, `claude-sonnet-4-5` |
| Anthropic via LiteLLM | `anthropic/...` | `anthropic/claude-sonnet-4-5` |
| OpenAI via LiteLLM | `openai/...` | `openai/gpt-4o`, `openai/gpt-4o-mini` |
| Azure AI Foundry via LiteLLM | `azure_ai/...` | `azure_ai/claude-sonnet-4-5` |
| Novita via LiteLLM | `novita/...` | `novita/deepseek/deepseek-r1-turbo` |
| OpenCode upstream | `opencode/...` or any `<id>/<model>` | `opencode/gpt-4o` |

The `inherit` literal is legal in any tier and defers to the owning node.

---

## How skills reach each runtime

| Runtime | Skill body delivery | Per-agent model |
|---|---|---|
| Claude SDK | Injected into `AgentDefinition.prompt` (bypasses SDK skill lookup — bundled content works without `~/.claude/skills/` installed) | Yes, via `AgentDefinition.model` |
| OpenCode | Folded into the session `system:` field | Partial — session-level model override |
| LiteLLM | Folded into the `system` chat role message | Request-level model picks |
| Pydantic AI | Prepended to the user prompt under `[Archon context]` header via the bridge protocol | User's agent owns the model (Archon provides context, agent chooses how to use it) |

The skill body itself is runtime-agnostic — you author one `SKILL.md` and
Archon delivers it to whichever runtime the node selects.

---

## Override semantics for bundled content

Bundled superpowers skills and agents are **read-only** in `.archon/{skills,
agents}/defaults/` — hand-edits there will be overwritten by the next
`scripts/sync-superpowers.ts` run. To modify the behavior of a bundled
skill locally:

```bash
# Copy out of defaults/ into the project tier.
cp -r .archon/skills/defaults/systematic-debugging .archon/skills/
# Edit freely.
vi .archon/skills/systematic-debugging/SKILL.md
```

`archon skills show systematic-debugging` will now report `source: project`
and load your edited content.

---

## Relationship to `resolvedSkills` / `resolvedAgents`

At DAG-execution time the workflow executor (`packages/workflows/src/
dag-executor.ts`) calls `resolveNodeContent(...)` which pulls the skill and
agent bodies from the `SkillAgentRegistry` and resolves their models. The
result goes onto `SendQueryOptions.resolvedSkills` / `resolvedAgents` —
providers consume those directly and never re-load from disk. This is why
bundled content works on every runtime, regardless of whether the user has
`~/.claude/skills/` installed or OpenCode's own skill system enabled.
