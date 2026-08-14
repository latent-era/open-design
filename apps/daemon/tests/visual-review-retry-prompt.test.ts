import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  buildVisualReviewPrompt,
  buildVisualReviewRetryPrompt,
  stageScreenshotForPrompt,
} from '../src/visual-review.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'od-visual-retry-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * The prompt handed back to the model on a dissenting verdict.
 *
 * Two failures shape it. The reviewer's note is model-written prose, so it is
 * quoted as evidence rather than pasted in as if it were an instruction — an
 * earlier runaway came from feeding commentary to a model as a directive. And
 * the retry must be scoped to fixing the named page, not to re-attempting the
 * user's whole original request, which the run has already carried out.
 */
describe('buildVisualReviewRetryPrompt', () => {
  it('names the file that needs fixing', () => {
    const prompt = buildVisualReviewRetryPrompt({
      file: 'screens/next-bell.html',
      note: 'NO. The countdown digits are clipped at the right edge.',
    });
    expect(prompt).toContain('screens/next-bell.html');
  });

  it('includes the reviewer note as the evidence to act on', () => {
    const prompt = buildVisualReviewRetryPrompt({
      file: 'a.html',
      note: 'NO. The countdown digits are clipped at the right edge.',
    });
    expect(prompt).toContain('The countdown digits are clipped at the right edge.');
  });

  it('scopes the work to the reported problem, not the original request', () => {
    const prompt = buildVisualReviewRetryPrompt({ file: 'a.html', note: 'NO. Buttons overlap.' });
    expect(prompt.toLowerCase()).toContain('do not start over');
  });

  it('bounds a runaway note so it cannot dominate the prompt', () => {
    // A reviewer that ignores "one short sentence" must not be able to push a
    // multi-kilobyte block into a context this small.
    const prompt = buildVisualReviewRetryPrompt({
      file: 'a.html',
      note: 'NO. '.padEnd(20_000, 'x'),
    });
    expect(prompt.length).toBeLessThan(2_000);
  });

  it('still produces a usable instruction when the note is empty', () => {
    const prompt = buildVisualReviewRetryPrompt({ file: 'a.html', note: '' });
    expect(prompt).toContain('a.html');
    expect(prompt.trim().length).toBeGreaterThan(0);
  });
});

/**
 * A state screenshot cannot be judged the way the normal view is.
 *
 * The empty state of a booking list correctly shows no bookings. Asking "does
 * this satisfy 'add a booking row'?" of that screenshot earns a NO for a page
 * behaving exactly as designed — and with the retry loop wired up, that false
 * dissent would spend a turn "fixing" something that was already right.
 */
describe('buildVisualReviewPrompt for a state', () => {
  it('names the state being shown', () => {
    const prompt = buildVisualReviewPrompt('add a booking row', 'empty');
    expect(prompt).toContain('empty');
  });

  it('tells the reviewer that differing content is expected', () => {
    const prompt = buildVisualReviewPrompt('add a booking row', 'empty');
    expect(prompt.toLowerCase()).toContain('expected');
  });

  it('still demands a leading YES or NO so the verdict parses', () => {
    const prompt = buildVisualReviewPrompt('add a booking row', 'loading');
    expect(prompt).toContain('YES or NO as the very first word');
  });

  it('is a different instruction from the normal-view prompt', () => {
    const normal = buildVisualReviewPrompt('add a booking row');
    const state = buildVisualReviewPrompt('add a booking row', 'empty');
    expect(state).not.toBe(normal);
  });

  it('leaves the normal-view prompt untouched when no state is given', () => {
    const prompt = buildVisualReviewPrompt('add a booking row');
    expect(prompt).toContain('The request was: add a booking row');
    expect(prompt).not.toContain('specific state');
  });
});

/**
 * Screenshots live under the project's audit directory, but the prompt image
 * sanitiser only accepts paths inside UPLOAD_DIR and silently drops everything
 * else. Handing it the audit path directly loses the image without an error,
 * leaving the model to fix a rendering fault it cannot see. Staging is what
 * makes the screenshot actually reach the retry.
 */
describe('stageScreenshotForPrompt', () => {
  it('copies the screenshot into the upload dir', () => {
    const source = makeTempDir();
    const uploadDir = makeTempDir();
    const screenshot = path.join(source, 'shot.png');
    fs.writeFileSync(screenshot, 'png-bytes');

    const staged = stageScreenshotForPrompt(screenshot, uploadDir);

    expect(staged).not.toBeNull();
    expect(path.dirname(path.resolve(staged!))).toBe(path.resolve(uploadDir));
    expect(fs.readFileSync(staged!, 'utf8')).toBe('png-bytes');
  });

  it('preserves the image extension so the mime type stays correct', () => {
    const source = makeTempDir();
    const uploadDir = makeTempDir();
    const screenshot = path.join(source, 'shot.jpeg');
    fs.writeFileSync(screenshot, 'jpeg-bytes');

    const staged = stageScreenshotForPrompt(screenshot, uploadDir);
    expect(path.extname(staged!)).toBe('.jpeg');
  });

  it('does not collide when two screenshots share a basename', () => {
    const uploadDir = makeTempDir();
    const a = makeTempDir();
    const b = makeTempDir();
    fs.writeFileSync(path.join(a, 'shot.png'), 'a');
    fs.writeFileSync(path.join(b, 'shot.png'), 'b');

    const first = stageScreenshotForPrompt(path.join(a, 'shot.png'), uploadDir);
    const second = stageScreenshotForPrompt(path.join(b, 'shot.png'), uploadDir);

    expect(first).not.toBe(second);
    expect(fs.readFileSync(first!, 'utf8')).toBe('a');
    expect(fs.readFileSync(second!, 'utf8')).toBe('b');
  });

  it('creates the upload dir when it does not exist yet', () => {
    const source = makeTempDir();
    const uploadDir = path.join(makeTempDir(), 'nested', 'uploads');
    fs.writeFileSync(path.join(source, 'shot.png'), 'png-bytes');

    const staged = stageScreenshotForPrompt(path.join(source, 'shot.png'), uploadDir);
    expect(staged).not.toBeNull();
    expect(fs.existsSync(staged!)).toBe(true);
  });

  it('returns null rather than throwing when the screenshot is missing', () => {
    // The retry is a best-effort improvement. A missing screenshot must
    // degrade to a note-only prompt, never take down the turn that produced
    // the page.
    const uploadDir = makeTempDir();
    expect(stageScreenshotForPrompt(path.join(makeTempDir(), 'gone.png'), uploadDir)).toBeNull();
  });
});
