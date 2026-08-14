import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  resolvePrototypeAuditProjectRoot,
  toProjectRelativePagePath,
} from '../src/prototype-qa.js';

/**
 * Which directory the audit treats as the project.
 *
 * Everything the audit writes hangs off this: the screenshot directory, the
 * receipt directory (`<root>/.open-design/qa`), and the resolution of the
 * page's own relative path. It defaulted to the agent's working directory,
 * which in the packaged container is the read-only image root — so the audit
 * died on mkdir and, with OD_PROTOTYPE_QA_REQUIRED set, the gate failed every
 * turn whose edit had already been written to disk.
 *
 * The project lives under the data root, which is the writable volume.
 */
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function dataRootWithProject(projectId: string): { cwd: string; dataDir: string } {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'od-audit-root-'));
  dirs.push(cwd);
  const dataDir = path.join(cwd, '.od');
  fs.mkdirSync(path.join(dataDir, 'projects', projectId), { recursive: true });
  return { cwd, dataDir };
}

describe('resolvePrototypeAuditProjectRoot', () => {
  it('resolves the project under the data root', () => {
    const { cwd, dataDir } = dataRootWithProject('proj-1');
    expect(resolvePrototypeAuditProjectRoot(cwd, undefined, 'proj-1'))
      .toBe(path.join(dataDir, 'projects', 'proj-1'));
  });

  it('honours an explicit data dir', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'od-audit-explicit-'));
    dirs.push(cwd);
    const dataDir = path.join(cwd, 'custom-data');
    fs.mkdirSync(path.join(dataDir, 'projects', 'proj-2'), { recursive: true });
    expect(resolvePrototypeAuditProjectRoot(cwd, dataDir, 'proj-2'))
      .toBe(path.join(dataDir, 'projects', 'proj-2'));
  });

  it('falls back to the working directory when no such project exists', () => {
    // An imported-folder project keeps its files outside the managed root, and
    // older callers already pass a real project cwd. Neither should break.
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'od-audit-fallback-'));
    dirs.push(cwd);
    expect(resolvePrototypeAuditProjectRoot(cwd, undefined, 'missing')).toBe(cwd);
  });

  it('falls back when no project id is given', () => {
    const { cwd } = dataRootWithProject('proj-3');
    expect(resolvePrototypeAuditProjectRoot(cwd, undefined, undefined)).toBe(cwd);
  });
});

describe('project-relative page paths', () => {
  it('accepts an absolute path inside the project', () => {
    // The agent passes absolute paths. The receipt filename is derived from
    // this value, while the daemon's gate looks receipts up by the
    // project-relative path -- so an unnormalized absolute path writes a
    // receipt under a name the gate never looks for, and the page reads as
    // unverified forever no matter how many times the audit runs.
    expect(toProjectRelativePagePath('/app/proj', '/app/proj/screens/a.html'))
      .toBe('screens/a.html');
  });

  it('leaves an already-relative path alone', () => {
    expect(toProjectRelativePagePath('/app/proj', 'screens/a.html')).toBe('screens/a.html');
  });

  it('leaves a path outside the project alone so the writer can reject it', () => {
    // Silently rewriting an outside path would turn a path-escape into a
    // successful audit of the wrong file.
    expect(toProjectRelativePagePath('/app/proj', '/etc/passwd')).toBe('/etc/passwd');
  });
});
