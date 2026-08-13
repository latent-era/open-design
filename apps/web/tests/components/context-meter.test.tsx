// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContextMeter } from '../../src/components/ContextMeter';
import type { ContextUsage } from '@open-design/contracts';

afterEach(() => cleanup());

const usage = (over: Partial<ContextUsage> = {}): ContextUsage => ({
  used: 10_000,
  limit: 65_536,
  ratio: 10_000 / 65_536,
  level: 'ok',
  ...over,
});

describe('ContextMeter', () => {
  it('shows nothing when the model window is unknown', () => {
    // A meter against a guessed denominator under-reports, and the user hits
    // the ceiling unwarned — the exact failure this exists to prevent.
    render(<ContextMeter usage={null} />);
    expect(screen.queryByTestId('context-meter')).toBeNull();
  });

  it('reports how much of the window is used', () => {
    render(<ContextMeter usage={usage()} />);
    expect(screen.getByTestId('context-meter').textContent).toContain('10k');
    expect(screen.getByTestId('context-meter').textContent).toContain('65.5k');
  });

  it('exposes progress to assistive tech', () => {
    render(<ContextMeter usage={usage({ ratio: 0.5 })} />);
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('50');
  });

  it('does not offer compaction while there is room', () => {
    // An always-present action trains the user to ignore it.
    render(<ContextMeter usage={usage()} onCompact={() => {}} />);
    expect(screen.queryByTestId('context-meter-compact')).toBeNull();
  });

  it('offers compaction once the conversation is close to the ceiling', () => {
    const onCompact = vi.fn();
    render(<ContextMeter usage={usage({ level: 'warn', ratio: 0.9 })} onCompact={onCompact} />);
    fireEvent.click(screen.getByTestId('context-meter-compact'));
    expect(onCompact).toHaveBeenCalled();
  });

  it('says plainly when a conversation is past the ceiling', () => {
    // This is the 0863112c state: failing every turn with nothing on screen
    // explaining why.
    render(<ContextMeter usage={usage({ level: 'over', ratio: 1.06 })} onCompact={() => {}} />);
    expect(screen.getByTestId('context-meter-over')).toBeTruthy();
    expect(screen.getByTestId('context-meter-compact')).toBeTruthy();
  });

  it('caps the bar at full rather than overflowing', () => {
    render(<ContextMeter usage={usage({ level: 'over', ratio: 1.5 })} />);
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('100');
  });
});
