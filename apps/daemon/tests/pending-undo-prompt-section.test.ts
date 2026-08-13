import { describe, expect, it } from 'vitest';

import { pendingUndoPromptSection } from '../src/prompts/pending-undo.js';
import { promptTelemetrySectionPriority } from '../src/prompt-telemetry.js';

/**
 * The agent has no process between turns — `opencode run` is spawned per turn
 * and exits — so an undo is reported to it as a section on the user's NEXT
 * message rather than at click time.
 *
 * Where that section sits is load-bearing. Every section through `echoGuard`
 * is byte-stable across turns; only `userRequest` changes. A varying section
 * placed before the stable ones would invalidate the cached prefix and turn a
 * ~1,500-token follow-up back into a ~52,000-token re-read.
 */
describe('pending undo prompt section', () => {
  it('sits after every byte-stable section', () => {
    // Anything at or before echoGuard is part of the cached prefix.
    expect(promptTelemetrySectionPriority('pendingUndo'))
      .toBeGreaterThan(promptTelemetrySectionPriority('echoGuard'));
    expect(promptTelemetrySectionPriority('pendingUndo'))
      .toBeGreaterThan(promptTelemetrySectionPriority('daemonSystemPrompt'));
    expect(promptTelemetrySectionPriority('pendingUndo'))
      .toBeGreaterThan(promptTelemetrySectionPriority('clientSystemPrompt'));
  });

  it('stays adjacent to the user request rather than drifting earlier', () => {
    expect(promptTelemetrySectionPriority('userRequest'))
      .toBeGreaterThan(promptTelemetrySectionPriority('pendingUndo'));
  });

  it('names the files that were rolled back', () => {
    const section = pendingUndoPromptSection({
      restored: ['screens/boxing-calendar.css'],
      deleted: [],
      discardedCount: 0,
    });
    expect(section).toContain('screens/boxing-calendar.css');
  });

  it('says how many later turns were discarded', () => {
    // Without this the agent's memory of the conversation disagrees with the
    // files on disk, and it will happily reference work that no longer exists.
    const section = pendingUndoPromptSection({
      restored: ['a.css'],
      deleted: ['b.css'],
      discardedCount: 2,
    });
    expect(section).toMatch(/2/u);
    expect(section).toContain('b.css');
  });

  it('produces nothing when no undo is pending', () => {
    expect(pendingUndoPromptSection(null)).toBeNull();
  });
});
