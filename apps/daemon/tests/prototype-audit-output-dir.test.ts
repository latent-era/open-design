import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { defaultPrototypeAuditOutputDir } from '../src/prototype-qa.js';

/**
 * Where audit screenshots are written.
 *
 * The default was `qa`, resolved against the agent's cwd. In the packaged
 * container that cwd is the read-only image root, so the audit died on
 * `mkdir '/app/qa'` and every turn failed the QA gate with its actual edit
 * already written to disk. Screenshots are daemon-managed data and belong
 * under the data root, which is the writable volume.
 */
describe('defaultPrototypeAuditOutputDir', () => {
  it('writes under the data root, not the working directory', () => {
    expect(defaultPrototypeAuditOutputDir('/app', undefined)).toBe(path.join('.od', 'qa'));
  });

  it('honours an explicit data dir inside the project root', () => {
    expect(defaultPrototypeAuditOutputDir('/app', '/app/data')).toBe(path.join('data', 'qa'));
  });

  it('falls back to the default root when the data dir is outside the project', () => {
    // The audit writer resolves the output dir under projectRoot and refuses
    // to escape it, so an outside data dir cannot be expressed here.
    expect(defaultPrototypeAuditOutputDir('/app', '/var/lib/od')).toBe(path.join('.od', 'qa'));
  });
});
