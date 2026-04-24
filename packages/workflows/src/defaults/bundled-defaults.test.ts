import { describe, it, expect } from 'bun:test';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import {
  isBinaryBuild,
  BUNDLED_COMMANDS,
  BUNDLED_WORKFLOWS,
  BUNDLED_SKILLS,
  BUNDLED_AGENTS,
  BUNDLED_MODELS_YAML,
} from './bundled-defaults';

// Resolve the on-disk defaults directories relative to this test file so the
// tests work regardless of cwd. From packages/workflows/src/defaults go up
// four levels to the repo root, then into .archon/.
const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..');
const COMMANDS_DIR = join(REPO_ROOT, '.archon/commands/defaults');
const WORKFLOWS_DIR = join(REPO_ROOT, '.archon/workflows/defaults');
const SKILLS_DIR = join(REPO_ROOT, '.archon/skills/defaults');
const AGENTS_DIR = join(REPO_ROOT, '.archon/agents/defaults');
const MODELS_YAML_PATH = join(REPO_ROOT, '.archon/models.defaults.yaml');

describe('bundled-defaults', () => {
  describe('isBinaryBuild', () => {
    it('should return false in dev/test mode', () => {
      // `isBinaryBuild()` reads the build-time constant `BUNDLED_IS_BINARY` from
      // `@archon/paths`. In dev/test mode it is `false`. It is only rewritten to
      // `true` by `scripts/build-binaries.sh` before `bun build --compile`.
      // Coverage of the `true` branch is via local binary smoke testing (see #979).
      expect(isBinaryBuild()).toBe(false);
    });
  });

  describe('bundle completeness', () => {
    // These assertions are the canary for bundle drift: if someone adds a
    // default file without regenerating bundled-defaults.generated.ts, the
    // bundle would be missing in compiled binaries (see #979 context). The
    // generator is `scripts/generate-bundled-defaults.ts`, and
    // `bun run check:bundled` verifies the generated file is up to date.

    it('BUNDLED_COMMANDS contains every .md file in .archon/commands/defaults/', () => {
      const onDisk = readdirSync(COMMANDS_DIR)
        .filter(f => f.endsWith('.md'))
        .map(f => f.slice(0, -'.md'.length))
        .sort();
      expect(Object.keys(BUNDLED_COMMANDS).sort()).toEqual(onDisk);
    });

    it('BUNDLED_WORKFLOWS contains every .yaml/.yml file in .archon/workflows/defaults/', () => {
      const onDisk = readdirSync(WORKFLOWS_DIR)
        .filter(f => f.endsWith('.yaml') || f.endsWith('.yml'))
        .map(f => f.replace(/\.ya?ml$/, ''))
        .sort();
      expect(Object.keys(BUNDLED_WORKFLOWS).sort()).toEqual(onDisk);
    });

    it('bundled content matches on-disk file content (defense against generator corruption)', () => {
      // Bundled content is LF-normalized by the generator so it stays identical
      // regardless of the checkout's line-ending policy. Match that here.
      const readLF = (path: string): string => readFileSync(path, 'utf-8').replace(/\r\n/g, '\n');

      for (const [name, content] of Object.entries(BUNDLED_COMMANDS)) {
        const diskContent = readLF(join(COMMANDS_DIR, `${name}.md`));
        expect(content).toBe(diskContent);
      }
      for (const [name, content] of Object.entries(BUNDLED_WORKFLOWS)) {
        // Workflows may be .yaml or .yml — prefer .yaml, fall back.
        let diskContent: string;
        try {
          diskContent = readLF(join(WORKFLOWS_DIR, `${name}.yaml`));
        } catch {
          diskContent = readLF(join(WORKFLOWS_DIR, `${name}.yml`));
        }
        expect(content).toBe(diskContent);
      }
    });
  });

  describe('BUNDLED_COMMANDS', () => {
    it('every command has meaningful content (>50 chars)', () => {
      for (const content of Object.values(BUNDLED_COMMANDS)) {
        expect(content.length).toBeGreaterThan(50);
      }
    });

    it('archon-pr-review-scope should read .pr-number before other discovery', () => {
      const content = BUNDLED_COMMANDS['archon-pr-review-scope'];
      expect(content).toContain('$ARTIFACTS_DIR/.pr-number');
      expect(content).toContain('PR_NUMBER=$(cat $ARTIFACTS_DIR/.pr-number');
    });

    it('archon-create-pr should write .pr-number to artifacts', () => {
      const content = BUNDLED_COMMANDS['archon-create-pr'];
      expect(content).toContain('echo "$PR_NUMBER" > "$ARTIFACTS_DIR/.pr-number"');
    });
  });

  describe('BUNDLED_WORKFLOWS', () => {
    it('every workflow has meaningful content (>50 chars)', () => {
      for (const content of Object.values(BUNDLED_WORKFLOWS)) {
        expect(content.length).toBeGreaterThan(50);
      }
    });

    it('archon-workflow-builder should have validate-before-save node ordering and key constraints', () => {
      const content = BUNDLED_WORKFLOWS['archon-workflow-builder'];
      expect(content).toContain('id: validate-yaml');
      expect(content).toContain('depends_on: [validate-yaml]');
      expect(content).toContain('denied_tools: [Edit, Bash]');
      expect(content).toContain('output_format:');
      expect(content).toContain('workflow_name');
    });

    it('archon-adversarial-dev init-workspace should avoid non-portable sed -i', () => {
      const content = BUNDLED_WORKFLOWS['archon-adversarial-dev'];
      expect(content).toContain('STATE_TMP="$ARTIFACTS/state.json.tmp"');
      expect(content).toContain(
        'sed "s/SPRINT_COUNT_PLACEHOLDER/$SPRINT_COUNT/" "$ARTIFACTS/state.json" > "$STATE_TMP"'
      );
      expect(content).not.toContain('sed -i "s/SPRINT_COUNT_PLACEHOLDER/$SPRINT_COUNT/"');
    });

    it('should have valid YAML structure', () => {
      for (const content of Object.values(BUNDLED_WORKFLOWS)) {
        expect(content).toContain('name:');
        expect(content).toContain('description:');
        expect(content.includes('nodes:')).toBe(true);
      }
    });

    it('the bundled `feature` workflow chains brainstorm → plan → approval → implement → review → finish and references superpowers skills + the code-reviewer agent', () => {
      const content = BUNDLED_WORKFLOWS.feature;
      expect(content).toBeDefined();
      // Node IDs in order
      for (const id of ['brainstorm', 'plan', 'approval-gate', 'implement', 'review', 'finish']) {
        expect(content).toContain(`id: ${id}`);
      }
      // Skill / agent references from the vendored superpowers library
      for (const skill of [
        'brainstorming',
        'writing-plans',
        'executing-plans',
        'test-driven-development',
        'finishing-a-development-branch',
      ]) {
        expect(content).toContain(skill);
      }
      expect(content).toContain('code-reviewer');
      // Approval gate uses Archon's native shape
      expect(content).toContain('approval:');
      expect(content).toContain('capture_response: true');
    });
  });

  describe('BUNDLED_SKILLS', () => {
    it('contains every skill directory in .archon/skills/defaults/', () => {
      const onDisk = readdirSync(SKILLS_DIR)
        .filter(name => {
          const p = join(SKILLS_DIR, name);
          if (!statSync(p).isDirectory()) return false;
          return existsSync(join(p, 'SKILL.md'));
        })
        .sort();
      expect(Object.keys(BUNDLED_SKILLS).sort()).toEqual(onDisk);
    });

    it('every skill has YAML frontmatter + non-trivial body', () => {
      for (const [name, content] of Object.entries(BUNDLED_SKILLS)) {
        expect(content.startsWith('---')).toBe(true);
        expect(content.length).toBeGreaterThan(100);
        expect(content).toContain(`name: ${name}`);
      }
    });

    it('includes the core superpowers skills', () => {
      // Acts as a canary against silent content loss during a sync.
      for (const required of [
        'systematic-debugging',
        'test-driven-development',
        'writing-plans',
        'brainstorming',
      ]) {
        expect(BUNDLED_SKILLS[required]).toBeDefined();
      }
    });
  });

  describe('BUNDLED_AGENTS', () => {
    it('contains every .md file in .archon/agents/defaults/', () => {
      const onDisk = readdirSync(AGENTS_DIR)
        .filter(f => f.endsWith('.md'))
        .map(f => f.slice(0, -'.md'.length))
        .sort();
      expect(Object.keys(BUNDLED_AGENTS).sort()).toEqual(onDisk);
    });

    it('every agent has YAML frontmatter', () => {
      for (const [name, content] of Object.entries(BUNDLED_AGENTS)) {
        expect(content.startsWith('---')).toBe(true);
        expect(content).toContain(`name: ${name}`);
      }
    });
  });

  describe('BUNDLED_MODELS_YAML', () => {
    it('matches .archon/models.defaults.yaml byte-for-byte (LF-normalized)', () => {
      const disk = readFileSync(MODELS_YAML_PATH, 'utf-8').replace(/\r\n/g, '\n');
      expect(BUNDLED_MODELS_YAML).toBe(disk);
    });

    it('declares version 1 and covers every vendored skill/agent', () => {
      expect(BUNDLED_MODELS_YAML).toContain('version: 1');
      for (const skillName of Object.keys(BUNDLED_SKILLS)) {
        expect(BUNDLED_MODELS_YAML).toContain(`${skillName}:`);
      }
      for (const agentName of Object.keys(BUNDLED_AGENTS)) {
        expect(BUNDLED_MODELS_YAML).toContain(`${agentName}:`);
      }
    });
  });
});
