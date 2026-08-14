import { describe, expect, it } from 'vitest';

import {
  DEFAULT_VISUAL_REVIEW_RETRY_MAX_ATTEMPTS,
  decideVisualReviewRetry,
} from '../src/run-retry-policy.js';

/**
 * The visual reviewer files a verdict; until now nothing read it. A page that
 * the model was told was wrong still shipped, because "not-satisfied" was
 * recorded and then dropped on the floor.
 *
 * This policy turns a dissenting verdict into exactly one more attempt. The
 * bound is the whole point: a verdict from a probabilistic reviewer must never
 * be able to spin a run, and must never fail a turn outright — the retry is an
 * extra chance to fix, not a gate.
 */
describe('decideVisualReviewRetry', () => {
  it('retries once when the reviewer says the render does not match', () => {
    const decision = decideVisualReviewRetry({
      verdict: 'not-satisfied',
      attemptCount: 0,
    });
    expect(decision.shouldRetry).toBe(true);
  });

  it('stops after the single bounded attempt', () => {
    // The retry itself gets reviewed. If that second look also dissents we
    // stop and let the advisory stand, rather than looping the model against
    // a judgement it has already failed to satisfy once.
    const decision = decideVisualReviewRetry({
      verdict: 'not-satisfied',
      attemptCount: DEFAULT_VISUAL_REVIEW_RETRY_MAX_ATTEMPTS,
    });
    expect(decision.shouldRetry).toBe(false);
    expect(decision.shouldRetry === false && decision.suppressedReason)
      .toBe('attempt_limit_reached');
  });

  it('does not retry a satisfied verdict', () => {
    const decision = decideVisualReviewRetry({
      verdict: 'satisfied',
      attemptCount: 0,
    });
    expect(decision.shouldRetry).toBe(false);
    expect(decision.shouldRetry === false && decision.suppressedReason)
      .toBe('not_dissenting');
  });

  it('does not retry an unknown verdict', () => {
    // `unknown` is what a reviewer returns when it is unavailable, timed out,
    // or answered unparseably — the local vision host being down, typically.
    // Retrying on it would burn an extra turn on every run for the entire
    // window the host is unhealthy, while proving nothing about the page.
    const decision = decideVisualReviewRetry({
      verdict: 'unknown',
      attemptCount: 0,
    });
    expect(decision.shouldRetry).toBe(false);
    expect(decision.shouldRetry === false && decision.suppressedReason)
      .toBe('not_dissenting');
  });

  it('does not retry when no review was recorded at all', () => {
    const decision = decideVisualReviewRetry({
      verdict: undefined,
      attemptCount: 0,
    });
    expect(decision.shouldRetry).toBe(false);
    expect(decision.shouldRetry === false && decision.suppressedReason)
      .toBe('not_dissenting');
  });

  it('does not retry a run the user cancelled', () => {
    const decision = decideVisualReviewRetry({
      verdict: 'not-satisfied',
      attemptCount: 0,
      cancelRequested: true,
    });
    expect(decision.shouldRetry).toBe(false);
    expect(decision.shouldRetry === false && decision.suppressedReason)
      .toBe('cancel_requested');
  });

  it('can be switched off entirely with maxAttempts 0', () => {
    // The kill switch. A probabilistic verdict driving extra model turns is
    // exactly the kind of behaviour an operator needs to be able to stop
    // without a deploy.
    const decision = decideVisualReviewRetry({
      verdict: 'not-satisfied',
      attemptCount: 0,
      maxAttempts: 0,
    });
    expect(decision.shouldRetry).toBe(false);
    expect(decision.shouldRetry === false && decision.suppressedReason)
      .toBe('attempt_limit_reached');
  });

  it('treats a malformed attempt count as no attempts yet', () => {
    const decision = decideVisualReviewRetry({
      verdict: 'not-satisfied',
      attemptCount: Number.NaN,
    });
    expect(decision.shouldRetry).toBe(true);
  });

  it('reports the attempt index it is scheduling', () => {
    const decision = decideVisualReviewRetry({
      verdict: 'not-satisfied',
      attemptCount: 0,
    });
    expect(decision.attemptIndex).toBe(1);
  });
});
