import { describe, expect, it } from 'vitest';

import {
  compactionStage,
  conversationContextUsage,
  latestHandoff,
} from '../src/runtime/context-meter';
import { CONTEXT_CLEAR_PROMPT } from '@open-design/contracts';
import type { AppConfig, ChatMessage } from '../src/types';

/**
 * What the context meter reads.
 *
 * The size that matters is the context the NEXT turn will send, so the meter
 * reads the most recent usage report and measures it against the model that
 * turn will run on.
 */

function config(model: string | null): AppConfig {
  return {
    agentId: 'opencode',
    ...(model ? { agentModels: { opencode: { model } } } : {}),
  } as AppConfig;
}

function turn(id: string, inputTokens: number | undefined): ChatMessage {
  return {
    id,
    role: 'assistant',
    content: '',
    events: inputTokens === undefined ? [] : [{ kind: 'usage', inputTokens }],
  } as ChatMessage;
}

describe('conversationContextUsage', () => {
  it('measures the latest reported context against the model window', () => {
    const usage = conversationContextUsage(
      [turn('m1', 10_000)],
      config('qwen3.6-35b'),
    );
    expect(usage).toMatchObject({ used: 10_000, limit: 65_536, level: 'ok' });
  });

  it('reads the most recent turn, not the largest', () => {
    // Compaction is the whole point of the meter: after it, context DROPS.
    // Taking the maximum would leave the meter pinned at the pre-compaction
    // figure and the user unable to see that compaction worked.
    const usage = conversationContextUsage(
      [turn('m1', 60_000), turn('m2', 8_000)],
      config('qwen3.6-35b'),
    );
    expect(usage?.used).toBe(8_000);
  });

  it('ignores turns that reported no usage', () => {
    // A prose-only or failed turn reports nothing; it must not read as a
    // conversation that suddenly shrank to zero.
    const usage = conversationContextUsage(
      [turn('m1', 40_000), turn('m2', undefined)],
      config('qwen3.6-35b'),
    );
    expect(usage?.used).toBe(40_000);
  });

  it('warns as the conversation approaches the ceiling', () => {
    const usage = conversationContextUsage(
      [turn('m1', 60_000)],
      config('qwen3.6-35b'),
    );
    expect(usage?.level).toBe('warn');
  });

  it('reports a conversation past the ceiling', () => {
    // The 0863112c case: over the 35B window, failing every turn, with
    // nothing on screen saying why.
    const usage = conversationContextUsage(
      [turn('m1', 69_553)],
      config('qwen3.6-35b'),
    );
    expect(usage?.level).toBe('over');
  });

  it('shows nothing when the model window is unknown', () => {
    expect(conversationContextUsage([turn('m1', 10_000)], config('mystery-model'))).toBeNull();
  });

  it('shows nothing before the first usage report', () => {
    expect(conversationContextUsage([], config('qwen3.6-35b'))).toBeNull();
  });
});

describe('compactionStage', () => {
  const ask = (id: string): ChatMessage =>
    ({ id, role: 'user', content: CONTEXT_CLEAR_PROMPT } as ChatMessage);
  const reply = (id: string, content: string): ChatMessage =>
    ({ id, role: 'assistant', content, events: [] } as ChatMessage);

  it('is idle in an ordinary conversation', () => {
    expect(compactionStage([turn('m1', 100)])).toBe('idle');
  });

  it('is idle while the handoff is still being written', () => {
    // The reply exists but is empty mid-stream. Offering "continue" here would
    // seed the new conversation with nothing.
    expect(compactionStage([ask('u1'), reply('a1', '')])).toBe('idle');
  });

  it('is ready once the handoff has been written', () => {
    expect(compactionStage([ask('u1'), reply('a1', 'HANDOFF')])).toBe('ready');
  });

  it('is idle again once the user carries on talking', () => {
    // A handoff the user has since talked past is stale; continuing from it
    // would silently drop whatever came after.
    expect(
      compactionStage([
        ask('u1'),
        reply('a1', 'HANDOFF'),
        { id: 'u2', role: 'user', content: 'actually wait' } as ChatMessage,
      ]),
    ).toBe('idle');
  });
});

describe('latestHandoff', () => {
  it('returns the written handoff so it can seed the new conversation', () => {
    expect(
      latestHandoff([
        { id: 'u1', role: 'user', content: CONTEXT_CLEAR_PROMPT } as ChatMessage,
        { id: 'a1', role: 'assistant', content: 'HANDOFF BODY', events: [] } as ChatMessage,
      ]),
    ).toBe('HANDOFF BODY');
  });

  it('returns null when there is no handoff to continue from', () => {
    expect(latestHandoff([turn('m1', 100)])).toBeNull();
  });
});

describe('cached tokens count toward the window', () => {
  const usageTurn = (input: number, cached: number): ChatMessage =>
    ({
      id: 'm1',
      role: 'assistant',
      content: '',
      events: [{ kind: 'usage', inputTokens: input, cachedInputTokens: cached }],
    } as ChatMessage);

  it('adds cache hits to the reported context', () => {
    // input_tokens is only the UNCACHED delta. On a warm conversation almost
    // everything is a cache hit, so reading it alone reported a 30k
    // conversation as ~90 tokens and the meter could never warn.
    const usage = conversationContextUsage([usageTurn(19, 14_341)], config('qwen3.6-35b'));
    expect(usage?.used).toBe(14_360);
  });

  it('still works when nothing was cached', () => {
    const usage = conversationContextUsage([usageTurn(52_000, 0)], config('qwen3.6-35b'));
    expect(usage?.used).toBe(52_000);
  });

  it('warns once cache hits push it past the threshold', () => {
    // The case that matters: a conversation is nearly full, but only because
    // of cached history. Ignoring the cache means silence right up to failure.
    const usage = conversationContextUsage([usageTurn(100, 60_000)], config('qwen3.6-35b'));
    expect(usage?.level).toBe('warn');
  });

  it('tolerates a turn that reported no cache field', () => {
    const usage = conversationContextUsage([usageTurn(1_000, undefined as never)], config('qwen3.6-35b'));
    expect(usage?.used).toBe(1_000);
  });
});
