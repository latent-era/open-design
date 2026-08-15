import type http from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, promises as fsp, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * The loop that turns "it told you it was wrong" into "it fixed it".
 *
 * Every layer below this one is unit tested, and every one of them passed
 * while the feature as a whole did nothing — that is the exact failure this
 * file exists to catch. What matters is the sequence: a dissenting verdict
 * spawns a second agent turn, that turn is handed the reviewer's note and the
 * screenshot, and the loop then STOPS. A bounded retry that fails to bound is
 * worse than no retry at all.
 *
 * Only two things are faked, and only because this host has neither: the
 * headless browser that renders the page, and the vision model that judges it.
 * The daemon, the chat pipeline, the QA gate, the run lifecycle, the retry
 * spawn, and the prompt/screenshot plumbing are all real.
 */
const hoisted = vi.hoisted(() => ({
  reviewerNote: 'NO. The countdown digits are clipped at the right edge.',
  // Flipped to 'satisfied' once the retry attempt has been reviewed, mirroring
  // a model that actually fixes the page. Without this the second review would
  // dissent again and the test could not tell "bounded" from "the reviewer
  // happened to stop complaining".
  reviewCount: 0,
  // When true the reviewer never relents — the case that decides whether the
  // bound is real or incidental.
  alwaysDissent: false,
}));

vi.mock('../src/prototype-qa.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/prototype-qa.js')>();
  const fs = await import('node:fs');
  const path = await import('node:path');
  return {
    ...actual,
    // Stands in for the headless browser. Writes a genuine receipt using the
    // real hash helper — a hand-rolled hash here would be the composite-vs-raw
    // mistake, and the gate would read every receipt as stale.
    runPrototypeAudit: async (input: { projectRoot: string; relpath: string }) => {
      const receiptPath = actual.prototypeQaReceiptPath(input.projectRoot, input.relpath);
      const shotRel = `.od/qa/${input.relpath.replace(/[^a-zA-Z0-9]/gu, '_')}.png`;
      const shotAbs = path.resolve(input.projectRoot, shotRel);
      fs.mkdirSync(path.dirname(shotAbs), { recursive: true });
      fs.writeFileSync(shotAbs, 'fake-png-bytes');
      const receipt = {
        version: actual.PROTOTYPE_QA_RECEIPT_VERSION,
        file: input.relpath,
        fileSha256: actual.prototypeSourceSha256(input.projectRoot, input.relpath),
        auditedAt: new Date().toISOString(),
        passed: true,
        viewports: [
          { width: 390, height: 844, screenshot: shotRel, issues: [] },
          { width: 1280, height: 900, screenshot: shotRel, issues: [] },
        ],
      };
      fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
      fs.writeFileSync(receiptPath, JSON.stringify(receipt), 'utf8');
      return receipt;
    },
  };
});

vi.mock('../src/visual-review.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/visual-review.js')>();
  return {
    // buildVisualReviewRetryPrompt and stageScreenshotForPrompt stay REAL —
    // they are the code under test, not scaffolding.
    ...actual,
    reviewRenderedPage: async () => {
      hoisted.reviewCount += 1;
      return hoisted.reviewCount === 1 || hoisted.alwaysDissent
        ? { verdict: 'not-satisfied' as const, note: hoisted.reviewerNote, reviewer: 'local' as const }
        : { verdict: 'satisfied' as const, note: 'YES. The digits fit.', reviewer: 'local' as const };
    },
  };
});

const { startServer } = await import('../src/server.js');

describe('visual review dissent drives one bounded retry', () => {
  let server: http.Server;
  let baseUrl: string;
  const tempDirs: string[] = [];
  const originalPath = process.env.PATH;
  const originalQaRequired = process.env.OD_PROTOTYPE_QA_REQUIRED;

  beforeAll(async () => {
    process.env.OD_PROTOTYPE_QA_REQUIRED = '1';
    const started = (await startServer({ port: 0, returnServer: true })) as {
      url: string;
      server: http.Server;
    };
    baseUrl = started.url;
    server = started.server;
  });

  afterAll(async () => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    if (originalPath == null) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalQaRequired == null) delete process.env.OD_PROTOTYPE_QA_REQUIRED;
    else process.env.OD_PROTOTYPE_QA_REQUIRED = originalQaRequired;
    if (server) await new Promise<void>((r) => server.close(() => r()));
  });

  async function driveTurn() {
    hoisted.reviewCount = 0;
    const projectId = `proj-${randomUUID()}`;
    const conversationId = `conv-${randomUUID()}`;
    const logDir = mkdtempSync(join(tmpdir(), 'od-visual-retry-log-'));
    tempDirs.push(logDir);
    const invocationLog = join(logDir, 'invocations.jsonl');

    const createProject = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: projectId, name: 'visual retry fixture' }),
    });
    expect(createProject.ok).toBe(true);

    // A fake opencode that writes the page, then records the prompt and argv it
    // was handed. The recording is the assertion surface: it is the only way to
    // see what the retry actually delivered to the model.
    const agentScript = `
const fs = require('node:fs');
let stdin = '';
process.stdin.on('data', (c) => { stdin += c; });
process.stdin.on('end', () => {
  // Each invocation must leave DIFFERENT bytes behind. A retry that rewrites
  // the file identically produces an empty artifact diff, and a run with no
  // diff is never re-verified — so an identical-write fixture would silently
  // prove nothing about whether the repaired page gets looked at.
  const prior = fs.existsSync(${JSON.stringify(invocationLog)})
    ? fs.readFileSync(${JSON.stringify(invocationLog)}, 'utf8').split('\\n').filter(Boolean).length
    : 0;
  fs.writeFileSync('next-bell.html', '<!doctype html><html><head><link rel="stylesheet" href="s.css"></head><body><div class="c">00:4' + prior + '</div></body></html>');
  fs.writeFileSync('s.css', '.c{font-size:' + (48 - prior * 8) + 'px}');
  fs.appendFileSync(${JSON.stringify(invocationLog)}, JSON.stringify({ prompt: stdin, argv: process.argv.slice(2) }) + '\\n');
  console.log(JSON.stringify({ type: 'step_start', sessionID: 'visual-retry-session' }));
  console.log(JSON.stringify({ type: 'text', sessionID: 'visual-retry-session', part: { text: 'Updated the countdown.' } }));
  console.log(JSON.stringify({ type: 'step_finish', part: { tokens: { input: 1, output: 1 } } }));
  process.exit(0);
});
`;
    const binDir = mkdtempSync(join(tmpdir(), 'od-visual-retry-bin-'));
    tempDirs.push(binDir);
    await fsp.writeFile(join(binDir, 'opencode'), `#!/usr/bin/env node\n${agentScript}`);
    await fsp.chmod(join(binDir, 'opencode'), 0o755);
    process.env.PATH = `${binDir}:${originalPath ?? ''}`;

    const response = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentId: 'opencode',
        projectId,
        conversationId,
        previewFileName: 'next-bell.html',
        // A model with a known context window. Routing deliberately stays
        // silent for an unknown model rather than inventing a denominator, so
        // without this the diagnostic correctly never fires.
        model: 'qwen3.6-35b',
        message: 'make the countdown inline on the next bell screen',
      }),
    });
    const body = await response.text();
    expect(response.ok).toBe(true);

    const invocations = existsSync(invocationLog)
      ? readFileSync(invocationLog, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as { prompt: string; argv: string[] })
      : [];

    return { invocations, body };
  }

  it('spawns exactly one follow-up turn carrying the note and the screenshot', async () => {
    const { invocations, body } = await driveTurn();

    // The whole point: the dissent produced a second turn.
    expect(invocations).toHaveLength(2);

    const retryPrompt = invocations[1]!.prompt;
    expect(retryPrompt).toContain('next-bell.html');
    expect(retryPrompt).toContain('countdown digits are clipped');
    expect(retryPrompt.toLowerCase()).toContain('do not start over');

    // The screenshot has to survive resolveSafePromptImagePaths, which drops
    // anything outside UPLOAD_DIR without a word. Staging is what makes it
    // arrive; this asserts it arrived.
    const retryArgv = invocations[1]!.argv.join(' ');
    expect(retryArgv).toMatch(/visual-review-[0-9a-f-]+\.png/u);

    expect(body).toContain('visual_review_retry_attempted');
    expect(body).toContain('"status":"succeeded"');

    // Task-shape routing reports on every turn. It sits behind a try/catch so a
    // fault in it cannot take a run down, which also means a fault would be
    // silent — this asserts it actually reaches the client rather than being
    // swallowed on the way.
    expect(body).toContain('task_routing');
    expect(body).toContain('estimated_tokens');

    // The repaired page must be looked at again — otherwise the retry is a
    // turn nobody checked, which is the failure this whole subsystem exists to
    // remove. This is the assertion that pins run.artifactOutcome being
    // cleared before the follow-up: left set, the second attempt inherits the
    // first attempt's older modifiedAfterMs, the existing receipt still reads
    // as current, the page is skipped, and this count stays at 1.
    expect(hoisted.reviewCount).toBe(2);
  }, 120_000);

  it('tells the client when a task does not fit the model it is running on', async () => {
    // The routing verdict was emitted only as a diagnostic, and diagnostics are
    // filtered out of the chat stream — so it reached nobody. It now rides on
    // the run, which means it has to survive the serializers in runtimes/runs.ts:
    // a field set on the run with no serializer is this repo's most repeated
    // bug, and it is invisible until someone looks for it downstream.
    const projectId = `proj-${randomUUID()}`;
    await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: projectId, name: 'routing fixture' }),
    });
    const binDir = mkdtempSync(join(tmpdir(), 'od-routing-bin-'));
    tempDirs.push(binDir);
    await fsp.writeFile(
      join(binDir, 'opencode'),
      '#!/usr/bin/env node\n'
        + 'process.stdin.on("data",()=>{});process.stdin.on("end",()=>{\n'
        + '  console.log(JSON.stringify({ type: "step_start", sessionID: "routing" }));\n'
        + '  console.log(JSON.stringify({ type: "text", sessionID: "routing", part: { text: "ok" } }));\n'
        + '  console.log(JSON.stringify({ type: "step_finish", part: { tokens: { input: 1, output: 1 } } }));\n'
        + '  process.exit(0);\n});\n',
    );
    await fsp.chmod(join(binDir, 'opencode'), 0o755);
    process.env.PATH = `${binDir}:${originalPath ?? ''}`;

    // Comfortably past 80% of the 35b's 65,536-token window at ~4 chars/token.
    const oversized = `describe this project in detail. ${'x'.repeat(260_000)}`;
    const response = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentId: 'opencode',
        projectId,
        conversationId: `conv-${randomUUID()}`,
        model: 'qwen3.6-35b',
        message: oversized,
      }),
    });
    const body = await response.text();

    expect(body).toContain('taskRouting');
    expect(body).toContain('"fits":false');
  }, 120_000);

  it('stays silent about routing when the task fits comfortably', async () => {
    // Advisories that fire on every turn stop being read.
    const { body } = await driveTurn();
    expect(body).not.toContain('taskRouting');
  }, 120_000);

  it('stops at one retry even when the reviewer never relents', async () => {
    // The property the whole design rests on. A reviewer that dissents on
    // every look must not be able to drive turn after turn: the verdict is
    // probabilistic, and an unbounded loop would burn the context window and
    // the user's time on a judgement that may simply be wrong.
    hoisted.alwaysDissent = true;
    try {
      const { invocations, body } = await driveTurn();
      expect(invocations).toHaveLength(2);
      // The turn still completes. A standing dissent is advisory to the end —
      // it never converts into a failed run.
      expect(body).toContain('"status":"succeeded"');
    } finally {
      hoisted.alwaysDissent = false;
    }
  }, 120_000);
});
