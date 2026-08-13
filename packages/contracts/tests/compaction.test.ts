import { describe, expect, it } from 'vitest';

import {
  CONTEXT_CLEAR_PROMPT,
  compactionSeedMessage,
} from '../src/models/compaction.js';

/**
 * Compaction reuses the prompt the user already runs by hand: ask for a
 * handoff, clear, paste it back. It is provider-agnostic on purpose — opencode
 * has no compact command, so this has to work without one.
 */
describe('CONTEXT_CLEAR_PROMPT', () => {
  it('asks for the things a bare state dump would omit', () => {
    // The wording is the user's, and its value is in what it demands beyond a
    // summary. Paraphrasing it away would produce a handoff that reads well
    // and loses the reasons.
    expect(CONTEXT_CLEAR_PROMPT).toContain('mistakes made');
    expect(CONTEXT_CLEAR_PROMPT).toContain("what we won't do again");
    expect(CONTEXT_CLEAR_PROMPT).toContain('how we solved them');
    expect(CONTEXT_CLEAR_PROMPT).toContain('the plan going forward');
  });

  it('asks for a prompt to paste back, not a summary to read', () => {
    expect(CONTEXT_CLEAR_PROMPT).toContain('after clearing your context');
  });
});

describe('compactionSeedMessage', () => {
  it('carries the handoff into the new conversation as the first message', () => {
    const seed = compactionSeedMessage('HANDOFF BODY');
    expect(seed).toContain('HANDOFF BODY');
  });

  it('marks the handoff as continuation rather than a fresh request', () => {
    // Without framing, the agent reads a pasted handoff as a spec to build
    // and starts re-doing finished work.
    const seed = compactionSeedMessage('HANDOFF BODY');
    expect(seed.toLowerCase()).toContain('continu');
  });

  it('refuses an empty handoff', () => {
    // Seeding a new conversation with nothing silently discards the old one.
    expect(() => compactionSeedMessage('   ')).toThrow(/handoff/iu);
  });
});
