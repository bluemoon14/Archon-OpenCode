# Archon as an MCP server

Archon exposes its skill / agent / model registry to MCP-capable hosts (Claude
Code, OpenCode, and other [Model Context Protocol](https://modelcontextprotocol.io)
clients) via `archon mcp serve`. This lets an outer AI session natively call
Archon's discovery surface without dropping to a shell.

---

## Transport

**stdio only** (v1). The CLI takes over stdin/stdout for the MCP protocol;
logs go to stderr via Archon's structured logger. Clients spawn `archon mcp
serve` as a subprocess.

---

## Client configuration

### Claude Code

Add to `~/.claude/mcp.json` (or project-scope `.claude/mcp.json`):

```json
{
  "mcpServers": {
    "archon": {
      "command": "archon",
      "args": ["mcp", "serve"]
    }
  }
}
```

Restart Claude Code. Verify the `archon_skills_list` tool appears in the
available-tools panel. If `archon` isn't on PATH, use an absolute path or set
`"command": "bun"` + `"args": ["--cwd", "/path/to/Archon-OpenCode", "run", "cli", "mcp", "serve"]`
in dev.

### OpenCode / other MCP clients

Any client that supports stdio MCP servers takes the same config shape — just
register a server named `archon` with command `archon` and args `["mcp",
"serve"]`.

---

## Tools exposed in v1

| Tool | Input | Output |
|---|---|---|
| `archon_skills_list` | `{}` | `{skills: [{name, source, description, model, modelSource, aliasExpanded}]}` |
| `archon_skills_show` | `{name: string}` | Full SKILL.md metadata + body |
| `archon_agents_list` | `{}` | `{agents: [...]}` with resolved model per entry |
| `archon_agents_show` | `{name: string}` | Full agent metadata + body |
| `archon_models_list` | `{}` | `{defaults, aliases, skills, agents}` — the full assignment table |

All return JSON inside an MCP `text` content block so hosts can parse without
additional schema negotiation.

---

## Deferred tools (follow-up)

These are in the plan but not in v1 — they need additional wiring before they
can be exposed safely:

- `archon_workflow_run` / `archon_workflow_status` / `archon_workflow_resume`
  — need IWorkflowStore wiring through the MCP process.
- `archon_skill_invoke` / `archon_agent_invoke` — one-shot invocations that
  call the underlying provider. Needs provider selection + registry read at
  tool-call time.
- `archon_models_set` / `archon_models_reset` — deliberately omitted. The
  outer AI should not silently rewrite routing config. Users who want those
  can drop to `archon models set ...` via whatever shell-tool the host
  provides.

---

## Local dev / testing

Run the server manually against stdin:

```bash
archon mcp serve
# Send a JSON-RPC request on stdin:
# {"jsonrpc": "2.0", "id": 1, "method": "tools/list"}
```

Or in-process via the test harness:

```typescript
import { createArchonMcpServer } from '@archon/cli/mcp/server';
const server = createArchonMcpServer({ cwd: process.cwd() });
// See packages/cli/src/mcp/server.test.ts for tool-invocation examples.
```

---

## Security notes

- stdio means the MCP server only accepts connections from the subprocess
  parent (the MCP client). No network exposure.
- All tools are **read-only**; no mutation API is exposed. The outer AI
  cannot change routing or write to `.archon/models.yaml` via MCP.
- Archon's own auth (upstream API keys) lives in `~/.archon/.env` and is
  never returned through MCP tools.
