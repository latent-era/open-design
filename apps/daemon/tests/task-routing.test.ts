import { describe, expect, it } from 'vitest';

import {
  TOKENS_PER_IMAGE,
  estimateTaskTokens,
  routeByTaskShape,
  routingCandidatesFromAgents,
} from '../src/task-routing.js';

/** Every case below asserts a decision was reached; null is its own test. */
function nonNull<T>(value: T | null): T {
  if (value === null) throw new Error('expected a routing decision');
  return value;
}

/**
 * Whole-project reasoning does not fit a 65k window and never will. The local
 * 35B gets 65,536 tokens; a project of any size plus a few reference images is
 * over that before the model has done anything. Sol has 1M.
 *
 * The user should not have to know this. They should not be picking a model by
 * guessing whether their question is "big". The shape of the task decides.
 */
describe('estimateTaskTokens', () => {
  it('scales with the amount of source in play', () => {
    const small = estimateTaskTokens({ sourceBytes: 4_000 });
    const large = estimateTaskTokens({ sourceBytes: 400_000 });
    expect(large).toBeGreaterThan(small);
  });

  it('reproduces the measured 95 KB + 8 images case', () => {
    // The one real calibration point on record: 95 KB of source with 8 images
    // came to roughly 48k tokens before any work began, against a 65,536
    // ceiling. The estimator has to land near that or every decision built on
    // it is wrong.
    const estimate = estimateTaskTokens({ sourceBytes: 95_000, imageCount: 8 });
    expect(estimate).toBeGreaterThan(40_000);
    expect(estimate).toBeLessThan(56_000);
  });

  it('counts images as a substantial fixed cost', () => {
    const withoutImages = estimateTaskTokens({ sourceBytes: 10_000 });
    const withImages = estimateTaskTokens({ sourceBytes: 10_000, imageCount: 3 });
    expect(withImages - withoutImages).toBe(3 * TOKENS_PER_IMAGE);
  });

  it('never returns a negative or NaN estimate for junk input', () => {
    expect(estimateTaskTokens({ sourceBytes: -5 })).toBeGreaterThanOrEqual(0);
    expect(estimateTaskTokens({ sourceBytes: Number.NaN })).toBeGreaterThanOrEqual(0);
  });
});

const LOCAL = { agentId: 'opencode', model: 'qwen3.6-35b', local: true } as const;
const SOL = { agentId: 'codex', model: 'gpt-5.6-sol', local: false } as const;

describe('routeByTaskShape', () => {
  it('keeps a small task on the local model', () => {
    // Local is preferred whenever it genuinely fits: it is free, private and
    // the host is right here. Routing everything to Sol to be safe would make
    // local runs pointless.
    const decision = nonNull(routeByTaskShape({
      estimatedTokens: 8_000,
      candidates: [LOCAL, SOL],
    }));
    expect(decision.agentId).toBe('opencode');
    expect(decision.fits).toBe(true);
  });

  it('routes a whole-project task to the large window', () => {
    const decision = nonNull(routeByTaskShape({
      estimatedTokens: 480_000,
      candidates: [LOCAL, SOL],
    }));
    expect(decision.agentId).toBe('codex');
    expect(decision.fits).toBe(true);
  });

  it('leaves headroom rather than filling the window to the brim', () => {
    // 60k of 65,536 "fits" arithmetically and fails in practice — the model
    // still has to produce output, and the meter warns at 80% for a reason.
    const decision = nonNull(routeByTaskShape({
      estimatedTokens: 60_000,
      candidates: [LOCAL, SOL],
    }));
    expect(decision.agentId).toBe('codex');
  });

  it('reports the mismatch instead of silently switching', () => {
    // The user's explicit model choice is not overwritten. The decision names
    // what it would recommend and why, and the caller surfaces it.
    const decision = nonNull(routeByTaskShape({
      estimatedTokens: 480_000,
      candidates: [LOCAL, SOL],
      selectedAgentId: 'opencode',
    }));
    expect(decision.agentId).toBe('codex');
    expect(decision.matchesSelection).toBe(false);
    expect(decision.reason).toBeTruthy();
  });

  it('stays quiet when the selection already suits the task', () => {
    const decision = nonNull(routeByTaskShape({
      estimatedTokens: 8_000,
      candidates: [LOCAL, SOL],
      selectedAgentId: 'opencode',
    }));
    expect(decision.matchesSelection).toBe(true);
  });

  it('picks the largest window and admits it does not fit', () => {
    // Nothing available can hold the task. Saying so beats picking one and
    // letting the turn die at the ceiling.
    const decision = nonNull(routeByTaskShape({
      estimatedTokens: 4_000_000,
      candidates: [LOCAL, SOL],
    }));
    expect(decision.agentId).toBe('codex');
    expect(decision.fits).toBe(false);
  });

  it('prefers the smallest window that comfortably fits', () => {
    // Do not spend a 1M-token model on a task a 200k model holds easily.
    const mid = { agentId: 'claude', model: 'claude-haiku-4-5-20251001', local: false } as const;
    const decision = nonNull(routeByTaskShape({
      estimatedTokens: 120_000,
      candidates: [LOCAL, mid, SOL],
    }));
    expect(decision.agentId).toBe('claude');
  });

  it('ignores candidates whose window is unknown', () => {
    // A missing window is deliberately never guessed — a fabricated
    // denominator routes work to a model that cannot hold it.
    const unknown = { agentId: 'mystery', model: 'not-a-real-model', local: true } as const;
    const decision = nonNull(routeByTaskShape({
      estimatedTokens: 8_000,
      candidates: [unknown, SOL],
    }));
    expect(decision.agentId).toBe('codex');
  });

  it('returns null when there is nothing to choose between', () => {
    expect(routeByTaskShape({ estimatedTokens: 1_000, candidates: [] })).toBeNull();
  });
});

/**
 * The roster the decision runs against. Recommending an agent the user has not
 * installed is worse than recommending nothing: it reads as instruction and
 * cannot be followed.
 */
describe('routingCandidatesFromAgents', () => {
  it('keeps an installed agent with a known window', () => {
    const candidates = routingCandidatesFromAgents([
      { agentId: 'codex', model: 'gpt-5.6-sol', available: true },
    ]);
    expect(candidates.map((c) => c.agentId)).toEqual(['codex']);
  });

  it('drops an agent whose executable is not on this machine', () => {
    const candidates = routingCandidatesFromAgents([
      { agentId: 'codex', model: 'gpt-5.6-sol', available: false },
      { agentId: 'opencode', model: 'qwen3.6-35b', available: true },
    ]);
    expect(candidates.map((c) => c.agentId)).toEqual(['opencode']);
  });

  it('drops an agent whose model could not be resolved', () => {
    expect(routingCandidatesFromAgents([{ agentId: 'x', model: null }])).toEqual([]);
    expect(routingCandidatesFromAgents([{ agentId: 'x', model: '  ' }])).toEqual([]);
  });

  it('drops an agent whose window is unknown rather than guessing one', () => {
    expect(routingCandidatesFromAgents([{ agentId: 'x', model: 'some-new-model' }])).toEqual([]);
  });

  it('keeps one entry per agent', () => {
    const candidates = routingCandidatesFromAgents([
      { agentId: 'codex', model: 'gpt-5.6-sol' },
      { agentId: 'codex', model: 'gpt-5.4' },
    ]);
    expect(candidates).toHaveLength(1);
  });

  it('carries the local flag through so local stays preferred', () => {
    const candidates = routingCandidatesFromAgents([
      { agentId: 'opencode', model: 'qwen3.6-35b', local: true },
    ]);
    expect(candidates[0]?.local).toBe(true);
  });

  it('feeds a real decision end to end', () => {
    // The join that matters: roster in, recommendation out.
    const candidates = routingCandidatesFromAgents([
      { agentId: 'opencode', model: 'qwen3.6-35b', available: true, local: true },
      { agentId: 'codex', model: 'gpt-5.6-sol', available: true },
      { agentId: 'ghost', model: 'gpt-5.6-sol', available: false },
    ]);
    const decision = nonNull(routeByTaskShape({
      estimatedTokens: 480_000,
      candidates,
      selectedAgentId: 'opencode',
    }));
    expect(decision.agentId).toBe('codex');
    expect(decision.matchesSelection).toBe(false);
  });
});
