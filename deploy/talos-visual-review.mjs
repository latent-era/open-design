#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const MAX_IMAGES = 8;
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const TIMEOUT_MS = 180_000;
const IMAGE_EXTENSIONS = new Set(['.gif', '.jpeg', '.jpg', '.png', '.webp']);

function usage(message) {
  if (message) console.error(message);
  console.error(
    'Usage: talos-visual-review --image <path> [--image <path> ...] --prompt <question>',
  );
  process.exit(2);
}

function parseArgs(argv) {
  const images = [];
  let prompt = '';
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--image') {
      const value = argv[index + 1];
      if (!value) usage('--image requires a path');
      images.push(value);
      index += 1;
    } else if (arg === '--prompt') {
      const value = argv[index + 1];
      if (!value) usage('--prompt requires text');
      prompt = value;
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      usage();
    } else {
      usage(`Unknown argument: ${arg}`);
    }
  }
  if (images.length === 0) usage('At least one --image is required');
  if (images.length > MAX_IMAGES) usage(`At most ${MAX_IMAGES} images are supported`);
  if (!prompt.trim()) usage('--prompt is required');
  return { images, prompt: prompt.trim() };
}

async function validateImages(imageArgs) {
  const resolved = [];
  for (const input of imageArgs) {
    const imagePath = path.resolve(input);
    if (!IMAGE_EXTENSIONS.has(path.extname(imagePath).toLowerCase())) {
      throw new Error(`Unsupported image type: ${input}`);
    }
    const info = await stat(imagePath);
    if (!info.isFile()) throw new Error(`Image is not a file: ${input}`);
    if (info.size === 0 || info.size > MAX_IMAGE_BYTES) {
      throw new Error(`Image must be between 1 byte and ${MAX_IMAGE_BYTES} bytes: ${input}`);
    }
    resolved.push(imagePath);
  }
  return resolved;
}

function runCodex(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.CODEX_CLI_PATH || 'codex', args, {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('Visual review timed out'));
    }, TIMEOUT_MS);

    const collect = (chunks, chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_OUTPUT_BYTES) {
        child.kill('SIGTERM');
        reject(new Error('Visual review output exceeded the safety limit'));
        return;
      }
      chunks.push(chunk);
    };
    child.stdout.on('data', (chunk) => collect(stdout, chunk));
    child.stderr.on('data', (chunk) => collect(stderr, chunk));
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(Buffer.concat(stdout).toString('utf8'));
        return;
      }
      const detail = Buffer.concat(stderr).toString('utf8').trim();
      reject(new Error(detail || `Codex exited with ${signal || code}`));
    });
  });
}

function extractLastAgentMessage(raw) {
  let text = '';
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
        text = typeof event.item.text === 'string' ? event.item.text : text;
      }
    } catch {
      // Codex may emit non-JSON diagnostics around its JSON event stream.
    }
  }
  return text;
}

const { images: imageArgs, prompt } = parseArgs(process.argv.slice(2));
const images = await validateImages(imageArgs);
const tempDir = await mkdtemp(path.join(os.tmpdir(), 'talos-visual-review-'));
try {
  const outputPath = path.join(tempDir, 'last-message.txt');
  const model = process.env.CODEX_VISION_MODEL || 'gpt-5.6-sol';
  const args = [
    'exec',
    '--json',
    '--ephemeral',
    '--sandbox',
    'read-only',
    '--skip-git-repo-check',
    '--ignore-user-config',
    '--model',
    model,
    '--config',
    'model_reasoning_effort="medium"',
    '--output-last-message',
    outputPath,
    prompt,
  ];
  for (const imagePath of images) args.push('--image', imagePath);

  const raw = await runCodex(args);
  const saved = await readFile(outputPath, 'utf8').catch(() => '');
  const result = saved.trim() || extractLastAgentMessage(raw).trim();
  if (!result) throw new Error('Visual reviewer returned no analysis');
  process.stdout.write(`${result}\n`);
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
