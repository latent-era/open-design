import { describe, expect, it, vi } from 'vitest';

import {
  isTransientReviewFailure,
  reviewRenderedPage,
} from '../src/visual-review.js';

/**
 * The reviewer fails far more often than it succeeds under load.
 *
 * Measured on the live host: nine 502s to five successes, every failure landing
 * at ~59s — llama-swap giving up while the agent still holds llama.cpp's slots.
 * The request itself is fine; the same screenshot reviewed in 9.5s when the host
 * was idle.
 *
 * That matters because a failed review returns `unknown`, and `unknown` never
 * triggers the fix-it retry. So the loop can only fire on the turns where the
 * review happens to get through, and the misses are invisible.
 */
describe('isTransientReviewFailure', () => {
  it('treats a bad gateway as transient', () => {
    expect(isTransientReviewFailure(new Error('local vision review failed: HTTP 502'))).toBe(true);
  });

  it('treats the other upstream-busy statuses as transient', () => {
    for (const status of [503, 504, 429]) {
      expect(isTransientReviewFailure(new Error(`local vision review failed: HTTP ${status}`)))
        .toBe(true);
    }
  });

  it('treats an aborted request as transient', () => {
    const err = new Error('The operation was aborted');
    err.name = 'AbortError';
    expect(isTransientReviewFailure(err)).toBe(true);
  });

  it('treats a connection failure as transient', () => {
    expect(isTransientReviewFailure(new TypeError('fetch failed'))).toBe(true);
  });

  it('does not retry a request the server rejected outright', () => {
    // A 400 means we sent something wrong. Retrying sends it again.
    expect(isTransientReviewFailure(new Error('local vision review failed: HTTP 400'))).toBe(false);
  });

  it('does not retry a missing model', () => {
    expect(isTransientReviewFailure(new Error('local vision review failed: HTTP 404'))).toBe(false);
  });
});

const PNG = `${process.cwd()}/tests/fixtures/visual-review-pixel.png`;

function jsonResponse(content: string) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content } }] }),
  } as unknown as Response;
}

function errorResponse(status: number) {
  return { ok: false, status, json: async () => ({}) } as unknown as Response;
}

describe('reviewRenderedPage retries a transient upstream failure', () => {
  const base = {
    screenshotPath: PNG,
    request: 'make the countdown inline',
    localEndpoint: 'http://local.invalid',
    localModel: 'qwen3.6-35b',
    retryDelayMs: 0,
  };

  it('recovers when the second attempt succeeds', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(errorResponse(502))
      .mockResolvedValueOnce(jsonResponse('NO. The digits are clipped.'));
    const outcome = await reviewRenderedPage({ ...base, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(outcome?.verdict).toBe('not-satisfied');
  });

  it('gives up after a bounded number of attempts', async () => {
    // Bounded for the same reason the fix-it retry is: a host that is busy now
    // is likely busy in a second, and a turn must not stall behind an
    // open-ended queue of one-minute timeouts.
    const fetchImpl = vi.fn().mockResolvedValue(errorResponse(502));
    const outcome = await reviewRenderedPage({ ...base, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(outcome?.verdict).toBe('unknown');
  });

  it('does not retry a non-transient failure', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(errorResponse(400));
    const outcome = await reviewRenderedPage({ ...base, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(outcome?.verdict).toBe('unknown');
  });

  it('does not retry a request that already succeeded', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse('YES. Looks right.'));
    const outcome = await reviewRenderedPage({ ...base, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(outcome?.verdict).toBe('satisfied');
  });

  it('asks the model not to think before answering', async () => {
    // Measured on the live host: with thinking on, the model spends its whole
    // token budget in `reasoning_content`, returns an empty `content`, and the
    // verdict parses as `unknown` — 9.9s to learn nothing. With thinking off
    // the same review answers correctly in 0.6s, which also keeps it out of the
    // queue that was producing 502s.
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse('YES. Fine.'));
    await reviewRenderedPage({ ...base, fetchImpl });
    const body = JSON.parse(String((fetchImpl.mock.calls[0]?.[1] as { body: string }).body));
    expect(body.chat_template_kwargs?.enable_thinking).toBe(false);
  });

  it('explains an empty answer that was spent on reasoning', async () => {
    // Distinguishes "the reviewer could not answer" from "the reviewer is
    // unreachable" — the two look identical as a bare `unknown`.
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: '', reasoning_content: 'Let me think about this...' } }],
      }),
    } as unknown as Response);
    const outcome = await reviewRenderedPage({ ...base, fetchImpl });
    expect(outcome?.verdict).toBe('unknown');
    expect(outcome?.note.toLowerCase()).toContain('reasoning');
  });

  it('reports why it could not review, not merely that it could not', async () => {
    // "unknown" with no reason is indistinguishable from a review that passed.
    const fetchImpl = vi.fn().mockResolvedValue(errorResponse(502));
    const outcome = await reviewRenderedPage({ ...base, fetchImpl });
    expect(outcome?.note).toContain('502');
  });
});
