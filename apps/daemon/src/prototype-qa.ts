import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import puppeteer, { type ConsoleMessage, type HTTPRequest, type Page } from 'puppeteer-core';

export const PROTOTYPE_QA_RECEIPT_VERSION = 1;

export interface PrototypeQaViewport {
  name: 'mobile' | 'desktop';
  width: number;
  height: number;
}

export const PROTOTYPE_QA_VIEWPORTS: readonly PrototypeQaViewport[] = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'desktop', width: 1280, height: 900 },
];

export interface PrototypeQaIssue {
  type: 'console' | 'page-error' | 'request' | 'overflow' | 'icon-font' | 'touch-target' | 'broken-link';
  message: string;
  selector?: string;
  url?: string;
  width?: number;
  height?: number;
}

export interface PrototypeQaViewportResult {
  viewport: PrototypeQaViewport;
  screenshot: string;
  issues: PrototypeQaIssue[];
}

export interface PrototypeQaReceipt {
  version: number;
  projectId: string;
  file: string;
  fileSha256: string;
  auditedAt: string;
  passed: boolean;
  viewports: PrototypeQaViewportResult[];
}

function normalizeRelpath(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\//, '');
}

function sha256File(filePath: string): string {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function receiptStem(relpath: string): string {
  const readable = normalizeRelpath(relpath)
    .replace(/\.[^.]+$/u, '')
    .replace(/[^a-zA-Z0-9_-]+/gu, '-');
  const suffix = createHash('sha1').update(normalizeRelpath(relpath)).digest('hex').slice(0, 10);
  return `${readable || 'prototype'}-${suffix}`;
}

export function prototypeQaReceiptPath(projectRoot: string, relpath: string): string {
  return path.join(projectRoot, '.open-design', 'qa', `${receiptStem(relpath)}.json`);
}

function safeProjectFile(projectRoot: string, relpath: string): string {
  const root = path.resolve(projectRoot);
  const full = path.resolve(root, relpath);
  if (full !== root && !full.startsWith(`${root}${path.sep}`)) {
    throw new Error(`prototype path escapes project root: ${relpath}`);
  }
  return full;
}

function browserWsEndpoint(base: string, token?: string): string {
  const endpoint = new URL(base);
  if (token && !endpoint.searchParams.has('token')) endpoint.searchParams.set('token', token);
  return endpoint.toString();
}

function projectFileUrl(origin: string, projectId: string, relpath: string): string {
  const encoded = normalizeRelpath(relpath).split('/').map(encodeURIComponent).join('/');
  return `${origin.replace(/\/$/u, '')}/api/projects/${encodeURIComponent(projectId)}/files/${encoded}`;
}

function screenshotPath(projectRoot: string, outputDir: string, relpath: string, viewport: PrototypeQaViewport): string {
  const outputRoot = safeProjectFile(projectRoot, outputDir);
  fs.mkdirSync(outputRoot, { recursive: true });
  return path.join(outputRoot, `${receiptStem(relpath)}-${viewport.name}.png`);
}

function conciseConsoleIssue(message: ConsoleMessage): PrototypeQaIssue | null {
  if (message.type() !== 'error') return null;
  return { type: 'console', message: message.text().slice(0, 500) };
}

function conciseRequestIssue(request: HTTPRequest): PrototypeQaIssue {
  return {
    type: 'request',
    message: request.failure()?.errorText || 'request failed',
    url: request.url(),
  };
}

async function inspectPage(page: Page): Promise<PrototypeQaIssue[]> {
  return page.evaluate(async () => {
    const browserGlobal = globalThis as any;
    const document = browserGlobal.document;
    const window = browserGlobal.window;
    const location = browserGlobal.location;
    const HTMLElement = browserGlobal.HTMLElement;
    const getComputedStyle = browserGlobal.getComputedStyle;
    const cssEscape = (value: string): string => browserGlobal.CSS?.escape
      ? browserGlobal.CSS.escape(value)
      : value.replace(/[^a-zA-Z0-9_-]/gu, '\\$&');
    const issues: PrototypeQaIssue[] = [];
    const visible = (element: any): boolean => {
      if (!(element instanceof HTMLElement)) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0;
    };
    const selectorFor = (element: any): string => {
      if (element.id) return `#${cssEscape(element.id)}`;
      const className = typeof element.className === 'string'
        ? element.className.trim().split(/\s+/u).slice(0, 2).map((part: string) => `.${cssEscape(part)}`).join('')
        : '';
      return `${element.tagName.toLowerCase()}${className}`;
    };

    const viewportWidth = document.documentElement.clientWidth;
    if (document.documentElement.scrollWidth > viewportWidth + 1 || document.body.scrollWidth > viewportWidth + 1) {
      issues.push({
        type: 'overflow',
        message: `document width ${Math.max(document.documentElement.scrollWidth, document.body.scrollWidth)} exceeds viewport ${viewportWidth}`,
        selector: 'html',
      });
    }

    for (const element of Array.from(document.querySelectorAll('body *')) as any[]) {
      if (!visible(element)) continue;
      const html = element;
      const rect = html.getBoundingClientRect();
      const style = getComputedStyle(html);
      const parentStyle = html.parentElement ? getComputedStyle(html.parentElement) : null;
      const intentionallyScrollable = style.overflowX === 'auto' || style.overflowX === 'scroll'
        || parentStyle?.overflowX === 'auto' || parentStyle?.overflowX === 'scroll';
      if (!intentionallyScrollable && (rect.left < -1 || rect.right > window.innerWidth + 1)) {
        issues.push({
          type: 'overflow',
          message: `visible element spans ${Math.round(rect.left)}..${Math.round(rect.right)} in ${window.innerWidth}px viewport`,
          selector: selectorFor(element),
        });
        if (issues.filter((issue) => issue.type === 'overflow').length >= 12) break;
      }
    }

    for (const element of Array.from(document.querySelectorAll('[class*="material-symbol"], [class*="material-icons"]')) as any[]) {
      if (!visible(element)) continue;
      const text = element.textContent?.trim() || '';
      if (/^[a-z][a-z0-9_]{2,}$/u.test(text)) {
        issues.push({
          type: 'icon-font',
          message: `icon ligature rendered as text: ${text}`,
          selector: selectorFor(element),
        });
      }
    }

    const interactive = document.querySelectorAll('button, input:not([type="hidden"]), select, textarea, summary, [role="button"], a[data-action], nav a');
    for (const element of Array.from(interactive) as any[]) {
      if (!visible(element) || element.hasAttribute('data-qa-touch-ignore')) continue;
      const rect = element.getBoundingClientRect();
      if (rect.width < 44 || rect.height < 44) {
        issues.push({
          type: 'touch-target',
          message: `interactive target is ${Math.round(rect.width)}x${Math.round(rect.height)}; minimum is 44x44`,
          selector: selectorFor(element),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        });
      }
    }

    const links = (Array.from(document.querySelectorAll('a[href]')) as any[])
      .filter(visible)
      .map((link: any) => link.href as string)
      .filter((href: string) => href.startsWith(location.origin) && !href.includes('#'));
    for (const href of [...new Set(links)].slice(0, 30)) {
      try {
        const response = await fetch(href, { method: 'HEAD' });
        if (!response.ok) issues.push({ type: 'broken-link', message: `internal link returned ${response.status}`, url: href });
      } catch (error) {
        issues.push({ type: 'broken-link', message: error instanceof Error ? error.message : 'internal link failed', url: href });
      }
    }
    return issues;
  });
}

export async function runPrototypeAudit(input: {
  projectRoot: string;
  projectId: string;
  relpath: string;
  outputDir?: string;
  browserWsUrl?: string;
  browserToken?: string;
  previewOrigin?: string;
  apiToken?: string;
  viewports?: readonly PrototypeQaViewport[];
}): Promise<PrototypeQaReceipt> {
  const projectRoot = path.resolve(input.projectRoot);
  const relpath = normalizeRelpath(input.relpath);
  const filePath = safeProjectFile(projectRoot, relpath);
  if (!fs.existsSync(filePath)) throw new Error(`prototype file not found: ${relpath}`);
  const browserWsUrl = input.browserWsUrl || process.env.OD_BROWSERLESS_WS_URL;
  if (!browserWsUrl) throw new Error('browser-backed preview is not configured (OD_BROWSERLESS_WS_URL is missing)');
  const previewOrigin = input.previewOrigin || process.env.OD_BROWSERLESS_PREVIEW_ORIGIN || process.env.OD_DAEMON_URL;
  if (!previewOrigin) throw new Error('browser-backed preview origin is not configured');

  const browser = await puppeteer.connect({
    browserWSEndpoint: browserWsEndpoint(browserWsUrl, input.browserToken ?? process.env.OD_BROWSERLESS_TOKEN),
  });
  const results: PrototypeQaViewportResult[] = [];
  try {
    for (const viewport of input.viewports ?? PROTOTYPE_QA_VIEWPORTS) {
      const page = await browser.newPage();
      const runtimeIssues: PrototypeQaIssue[] = [];
      page.on('console', (message) => {
        const issue = conciseConsoleIssue(message);
        if (issue) runtimeIssues.push(issue);
      });
      page.on('pageerror', (error) => runtimeIssues.push({ type: 'page-error', message: error.message.slice(0, 500) }));
      page.on('requestfailed', (request) => runtimeIssues.push(conciseRequestIssue(request)));
      try {
        await page.setViewport({ width: viewport.width, height: viewport.height, deviceScaleFactor: 1 });
        const apiToken = input.apiToken ?? process.env.OD_API_TOKEN;
        if (apiToken) await page.setExtraHTTPHeaders({ authorization: `Bearer ${apiToken}` });
        await page.goto(projectFileUrl(previewOrigin, input.projectId, relpath), {
          waitUntil: 'networkidle2',
          timeout: 30_000,
        });
        const screenshot = screenshotPath(projectRoot, input.outputDir ?? 'qa', relpath, viewport);
        await page.screenshot({ path: screenshot as `${string}.png`, type: 'png', fullPage: false });
        results.push({
          viewport,
          screenshot: normalizeRelpath(path.relative(projectRoot, screenshot)),
          issues: [...runtimeIssues, ...(await inspectPage(page))],
        });
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.disconnect();
  }

  const receipt: PrototypeQaReceipt = {
    version: PROTOTYPE_QA_RECEIPT_VERSION,
    projectId: input.projectId,
    file: relpath,
    fileSha256: sha256File(filePath),
    auditedAt: new Date().toISOString(),
    passed: results.every((result) => result.issues.length === 0),
    viewports: results,
  };
  const receiptPath = prototypeQaReceiptPath(projectRoot, relpath);
  fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
  fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  return receipt;
}

export interface PrototypeQaReceiptFailure {
  file: string;
  reason: 'missing' | 'invalid' | 'stale' | 'failed';
}

export function listProjectHtmlFiles(projectRoot: string): string[] {
  const root = path.resolve(projectRoot);
  const files: string[] = [];
  const ignored = new Set(['node_modules', '.git', '.open-design', 'qa', 'dist', 'build', '.next']);
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!ignored.has(entry.name) && !entry.name.startsWith('.')) walk(path.join(directory, entry.name));
      } else if (entry.isFile() && /\.html?$/iu.test(entry.name)) {
        files.push(normalizeRelpath(path.relative(root, path.join(directory, entry.name))));
      }
    }
  };
  walk(root);
  return files.sort();
}

export function validatePrototypeQaReceipts(input: {
  projectRoot: string;
  htmlFiles: string[];
  modifiedAfterMs?: number;
}): PrototypeQaReceiptFailure[] {
  const failures: PrototypeQaReceiptFailure[] = [];
  for (const relpathRaw of input.htmlFiles) {
    const relpath = normalizeRelpath(relpathRaw);
    const filePath = safeProjectFile(input.projectRoot, relpath);
    const receiptPath = prototypeQaReceiptPath(input.projectRoot, relpath);
    if (!fs.existsSync(receiptPath)) {
      failures.push({ file: relpath, reason: 'missing' });
      continue;
    }
    let receipt: PrototypeQaReceipt;
    try {
      receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as PrototypeQaReceipt;
    } catch {
      failures.push({ file: relpath, reason: 'invalid' });
      continue;
    }
    if (receipt.version !== PROTOTYPE_QA_RECEIPT_VERSION || receipt.file !== relpath || receipt.fileSha256 !== sha256File(filePath)) {
      failures.push({ file: relpath, reason: 'stale' });
      continue;
    }
    const auditedAt = Date.parse(receipt.auditedAt);
    if (!Number.isFinite(auditedAt) || (input.modifiedAfterMs != null && auditedAt < input.modifiedAfterMs)) {
      failures.push({ file: relpath, reason: 'stale' });
      continue;
    }
    if (!receipt.passed || receipt.viewports.length < 2) failures.push({ file: relpath, reason: 'failed' });
  }
  return failures;
}
