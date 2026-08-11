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

function isRuntimeReadyForMode(status, targetMode) {
  if (!status || typeof status !== 'object') return false;
  return targetMode === 'chat'
    ? status.qwen_active === true && status.qwen_status_active === true
    : status.ds4_active === true;
}

async function selectRuntime() {
  if (args.includes('--version') || !mode) return;
  const baseUrl = String(process.env.LOCAL_LLM_CONTROL_URL || '').replace(/\/+$/u, '');
  const token = String(process.env.LOCAL_LLM_CONTROL_TOKEN || '');
  if (!baseUrl || !token) throw new Error('Talos local runtime control is not configured');
  const authHeader = { authorization: `Bearer ${token}` };

  // Every chat turn spawns `opencode` through this wrapper, not just an
  // explicit model switch. Without this check, every single message paid the
  // full switch cost (and could exceed the request timeout below) even when
  // the target model was already loaded and nothing needed to change —
  // this was failing ordinary chat turns with "aborted due to timeout".
  const statusResponse = await fetch(`${baseUrl}/status`, {
    headers: authHeader,
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  if (statusResponse?.ok) {
    const status = await statusResponse.json().catch(() => null);
    if (isRuntimeReadyForMode(status, mode)) return;
  }

  // A cold model load can take minutes (observed >190s in production), so
  // this only fires when a real switch is needed (the check above skips it
  // otherwise), and gets a generous ceiling rather than the request's own
  // lifetime deciding success.
  const response = await fetch(`${baseUrl}/mode`, {
    method: 'POST',
    headers: {
      ...authHeader,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ mode }),
    signal: AbortSignal.timeout(600_000),
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
