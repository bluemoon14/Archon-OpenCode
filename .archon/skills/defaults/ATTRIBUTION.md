# Superpowers vendoring — attribution

Archon vendors a subset of [obra/superpowers](https://github.com/obra/superpowers)
under this directory (`.archon/skills/defaults/`) and `.archon/agents/defaults/`.

- Upstream repo: https://github.com/obra/superpowers
- Pinned tag: v5.0.7
- Pinned commit: dd7a63ac45233dce0a6c6222a77f205ee7c78750
- License: MIT (see LICENSE in this directory)

Content is copied verbatim from the upstream `skills/` and `agents/` directories
by `scripts/sync-superpowers.ts`. Do not hand-edit files here — changes will be
overwritten on the next sync. To modify content locally, add an override at
`.archon/skills/<name>/` or `.archon/agents/<name>.md` (not under `defaults/`)
so Archon's loader picks it up via the project tier.
