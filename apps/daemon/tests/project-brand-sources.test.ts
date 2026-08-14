import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  collectProjectBrandSources,
  selectBrandSourcePage,
} from '../src/project-brand-sources.js';

const dirs: string[] = [];
function tempProject(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'od-brand-src-'));
  dirs.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }
  return root;
}
afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

/**
 * `od brand extract-from-html` has existed and gone unused, because it wants a
 * single hand-supplied HTML document. The thing people actually have is a
 * project — a folder of screens sharing a stylesheet. Turning that folder into
 * the extractor's inputs is the whole missing step, and the reason this is
 * Claude Design's headline feature and not ours.
 */
describe('selectBrandSourcePage', () => {
  it('prefers the configured entry file', () => {
    expect(selectBrandSourcePage(['a.html', 'index.html'], 'index.html')).toBe('index.html');
  });

  it('falls back to index.html when no entry is configured', () => {
    expect(selectBrandSourcePage(['zzz.html', 'index.html'], null)).toBe('index.html');
  });

  it('falls back to the first page when there is no index', () => {
    // Deterministic rather than arbitrary: the caller sorts, so the same
    // project always yields the same brand source.
    expect(selectBrandSourcePage(['a.html', 'b.html'], null)).toBe('a.html');
  });

  it('ignores an entry file that is not actually present', () => {
    // A stale metadata.entryFile must not select a page that no longer exists.
    expect(selectBrandSourcePage(['a.html'], 'deleted.html')).toBe('a.html');
  });

  it('returns null for a project with no pages', () => {
    expect(selectBrandSourcePage([], null)).toBeNull();
  });
});

describe('collectProjectBrandSources', () => {
  it('returns the chosen page and its stylesheet', () => {
    const root = tempProject({
      'index.html': '<!doctype html><link rel="stylesheet" href="theme.css"><h1>Hi</h1>',
      'theme.css': ':root { --brand: #2b4cff }',
    });
    const sources = collectProjectBrandSources(root, null);
    expect(sources?.html).toContain('<h1>Hi</h1>');
    expect(sources?.css).toContain('--brand: #2b4cff');
  });

  it('gathers stylesheets from every page, not just the chosen one', () => {
    // The design system lives in the CSS, and a multi-screen prototype spreads
    // its vocabulary across screens. Harvesting only the entry page's
    // stylesheet would sample one screen's palette and call it the brand.
    const root = tempProject({
      'index.html': '<link rel="stylesheet" href="base.css">',
      'booking.html': '<link rel="stylesheet" href="booking.css">',
      'base.css': ':root { --brand: #2b4cff }',
      'booking.css': '.cta { color: #ff2b6b }',
    });
    const sources = collectProjectBrandSources(root, null);
    expect(sources?.css).toContain('#2b4cff');
    expect(sources?.css).toContain('#ff2b6b');
  });

  it('includes each stylesheet only once when pages share one', () => {
    const root = tempProject({
      'a.html': '<link rel="stylesheet" href="shared.css">',
      'b.html': '<link rel="stylesheet" href="shared.css">',
      'shared.css': '.x { color: red }',
    });
    const sources = collectProjectBrandSources(root, null);
    expect(sources!.css.match(/\.x \{ color: red \}/gu)).toHaveLength(1);
  });

  it('survives a page referencing a stylesheet that is missing', () => {
    // Prototypes are edited by a model; a dangling href is routine and must not
    // take the whole extraction down.
    const root = tempProject({
      'index.html': '<link rel="stylesheet" href="gone.css"><h1>Hi</h1>',
    });
    const sources = collectProjectBrandSources(root, null);
    expect(sources?.html).toContain('<h1>Hi</h1>');
  });

  it('returns null for a project with no HTML at all', () => {
    expect(collectProjectBrandSources(tempProject({ 'readme.md': 'hi' }), null)).toBeNull();
  });

  it('does not read outside the project root', () => {
    // A traversal in an href must not let extraction pull in host files.
    const root = tempProject({
      'index.html': '<link rel="stylesheet" href="../../../../etc/passwd">',
    });
    const sources = collectProjectBrandSources(root, null);
    expect(sources?.css ?? '').not.toContain('root:');
  });
});
