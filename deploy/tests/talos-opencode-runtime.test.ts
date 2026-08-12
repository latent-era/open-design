import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, '../..');
const scriptPath = path.join(repoRoot, 'deploy/talos-opencode-runtime.mjs');

interface ControllerState {
  qwen_active: boolean;
  qwen_status_active: boolean;
  ds4_active: boolean;
  game_running: boolean;
}

async function withMockController(
  initialStatus: ControllerState,
  modeResponse: { status: number; body: unknown } | null,
  fn: (ctx: {
    baseUrl: string;
    statusCalls: number[];
    modeCalls: Array<{ body: unknown }>;
  }) => Promise<void>,
): Promise<void> {
  let statusCalls: number[] = [];
  const modeCalls: Array<{ body: unknown }> = [];
  let status = { ...initialStatus };

  const server: Server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/status') {
      statusCalls.push(Date.now());
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(status));
      return;
    }
    if (req.method === 'POST' && req.url === '/mode') {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        const body = JSON.parse(raw || '{}');
        modeCalls.push({ body });
        if (!modeResponse) {
          status = body.mode === 'coding'
            ? { qwen_active: false, qwen_status_active: false, ds4_active: true, game_running: false }
            : { qwen_active: true, qwen_status_active: true, ds4_active: false, game_running: false };
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(status));
          return;
        }
        res.writeHead(modeResponse.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(modeResponse.body));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('failed to bind mock controller');
  try {
    await fn({ baseUrl: `http://127.0.0.1:${address.port}`, statusCalls, modeCalls });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function runWrapper(baseUrl: string, mode: string, args: string[] = ['run']) {
  // Use an absolute node path so execFile itself still resolves; only the
  // *script's own* PATH (for its `spawn('opencode', ...)` call) is broken,
  // so `opencode` is guaranteed not found regardless of the host machine.
  return execFileAsync(process.execPath, [scriptPath, ...args], {
    env: {
      ...process.env,
      PATH: '/nonexistent',
      TALOS_LLM_MODE: mode,
      LOCAL_LLM_CONTROL_URL: baseUrl,
      LOCAL_LLM_CONTROL_TOKEN: 'test-token',
    },
    timeout: 10_000,
  }).catch((error) => error); // `opencode` missing always exits non-zero; caller inspects error.stderr
}

test('talos-opencode-runtime: skips reactivation when the target model is already active', async () => {
  await withMockController(
    { qwen_active: false, qwen_status_active: false, ds4_active: true, game_running: false },
    null,
    async ({ baseUrl, statusCalls, modeCalls }) => {
      // Regression: this wrapper runs before every `opencode` invocation
      // (every chat turn), not just an explicit model switch. Without a
      // short-circuit, it unconditionally re-triggered a full reload cycle
      // on every message — even when the target model was already loaded —
      // which could exceed the request timeout and fail ordinary chat turns
      // with "aborted due to timeout".
      await runWrapper(baseUrl, 'coding');
      assert.equal(statusCalls.length, 1);
      assert.equal(modeCalls.length, 0);
    },
  );
});

test('talos-opencode-runtime: activates the runtime when the target model is not yet active', async () => {
  await withMockController(
    { qwen_active: true, qwen_status_active: true, ds4_active: false, game_running: false },
    null,
    async ({ baseUrl, modeCalls }) => {
      await runWrapper(baseUrl, 'coding');
      assert.equal(modeCalls.length, 1);
      assert.deepEqual(modeCalls[0]?.body, { mode: 'coding' });
    },
  );
});

test('talos-opencode-runtime: capability probes never trigger a model switch', async () => {
  await withMockController(
    { qwen_active: true, qwen_status_active: true, ds4_active: false, game_running: false },
    null,
    async ({ baseUrl, modeCalls }) => {
      // Regression: the daemon probes each agent's `helpArgs` to sniff which
      // optional flags the installed CLI advertises. For the Talos profiles
      // those args are inherited from the opencode adapter — `run --help`
      // (apps/daemon/src/runtimes/opencode-permissions.ts) — and the probe
      // env carries the profile's own TALOS_LLM_MODE. Detection is uncached
      // and runs on daemon startup, on /api/agents, and around chat runs,
      // probing BOTH Talos profiles concurrently, so every trigger fired one
      // `mode=chat` and one `mode=coding` switch with no user action at all.
      // That is what silently moved the host off the model the user picked.
      await runWrapper(baseUrl, 'coding', ['run', '--help']);
      assert.deepEqual(modeCalls, []);
    },
  );
});

test('talos-opencode-runtime: non-inference subcommands never trigger a model switch', async () => {
  await withMockController(
    { qwen_active: true, qwen_status_active: true, ds4_active: false, game_running: false },
    null,
    async ({ baseUrl, modeCalls }) => {
      // The previous guard was a denylist of known-harmless invocations, so it
      // broke silently the first time the daemon grew a probe shape it did not
      // enumerate. Only an actual inference run may move the host.
      for (const args of [['--help'], ['auth', 'list'], ['models'], ['--version'], []]) {
        await runWrapper(baseUrl, 'coding', args);
      }
      assert.deepEqual(modeCalls, []);
    },
  );
});

test('talos-opencode-runtime: surfaces a clear error when activation fails', async () => {
  await withMockController(
    { qwen_active: true, qwen_status_active: true, ds4_active: false, game_running: false },
    { status: 500, body: { error: 'controller offline' } },
    async ({ baseUrl }) => {
      const result = await runWrapper(baseUrl, 'coding') as { stderr?: string; code?: number };
      assert.equal(result.code, 1);
      assert.match(
        result.stderr ?? '',
        /Unable to activate the coding runtime: controller offline/,
      );
    },
  );
});
