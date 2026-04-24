# Archon developer install.
#
# Typical usage (runs targets in order — `install` is idempotent so it's
# always safe to re-run):
#
#   make install            # Bun deps + link the `archon` CLI globally
#   make install claude     # above, then install or update Claude Code
#   make install opencode   # above, then install or update OpenCode
#   make install pydantic   # above, then install or update uv (for BYO Pydantic AI agents)
#
#   make claude             # install/update Claude Code only (assumes `make install` already ran)
#   make opencode           # install/update OpenCode only
#   make pydantic           # install/update uv only
#
#   make bootstrap          # install + Claude + archon setup (most common one-shot flow)
#   make bootstrap-claude   # alias for `bootstrap`
#   make bootstrap-opencode # install + OpenCode + archon setup
#   make bootstrap-pydantic # install + uv + archon setup
#
#   make validate           # run the full validate suite (type-check, lint, tests)
#
# Every target is idempotent — re-running updates in place. Runtime installers
# (Anthropic's, OpenCode's, Astral's) handle both fresh installs and upgrades.

.PHONY: help install claude opencode pydantic setup bootstrap bootstrap-claude bootstrap-opencode bootstrap-pydantic validate check-bun check-curl

.DEFAULT_GOAL := help

help:
	@echo 'Archon — developer setup'
	@echo ''
	@echo 'Targets:'
	@echo '  make install             Install Bun deps and link the `archon` CLI globally.'
	@echo '  make install claude      Above, then install or update Claude Code.'
	@echo '  make install opencode    Above, then install or update OpenCode.'
	@echo '  make install pydantic    Above, then install or update uv (for BYO Pydantic AI agents).'
	@echo ''
	@echo '  make claude              Install/update Claude Code only.'
	@echo '  make opencode            Install/update OpenCode only.'
	@echo '  make pydantic            Install/update uv only.'
	@echo ''
	@echo '  make bootstrap           One-shot: install + Claude + `archon setup` wizard.'
	@echo '  make bootstrap-opencode  One-shot: install + OpenCode + `archon setup` wizard.'
	@echo '  make bootstrap-pydantic  One-shot: install + uv + `archon setup` wizard.'
	@echo ''
	@echo '  make validate            Run the full validate suite (type-check, lint, tests).'
	@echo ''
	@echo 'All targets are idempotent. Runtime installers handle both fresh installs and upgrades.'

check-bun:
	@command -v bun >/dev/null 2>&1 || { \
	  echo 'error: bun is required. Install from https://bun.sh and re-run.'; \
	  exit 1; \
	}

check-curl:
	@command -v curl >/dev/null 2>&1 || { \
	  echo 'error: curl is required to install AI runtimes. Install curl and re-run.'; \
	  exit 1; \
	}

install: check-bun
	@echo '→ Installing workspace dependencies (Bun)'
	bun install
	@echo '→ Linking the `archon` CLI globally'
	@# `bun link` in the CLI package registers @archon/cli so the `archon` bin
	@# lands on PATH via bun's global link dir. Idempotent — re-running
	@# just re-registers the link.
	cd packages/cli && bun link
	@echo ''
	@echo 'Archon installed. Verify with `archon --help` (or `bun run cli --help` if the link did not take).'
	@echo 'Next: configure an AI runtime with `make claude`, `make opencode`, or `make pydantic`.'

claude: check-curl install
	@echo '→ Installing or updating Claude Code'
	@if command -v claude >/dev/null 2>&1; then \
	  echo "  Claude Code already at $$(command -v claude) — running the installer will update it to latest."; \
	else \
	  echo "  Claude Code not detected — installing fresh."; \
	fi
	curl -fsSL https://claude.ai/install.sh | bash
	@echo ''
	@echo 'Claude Code ready. If `claude` is not on PATH, add $$HOME/.local/bin.'
	@echo 'Next: run `archon setup` to configure Archon to use Claude.'

opencode: check-curl install
	@echo '→ Installing or updating OpenCode'
	@if command -v opencode >/dev/null 2>&1; then \
	  echo "  OpenCode already at $$(command -v opencode) — running the installer will update it to latest."; \
	else \
	  echo "  OpenCode not detected — installing fresh."; \
	fi
	curl -fsSL https://opencode.ai/install | bash
	@echo ''
	@echo 'OpenCode ready. Export an upstream API key (e.g. OPENAI_API_KEY) in your shell.'
	@echo 'Next: run `archon setup` — the OpenCode plugin will detect the binary and walk you through auth mapping.'

pydantic: check-curl install
	@echo '→ Installing or updating uv (Astral, for Pydantic AI agent scripts)'
	@if command -v uv >/dev/null 2>&1; then \
	  echo "  uv already at $$(command -v uv) — running `uv self update`."; \
	  uv self update || echo '  (self-update failed; uv is still usable — upgrade manually if needed)'; \
	else \
	  curl -LsSf https://astral.sh/uv/install.sh | sh; \
	fi
	@echo ''
	@echo 'uv ready. Add Python agents under .archon/agents/ (one module-level `agent: pydantic_ai.Agent` each).'
	@echo 'Next: run `archon setup` — the Pydantic plugin scans .archon/agents/ and prints a config snippet.'

setup: check-bun
	@echo '→ Running `archon setup` wizard'
	@# Interactive — detects every installed runtime (claude, opencode, uv) and
	@# walks the user through auth mapping. Safe to re-run; merges with any
	@# existing ~/.archon/.env.
	bun run cli setup

# One-shot bootstrap chains — install everything + run the wizard in one go.
# New contributors should typically use one of these instead of stitching
# install/runtime/setup together by hand. Each chain is idempotent because
# every dependency target is idempotent.
bootstrap: bootstrap-claude

bootstrap-claude: install claude setup

bootstrap-opencode: install opencode setup

bootstrap-pydantic: install pydantic setup

validate: check-bun
	bun run validate
