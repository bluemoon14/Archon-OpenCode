/**
 * MCP tool `archon_plan_session` — rank skills by relevance to a stated goal.
 *
 * v1 uses simple token-overlap scoring against each skill's description:
 * lowercased, punctuation-stripped, stopword-trimmed, dedup'd. Top-N returned
 * with a numeric score. Deliberately does NOT call an LLM — this is a
 * discoverability aid for the caller (the outer AI), not a planning oracle.
 *
 * Future: when Archon has a sampling/budget context per MCP session, upgrade
 * to an actual model call that reads the skill bodies in addition to
 * descriptions. Until then, token-overlap is good enough to surface
 * "brainstorming" for "I'm stuck" without the latency/cost hit.
 */
import { createSkillAgentRegistry } from '@archon/workflows/skill-agent-registry';

export interface PlanSessionInput {
  /** Free-form description of what the user is trying to do. */
  goal: string;
  /** Max results. Default 5. */
  limit?: number;
}

export interface PlanSessionOutput {
  goal: string;
  suggestions: {
    name: string;
    description: string;
    score: number;
  }[];
}

/**
 * Very small stopword set — just the high-frequency English words that
 * would otherwise dominate overlap scores. Intentionally tiny; the user's
 * goal string is usually short + action-focused so tokenization errors
 * matter more than exhaustive coverage.
 */
const STOPWORDS = new Set([
  'the',
  'a',
  'an',
  'and',
  'or',
  'of',
  'to',
  'in',
  'on',
  'at',
  'for',
  'with',
  'is',
  'it',
  'this',
  'that',
  'be',
  'are',
  'was',
  'were',
  'i',
  'my',
  'me',
  'we',
  'our',
  'you',
  'your',
  'use',
  'using',
]);

function tokenize(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 2) continue;
    if (STOPWORDS.has(raw)) continue;
    out.add(raw);
  }
  return out;
}

export async function planSession(
  input: PlanSessionInput,
  cwd: string
): Promise<PlanSessionOutput> {
  const goalTokens = tokenize(input.goal);
  if (goalTokens.size === 0) {
    return { goal: input.goal, suggestions: [] };
  }

  const registry = createSkillAgentRegistry({ repoRoot: cwd });
  const summaries = await registry.listSkills();

  const scored = await Promise.all(
    summaries.map(async s => {
      // `listSkills` returns just `{name, source}`; we need the description
      // to score. The registry's `loadSkill` is cheap for already-loaded
      // bundled content; cost is a fraction of a single model call.
      const skill = await registry.loadSkill(s.name);
      const skillTokens = tokenize(`${skill.name} ${skill.description}`);
      let overlap = 0;
      for (const t of goalTokens) if (skillTokens.has(t)) overlap++;
      return { name: skill.name, description: skill.description, score: overlap };
    })
  );

  const limit = input.limit ?? 5;
  return {
    goal: input.goal,
    suggestions: scored
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
      .slice(0, limit),
  };
}
