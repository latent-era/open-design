import { describe, expect, it } from 'vitest';

import { PROTOTYPE_QA_VIEWPORTS } from '../src/prototype-qa.js';

/**
 * Which widths the audit actually renders.
 *
 * Two viewports at 390 and 1280 straddle the range where phone layouts
 * break. A fix scoped to `@media (max-width: 390px)` passed at 390 (the rule
 * applies) and at 1280 (there is room), while every width between was still
 * broken — the audit photographed the two places that worked.
 */
describe('prototype QA viewports', () => {
  it('renders a width above the common 390px phone breakpoint', () => {
    const widths = PROTOTYPE_QA_VIEWPORTS.map((v) => v.width);
    expect(widths.some((w) => w > 390 && w < 900)).toBe(true);
  });

  it('keeps the narrow phone and desktop ends', () => {
    const widths = PROTOTYPE_QA_VIEWPORTS.map((v) => v.width);
    expect(widths).toContain(390);
    expect(widths).toContain(1280);
  });

  it('gives every viewport a distinct name so receipts do not collide', () => {
    // Screenshot filenames are keyed by viewport name; a duplicate would have
    // one viewport silently overwrite another's evidence.
    const names = PROTOTYPE_QA_VIEWPORTS.map((v) => v.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
