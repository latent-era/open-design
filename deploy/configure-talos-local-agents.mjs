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
      // OpenCode compacts a conversation as it approaches `limit.context`.
      // Without the limit declared it has nothing to compare against, so it
      // appends turns until llama-server rejects the request outright and the
      // run dies mid-conversation with no recovery.
      //
      // These are the real per-conversation ceilings, not the servers' totals:
      // llama-swap runs each Qwen with `-c 196608`, and llama.cpp splits that
      // pool across `--parallel` slots. Keep them in step with
      // ~/llama-swap/config.yaml — a limit larger than the server's is worse
      // than none, because it promises room that does not exist.
      //
      // `attachment` / `modalities` declare that these models can read images.
      // Both are served with a multimodal projector (`--mmproj` in
      // ~/llama-swap/config.yaml), but OpenCode assumes text-only unless told
      // otherwise and refuses the attachment outright — the model answers "this
      // model does not support image input" while the server is perfectly
      // capable. Keep these in step with the projector flags: claiming vision a
      // server cannot provide fails at request time instead of politely.
      models: {
        // -c 196608 / --parallel 2
        'qwen3.6-27b': {
          name: 'Qwen 3.6 27B',
          limit: { context: 98304, output: 8192 },
          attachment: true,
          modalities: { input: ['text', 'image'], output: ['text'] },
        },
        // -c 196608 / --parallel 3
        'qwen3.6-35b': {
          name: 'Qwen 3.6 35B',
          limit: { context: 65536, output: 8192 },
          attachment: true,
          modalities: { input: ['text', 'image'], output: ['text'] },
        },
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
        // ds4-server --ctx 262144, single sequence
        'deepseek-v4-flash-0731-q2': {
          name: 'DeepSeek V4 Flash 0731 Q2',
          limit: { context: 262144, output: 8192 },
        },
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
