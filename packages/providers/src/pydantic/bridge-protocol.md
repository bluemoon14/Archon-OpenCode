# Archon ↔ Pydantic AI stdio bridge protocol (v1)

Line-delimited JSON over stdin/stdout. One envelope per line. Envelopes are
versioned (`v: 1`) and discriminated by `kind`. Unknown `kind` values are
ignored by both sides (forward-compat).

Stderr is reserved for free-form logging by the bridge; it is captured by the
host but never parsed.

## Lifecycle

1. Host spawns the bridge: `uv run --script <bridge.py> -- <user_agent.py>`.
2. Bridge imports the user agent file (expects a module-level `agent` exporting
   a `pydantic_ai.Agent` instance). On success, writes `ready`. On failure,
   writes a terminal `error` with code `agent_import_error` and exits 1.
3. Host sends one `query` envelope. Bridge responds with a stream of
   `assistant` / `thinking` / `tool` / `tool_result` chunks, terminated by
   exactly one `result` or `error` whose `id` matches the query.
4. Host may send `abort {id}` mid-stream; the bridge cancels the current run
   and emits a terminal `error` with code `agent_runtime_error` + message
   "aborted".
5. Host may send `shutdown` at any time. Bridge emits no further lines and
   exits 0.

Host must send exactly one query at a time — the bridge is single-threaded
per process. Do not send a second `query` until the previous one's terminal
envelope has been received.

## Envelopes

### Host → Bridge

```jsonc
{"v":1,"kind":"query","id":"<uuid>","prompt":"...","cwd":"...","env":{"KEY":"VAL"},"systemContext":"..."}
{"v":1,"kind":"abort","id":"<uuid>"}
{"v":1,"kind":"shutdown"}
```

- `id` — caller-chosen unique string, echoed on all response envelopes.
- `cwd` — repo root; informational only (bridge does not chdir, subprocess
  already spawned there).
- `env` — optional extra env for the bridge process. Already applied at spawn
  time by the host; passed through for parity with Claude's nodeConfig.
- `systemContext` — optional string. When present, the bridge prepends it to
  the user prompt under an `[Archon context]` header before invoking
  `agent.run_stream_events()`. Carries the node-level `systemPrompt` plus
  folded `resolvedSkills` / `resolvedAgents` from the SkillAgentRegistry so
  Pydantic nodes receive the same skill/agent context as Claude / OpenCode /
  LiteLLM. User agents remain free to inspect and reshape before model
  invocation (they control the agent instance).

### Bridge → Host

```jsonc
{"v":1,"kind":"ready","agent":"<name-from-agent.name-or-module>"}

{"v":1,"kind":"assistant","id":"<uuid>","content":"..."}
{"v":1,"kind":"thinking","id":"<uuid>","content":"..."}

{"v":1,"kind":"tool","id":"<uuid>","toolName":"...","toolInput":{"k":"v"},"toolCallId":"..."}
{"v":1,"kind":"tool_result","id":"<uuid>","toolName":"...","toolOutput":"...","toolCallId":"..."}

{"v":1,"kind":"result","id":"<uuid>","tokens":{"input":42,"output":17,"total":59},"structuredOutput":"...","stopReason":"end","numTurns":1}
{"v":1,"kind":"error","id":"<uuid>","code":"agent_import_error|agent_runtime_error|unknown","message":"..."}
```

Chunks flush on newline; the host reads line-by-line via Node's `readline`.
Back-pressure is natural — if the host consumer is slow, the OS pipe buffer
fills and `print(..., flush=True)` blocks, which suspends the agent run.

## Mapping from pydantic-ai events

Pydantic AI's `agent.run_stream_events()` yields a discriminated union of
events. The adapter translates:

| pydantic-ai event / kind                         | bridge envelope   | notes                                                         |
| ------------------------------------------------ | ----------------- | ------------------------------------------------------------- |
| `PartStartEvent(part=TextPart)`                  | `assistant`       | emit `part.content` once                                      |
| `PartDeltaEvent(delta=TextPartDelta)`            | `assistant`       | emit `delta.content_delta`                                    |
| `PartStartEvent(part=ThinkingPart)`              | `thinking`        | emit `part.content` once                                      |
| `PartDeltaEvent(delta=ThinkingPartDelta)`        | `thinking`        | emit `delta.content_delta`                                    |
| `FunctionToolCallEvent(part=ToolCallPart)`       | `tool`            | `toolName=part.tool_name`, `toolInput=part.args_as_dict()`    |
| `FunctionToolResultEvent(result=ToolReturnPart)` | `tool_result`     | `toolOutput=str(result.content)`                              |
| `AgentRunResultEvent(result=AgentRunResult)`     | `result`          | tokens from `result.usage()`, output via `str(result.output)` |
| exception raised during run                      | `error` (runtime) | code `agent_runtime_error`                                    |

`PartEndEvent` and `FinalResultEvent` are observed but not forwarded as chunks
(they'd duplicate text already emitted as deltas).

## Error codes

| code                  | meaning                                                           |
| --------------------- | ----------------------------------------------------------------- |
| `agent_import_error`  | `import` of the user agent file raised before `ready` was emitted |
| `agent_runtime_error` | agent raised mid-run, or the host sent `abort`                    |
| `unknown`             | anything else (bridge crash caught at top level)                  |

Host dispatches on `code` to produce actionable messages (see
`packages/core/src/utils/error-formatter.ts`).
