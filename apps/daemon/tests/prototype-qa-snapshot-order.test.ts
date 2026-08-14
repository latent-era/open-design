import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// A structural test. The daemon's run-finish path cannot be instantiated
// without a full server, so this pins the ordering invariant at the source
// level instead. It is deliberately weak — it proves the call order, not the
// behaviour — and should be replaced with a behavioural test if that path ever
// becomes unit-testable.
describe('run finish ordering', () => {
  it('snapshots file versions before the prototype QA gate can return', () => {
    // The QA gate returns early on failure. With the snapshot after it, a run
    // that failed verification recorded no versions at all — so the runs most
    // worth undoing were exactly the ones with no undo point. File versions
    // describe what is on disk, and the agent's edits are already written by
    // the time either of these runs.
    const src = readFileSync(
      path.join(import.meta.dirname, '../src/server.ts'),
      'utf8',
    );
    // Matched on the call, not its exact wording: this pins an ordering
    // invariant, and it should not go red because a call gained an `await`.
    const snapshotAt = src.indexOf('snapshotAiHtmlVersionsBeforeSuccess()');
    const gateAt = src.indexOf('const qaFailures =');

    expect(snapshotAt).toBeGreaterThan(-1);
    expect(gateAt).toBeGreaterThan(-1);
    expect(snapshotAt).toBeLessThan(gateAt);
  });
});
