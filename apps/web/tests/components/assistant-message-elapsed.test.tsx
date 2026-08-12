// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { AssistantMessage } from '../../src/components/AssistantMessage';
import type { AgentEvent, ChatMessage } from '../../src/types';

function completedMessage(events: AgentEvent[]): ChatMessage {
  return {
    id: 'assistant-1',
    role: 'assistant',
    // The footer only renders once there is something to act on, and
    // `copyMarkdown` is derived from `content` — so a realistic completed
    // message carries its assembled text here, as the daemon persists it.
    content: events
      .filter((event): event is Extract<AgentEvent, { kind: 'text' }> => event.kind === 'text')
      .map((event) => event.text)
      .join(''),
    events,
    startedAt: 1_000,
    endedAt: 9_400,
  };
}

describe('AssistantMessage elapsed time', () => {
  afterEach(() => cleanup());

  it('shows how long a prose-only reply took', () => {
    // The run duration used to live only inside TaskActivityCard, which
    // renders only when a turn produced thinking or tool calls
    // (`splitTaskActivity` returns null for `entries.length === 0`). A reply
    // that is purely text therefore reported "Done" with no indication of
    // whether it took one second or eight minutes. Local models surface this
    // constantly because they routinely answer a question without calling a
    // tool, which made them look like they reported less than cloud agents
    // when the difference was really tool use, not the runtime.
    render(
      <AssistantMessage
        message={completedMessage([
          { kind: 'text', text: 'The Profile tab shows the account header and preferences.' },
        ])}
        streaming={false}
        projectId="project-1"
        isLast
      />,
    );

    expect(screen.getByText('Done')).toBeTruthy();
    expect(screen.getByText('8.4s')).toBeTruthy();
  });

  it('does not repeat the duration when an activity card already reports it', () => {
    // TaskActivityCard owns run state for turns that have an execution
    // disclosure; the footer must stay actions-only there so the elapsed time
    // is not rendered twice on the same message.
    render(
      <AssistantMessage
        message={completedMessage([
          { kind: 'thinking', text: 'Considering the layout.' },
          { kind: 'text', text: 'Done thinking.' },
        ])}
        streaming={false}
        projectId="project-1"
        isLast
      />,
    );

    expect(screen.getAllByText('8.4s')).toHaveLength(1);
  });
});
