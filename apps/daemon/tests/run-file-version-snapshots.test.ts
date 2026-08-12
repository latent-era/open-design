import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { snapshotAiHtmlVersionsForRun } from '../src/run-html-version-snapshots.js';

const dirs: string[] = [];

function project(): { projectsRoot: string; projectId: string; projectRoot: string } {
  const projectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'od-versions-'));
  dirs.push(projectsRoot);
  const projectId = 'proj-1';
  const projectRoot = path.join(projectsRoot, projectId);
  fs.mkdirSync(path.join(projectRoot, 'screens'), { recursive: true });
  return { projectsRoot, projectId, projectRoot };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('run file version snapshots', () => {
  it('versions a stylesheet the run touched', async () => {
    // A request to remove one decorative line edited only a shared stylesheet.
    // HTML-only coverage meant the change produced no version at all, so there
    // was nothing to restore for exactly the edit a user would want to undo.
    const { projectsRoot, projectId, projectRoot } = project();
    const cssPath = path.join(projectRoot, 'screens', 'boxing-calendar.css');
    fs.writeFileSync(cssPath, '.fight-bill__versus { color: red; }', 'utf8');

    const result = await snapshotAiHtmlVersionsForRun({
      projectsRoot,
      projectId,
      projectRoot,
      diff: { touchedPaths: [cssPath] },
      prompt: 'remove the vertical line',
    });

    expect(result.snapshots.map((s) => s.fileName)).toEqual(['screens/boxing-calendar.css']);
  });

  it('still ignores binary and unlisted file types', async () => {
    const { projectsRoot, projectId, projectRoot } = project();
    const pngPath = path.join(projectRoot, 'screens', 'shot.png');
    fs.writeFileSync(pngPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const result = await snapshotAiHtmlVersionsForRun({
      projectsRoot,
      projectId,
      projectRoot,
      diff: { touchedPaths: [pngPath] },
      prompt: null,
    });

    expect(result.snapshots).toEqual([]);
  });
});
