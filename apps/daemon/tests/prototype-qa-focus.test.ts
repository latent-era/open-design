import { describe, expect, it } from 'vitest';
import { partitionPrototypeQaFiles } from '../src/prototype-qa.js';

const ALL = [
  'screens/next-bell-home.html',
  'screens/discover-browse-events.html',
  'screens/profile-settings-screen.html',
];

describe('prototype QA file partition', () => {
  it('blocks on the focused page and advises on the rest', () => {
    // Editing one shared stylesheet marked every page in the project as
    // affected, which failed a turn whose edit had succeeded. One real check
    // gives usable confidence; the rest are reported, not enforced.
    const { blocking, advisory } = partitionPrototypeQaFiles({
      htmlFiles: ALL,
      focusedFile: 'screens/discover-browse-events.html',
    });
    expect(blocking).toEqual(['screens/discover-browse-events.html']);
    expect(advisory).toEqual([
      'screens/next-bell-home.html',
      'screens/profile-settings-screen.html',
    ]);
  });

  it('blocks on nothing when no page is in focus', () => {
    // Better to report than to fail a turn against an arbitrarily chosen page.
    const { blocking, advisory } = partitionPrototypeQaFiles({
      htmlFiles: ALL,
      focusedFile: null,
    });
    expect(blocking).toEqual([]);
    expect(advisory).toEqual(ALL);
  });

  it('ignores a focused page outside the affected set', () => {
    const { blocking, advisory } = partitionPrototypeQaFiles({
      htmlFiles: ALL,
      focusedFile: 'screens/unrelated.html',
    });
    expect(blocking).toEqual([]);
    expect(advisory).toEqual(ALL);
  });

  it('normalizes windows separators before matching', () => {
    const { blocking } = partitionPrototypeQaFiles({
      htmlFiles: ALL,
      focusedFile: 'screens\\next-bell-home.html',
    });
    expect(blocking).toEqual(['screens/next-bell-home.html']);
  });
});
