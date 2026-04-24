#!/usr/bin/env bun
/**
 * Vendor obra/superpowers skills + agents into Archon's bundled defaults.
 *
 * Maintainer-only script. Run once per Archon release (or when upstream adds
 * content we want to pull in). Clones the upstream repo at a pinned commit,
 * copies the `skills/` + `agents/` + `LICENSE` files into
 * `.archon/{skills,agents}/defaults/`, and refreshes
 * `packages/workflows/src/defaults/bundled-defaults.generated.ts` via
 * `bun run generate:bundled`.
 *
 * The pinned SHA is hard-coded below. To bump: update SUPERPOWERS_COMMIT to a
 * commit on obra/superpowers@main (or a tag SHA), re-run this script, review
 * the diff, commit the result with `chore(superpowers): bump to <sha>`.
 *
 * Why vendoring (rather than runtime install): superpowers must ship inside
 * the Archon binary with no network dependency at install or run time. See
 * ~/.claude/plans/resilient-coalescing-hickey.md §A for the hard commitment.
 *
 * Usage:
 *   bun run scripts/sync-superpowers.ts          # clone + copy + regen bundle
 *   bun run scripts/sync-superpowers.ts --check  # regen with stored content and
 *                                                #   verify the bundle is fresh
 *                                                #   (for CI — does not clone)
 */
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Pinned upstream commit — obra/superpowers v5.0.7
// https://github.com/obra/superpowers/releases/tag/v5.0.7
const SUPERPOWERS_COMMIT = 'dd7a63ac45233dce0a6c6222a77f205ee7c78750';
const SUPERPOWERS_TAG = 'v5.0.7';
const SUPERPOWERS_REPO = 'https://github.com/obra/superpowers.git';

const REPO_ROOT = resolve(import.meta.dir, '..');
const SKILLS_DEFAULTS = join(REPO_ROOT, '.archon/skills/defaults');
const AGENTS_DEFAULTS = join(REPO_ROOT, '.archon/agents/defaults');
const ATTRIBUTION_PATH = join(REPO_ROOT, '.archon/skills/defaults/ATTRIBUTION.md');
const LICENSE_PATH = join(REPO_ROOT, '.archon/skills/defaults/LICENSE');

const CHECK_ONLY = process.argv.includes('--check');

function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string } = {}
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', rejectPromise);
    child.on('close', (code: number | null) => {
      resolvePromise({ code: code ?? 0, stdout, stderr });
    });
  });
}

async function cloneAtCommit(commit: string): Promise<string> {
  const workDir = await mkdtemp(join(tmpdir(), 'archon-superpowers-'));
  console.log(`[sync] cloning ${SUPERPOWERS_REPO} into ${workDir}`);
  const clone = await run('git', ['clone', '--filter=blob:none', SUPERPOWERS_REPO, workDir]);
  if (clone.code !== 0) {
    throw new Error(`git clone failed: ${clone.stderr}`);
  }
  const checkout = await run('git', ['checkout', '--detach', commit], { cwd: workDir });
  if (checkout.code !== 0) {
    throw new Error(`git checkout ${commit} failed: ${checkout.stderr}`);
  }
  return workDir;
}

async function syncContent(upstreamRoot: string): Promise<void> {
  // Wipe and re-copy so removed files from upstream disappear from our vendor tree.
  await rm(SKILLS_DEFAULTS, { recursive: true, force: true });
  await rm(AGENTS_DEFAULTS, { recursive: true, force: true });
  await mkdir(SKILLS_DEFAULTS, { recursive: true });
  await mkdir(AGENTS_DEFAULTS, { recursive: true });

  console.log(`[sync] copying skills/ → ${SKILLS_DEFAULTS}`);
  await cp(join(upstreamRoot, 'skills'), SKILLS_DEFAULTS, { recursive: true });

  console.log(`[sync] copying agents/ → ${AGENTS_DEFAULTS}`);
  await cp(join(upstreamRoot, 'agents'), AGENTS_DEFAULTS, { recursive: true });

  const license = await readFile(join(upstreamRoot, 'LICENSE'), 'utf-8');
  await writeFile(LICENSE_PATH, license, 'utf-8');

  await writeFile(
    ATTRIBUTION_PATH,
    `# Superpowers vendoring — attribution

Archon vendors a subset of [obra/superpowers](https://github.com/obra/superpowers)
under this directory (\`.archon/skills/defaults/\`) and \`.archon/agents/defaults/\`.

- Upstream repo: https://github.com/obra/superpowers
- Pinned tag: ${SUPERPOWERS_TAG}
- Pinned commit: ${SUPERPOWERS_COMMIT}
- License: MIT (see LICENSE in this directory)

Content is copied verbatim from the upstream \`skills/\` and \`agents/\` directories
by \`scripts/sync-superpowers.ts\`. Do not hand-edit files here — changes will be
overwritten on the next sync. To modify content locally, add an override at
\`.archon/skills/<name>/\` or \`.archon/agents/<name>.md\` (not under \`defaults/\`)
so Archon's loader picks it up via the project tier.
`,
    'utf-8'
  );

  console.log('[sync] wrote ATTRIBUTION.md + LICENSE');
}

async function regenBundle(): Promise<void> {
  console.log('[sync] regenerating bundled-defaults.generated.ts');
  const result = await run('bun', ['run', 'generate:bundled'], { cwd: REPO_ROOT });
  if (result.code !== 0) {
    throw new Error(`generate:bundled failed:\n${result.stdout}${result.stderr}`);
  }
  process.stdout.write(result.stdout);
}

async function checkBundle(): Promise<void> {
  console.log('[sync] verifying bundle is fresh (check-only mode)');
  const result = await run('bun', ['run', 'check:bundled'], { cwd: REPO_ROOT });
  process.stdout.write(result.stdout);
  if (result.code !== 0) {
    console.error(result.stderr);
    throw new Error("check:bundled reported stale bundle — run 'bun run generate:bundled'");
  }
}

async function main(): Promise<void> {
  if (CHECK_ONLY) {
    await checkBundle();
    return;
  }

  let workDir: string | undefined;
  try {
    workDir = await cloneAtCommit(SUPERPOWERS_COMMIT);
    await syncContent(workDir);
    await regenBundle();
    console.log(
      `[sync] done. Vendored superpowers ${SUPERPOWERS_TAG} (${SUPERPOWERS_COMMIT.slice(0, 10)})`
    );
  } finally {
    if (workDir !== undefined) {
      await rm(workDir, { recursive: true, force: true });
    }
  }
}

main().catch(err => {
  console.error('[sync] failed:', err);
  process.exit(1);
});
