import { describe, expect, it } from 'vitest';

import { OFFICIAL_DESIGNER_PROMPT } from '../src/prompts/official-system.js';
import { SLIM_CORE_CHARTER } from '../src/prompts/core-slim.js';
import { PROTOTYPE_QA_VIEWPORTS } from '../src/prototype-qa.js';

/**
 * The audit renders screenshots that nothing then looks at.
 *
 * Running the audit only surfaces what the geometry checks can measure —
 * overflow, touch targets, failed assets. It cannot see a heading duplicated
 * one row below itself, a hole in a grid, or a label that reads wrong. Those
 * reached the user repeatedly while every audit reported PASS.
 *
 * The agent's model can read a screenshot (verified end to end against the
 * local runtime). Nothing was telling it to.
 */
const PROMPTS: ReadonlyArray<readonly [string, string]> = [
  ['official-system', OFFICIAL_DESIGNER_PROMPT],
  ['core-slim', SLIM_CORE_CHARTER],
];

describe.each(PROMPTS)('%s prompt', (_name, prompt) => {
  it('tells the agent to look at the screenshot, not just run the audit', () => {
    expect(prompt.toLowerCase()).toMatch(/(open|view|look at|inspect)[^.]{0,60}screenshot/u);
  });

  it('says what to look for that the checks cannot measure', () => {
    // Without naming these, "look at the screenshot" reads as decorative.
    expect(prompt.toLowerCase()).toMatch(/duplicat/u);
  });

  it('lists every viewport the audit actually renders', () => {
    // The prompt described two viewports after a third was added, so the
    // agent was told to expect fewer screenshots than it gets.
    for (const viewport of PROTOTYPE_QA_VIEWPORTS) {
      expect(prompt).toContain(String(viewport.width));
    }
  });

  it('does not promise the agent can see when it cannot', () => {
    // A text-only model must be told to say so rather than invent a reading.
    expect(prompt.toLowerCase()).toMatch(/cannot (view|see)|unable to view/u);
  });
});
