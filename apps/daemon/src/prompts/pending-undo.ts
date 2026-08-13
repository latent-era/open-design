export interface PendingUndo {
  /** Project-relative files rolled back to an earlier version. */
  restored: string[];
  /** Files removed because they did not exist before the undone turn. */
  deleted: string[];
  /** How many later turns the rewind also discarded. */
  discardedCount: number;
}

/**
 * The note that tells the agent an undo happened.
 *
 * Delivered as a section on the user's next message, not at click time: there
 * is no agent process between turns, so notifying immediately would cost a
 * wasted model call for behaviour identical to a note.
 *
 * MUST be composed after every byte-stable section (see `prompt-telemetry`'s
 * SECTION_PRIORITY). Placing it earlier would move the cached prefix and turn
 * a cheap follow-up into a full re-read.
 */
export function pendingUndoPromptSection(undo: PendingUndo | null): string | null {
  if (!undo) return null;
  const lines = [
    'The user undid a previous turn. The project files have been rolled back;',
    'your memory of the conversation is ahead of what is now on disk.',
  ];
  if (undo.restored.length > 0) {
    lines.push('', 'Restored to an earlier version:');
    for (const name of undo.restored) lines.push(`- ${name}`);
  }
  if (undo.deleted.length > 0) {
    lines.push('', 'Removed (did not exist before that turn):');
    for (const name of undo.deleted) lines.push(`- ${name}`);
  }
  if (undo.discardedCount > 0) {
    lines.push(
      '',
      `This also discarded ${undo.discardedCount} later turn(s). Do not treat work from`,
      'those turns as still present — re-read any file before building on it.',
    );
  }
  return lines.join('\n');
}
