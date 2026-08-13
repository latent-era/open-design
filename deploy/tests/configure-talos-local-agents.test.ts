import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, '../..');
const scriptPath = path.join(repoRoot, 'deploy/configure-talos-local-agents.mjs');

interface OpenCodeConfig {
  provider: Record<string, {
    models: Record<string, { name?: string; limit?: { context?: number; output?: number } }>;
  }>;
}

async function generateConfig(): Promise<OpenCodeConfig> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'od-talos-agents-'));
  await execFileAsync(process.execPath, [scriptPath], {
    env: {
      ...process.env,
      HOME: home,
      LOCAL_LLM_DEV_URL: 'http://127.0.0.1:8989',
      LOCAL_LLM_CODING_URL: 'http://127.0.0.1:1234',
      LOCAL_LLM_CONTROL_URL: 'http://127.0.0.1:8992',
      LOCAL_LLM_CONTROL_TOKEN: 'test-token',
    },
    timeout: 15_000,
  });
  const written = path.join(home, '.config', 'opencode', 'opencode.json');
  const parsed = JSON.parse(fs.readFileSync(written, 'utf8')) as OpenCodeConfig;
  fs.rmSync(home, { recursive: true, force: true });
  return parsed;
}

test('configure-talos-local-agents: declares each local model context limit', async () => {
  // Regression: the generated config named the models but declared no `limit`,
  // so OpenCode had nothing to compare a growing conversation against and never
  // compacted it. Turns were appended until llama-server rejected the request
  // outright — "request (69553 tokens) exceeds the available context size
  // (65536 tokens)" — and the run died with no recovery, mid-conversation.
  //
  // The limits are not arbitrary: llama-swap runs each Qwen server with
  // `-c 196608`, split across its slots, so the usable per-conversation
  // context is that total divided by `--parallel`.
  const config = await generateConfig();
  const qwen = config.provider.qwen_local?.models ?? {};
  const deepseek = config.provider.deepseek_local?.models ?? {};

  // -c 196608 / --parallel 3
  assert.equal(qwen['qwen3.6-35b']?.limit?.context, 65_536);
  // -c 196608 / --parallel 2
  assert.equal(qwen['qwen3.6-27b']?.limit?.context, 98_304);
  // ds4-server --ctx 262144
  assert.equal(deepseek['deepseek-v4-flash-0731-q2']?.limit?.context, 262_144);
});

test('configure-talos-local-agents: keeps the model display names', async () => {
  const config = await generateConfig();
  const qwen = config.provider.qwen_local?.models ?? {};
  assert.equal(qwen['qwen3.6-35b']?.name, 'Qwen 3.6 35B');
  assert.equal(qwen['qwen3.6-27b']?.name, 'Qwen 3.6 27B');
});
