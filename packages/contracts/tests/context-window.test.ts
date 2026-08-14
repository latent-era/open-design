import { describe, expect, it } from 'vitest';

import {
  contextUsage,
  contextWindowForModel,
  CONTEXT_USAGE_WARN_RATIO,
} from '../src/models/context-window.js';

/**
 * The context meter's arithmetic.
 *
 * `input_tokens` from a run's usage event over the model's window. The window
 * is per-model and must not be guessed: a local 35B conversation that exceeds
 * 65,536 fails every turn, and the user's only signal today is the failure.
 */
describe('contextWindowForModel', () => {
  it('knows the local models the host actually runs', () => {
    // These are measured, not nominal: -c 196608 divided by the server's
    // --parallel count is what one conversation actually gets.
    expect(contextWindowForModel('qwen3.6-35b')).toBe(65_536);
    expect(contextWindowForModel('qwen3.6-27b')).toBe(98_304);
  });

  it('returns null for a model it has no figure for', () => {
    // Better no meter than a wrong one — a fabricated denominator would
    // under-report usage and the user would hit the ceiling unwarned.
    expect(contextWindowForModel('some-unknown-model')).toBeNull();
  });
});

describe('contextUsage', () => {
  it('reports the fraction of the window used', () => {
    const usage = contextUsage({ inputTokens: 32_768, model: 'qwen3.6-35b' });
    expect(usage).toMatchObject({ used: 32_768, limit: 65_536, ratio: 0.5 });
  });

  it('stays quiet below the warning threshold', () => {
    expect(contextUsage({ inputTokens: 1_000, model: 'qwen3.6-35b' })?.level).toBe('ok');
  });

  it('warns past the threshold', () => {
    const usage = contextUsage({
      inputTokens: Math.ceil(65_536 * CONTEXT_USAGE_WARN_RATIO) + 1,
      model: 'qwen3.6-35b',
    });
    expect(usage?.level).toBe('warn');
  });

  it('reports a conversation that is already over the ceiling', () => {
    // The state conversation 0863112c was in: 69,553 tokens against a 65,536
    // window, failing every turn with nothing on screen explaining why.
    const usage = contextUsage({ inputTokens: 69_553, model: 'qwen3.6-35b' });
    expect(usage?.level).toBe('over');
    expect(usage?.ratio).toBeGreaterThan(1);
  });

  it('produces nothing when the model has no known window', () => {
    expect(contextUsage({ inputTokens: 1_000, model: 'some-unknown-model' })).toBeNull();
  });

  it('produces nothing before any usage has been reported', () => {
    expect(contextUsage({ inputTokens: null, model: 'qwen3.6-35b' })).toBeNull();
  });
});

describe('provider-prefixed model ids', () => {
  it('resolves the ids the daemon actually reports', () => {
    // Open Design addresses local models as `<provider>/<model>`
    // (qwen_local/qwen3.6-35b), while the window figures are keyed by the bare
    // model. Without stripping, every local conversation has an unknown window
    // and the meter silently never renders.
    expect(contextWindowForModel('qwen_local/qwen3.6-35b')).toBe(65_536);
    expect(contextWindowForModel('qwen_local/qwen3.6-27b')).toBe(98_304);
  });

  it('knows the DeepSeek runtime, which has its own context flag', () => {
    // ds4-server is a separate binary started with --ctx 262144; it does not
    // share the llama-server pool the Qwen figures come from.
    expect(contextWindowForModel('deepseek_local/deepseek-v4-flash-0731-q2'))
      .toBe(262_144);
  });

  it('still resolves a bare id', () => {
    expect(contextWindowForModel('qwen3.6-35b')).toBe(65_536);
  });

  it('does not invent a window for an unknown prefixed model', () => {
    expect(contextWindowForModel('qwen_local/some-future-model')).toBeNull();
  });
});
