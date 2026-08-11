#!/usr/bin/env node

import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

function cleanBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/u, '');
}

const qwenBaseUrl = cleanBaseUrl(process.env.LOCAL_LLM_DEV_URL);
const deepSeekBaseUrl = cleanBaseUrl(process.env.LOCAL_LLM_CODING_URL);
const controlUrl = cleanBaseUrl(process.env.LOCAL_LLM_CONTROL_URL);
const controlToken = String(process.env.LOCAL_LLM_CONTROL_TOKEN || '').trim();

if (!qwenBaseUrl || !deepSeekBaseUrl || !controlUrl || !controlToken) {
  console.log('[talos-local-agents] local runtimes are not fully configured; keeping Codex only');
  process.exit(0);
}

const home = os.homedir();
const openCodeDir = path.join(home, '.config', 'opencode');
const openDesignDir = path.join(home, '.open-design');
await mkdir(openCodeDir, { recursive: true });
await mkdir(openDesignDir, { recursive: true });

const openCodeConfig = {
  $schema: 'https://opencode.ai/config.json',
  provider: {
    qwen_local: {
      npm: '@ai-sdk/openai-compatible',
      name: 'Qwen Local',
      options: {
        baseURL: `${qwenBaseUrl}/v1`,
        apiKey: 'local-runtime',
      },
      models: {
        'qwen3.6-27b': { name: 'Qwen 3.6 27B' },
        'qwen3.6-35b': { name: 'Qwen 3.6 35B' },
      },
    },
    deepseek_local: {
      npm: '@ai-sdk/openai-compatible',
      name: 'DeepSeek Local',
      options: {
        baseURL: `${deepSeekBaseUrl}/v1`,
        apiKey: 'local-runtime',
      },
      models: {
        'deepseek-v4-flash-0731-q2': { name: 'DeepSeek V4 Flash 0731 Q2' },
      },
    },
  },
};

const agentProfiles = {
  agents: [
    {
      id: 'talos-qwen',
      name: 'Qwen Local',
      baseAgent: 'opencode',
      bin: '/usr/local/bin/talos-opencode-runtime',
      defaultModel: 'qwen_local/qwen3.6-35b',
      models: [
        { id: 'qwen_local/qwen3.6-27b', label: 'Qwen 3.6 27B' },
        { id: 'qwen_local/qwen3.6-35b', label: 'Qwen 3.6 35B' },
      ],
      env: { TALOS_LLM_MODE: 'chat' },
    },
    {
      id: 'talos-deepseek',
      name: 'DeepSeek V4 Flash Local',
      baseAgent: 'opencode',
      bin: '/usr/local/bin/talos-opencode-runtime',
      defaultModel: 'deepseek_local/deepseek-v4-flash-0731-q2',
      models: [
        {
          id: 'deepseek_local/deepseek-v4-flash-0731-q2',
          label: 'DeepSeek V4 Flash 0731 Q2',
        },
      ],
      env: { TALOS_LLM_MODE: 'coding' },
    },
  ],
};

await Promise.all([
  writeFile(path.join(openCodeDir, 'opencode.json'), `${JSON.stringify(openCodeConfig, null, 2)}\n`, { mode: 0o600 }),
  writeFile(path.join(openDesignDir, 'agents.local.json'), `${JSON.stringify(agentProfiles, null, 2)}\n`, { mode: 0o600 }),
]);
console.log('[talos-local-agents] configured Sol, Qwen, and DeepSeek execution profiles');
