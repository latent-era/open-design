import { afterEach, describe, expect, it, vi } from 'vitest';

import { activateTalosLocalRuntime } from '../../src/providers/daemon';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('activateTalosLocalRuntime', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('resolves once the target model is confirmed active, even after several not-ready polls', async () => {
    // Regression: this used to be a single request that both triggered the
    // switch and doubled as the readiness signal. A cold model load can
    // outlast that request (observed >190s in production against a 190s
    // daemon-side timeout), which made a slow-but-successful switch look
    // like a failure to the caller. Readiness must come from polling actual
    // status, not from the trigger request settling.
    let getCallCount = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      expect(url).toBe('/api/talos/local-runtime');
      if (init?.method === 'POST') {
        expect(JSON.parse(String(init.body))).toEqual({ agentId: 'talos-deepseek' });
        return jsonResponse({ accepted: true, mode: 'coding' }, 202);
      }
      getCallCount += 1;
      const ready = getCallCount >= 3;
      return jsonResponse({
        mode: ready ? 'coding' : 'transitioning',
        qwen_active: false,
        qwen_status_active: false,
        ds4_active: ready,
        game_running: false,
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.useFakeTimers();

    const promise = activateTalosLocalRuntime('talos-deepseek', { pollIntervalMs: 50 });
    const assertion = expect(promise).resolves.toMatchObject({
      mode: 'coding',
      ds4_active: true,
    });

    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(50);
    await assertion;
    expect(getCallCount).toBe(3);
  });

  it('times out rather than polling forever when the host never reports ready', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      expect(url).toBe('/api/talos/local-runtime');
      if (init?.method === 'POST') return jsonResponse({ accepted: true, mode: 'chat' }, 202);
      return jsonResponse({
        mode: 'transitioning',
        qwen_active: false,
        qwen_status_active: false,
        ds4_active: false,
        game_running: false,
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.useFakeTimers();

    const promise = activateTalosLocalRuntime('talos-qwen', {
      pollIntervalMs: 50,
      timeoutMs: 120,
    });
    const assertion = expect(promise).rejects.toThrow(/timed out/i);

    await vi.advanceTimersByTimeAsync(200);
    await assertion;
  });

  it('rejects immediately when the trigger request itself fails', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: 'unavailable' }, 503));
    vi.stubGlobal('fetch', fetchMock);

    await expect(activateTalosLocalRuntime('talos-deepseek')).rejects.toThrow(
      'Unable to activate local model',
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
