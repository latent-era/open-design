import { describe, expect, it } from 'vitest';

import {
  planUndo,
  planUndoForMessages,
  runFileVersionsFromSnapshots,
} from '../src/run-undo.js';

/**
 * Timeline-rewind undo. Undoing a run discards that run's changes AND every
 * change made after it, so the project is returned to exactly its state before
 * the target run — never a mix of old and new.
 *
 * The planner is pure over the runs' recorded file versions. Restoring is a
 * separate write step, so these tests pin *what* should be restored without a
 * filesystem or a version store.
 */

function run(id: string, files: Array<[string, string, string | null]>) {
  return {
    id,
    fileVersions: files.map(([fileName, versionId, previousVersionId]) => ({
      fileName,
      versionId,
      previousVersionId,
    })),
  };
}

describe('planUndo', () => {
  it('restores a file to the version it was at before the target run', () => {
    const plan = planUndo({
      runs: [run('r1', [['a.css', 'v2', 'v1']])],
      targetRunId: 'r1',
    });

    expect(plan.restores).toEqual([{ fileName: 'a.css', versionId: 'v1' }]);
  });

  it('rewinds past a later run that touched the same file', () => {
    // The later run's previousVersionId is the target's output (v2). Restoring
    // to that would undo only the later run and leave the target's change in
    // place, which is the mixed state timeline-rewind exists to prevent.
    const plan = planUndo({
      runs: [
        run('r1', [['a.css', 'v2', 'v1']]),
        run('r2', [['a.css', 'v3', 'v2']]),
      ],
      targetRunId: 'r1',
    });

    expect(plan.restores).toEqual([{ fileName: 'a.css', versionId: 'v1' }]);
  });

  it('also discards a file that only a later run created', () => {
    // b.css did not exist before the target run. Rewinding the timeline has to
    // account for it, or undo leaves behind a file from a discarded future.
    const plan = planUndo({
      runs: [
        run('r1', [['a.css', 'v2', 'v1']]),
        run('r2', [['b.css', 'v9', null]]),
      ],
      targetRunId: 'r1',
    });

    expect(plan.restores).toEqual([{ fileName: 'a.css', versionId: 'v1' }]);
    expect(plan.deletes).toEqual(['b.css']);
  });

  it('deletes a file the target run itself created', () => {
    const plan = planUndo({
      runs: [run('r1', [['new.css', 'v1', null]])],
      targetRunId: 'r1',
    });

    expect(plan.restores).toEqual([]);
    expect(plan.deletes).toEqual(['new.css']);
  });

  it('ignores runs before the target', () => {
    const plan = planUndo({
      runs: [
        run('r0', [['old.css', 'v1', null]]),
        run('r1', [['a.css', 'v2', 'v1']]),
      ],
      targetRunId: 'r1',
    });

    expect(plan.restores).toEqual([{ fileName: 'a.css', versionId: 'v1' }]);
    expect(plan.deletes).toEqual([]);
  });

  it('counts the later runs it will discard so the confirmation can name them', () => {
    // The user is told "this change plus N later changes" before committing to
    // a destructive rewind.
    const plan = planUndo({
      runs: [
        run('r1', [['a.css', 'v2', 'v1']]),
        run('r2', [['a.css', 'v3', 'v2']]),
        run('r3', [['b.css', 'v4', null]]),
      ],
      targetRunId: 'r1',
    });

    expect(plan.discardedRunIds).toEqual(['r2', 'r3']);
  });

  it('refuses to plan an undo for a run it cannot find', () => {
    expect(() => planUndo({ runs: [run('r1', [])], targetRunId: 'nope' }))
      .toThrow(/nope/u);
  });
});

describe('runFileVersionsFromSnapshots', () => {
  it('reduces a snapshot result to the record a run persists', () => {
    // The snapshot writer returns whole ProjectFileVersion objects. Only the
    // id and the displaced id are needed to find a run's versions later, and
    // the run record should not carry the full version payload.
    const records = runFileVersionsFromSnapshots([
      {
        fileName: 'screens/a.css',
        version: { id: 'v2' } as never,
        previousVersionId: 'v1',
      },
      {
        fileName: 'screens/b.html',
        version: { id: 'v9' } as never,
        previousVersionId: null,
      },
    ]);

    expect(records).toEqual([
      { fileName: 'screens/a.css', versionId: 'v2', previousVersionId: 'v1' },
      { fileName: 'screens/b.html', versionId: 'v9', previousVersionId: null },
    ]);
  });
});

describe('planUndoForMessages', () => {
  const versioned = (id: string, fileName: string, versionId: string, prev: string | null) => ({
    id,
    fileVersions: [{ fileName, versionId, previousVersionId: prev }],
  });

  it('skips messages that versioned nothing', () => {
    // Prose-only turns sit between edits. They carry no versions and must not
    // be counted as discarded changes, or the confirmation overstates the loss.
    const plan = planUndoForMessages(
      [
        versioned('m1', 'a.css', 'v2', 'v1'),
        { id: 'm2' },
        versioned('m3', 'a.css', 'v3', 'v2'),
      ],
      'm1',
    );

    expect(plan.restores).toEqual([{ fileName: 'a.css', versionId: 'v1' }]);
    expect(plan.discardedRunIds).toEqual(['m3']);
  });

  it('ignores a message already undone', () => {
    // Its changes are gone from disk. Counting it again would rewind past
    // edits the user never asked to lose.
    const plan = planUndoForMessages(
      [
        versioned('m1', 'a.css', 'v2', 'v1'),
        { ...versioned('m2', 'b.css', 'v5', null), undoneAt: 123 },
      ],
      'm1',
    );

    expect(plan.discardedRunIds).toEqual([]);
    expect(plan.deletes).toEqual([]);
  });

  it('refuses a message that has no undo point', () => {
    expect(() => planUndoForMessages([{ id: 'm1' }], 'm1'))
      .toThrow(/m1/u);
  });
});
