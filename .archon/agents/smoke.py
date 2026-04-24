# /// script
# requires-python = ">=3.10"
# dependencies = ["pydantic-ai[openai]>=0.1.0"]
# ///
"""
Minimal Pydantic AI smoke agent.

Invoked by Archon's Pydantic bridge when a workflow node selects
`provider: pydantic` + `agent: smoke`. Archon runs this file via
`uv run --script` so PEP 723 deps above are resolved on first invocation.

Uses `openai:gpt-4o-mini` (env OPENAI_API_KEY required) rather than a Claude
model — avoids having smoke tests round-trip through Claude for a non-Claude
provider check.
"""

from pydantic_ai import Agent

agent = Agent("openai:gpt-4o-mini", name="smoke")
