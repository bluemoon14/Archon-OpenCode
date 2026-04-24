# /// script
# requires-python = ">=3.10"
# dependencies = ["pydantic-ai>=0.1.0"]
# ///
"""
Archon <-> Pydantic AI stdio bridge (protocol v1).

Spawned by the Archon TypeScript PydanticProvider as:

    uv run --script archon_pydantic_bridge.py -- <user_agent.py>

Reads line-delimited JSON envelopes from stdin and writes line-delimited JSON
envelopes to stdout. See bridge-protocol.md for the wire format.

Concurrency: single-threaded per process. One query at a time. Abort is an
in-band envelope that cancels the currently running asyncio task.
"""

from __future__ import annotations

import asyncio
import importlib.util
import json
import sys
import traceback
from pathlib import Path
from typing import Any


# --------------------------------------------------------------------------- #
# I/O helpers                                                                 #
# --------------------------------------------------------------------------- #


def _emit(envelope: dict[str, Any]) -> None:
    """Write one JSON envelope on a single line. Explicit flush — host reads
    line-by-line and back-pressure depends on promptly emptying our buffer."""
    envelope["v"] = 1
    sys.stdout.write(json.dumps(envelope, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def _log(msg: str) -> None:
    """Free-form stderr logging. Captured by the host but not parsed."""
    sys.stderr.write(f"[archon-pydantic-bridge] {msg}\n")
    sys.stderr.flush()


# --------------------------------------------------------------------------- #
# Agent loading                                                               #
# --------------------------------------------------------------------------- #


def _load_user_agent(agent_path: Path) -> Any:
    """Dynamically import the user's agent file. Raises on any import error —
    caller translates to an `agent_import_error` envelope."""
    spec = importlib.util.spec_from_file_location("_archon_user_agent", agent_path)
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot create spec for {agent_path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    agent = getattr(module, "agent", None)
    if agent is None:
        raise AttributeError(
            f"{agent_path} does not define a module-level `agent` variable"
        )
    return agent


# --------------------------------------------------------------------------- #
# Event translation                                                           #
# --------------------------------------------------------------------------- #


def _part_to_delta_text(part: Any) -> str | None:
    """Extract visible text from a TextPart or ThinkingPart, returning None
    for parts that carry no plain-text payload."""
    for attr in ("content", "text"):
        value = getattr(part, attr, None)
        if isinstance(value, str):
            return value
    return None


def _delta_text(delta: Any) -> str | None:
    for attr in ("content_delta", "content"):
        value = getattr(delta, attr, None)
        if isinstance(value, str):
            return value
    return None


def _tool_input(part: Any) -> dict[str, Any]:
    # ToolCallPart exposes either an args dict or a JSON string. Prefer a dict
    # when the SDK already parsed it; fall back to raw string otherwise.
    args = getattr(part, "args", None)
    if isinstance(args, dict):
        return args
    if isinstance(args, str):
        try:
            parsed = json.loads(args)
            if isinstance(parsed, dict):
                return parsed
        except json.JSONDecodeError:
            pass
    return {"_raw": args} if args is not None else {}


def _tool_output(result_part: Any) -> str:
    content = getattr(result_part, "content", None)
    if isinstance(content, str):
        return content
    if content is not None:
        return json.dumps(content, default=str)
    return ""


def _usage_to_tokens(usage: Any) -> dict[str, int]:
    out: dict[str, int] = {}
    for key in ("input_tokens", "output_tokens", "total_tokens"):
        value = getattr(usage, key, None)
        if isinstance(value, int):
            out[key.removesuffix("_tokens")] = value
    # Normalise keys to the Archon MessageChunk shape.
    return {
        "input": out.get("input", 0),
        "output": out.get("output", 0),
        "total": out.get(
            "total",
            out.get("input", 0) + out.get("output", 0),
        ),
    }


# --------------------------------------------------------------------------- #
# Query execution                                                             #
# --------------------------------------------------------------------------- #


async def _run_query(
    agent: Any,
    query_id: str,
    prompt: str,
    system_context: str | None = None,
) -> None:
    """Run one query to completion, emitting chunks along the way. Raises on
    any agent-raised exception — caller translates to an `error` envelope.

    `system_context` is optional Archon-assembled system-level content
    (user systemPrompt + resolvedSkills + resolvedAgents, already folded
    into one string by the TypeScript caller). When present we prepend it
    to the user prompt with a clear delimiter so user agents that don't
    opt in to a message-history API still see the context. User agents
    remain free to strip or reshape it before model invocation."""
    # Lazy import so agent_import_error still wraps pydantic-ai import
    # failures, not module-load-time issues in this bridge.
    from pydantic_ai import messages as pa_messages

    effective_prompt = prompt
    if system_context:
        effective_prompt = (
            f"[Archon context]\n{system_context}\n\n"
            f"[User prompt]\n{prompt}"
        )

    async for event in agent.run_stream_events(effective_prompt):
        kind = getattr(event, "event_kind", None)

        if kind == "part_start":
            part = event.part
            text = _part_to_delta_text(part)
            if text is None or text == "":
                continue
            envelope_kind = (
                "thinking" if isinstance(part, pa_messages.ThinkingPart) else "assistant"
            )
            _emit({"kind": envelope_kind, "id": query_id, "content": text})

        elif kind == "part_delta":
            text = _delta_text(event.delta)
            if text is None or text == "":
                continue
            envelope_kind = (
                "thinking"
                if isinstance(event.delta, pa_messages.ThinkingPartDelta)
                else "assistant"
            )
            _emit({"kind": envelope_kind, "id": query_id, "content": text})

        elif kind == "function_tool_call":
            part = event.part
            _emit(
                {
                    "kind": "tool",
                    "id": query_id,
                    "toolName": getattr(part, "tool_name", "unknown"),
                    "toolInput": _tool_input(part),
                    "toolCallId": getattr(part, "tool_call_id", ""),
                }
            )

        elif kind == "function_tool_result":
            result_part = event.result
            _emit(
                {
                    "kind": "tool_result",
                    "id": query_id,
                    "toolName": getattr(result_part, "tool_name", "unknown"),
                    "toolOutput": _tool_output(result_part),
                    "toolCallId": getattr(result_part, "tool_call_id", ""),
                }
            )

        elif kind == "agent_run_result":
            result = event.result
            output = result.output
            structured: Any
            if isinstance(output, (str, int, float, bool)) or output is None:
                structured = output
            else:
                # Pydantic models and dataclasses: best-effort serialisation.
                try:
                    dump = getattr(output, "model_dump", None)
                    structured = dump() if callable(dump) else output
                except Exception:  # pragma: no cover — defensive
                    structured = str(output)
            try:
                tokens = _usage_to_tokens(result.usage())
            except Exception:  # pragma: no cover — defensive
                tokens = {"input": 0, "output": 0, "total": 0}
            _emit(
                {
                    "kind": "result",
                    "id": query_id,
                    "tokens": tokens,
                    "structuredOutput": structured,
                    "stopReason": "end",
                    "numTurns": 1,
                }
            )

        # part_end, final_result: intentionally not forwarded — deltas and
        # tool events already carry the incremental signal.


# --------------------------------------------------------------------------- #
# Main loop                                                                   #
# --------------------------------------------------------------------------- #


async def _main(agent_path: Path) -> int:
    try:
        agent = _load_user_agent(agent_path)
    except Exception as err:
        _emit(
            {
                "kind": "error",
                "id": "",
                "code": "agent_import_error",
                "message": f"{type(err).__name__}: {err}\n{traceback.format_exc()}",
            }
        )
        return 1

    agent_name = getattr(agent, "name", None) or agent_path.stem
    _emit({"kind": "ready", "agent": agent_name})

    loop = asyncio.get_running_loop()
    queue: asyncio.Queue[str] = asyncio.Queue()

    def pump() -> None:
        try:
            for raw_line in sys.stdin:
                line = raw_line.rstrip("\n")
                if line:
                    asyncio.run_coroutine_threadsafe(queue.put(line), loop)
        finally:
            asyncio.run_coroutine_threadsafe(queue.put(""), loop)  # EOF

    loop.run_in_executor(None, pump)

    current_task: asyncio.Task[None] | None = None
    current_id: str | None = None

    while True:
        line = await queue.get()
        if line == "":
            # EOF — host closed stdin without an explicit shutdown.
            if current_task and not current_task.done():
                current_task.cancel()
            return 0

        try:
            envelope = json.loads(line)
        except json.JSONDecodeError:
            _log(f"ignoring malformed line: {line[:120]}")
            continue

        kind = envelope.get("kind")
        if kind == "shutdown":
            if current_task and not current_task.done():
                current_task.cancel()
            return 0

        if kind == "abort":
            target_id = envelope.get("id")
            if current_task and target_id == current_id and not current_task.done():
                current_task.cancel()
            continue

        if kind != "query":
            _log(f"ignoring unknown envelope kind: {kind!r}")
            continue

        query_id = str(envelope.get("id", ""))
        prompt = str(envelope.get("prompt", ""))
        raw_system_context = envelope.get("systemContext")
        system_context = (
            raw_system_context if isinstance(raw_system_context, str) else None
        )
        current_id = query_id
        current_task = asyncio.create_task(
            _run_query(agent, query_id, prompt, system_context)
        )

        try:
            await current_task
        except asyncio.CancelledError:
            _emit(
                {
                    "kind": "error",
                    "id": query_id,
                    "code": "agent_runtime_error",
                    "message": "aborted",
                }
            )
        except Exception as err:
            _emit(
                {
                    "kind": "error",
                    "id": query_id,
                    "code": "agent_runtime_error",
                    "message": f"{type(err).__name__}: {err}\n{traceback.format_exc()}",
                }
            )
        finally:
            current_task = None
            current_id = None


def main() -> int:
    if len(sys.argv) < 2:
        _log("usage: archon_pydantic_bridge.py <user_agent.py>")
        return 2
    agent_path = Path(sys.argv[1]).resolve()
    if not agent_path.is_file():
        _emit(
            {
                "kind": "error",
                "id": "",
                "code": "agent_import_error",
                "message": f"agent file not found: {agent_path}",
            }
        )
        return 1

    try:
        return asyncio.run(_main(agent_path))
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    sys.exit(main())
