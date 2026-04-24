# OpenCode provider

Archon provider that drives the [OpenCode](https://opencode.ai) coding agent.
Use it when you want OpenCode's front-end (wider model support, built-in
tools) inside an Archon workflow.

## How it works

`OpenCodeProvider` spawns `opencode serve` as a subprocess per `sendQuery`
using `@opencode-ai/sdk`'s `createOpencodeServer`. The SDK handles
cross-platform spawn, readiness detection ("opencode server listening on
http://..."), and tear-down. Archon:

1. Resolves the binary (env → config → autodetect → throws).
2. Asks the OS for an ephemeral port (`port: 0`).
3. Passes the resolved `providerID/modelID` into `session.prompt`.
4. Subscribes to `event.subscribe()` and translates each event into an
   Archon `MessageChunk` (see `event-mapper.ts`).
5. Closes the subprocess in `finally` — always, on abort or completion.

For users running their own `opencode serve` (shared dev machine, remote
instance), set `assistants.opencode.baseUrl` and Archon skips spawn.

## Install

```bash
curl -fsSL https://opencode.ai/install | bash
# or
npm install -g opencode-ai
```

Either put the install directory on PATH, set `OPENCODE_BIN_PATH`, or record
the absolute path in `.archon/config.yaml`.

## Config

```yaml
# ~/.archon/config.yaml or .archon/config.yaml
assistants:
  opencode:
    model: opencode/openai/gpt-4o-mini # optional default
    opencodeBinaryPath: /absolute/path/to/opencode # optional
    baseUrl: http://127.0.0.1:4096 # optional — skip spawn
    providers: # per-upstream auth (env-var NAMES, not secrets)
      openai: { authTokenEnv: OPENAI_API_KEY }
      anthropic: { authTokenEnv: ANTHROPIC_API_KEY }
```

The env vars listed under `providers.<id>.authTokenEnv` are read from the
host process and injected into the `opencode serve` child at spawn time.
Never put secrets in YAML.

## Workflow usage

```yaml
name: my-workflow
provider: opencode
model: opencode/openai/gpt-4o-mini

nodes:
  - id: plan
    prompt: "Describe the change needed."
    allowed_tools: []
```

Model inference: any string matching `providerID/modelID` routes to OpenCode
by default, **except** Anthropic aliases (`sonnet`, `opus`, `haiku`,
`claude-*`) which stay reserved for the Claude provider. Use the
`opencode/` prefix (e.g. `opencode/anthropic/claude-3-5-sonnet-latest`) to
force OpenCode routing for ambiguous cases.

## Capability matrix

| Feature                                         | OpenCode |
| ----------------------------------------------- | -------- |
| Session resume (`resumeSessionId`)              | yes      |
| MCP servers                                     | yes      |
| Tool allow/deny lists                           | yes      |
| Structured output (`output_format: json_schema`) | yes      |
| Env injection                                   | yes      |
| Hooks                                           | no       |
| Skills (Claude AgentDefinition)                 | no       |
| Inline sub-agents (Claude `agents:`)            | no       |
| Extended thinking / effort budgets              | no       |
| `maxBudgetUsd` / `fallbackModel` / `sandbox`    | no       |

Unsupported fields emit a capability warning from the DAG executor and are
ignored by the provider.

## Troubleshooting

- **`ProviderError: binary_not_found`** — opencode is not on PATH and no
  binary path is configured. Follow the install section above.
- **`ProviderError: subprocess_crash`** — the server exited before emitting
  its `listening on` line. Check stderr in the debug log; usually an
  upstream provider auth issue (missing `OPENAI_API_KEY` etc).
- **Capability warnings** — expected; the node YAML includes a field
  OpenCode doesn't support, and it's being ignored.
