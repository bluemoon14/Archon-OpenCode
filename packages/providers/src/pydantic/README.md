# Pydantic AI provider (BYO agent)

Archon provider for [Pydantic AI](https://ai.pydantic.dev). Unlike the Claude
and OpenCode providers, this is **bring-your-own-agent** — you write a
Python file that exports a `pydantic_ai.Agent`, and Archon invokes it via
a JSONL stdio bridge spawned with `uv`.

## Why it's shaped this way

Pydantic AI is a Python framework; Archon is Bun/TypeScript. Rather than
embed a Python runtime or force a narrow "Archon Pydantic config" shape
onto users, the provider delegates everything about the agent — model
choice, tools, system prompt, dependencies — to the user's Python file.
Archon only owns the plumbing: spawn `uv`, send a prompt, stream events,
normalise them into `MessageChunk`s, tear down cleanly.

See [`bridge-protocol.md`](./bridge-protocol.md) for the wire format.

## Install

```bash
# macOS / Linux
curl -LsSf https://astral.sh/uv/install.sh | sh
# Homebrew
brew install uv
```

Either put `uv` on PATH, set `UV_BIN_PATH`, or record its absolute path in
`.archon/config.yaml`.

## Writing an agent

Any file that exports a module-level `agent` variable pointing at a
`pydantic_ai.Agent` instance works. Use [PEP 723 inline metadata][pep723]
to declare Python deps — `uv run --script` resolves them lazily:

```python
# .archon/agents/planner.py
# /// script
# requires-python = ">=3.10"
# dependencies = ["pydantic-ai[openai]>=0.1.0"]
# ///
from pydantic_ai import Agent

agent = Agent("openai:gpt-4o-mini", name="planner")
```

[pep723]: https://peps.python.org/pep-0723/

First-run cold-start pays for the interpreter + dep resolution (5–30s);
cached subsequent runs are near-instant. Archon defaults the bridge ready
timeout to 120s to accommodate the cold path.

## Config

```yaml
# ~/.archon/config.yaml or .archon/config.yaml
assistants:
  pydantic:
    uvBinaryPath: /opt/homebrew/bin/uv # optional
    agentsDir: .archon/agents # optional, default shown
    agents:
      planner: { entry: .archon/agents/planner.py }
      reviewer:
        entry: .archon/agents/reviewer.py
        deps: ["httpx", "rich"] # optional — informational today
```

`entry` can be absolute or relative-to-repo-root. The file must exist when
the workflow runs (resolved at `sendQuery` time, not at config load).

## Workflow usage

```yaml
name: dual-agent-review
provider: pydantic

nodes:
  - id: plan
    agent: planner
    prompt: "Outline what this PR changes."
  - id: review
    agent: reviewer
    depends_on: [plan]
    prompt: |
      The plan says:
      $plan.output
      Flag anything that looks risky.
```

The `agent:` node field is required for Pydantic nodes — it names an entry
under `assistants.pydantic.agents.<name>.entry`. Unlike Claude or OpenCode,
model-name routing is never used: Pydantic selection is always explicit via
`provider: pydantic` + `agent: <name>`.

## Capability matrix

| Feature                                   | Pydantic AI |
| ----------------------------------------- | ----------- |
| Structured output                         | yes (core)  |
| Env injection                             | yes         |
| Session resume                            | no          |
| MCP servers                               | no          |
| Hooks                                     | no          |
| Skills / inline sub-agents                | no          |
| Tool allow/deny, effort, thinking, sandbox | no          |

Most Archon per-node knobs have no meaning here — the user's agent owns
tools, model, and system prompt. `structuredOutput` is honoured because
Pydantic AI's typed output lands in the `result.structuredOutput` field.

## Error codes

| code                  | cause                                                             |
| --------------------- | ----------------------------------------------------------------- |
| `agent_import_error`  | the user's Python file failed to import (syntax, missing dep, …)   |
| `agent_runtime_error` | agent raised mid-run, or the host sent `abort`                    |
| `binary_not_found`    | `uv` not resolvable via env / config / autodetect                 |
| `subprocess_crash`    | uv exited non-zero before emitting `ready`                        |
| `timeout`             | no `ready` envelope within the start timeout (120s default)        |

## Troubleshooting

- **Cold-start timeouts** — first run on a new machine resolves pydantic-ai's
  dependency tree. Warm the cache once with `uv run --script
  .archon/agents/<name>.py` (no need to pass an agent — uv will still
  resolve deps while the script no-ops).
- **`agent_import_error`** — the bridge surfaces the full Python traceback
  in the error message. Usually a missing dep in the PEP 723 block or a
  typo in the `agent = ...` line.
- **Abort hangs** — the bridge asks the agent to cancel in-band; if the
  agent is mid-network-call and ignores cancellation, Archon falls back to
  SIGTERM after 2s, SIGKILL after 4s. Expect worst-case ~5s tear-down.
