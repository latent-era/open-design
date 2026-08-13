/**
 * The prompt that drives compaction.
 *
 * This is the user's own wording, used by hand today: ask for a handoff, clear
 * the context, paste it back. It is deliberately provider-agnostic — opencode
 * has no compact command, so compaction cannot rely on one.
 *
 * Do not paraphrase or "tidy" this. Its value is in what it demands beyond a
 * state dump: the mistakes, how they were solved, and what not to repeat. A
 * summary that drops those reads well and loses the reasons, which is exactly
 * what the next session needs.
 */
export const CONTEXT_CLEAR_PROMPT =
  'You are running out of context, so give me a prompt i can give you after '
  + 'clearing your context that lets you know everything we have done, mistakes '
  + 'made, problems we have run into, how we solved them, what we won\'t do '
  + 'again, what we want to remember, context and information you think you '
  + 'would need if you were going to continue working on this project and what '
  + 'we worked on before, and the plan going forward.';

export class EmptyHandoffError extends Error {
  readonly code = 'EMPTY_HANDOFF';

  constructor() {
    super('Refusing to compact: the handoff is empty');
    this.name = 'EmptyHandoffError';
  }
}

/**
 * Frame a handoff as the opening message of the continuing conversation.
 *
 * The framing matters: a bare pasted handoff reads to the agent as a fresh
 * specification, and it starts rebuilding work that is already done.
 */
export function compactionSeedMessage(handoff: string): string {
  const body = handoff.trim();
  if (!body) throw new EmptyHandoffError();
  return [
    'This conversation continues earlier work. The context below is a handoff',
    'written at the end of the previous session — treat it as what has already',
    'happened, not as a new request. Do not redo work it reports as finished.',
    '',
    '---',
    '',
    body,
  ].join('\n');
}
