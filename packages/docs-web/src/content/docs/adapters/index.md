---
title: Platform Adapters
description: Overview of all platform adapters available for connecting to Archon.
category: adapters
area: adapters
audience: [user, operator]
status: current
sidebar:
  order: 0
---

Archon supports multiple platform adapters. Each adapter connects Archon to a different communication channel, letting you trigger workflows and interact with AI agents from wherever you work.

## Core Adapters

| Adapter | Transport | Auth Required | Setup |
|---------|-----------|---------------|-------|
| [**Web UI**](/adapters/web/) | SSE streaming | None | Built-in |
| [**CLI**](/reference/cli/) | stdout | None | Built-in |
| [**GitHub**](/adapters/github/) | Webhooks | Token + webhook secret | [Setup guide](/adapters/github/) |

## How Adapters Work

All adapters implement the `IPlatformAdapter` interface. They handle:

- **Message ingestion** -- receiving messages from the platform and forwarding them to Archon's orchestrator
- **Response delivery** -- streaming or batching AI responses back to the platform
- **Authorization** -- optional user whitelists to restrict access
- **Conversation tracking** -- mapping platform-specific identifiers (thread IDs, chat IDs, issue numbers) to Archon conversations

## Choosing an Adapter

- **Web UI** is the fastest way to get started -- no tokens or external services needed.
- **GitHub** integrates directly into your issue and PR workflow via webhooks.

You can run Web UI and GitHub simultaneously. The GitHub adapter starts automatically when `GITHUB_TOKEN` and `WEBHOOK_SECRET` are set.
