import { describe, expect, it } from 'vitest';

import {
  buildVisualReviewPrompt,
  parseVisualReviewVerdict,
} from '../src/visual-review.js';

/**
 * Reading a vision model's answer about a rendered page.
 *
 * The model is asked to lead with YES or NO so the verdict does not depend on
 * parsing prose. A thinking model still wraps that in reasoning, and a local
 * model can decline or waffle — none of which may be read as approval, because
 * the whole point is catching a turn that claimed work it never looked at.
 */
describe('parseVisualReviewVerdict', () => {
  it('reads a leading YES as satisfied', () => {
    expect(parseVisualReviewVerdict('YES — the heading is now bold.').verdict)
      .toBe('satisfied');
  });

  it('reads a leading NO as not satisfied', () => {
    expect(parseVisualReviewVerdict('NO. The countdown is still clipped.').verdict)
      .toBe('not-satisfied');
  });

  it('looks past a thinking block', () => {
    // Local models emit <think> before answering; the verdict is after it.
    const answer = '<think>Let me look at the countdown.</think>\nNO, still clipped.';
    expect(parseVisualReviewVerdict(answer).verdict).toBe('not-satisfied');
  });

  it('is unknown when the model does not commit', () => {
    // Not "satisfied". An unreadable answer must never read as approval.
    expect(parseVisualReviewVerdict('It is hard to tell from this image.').verdict)
      .toBe('unknown');
  });

  it('is unknown for an empty answer', () => {
    expect(parseVisualReviewVerdict('').verdict).toBe('unknown');
  });

  it('keeps the model’s reasoning as the note', () => {
    const parsed = parseVisualReviewVerdict('NO. The button overlaps the digits.');
    expect(parsed.note).toContain('overlaps');
  });

  it('does not mistake a NO inside prose for the verdict', () => {
    // "NOT" and "NOTHING" start with NO; only a standalone token counts.
    expect(parseVisualReviewVerdict('YES. Nothing overlaps now.').verdict)
      .toBe('satisfied');
  });
});

describe('buildVisualReviewPrompt', () => {
  it('asks about the request that was actually made', () => {
    const prompt = buildVisualReviewPrompt('make the heading bigger');
    expect(prompt).toContain('make the heading bigger');
  });

  it('demands a leading YES or NO', () => {
    expect(buildVisualReviewPrompt('x')).toMatch(/YES|NO/u);
  });

  it('tells the model to judge the image, not the description', () => {
    // The failure this exists to catch is a model reporting a change it never
    // rendered, so the instruction has to point at the screenshot itself.
    expect(buildVisualReviewPrompt('x').toLowerCase()).toContain('screenshot');
  });
});
