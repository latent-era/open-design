import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runPrototypeAudit } from '../src/prototype-qa.js';

/**
 * The assembled audit, against a real headless browser.
 *
 * Everything else about states is checked without a browser: discovery is a
 * pure function, and the class/hover mechanism can be exercised with puppeteer
 * directly. Neither proves that `runPrototypeAudit` — the function that
 * actually ships — renders the states, writes their screenshots, and records
 * them on the receipt.
 *
 * Skipped unless a browser is configured, so it never fails a machine that has
 * no browserless. To run it here: `ssh -N -L 3200:127.0.0.1:3200 talos`, then
 *   OD_BROWSERLESS_WS_URL=ws://127.0.0.1:3200 \
 *   OD_QA_PREVIEW_HOST=<this machine's IP reachable from browserless> \
 *   npx vitest run -c vitest.config.ts tests/prototype-qa-states-browser.test.ts
 * The host matters: browserless fetches the page back over the network, so
 * `localhost` would resolve to the browser's own container.
 */
const WS_URL = process.env.OD_BROWSERLESS_WS_URL;
const PREVIEW_HOST = process.env.OD_QA_PREVIEW_HOST;
const PORT = Number(process.env.OD_QA_PREVIEW_PORT ?? 18081);
const enabled = Boolean(WS_URL && PREVIEW_HOST);

const PAGE = `<!doctype html><html><head><link rel="stylesheet" href="theme.css"></head><body>
  <div class="list"><div class="row"></div><div class="row"></div></div>
  <p class="empty">No sessions booked yet.</p>
  <button class="cta" data-od-hover>Book a session</button>
</body></html>`;

const CSS = `body{font:16px sans-serif;margin:0;padding:24px;background:#fff}
.list{display:grid;gap:8px}.row{height:48px;background:#dfe7ff;border-radius:8px}
.empty{display:none}
.od-state-empty .list{display:none}
.od-state-empty .empty{display:block}
.cta{padding:16px 20px;min-height:44px;background:#2b4cff;color:#fff;border:0;border-radius:8px}
.cta:hover{background:#ff2b6b}`;

describe.skipIf(!enabled)('runPrototypeAudit captures declared states', () => {
  let projectRoot: string;
  let server: http.Server;
  const projectId = 'qa-states-fixture';

  beforeAll(async () => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'od-qa-states-'));
    fs.writeFileSync(path.join(projectRoot, 'index.html'), PAGE, 'utf8');
    fs.writeFileSync(path.join(projectRoot, 'theme.css'), CSS, 'utf8');
    // The production case: a second screen sharing the stylesheet, so it
    // "declares" the empty state, while having nothing the state can act on.
    fs.writeFileSync(
      path.join(projectRoot, 'settings.html'),
      '<!doctype html><html><head><link rel="stylesheet" href="theme.css"></head>'
        + '<body><h1>Settings</h1><p>Nothing here is a session.</p></body></html>',
      'utf8',
    );
    server = http.createServer((req, res) => {
      const rel = decodeURIComponent((req.url ?? '').split('?')[0] ?? '')
        .replace(`/api/projects/${projectId}/files/`, '');
      // The browser asks for a favicon unprompted; a 404 for it is a console
      // error the audit rightly reports, and it would mask what this fixture is
      // actually testing.
      if (rel.includes('favicon')) {
        res.writeHead(204).end();
        return;
      }
      const file = path.join(projectRoot, rel);
      if (!file.startsWith(projectRoot) || !fs.existsSync(file)) {
        res.writeHead(404).end('no');
        return;
      }
      res.writeHead(200, {
        'content-type': rel.endsWith('.css') ? 'text/css' : 'text/html',
      });
      res.end(fs.readFileSync(file));
    });
    await new Promise<void>((resolve) => server.listen(PORT, '0.0.0.0', resolve));
  });

  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (projectRoot) fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it('renders, screenshots and records every declared state', async () => {
    const receipt = await runPrototypeAudit({
      projectRoot,
      projectId,
      relpath: 'index.html',
      browserWsUrl: WS_URL!,
      previewOrigin: `http://${PREVIEW_HOST}:${PORT}`,
    });

    const states = (receipt.states ?? []).map((state) => state.state).sort();
    expect(states).toEqual(['empty', 'hover']);

    // Every state screenshot must exist on disk and be distinct from the base
    // capture — a state that silently renders identically to the normal view
    // is the failure mode this whole feature exists to remove.
    const baseShot = receipt.viewports[0]!.screenshot;
    const baseBytes = fs.readFileSync(path.resolve(projectRoot, baseShot));
    for (const state of receipt.states ?? []) {
      const shot = path.resolve(projectRoot, state.screenshot);
      expect(fs.existsSync(shot)).toBe(true);
      expect(fs.readFileSync(shot).equals(baseBytes)).toBe(false);
    }

    // States are captured at one viewport only. Multiplying them across all
    // three is the cost blow-up this design deliberately avoids.
    const stateViewports = new Set((receipt.states ?? []).map((s) => s.viewport.name));
    expect(stateViewports.size).toBe(1);
  }, 180_000);

  it('reports a mostly-empty state without failing the turn', async () => {
    // The failure someone who does not build apps is least able to name: an
    // empty state hides a list, puts a short message in its place, and leaves
    // most of the screen blank. Nothing overflows, nothing is clipped, so every
    // other check passes it. It has to be reported — and it must not fail the
    // turn, because "this looks airy" is a judgement, not a defect.
    const receipt = await runPrototypeAudit({
      projectRoot,
      projectId,
      relpath: 'index.html',
      browserWsUrl: WS_URL!,
      previewOrigin: `http://${PREVIEW_HOST}:${PORT}`,
    });

    const emptyState = (receipt.states ?? []).find((state) => state.state === 'empty');
    const sparse = (emptyState?.issues ?? []).filter((issue) => issue.type === 'sparse');
    expect(sparse).toHaveLength(1);
    expect(sparse[0]?.advisory).toBe(true);
    expect(sparse[0]?.message).toMatch(/% of the screen is empty/u);

    // The whole point of the severity split: a sparse layout is reported and
    // the turn still succeeds.
    expect(receipt.passed).toBe(true);
  }, 180_000);

  it('skips a state the page shares but cannot exhibit', async () => {
    // settings.html links the same stylesheet, so it declares `empty` exactly
    // as index.html does — but it has no `.sessions-list` or `.sessions-empty`.
    // Rendering the state there would produce a capture identical to the normal
    // view and a receipt entry implying something was checked. The hover state
    // is likewise absent: no element carries data-od-hover.
    const receipt = await runPrototypeAudit({
      projectRoot,
      projectId,
      relpath: 'settings.html',
      browserWsUrl: WS_URL!,
      previewOrigin: `http://${PREVIEW_HOST}:${PORT}`,
    });

    expect(receipt.states ?? []).toEqual([]);

    // And no stray state screenshots were written for it.
    const shots = fs
      .readdirSync(path.join(projectRoot, 'qa'))
      .filter((name) => name.includes('settings') && name.includes('empty'));
    expect(shots).toEqual([]);
  }, 180_000);
});
