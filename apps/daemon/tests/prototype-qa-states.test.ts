import { describe, expect, it } from 'vitest';

import {
  MAX_PROTOTYPE_QA_STATES,
  discoverPrototypeStates,
} from '../src/prototype-qa.js';

/**
 * Empty, loading, hover, modal and error states are invisible to every check
 * in the product: the audit loads a page and screenshots whatever it looks
 * like on arrival. A list that renders correctly with three rows and collapses
 * to a blank panel with zero rows passes everything.
 *
 * States are DISCOVERED from the source rather than configured per page. A
 * config file that has to be written by hand for every prototype is a config
 * file nobody writes, and the audit cannot guess selectors on its own. Writing
 * the CSS for a state is therefore what declares it.
 */
describe('discoverPrototypeStates', () => {
  it('finds a state from the stylesheet rule that implements it', () => {
    const states = discoverPrototypeStates([
      '.od-state-empty .list { display: none; }',
    ]);
    expect(states.map((state) => state.name)).toEqual(['empty']);
  });

  it('carries the class the audit has to apply', () => {
    const [state] = discoverPrototypeStates(['.od-state-loading .row { opacity: 0.4 }']);
    expect(state?.className).toBe('od-state-loading');
  });

  it('finds states declared in markup as well as stylesheets', () => {
    // A prototype may ship its state rules in a <style> block rather than a
    // separate file, so the HTML source counts as a source too.
    const states = discoverPrototypeStates([
      '<style>.od-state-error .banner { display: block }</style>',
    ]);
    expect(states.map((state) => state.name)).toEqual(['error']);
  });

  it('reports each state once however many rules mention it', () => {
    const states = discoverPrototypeStates([
      '.od-state-empty .list { display: none }',
      '.od-state-empty .placeholder { display: grid }',
      '.od-state-empty h2 { color: red }',
    ]);
    expect(states).toHaveLength(1);
  });

  it('orders states so a receipt does not churn between audits', () => {
    // Screenshot filenames derive from this order. Unstable ordering would
    // make every audit look like a change.
    const states = discoverPrototypeStates([
      '.od-state-loading{}',
      '.od-state-empty{}',
      '.od-state-error{}',
    ]);
    expect(states.map((state) => state.name)).toEqual(['empty', 'error', 'loading']);
  });

  it('picks up a hover target from the markup', () => {
    // Hover needs no page cooperation — the browser can do it — but the audit
    // still has to be told what to hover.
    const states = discoverPrototypeStates([
      '<button data-od-hover class="cta">Book</button>',
    ]);
    expect(states.map((state) => state.name)).toContain('hover');
    expect(states.find((state) => state.name === 'hover')?.hoverSelector)
      .toBe('[data-od-hover]');
  });

  it('returns nothing for a page that declares no states', () => {
    // The overwhelmingly common case. It must cost nothing: no extra renders,
    // no extra screenshots, no change to the receipt.
    expect(discoverPrototypeStates(['.list { display: grid }'])).toEqual([]);
  });

  it('ignores a bare od-state- prefix with no name', () => {
    expect(discoverPrototypeStates(['.od-state- { color: red }'])).toEqual([]);
  });

  it('does not treat a longer word as a state name boundary', () => {
    // `od-state-empty-wide` is its own state, not `empty`.
    const states = discoverPrototypeStates(['.od-state-empty-wide{}']);
    expect(states.map((state) => state.name)).toEqual(['empty-wide']);
  });

  it('caps how many states one page can demand', () => {
    // Each state is another full render and screenshot. An unbounded count
    // would let one page's CSS turn a cheap edit into the most expensive
    // verification in the product — the failure that forced blocking down to
    // a single page in the first place.
    const many = Array.from({ length: 40 }, (_v, index) => `.od-state-s${index}{}`);
    expect(discoverPrototypeStates(many)).toHaveLength(MAX_PROTOTYPE_QA_STATES);
  });

  it('tolerates empty and blank sources', () => {
    expect(discoverPrototypeStates([])).toEqual([]);
    expect(discoverPrototypeStates(['', '   '])).toEqual([]);
  });
});
