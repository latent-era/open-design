import type { RunFileVersion } from '@open-design/contracts';

export type { RunFileVersion };

/**
 * Reduce the snapshot writer's result to what a run persists. The writer
 * returns whole version objects; a run only needs the pair of ids that lets it
 * find its own versions and the state each file displaced.
 */
export function runFileVersionsFromSnapshots(
  snapshots: Array<{
    fileName: string;
    version: { id: string };
    previousVersionId: string | null;
  }>,
): RunFileVersion[] {
  return snapshots.map(({ fileName, version, previousVersionId }) => ({
    fileName,
    versionId: version.id,
    previousVersionId,
  }));
}

export interface UndoPlanInput {
  /** The conversation's runs that recorded file versions, oldest first. */
  runs: Array<{ id: string; fileVersions: RunFileVersion[] }>;
  targetRunId: string;
}

export interface UndoPlan {
  restores: Array<{ fileName: string; versionId: string }>;
  /** Files that did not exist before the target run. Rewinding removes them. */
  deletes: string[];
  /** Runs after the target whose changes this undo also discards. Names the
   *  cost in the confirmation. */
  discardedRunIds: string[];
}

export interface UndoableMessage {
  id: string;
  fileVersions?: RunFileVersion[];
  /** Set once this message's changes have been rewound. */
  undoneAt?: number;
}

/**
 * Plan an undo from a conversation's messages, oldest first.
 *
 * Only messages that actually versioned files take part. Prose-only turns
 * carry no versions, and an already-undone message's changes are no longer on
 * disk — counting either would make the confirmation overstate what is lost.
 */
export function planUndoForMessages(
  messages: UndoableMessage[],
  targetMessageId: string,
): UndoPlan {
  const runs = messages
    .filter((message) => !message.undoneAt && (message.fileVersions?.length ?? 0) > 0)
    .map((message) => ({ id: message.id, fileVersions: message.fileVersions ?? [] }));
  return planUndo({ runs, targetRunId: targetMessageId });
}

export class UnknownUndoTargetError extends Error {
  readonly code = 'UNDO_TARGET_NOT_FOUND';

  constructor(targetRunId: string) {
    super(`No recorded file versions for run ${targetRunId}`);
    this.name = 'UnknownUndoTargetError';
  }
}

/**
 * Timeline rewind: return the project to its state immediately before
 * `targetRunId`, discarding every later change as well.
 *
 * The state to restore is each file's `previousVersionId` at its FIRST
 * appearance from the target run onward. Using a later run's
 * `previousVersionId` would restore that run's input — which is the target's
 * output — leaving the target's change in place and the timeline mixed.
 */
export function planUndo(input: UndoPlanInput): UndoPlan {
  const targetIndex = input.runs.findIndex((run) => run.id === input.targetRunId);
  if (targetIndex === -1) throw new UnknownUndoTargetError(input.targetRunId);

  const affected = input.runs.slice(targetIndex);
  const restores: Array<{ fileName: string; versionId: string }> = [];
  const deletes: string[] = [];
  const seen = new Set<string>();

  for (const run of affected) {
    for (const { fileName, previousVersionId } of run.fileVersions) {
      if (seen.has(fileName)) continue;
      seen.add(fileName);
      if (previousVersionId === null) deletes.push(fileName);
      else restores.push({ fileName, versionId: previousVersionId });
    }
  }

  return {
    restores,
    deletes,
    discardedRunIds: affected.slice(1).map((run) => run.id),
  };
}
