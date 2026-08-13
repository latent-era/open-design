import {
  contextUsage,
  CONTEXT_CLEAR_PROMPT,
  type ContextUsage,
} from '@open-design/contracts';

import type { AppConfig, ChatMessage } from '../types';

/** The model the conversation's next turn will run on. */
export function activeModelId(config: AppConfig | undefined): string | null {
  const agentId = config?.agentId;
  if (!agentId) return null;
  return config?.agentModels?.[agentId]?.model ?? null;
}

/**
 * How full the conversation's context is.
 *
 * Reads the MOST RECENT usage report rather than the largest. Compaction is
 * the reason this meter exists, and compaction makes the number go down — a
 * high-water mark would stay pinned at the pre-compaction figure and hide the
 * one thing the user is watching for.
 *
 * Turns that reported no usage (prose-only, failed) are skipped rather than
 * read as zero.
 */
export function conversationContextUsage(
  messages: ChatMessage[],
  config: AppConfig | undefined,
): ContextUsage | null {
  let latest: number | null = null;
  for (const message of messages) {
    for (const event of message.events ?? []) {
      if (event.kind === 'usage' && typeof event.inputTokens === 'number') {
        latest = event.inputTokens;
      }
    }
  }
  return contextUsage({ inputTokens: latest, model: activeModelId(config) });
}

export type CompactionStage = 'idle' | 'ready';

/**
 * The last assistant turn, only if it is a freshly-written handoff.
 *
 * "Freshly" matters: once the user has spoken again, the handoff no longer
 * describes the conversation, and continuing from it would silently drop
 * everything said since.
 */
function trailingHandoffReply(messages: ChatMessage[]): ChatMessage | null {
  const last = messages.at(-1);
  const previous = messages.at(-2);
  if (!last || !previous) return null;
  if (last.role !== 'assistant' || previous.role !== 'user') return null;
  if (previous.content.trim() !== CONTEXT_CLEAR_PROMPT) return null;
  return last.content.trim() ? last : null;
}

/**
 * Whether a written handoff is sitting ready to continue from.
 *
 * Compaction is deliberately two visible steps — the agent writes the handoff
 * in the chat, then the user continues into a fresh conversation. Swapping the
 * conversation automatically would reset the context before anyone could see
 * whether the handoff was any good.
 */
export function compactionStage(messages: ChatMessage[]): CompactionStage {
  return trailingHandoffReply(messages) ? 'ready' : 'idle';
}

/** The handoff body to seed the continuing conversation with. */
export function latestHandoff(messages: ChatMessage[]): string | null {
  return trailingHandoffReply(messages)?.content.trim() ?? null;
}
