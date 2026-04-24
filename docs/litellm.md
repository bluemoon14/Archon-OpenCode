# LiteLLM in Archon

Archon routes non-Claude LLM calls through [LiteLLM](https://github.com/BerriAI/litellm),
an OpenAI-compatible proxy that brokers Anthropic, OpenAI, Azure AI Foundry,
Novita, and dozens of other upstreams from one endpoint. Archon spawns and
manages the proxy subprocess automatically — the user configures upstream
keys once and every runtime (Claude SDK, OpenCode, Pydantic AI) can reach
every model.

This doc covers install, configuration, security, and the known gaps.

---

## Setup

The easiest path is the interactive wizard:

```bash
archon setup
# answer yes to "Configure LiteLLM?"
# multi-select: Anthropic, OpenAI, Azure AI Foundry, Novita
```

The wizard:
- Detects `uv` (Astral's Python package manager).
- Scaffolds `~/.archon/litellm_config.yaml` with a working `model_list` for
  the selected upstreams.
- Emits env-var names for `~/.archon/.env` (no secrets in YAML).
- Prints the install command for a pinned LiteLLM version — you run it
  yourself after reviewing (see security note below).

### Pinned version + install

The wizard will not run `pip` / `uv tool install` on your behalf. The
post-setup note prints the exact command:

```bash
uv tool install 'litellm[proxy]==1.83.0'
```

Bump the pin in `packages/cli/src/setup/plugins/litellm.ts` after auditing
the upstream changelog.

---

## Configuration

### ~/.archon/litellm_config.yaml

```yaml
# Scaffolded by `archon setup`. Secrets come from environment variables via
# the os.environ/<VAR> placeholder — never inline keys in this file.

model_list:
  - model_name: claude-sonnet
    litellm_params:
      model: anthropic/claude-sonnet-4-5
      api_key: os.environ/ANTHROPIC_API_KEY
  - model_name: gpt-4o
    litellm_params:
      model: openai/gpt-4o
      api_key: os.environ/OPENAI_API_KEY
  - model_name: azure-claude-sonnet
    litellm_params:
      model: azure_ai/claude-sonnet-4-5
      api_key: os.environ/AZURE_AI_API_KEY
      api_base: os.environ/AZURE_AI_API_BASE
  - model_name: novita-deepseek-r1
    litellm_params:
      model: novita/deepseek/deepseek-r1-turbo
      api_key: os.environ/NOVITA_API_KEY

general_settings:
  master_key: os.environ/LITELLM_MASTER_KEY
```

### .archon/config.yaml (the Archon side)

```yaml
assistants:
  litellm:
    configPath: ~/.archon/litellm_config.yaml
    port: 4000
    masterKeyEnv: LITELLM_MASTER_KEY
    providers:
      anthropic:
        authTokenEnv: ANTHROPIC_API_KEY
      openai:
        authTokenEnv: OPENAI_API_KEY
      azure_ai:
        authTokenEnv: AZURE_AI_API_KEY
        apiBaseEnv: AZURE_AI_API_BASE
      novita:
        authTokenEnv: NOVITA_API_KEY
```

### ~/.archon/.env

```bash
LITELLM_MASTER_KEY=<a-long-random-string>
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
AZURE_AI_API_KEY=...
AZURE_AI_API_BASE=https://<resource>.services.ai.azure.com/anthropic
NOVITA_API_KEY=...
```

---

## How workflows reach LiteLLM

Set a canonical `provider/model` on a node:

```yaml
nodes:
  - id: code-review
    prompt: "Review these changes..."
    model: openai/gpt-4o          # → LiteLLM → OpenAI

  - id: plan
    prompt: "Design the feature..."
    model: anthropic/claude-opus-4-5  # → Claude SDK (direct, preferred when claude binary installed)

  - id: fast-check
    prompt: "Summarize..."
    provider: litellm             # force LiteLLM routing
    model: anthropic/claude-haiku-4-5
```

Model prefixes claimed by LiteLLM: `anthropic/`, `openai/`, `azure/`,
`azure_ai/`, `novita/`.

**Routing precedence**: Claude and LiteLLM both accept `anthropic/*`
prefixes. Claude is registered first in the provider registry, so Claude
SDK wins by default — which matches the "prefer Claude SDK when the binary
is installed" guidance. Force LiteLLM with an explicit `provider: litellm`
on the node.

---

## Fallbacks

Per-request fallback is supported via LiteLLM's `fallbacks: [...]` body
parameter. Archon forwards `options.fallbackModel` automatically:

```yaml
nodes:
  - id: smart-with-backup
    model: openai/gpt-4o
    fallbackModel: anthropic/claude-sonnet-4-5
```

When the primary fails (rate limit, 5xx, content filter), LiteLLM retries
against the fallback in the same request.

---

## Security: pin versions + audit

In March 2026 LiteLLM versions 1.82.7 and 1.82.8 on PyPI were compromised
via a poisoned GitHub Action in LiteLLM's CI/CD. The malicious packages
contained credential-stealer code targeting SSH keys, `.env` files, cloud
tokens, and Kubernetes configs. They were live for ~40 minutes but
downloaded ~119,000 times. Source: [LiteLLM security update
(March 2026)](https://docs.litellm.ai/blog/security-update-march-2026) +
[PyPI incident report](https://blog.pypi.org/posts/2026-04-02-incident-report-litellm-telnyx-supply-chain-attack/).

Archon's response:

- **The setup plugin never auto-installs LiteLLM.** It prints the command;
  the user runs it after auditing.
- **The install command always pins a specific version.** Bump deliberately
  after release-note review.
- **Prefer the official Docker image in production** (cosign-signed as of
  the post-incident CI/CD rebuild).

---

## Known gaps

- **OpenAI Codex models**: `gpt-5-codex`, `codex-mini` are served only via
  the OpenAI Responses API. LiteLLM's `/v1/responses` route exists but
  Codex models are not documented as supported — treat as "route through
  chat completions for now; Codex-specific models require an upgrade once
  LiteLLM adds explicit support."

- **Anthropic streaming + tool use through LiteLLM** had recurring bugs in
  v1.82.x (issues #4495, #25321). Archon prefers Claude SDK for Anthropic
  models when the `claude` binary is installed; LiteLLM is the path only
  when the user explicitly sets `provider: litellm` OR the binary is
  missing.

- **Azure AI Foundry gotchas**:
  - Use the `azure_ai/` prefix, **not** `azure/`. They're separate LiteLLM
    providers.
  - Env vars are `AZURE_AI_API_KEY` + `AZURE_AI_API_BASE` (not
    `AZURE_API_KEY`).
  - `AZURE_AI_API_BASE` should end at the resource endpoint — LiteLLM
    appends `/v1/messages` automatically.
  - Auth header is `api-key` (Azure convention), not `x-api-key`.

- **Tool calling / structured output**: the LiteLLM provider MVP is
  text-only. Function calling + `response_format: json_schema` translation
  to Archon's `tool` / `tool_result` / structuredOutput chunks is on the
  follow-up list.

---

## Troubleshooting

- **"LiteLLM master key not found in env var 'LITELLM_MASTER_KEY'"** —
  your `~/.archon/.env` is missing the generated master key. Replace
  `change-me-before-first-run` with a real value (any random string ≥ 16
  chars).

- **"litellm proxy did not become ready within 30000ms"** — the proxy
  subprocess started but never accepted the `/health/liveliness` probe.
  The error message includes the last 4KB of the proxy's stderr — scan
  for upstream auth errors (most common) or Python traceback.

- **"Failed to spawn litellm proxy (litellm)"** — the `litellm` binary
  isn't on `PATH`. Either install it (`uv tool install
  'litellm[proxy]==<version>'`) or set `assistants.litellm.litellmBinaryPath`
  in `.archon/config.yaml`.
