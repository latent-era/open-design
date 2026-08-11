#!/usr/bin/env node

import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
const mode = process.env.TALOS_LLM_MODE;

if (args[0] === 'models') {
  const models = mode === 'coding'
    ? ['deepseek_local/deepseek-v4-flash-0731-q2']
    : ['qwen_local/qwen3.6-27b', 'qwen_local/qwen3.6-35b'];
  process.stdout.write(`${models.join('\n')}\n`);
  process.exit(0);
}

async function selectRuntime() {
  if (args.includes('--version') || !mode) return;
  const baseUrl = String(process.env.LOCAL_LLM_CONTROL_URL || '').replace(/\/+$/u, '');
  const token = String(process.env.LOCAL_LLM_CONTROL_TOKEN || '');
  if (!baseUrl || !token) throw new Error('Talos local runtime control is not configured');

  const response = await fetch(`${baseUrl}/mode`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ mode }),
    signal: AbortSignal.timeout(190_000),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    const detail = typeof payload.error === 'string' ? payload.error : `HTTP ${response.status}`;
    throw new Error(`Unable to activate the ${mode} runtime: ${detail}`);
  }
}

try {
  await selectRuntime();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

const child = spawn('opencode', args, { stdio: 'inherit', env: process.env });
child.on('error', (error) => {
  console.error(`Unable to start OpenCode: ${error.message}`);
  process.exit(1);
});
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
