// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AssistantMessage } from '../../src/components/AssistantMessage';
import type { ChatMessage } from '../../src/types';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'assistant-1',
    role: 'assistant',
    content: 'Removed the vertical line.',
    events: [{ kind: 'text', text: 'Removed the vertical line.' }],
    startedAt: 1_000,
    endedAt: 9_400,
    fileVersions: [
      { fileName: 'screens/boxing-calendar.css', versionId: 'v2', previousVersionId: 'v1' },
    ],
    ...overrides,
  };
}

function renderMessage(msg: ChatMessage) {
  return render(
    <AssistantMessage message={msg} streaming={false} projectId="project-1" isLast />,
  );
}

describe('per-message undo', () => {
  it('offers undo on a turn that versioned files', () => {
    renderMessage(message());
    expect(screen.getByTestId('assistant-undo-button')).toBeTruthy();
  });

  it('offers no undo on a prose-only turn', () => {
    // Nothing was written, so there is no point to rewind to. A control that
    // did nothing would still imply the turn changed something.
    renderMessage(message({ fileVersions: [] }));
    expect(screen.queryByTestId('assistant-undo-button')).toBeNull();
  });

  it('offers no undo on a turn already rewound', () => {
    renderMessage(message({ undoneAt: 1_700_000_000_000 }));
    expect(screen.queryByTestId('assistant-undo-button')).toBeNull();
  });

  it('names the later changes the rewind will discard before applying it', async () => {
    // Losing later work is the surprising part of timeline rewind, so the
    // count comes from the daemon's own plan rather than anything the client
    // guessed, and the user sees it before the write happens.
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        restores: [{ fileName: 'a.css', versionId: 'v1' }],
        deletes: ['b.css'],
        discardedMessageIds: ['m2', 'm3'],
      }),
    } as unknown as Response);

    renderMessage(message());
    fireEvent.click(screen.getByTestId('assistant-undo-button'));

    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(confirm.mock.calls[0]![0]).toContain('2');
    // Declining the confirmation must not write.
    expect(fetchMock.mock.calls.every(([, init]) => (init as RequestInit | undefined)?.method !== 'POST')).toBe(true);
  });

  it('applies the rewind once confirmed', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ restores: [], deletes: [], discardedMessageIds: [] }),
    } as unknown as Response);

    renderMessage(message());
    fireEvent.click(screen.getByTestId('assistant-undo-button'));

    await waitFor(() => {
      const posted = fetchMock.mock.calls.some(
        ([, init]) => (init as RequestInit | undefined)?.method === 'POST',
      );
      expect(posted).toBe(true);
    });
  });
});
