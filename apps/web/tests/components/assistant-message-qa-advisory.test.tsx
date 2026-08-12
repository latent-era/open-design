// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { AssistantMessage } from '../../src/components/AssistantMessage';
import type { ChatMessage } from '../../src/types';

afterEach(() => cleanup());

function message(advisory: string[]): ChatMessage {
  return {
    id: 'assistant-1',
    role: 'assistant',
    content: 'Removed the vertical line.',
    events: [{ kind: 'text', text: 'Removed the vertical line.' }],
    startedAt: 1_000,
    endedAt: 9_400,
    prototypeQaAdvisory: advisory,
  };
}

describe('unverified-screens advisory', () => {
  it('reports screens that were not visually checked', () => {
    // Prototype verification gates on the focused page alone, so a turn that
    // touched a shared stylesheet succeeds with other pages unchecked. Saying
    // nothing would quietly imply everything was verified; the previous
    // behaviour said the opposite by failing the whole run.
    render(
      <AssistantMessage
        message={message(['screens/next-bell-home.html', 'screens/profile-settings-screen.html'])}
        streaming={false}
        projectId="project-1"
        isLast
      />,
    );
    expect(screen.getByText('2 screens not visually checked')).toBeTruthy();
  });

  it('says nothing when every affected screen was checked', () => {
    render(
      <AssistantMessage
        message={message([])}
        streaming={false}
        projectId="project-1"
        isLast
      />,
    );
    expect(screen.queryByText(/not visually checked/)).toBeNull();
  });
});
