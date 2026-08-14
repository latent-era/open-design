import {
  CONTEXT_USAGE_WARN_RATIO,
  contextWindowForModel,
} from '@open-design/contracts';

/**
 * Rough characters-per-token for source text. The usual approximation, and
 * good enough for a routing decision whose outcome is a choice between a 65k
 * window and a 1M one — a 20% error either way does not change the answer.
 */
export const CHARS_PER_TOKEN = 4;

/**
 * Tokens charged per attached image, calibrated against the one measurement on
 * record: 95 KB of source plus 8 images came to roughly 48k tokens before any
 * work started. Text accounts for about 24k of that, leaving ~3k an image.
 * The local server's `--image-min-tokens 1024` is the floor, not the typical
 * cost, so the floor would badly under-count.
 */
export const TOKENS_PER_IMAGE = 3_000;

export interface RoutingCandidate {
  agentId: string;
  model: string;
  local?: boolean;
}

export interface RoutingDecision {
  agentId: string;
  model: string;
  contextWindow: number;
  /** False when even the largest available window cannot hold the task. */
  fits: boolean;
  /** False when the recommendation differs from what the user picked. */
  matchesSelection: boolean;
  reason: string;
}

function safeCount(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 0;
  return value;
}

/**
 * Estimate what a task will cost before the model does anything.
 *
 * This is the number the user cannot be expected to work out for themselves,
 * and the reason "which model should I use?" is the wrong question to put to
 * them. A boxing-app-sized project with a handful of reference screenshots is
 * already three quarters of the local window on arrival.
 */
export function estimateTaskTokens(input: {
  sourceBytes: number;
  imageCount?: number;
  promptChars?: number;
}): number {
  const source = safeCount(input.sourceBytes);
  const prompt = safeCount(input.promptChars);
  const images = safeCount(input.imageCount);
  return Math.round((source + prompt) / CHARS_PER_TOKEN + images * TOKENS_PER_IMAGE);
}

/**
 * Narrow the installed agent list down to things worth routing to.
 *
 * Two filters, both about not recommending fiction. An agent whose executable
 * is not on this machine cannot run the task however roomy its window, and an
 * agent whose default model is unresolved has no window to compare — and a
 * guessed window sends real work to a model that cannot hold it.
 */
export function routingCandidatesFromAgents(
  agents: readonly {
    agentId: string;
    model: string | null | undefined;
    available?: boolean;
    local?: boolean;
  }[],
): RoutingCandidate[] {
  const seen = new Set<string>();
  const candidates: RoutingCandidate[] = [];
  for (const agent of agents) {
    if (agent.available === false) continue;
    if (typeof agent.model !== 'string' || !agent.model.trim()) continue;
    if (contextWindowForModel(agent.model) === null) continue;
    if (seen.has(agent.agentId)) continue;
    seen.add(agent.agentId);
    candidates.push({
      agentId: agent.agentId,
      model: agent.model,
      ...(agent.local === undefined ? {} : { local: agent.local }),
    });
  }
  return candidates;
}

/**
 * Choose the agent whose context window suits the shape of the task.
 *
 * Deliberately a recommendation, never a substitution. The user's explicit
 * model choice is theirs; silently re-routing their work to a different model —
 * with different cost, privacy and latency — because a heuristic disagreed is
 * exactly the "helpfully correcting the user" behaviour that has to be shown
 * rather than performed. `matchesSelection` is what the caller surfaces.
 *
 * Preference order among windows that fit: local first (free, private, and the
 * host is on the desk), then the smallest sufficient window, so a 1M model is
 * not spent on a task a smaller one holds comfortably.
 */
export function routeByTaskShape(input: {
  estimatedTokens: number;
  candidates: readonly RoutingCandidate[];
  selectedAgentId?: string;
  headroomRatio?: number;
}): RoutingDecision | null {
  const headroom =
    typeof input.headroomRatio === 'number' && input.headroomRatio > 0 && input.headroomRatio <= 1
      ? input.headroomRatio
      : CONTEXT_USAGE_WARN_RATIO;
  const needed = safeCount(input.estimatedTokens);

  // A candidate whose window is unknown is dropped rather than guessed at. An
  // invented denominator here routes real work to a model that cannot hold it.
  const known = input.candidates
    .map((candidate) => ({
      ...candidate,
      contextWindow: contextWindowForModel(candidate.model),
    }))
    .filter((candidate): candidate is typeof candidate & { contextWindow: number } =>
      typeof candidate.contextWindow === 'number');
  if (known.length === 0) return null;

  const usable = known.filter((candidate) => candidate.contextWindow * headroom >= needed);
  const decide = () => {
    if (usable.length === 0) {
      // Nothing fits. Pick the biggest and say so, rather than choosing one
      // silently and letting the turn die at the ceiling.
      const largest = [...known].sort((a, b) => b.contextWindow - a.contextWindow)[0]!;
      return {
        candidate: largest,
        fits: false,
        reason:
          `this task needs about ${needed.toLocaleString()} tokens, more than any available ` +
          `model can hold (largest is ${largest.model} at ${largest.contextWindow.toLocaleString()}). ` +
          'Narrow the task or split it across turns.',
      };
    }
    const sorted = [...usable].sort((a, b) => {
      if (!!a.local !== !!b.local) return a.local ? -1 : 1;
      return a.contextWindow - b.contextWindow;
    });
    const chosen = sorted[0]!;
    return {
      candidate: chosen,
      fits: true,
      reason:
        `this task needs about ${needed.toLocaleString()} tokens; ` +
        `${chosen.model} holds ${chosen.contextWindow.toLocaleString()}.`,
    };
  };

  const { candidate, fits, reason } = decide();
  return {
    agentId: candidate.agentId,
    model: candidate.model,
    contextWindow: candidate.contextWindow,
    fits,
    matchesSelection:
      input.selectedAgentId === undefined || input.selectedAgentId === candidate.agentId,
    reason,
  };
}
