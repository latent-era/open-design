import { describe, expect, it } from 'vitest';

import { partitionPrototypeQaFiles } from '../src/prototype-qa.js';

/**
 * What gets VERIFIED is a different question from what BLOCKS.
 *
 * Blocking stays deliberately narrow — one page, so a shared-stylesheet edit
 * cannot demand eight audits before a turn can finish. But the pages that were
 * not blocking were never rendered or looked at either, so a screen the run
 * rewrote could ship unseen while the turn reported success.
 *
 * Verification therefore covers the focused page plus every HTML page the run
 * actually changed. That is bounded by the edit — usually one or two files —
 * rather than by how many pages the stylesheet happens to affect.
 */
describe('partitionPrototypeQaFiles verify set', () => {
  it('verifies the focused page', () => {
    const { verify } = partitionPrototypeQaFiles({
      htmlFiles: ['a.html', 'b.html'],
      focusedFile: 'a.html',
      changedFiles: [],
    });
    expect(verify).toEqual(['a.html']);
  });

  it('verifies a changed page even when another page is focused', () => {
    // The case that let a rewritten screen ship unseen: the run changed b,
    // the user had a open, so nothing ever rendered b.
    const { verify } = partitionPrototypeQaFiles({
      htmlFiles: ['a.html', 'b.html'],
      focusedFile: 'a.html',
      changedFiles: ['b.html'],
    });
    expect(verify.sort()).toEqual(['a.html', 'b.html']);
  });

  it('does not verify pages that were merely affected', () => {
    // A shared stylesheet edit marks every page affected. Rendering all of
    // them is what made the original fan-out unusable, so only pages the run
    // actually wrote are verified.
    const { verify } = partitionPrototypeQaFiles({
      htmlFiles: ['a.html', 'b.html', 'c.html'],
      focusedFile: 'a.html',
      changedFiles: [],
    });
    expect(verify).toEqual(['a.html']);
  });

  it('still verifies changed pages when there is no focused page', () => {
    const { verify } = partitionPrototypeQaFiles({
      htmlFiles: ['a.html', 'b.html'],
      focusedFile: null,
      changedFiles: ['b.html'],
    });
    expect(verify).toEqual(['b.html']);
  });

  it('never lists a page twice', () => {
    const { verify } = partitionPrototypeQaFiles({
      htmlFiles: ['a.html'],
      focusedFile: 'a.html',
      changedFiles: ['a.html'],
    });
    expect(verify).toEqual(['a.html']);
  });

  it('leaves blocking narrow — verification is not a second gate', () => {
    // Widening what gets looked at must not widen what can fail a turn.
    const { blocking } = partitionPrototypeQaFiles({
      htmlFiles: ['a.html', 'b.html'],
      focusedFile: 'a.html',
      changedFiles: ['b.html'],
    });
    expect(blocking).toEqual(['a.html']);
  });

  it('ignores a changed file that is not a project HTML page', () => {
    const { verify } = partitionPrototypeQaFiles({
      htmlFiles: ['a.html'],
      focusedFile: null,
      changedFiles: ['styles.css', 'b.html'],
    });
    expect(verify).toEqual([]);
  });
});
