import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  listProjectHtmlFiles,
  PROTOTYPE_QA_RECEIPT_VERSION,
  prototypeQaReceiptPath,
  validatePrototypeQaReceipts,
} from '../src/prototype-qa.js';

let projectRoot: string;

beforeEach(async () => {
  projectRoot = await mkdtemp(join(tmpdir(), 'prototype-qa-test-'));
});

afterEach(async () => {
  await rm(projectRoot, { recursive: true, force: true });
});

async function writePassingReceipt(relpath: string, auditedAt = new Date().toISOString()) {
  const content = await readFile(join(projectRoot, relpath));
  const receiptPath = prototypeQaReceiptPath(projectRoot, relpath);
  await mkdir(dirname(receiptPath), { recursive: true });
  await writeFile(receiptPath, JSON.stringify({
    version: PROTOTYPE_QA_RECEIPT_VERSION,
    projectId: 'project-1',
    file: relpath,
    fileSha256: createHash('sha256').update(content).digest('hex'),
    auditedAt,
    passed: true,
    viewports: [
      { viewport: { name: 'mobile', width: 390, height: 844 }, screenshot: 'qa/mobile.png', issues: [] },
      { viewport: { name: 'desktop', width: 1280, height: 900 }, screenshot: 'qa/desktop.png', issues: [] },
    ],
  }));
}

describe('prototype QA receipts', () => {
  it('lists project HTML while excluding QA and hidden output', async () => {
    await mkdir(join(projectRoot, 'screens'), { recursive: true });
    await mkdir(join(projectRoot, 'qa'), { recursive: true });
    await mkdir(join(projectRoot, '.open-design'), { recursive: true });
    await writeFile(join(projectRoot, 'index.html'), '<main>Home</main>');
    await writeFile(join(projectRoot, 'screens', 'detail.htm'), '<main>Detail</main>');
    await writeFile(join(projectRoot, 'qa', 'ignored.html'), 'ignored');
    await writeFile(join(projectRoot, '.open-design', 'ignored.html'), 'ignored');

    expect(listProjectHtmlFiles(projectRoot)).toEqual(['index.html', 'screens/detail.htm']);
  });

  it('accepts a passing receipt tied to the current file revision', async () => {
    await writeFile(join(projectRoot, 'index.html'), '<main>Ready</main>');
    await writePassingReceipt('index.html');

    expect(validatePrototypeQaReceipts({ projectRoot, htmlFiles: ['index.html'] })).toEqual([]);
  });

  it('rejects missing, failed, stale, and pre-change receipts', async () => {
    await writeFile(join(projectRoot, 'index.html'), '<main>First</main>');
    expect(validatePrototypeQaReceipts({ projectRoot, htmlFiles: ['index.html'] })).toEqual([
      { file: 'index.html', reason: 'missing' },
    ]);

    await writePassingReceipt('index.html', '2026-01-01T00:00:00.000Z');
    expect(validatePrototypeQaReceipts({
      projectRoot,
      htmlFiles: ['index.html'],
      modifiedAfterMs: Date.parse('2026-01-02T00:00:00.000Z'),
    })).toEqual([{ file: 'index.html', reason: 'stale' }]);

    await writeFile(join(projectRoot, 'index.html'), '<main>Changed</main>');
    expect(validatePrototypeQaReceipts({ projectRoot, htmlFiles: ['index.html'] })).toEqual([
      { file: 'index.html', reason: 'stale' },
    ]);
  });
});
