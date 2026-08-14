import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { load } from 'cheerio';
import puppeteer, { type ConsoleMessage, type HTTPRequest, type Page } from 'puppeteer-core';

export const PROTOTYPE_QA_RECEIPT_VERSION = 2;

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

function localDependencyPaths(projectRoot: string, relpath: string): string[] {
  const filePath = safeProjectFile(projectRoot, relpath);
  const $ = load(fs.readFileSync(filePath, 'utf8'));
  const dependencies = new Set<string>();
  $('link[rel~="stylesheet"][href], script[src], img[src], source[src], video[poster]').each((_index, element) => {
    const raw = $(element).attr('href') ?? $(element).attr('src') ?? $(element).attr('poster');
    if (!raw || /^(?:[a-z]+:|\/\/|#)/iu.test(raw)) return;
    const withoutQuery = raw.split(/[?#]/u, 1)[0];
    if (!withoutQuery) return;
    const dependency = normalizeRelpath(path.join(path.dirname(relpath), withoutQuery));
    safeProjectFile(projectRoot, dependency);
    dependencies.add(dependency);
  });
  return [...dependencies].sort();
}

export function prototypeSourceSha256(projectRoot: string, relpath: string): string {
  const normalized = normalizeRelpath(relpath);
  const hash = createHash('sha256');
  for (const dependency of [normalized, ...localDependencyPaths(projectRoot, normalized)]) {
    const dependencyPath = safeProjectFile(projectRoot, dependency);
    hash.update(`${dependency}\0`);
    if (fs.existsSync(dependencyPath)) hash.update(fs.readFileSync(dependencyPath));
    else hash.update('<missing>');
    hash.update('\0');
  }
  return hash.digest('hex');
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
      if (element.hasAttribute('data-qa-overflow-ignore')) continue;
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

      const directText = Array.from(html.childNodes)
        .filter((node: any) => node.nodeType === 3)
        .map((node: any) => node.textContent || '')
        .join('')
        .trim();
      const clipsText = directText.length > 0
        && style.textOverflow !== 'ellipsis'
        && (
          ((style.overflowX === 'hidden' || style.overflowX === 'clip') && html.scrollWidth > html.clientWidth + 1)
          || ((style.overflowY === 'hidden' || style.overflowY === 'clip') && html.scrollHeight > html.clientHeight + 1)
        );
      if (clipsText) {
        issues.push({
          type: 'overflow',
          message: `text content is clipped (${html.scrollWidth}x${html.scrollHeight} inside ${html.clientWidth}x${html.clientHeight})`,
          selector: selectorFor(element),
        });
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
  const relpath = normalizeRelpath(toProjectRelativePagePath(projectRoot, input.relpath));
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
    fileSha256: prototypeSourceSha256(projectRoot, relpath),
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
    safeProjectFile(input.projectRoot, relpath);
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
    if (receipt.version !== PROTOTYPE_QA_RECEIPT_VERSION || receipt.file !== relpath || receipt.fileSha256 !== prototypeSourceSha256(input.projectRoot, relpath)) {
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

/** Split the pages a run affected into the one that gates the turn and the rest.
 *
 *  Editing a shared stylesheet marks every page in the project as affected. It
 *  is right to report that and wrong to fail a turn on it: the edit succeeded,
 *  only the verification is outstanding, and a two-declaration CSS tweak was
 *  carrying the most expensive verification in the product.
 *
 *  Exactly one page gates — the one the user has open — so a completed turn
 *  still carries real evidence rather than none. When no page is in focus
 *  nothing blocks; failing against an arbitrarily chosen page would be worse
 *  than reporting. */
export function partitionPrototypeQaFiles(input: {
  htmlFiles: string[];
  focusedFile: string | null;
}): { blocking: string[]; advisory: string[] } {
  const focused = input.focusedFile ? normalizeRelpath(input.focusedFile) : null;
  const files = input.htmlFiles.map((file) => normalizeRelpath(file));
  if (!focused || !files.includes(focused)) {
    return { blocking: [], advisory: files };
  }
  return {
    blocking: [focused],
    advisory: files.filter((file) => file !== focused),
  };
}


/**
 * The directory the audit should treat as the project root.
 *
 * Everything the audit writes hangs off this: the screenshot directory, the
 * receipt directory (`<root>/.open-design/qa`), and the resolution of the
 * page's own relative path. Defaulting it to the agent's working directory
 * breaks in the packaged container, where that is the read-only image root —
 * the audit dies on mkdir and the QA gate then fails turns whose edit has
 * already been written to disk.
 *
 * Managed projects live under the data root, which is the writable volume.
 * Falls back to the working directory when the project is not there, so
 * imported-folder projects and callers already running from a project cwd keep
 * working.
 */
export function resolvePrototypeAuditProjectRoot(
  cwd: string,
  dataDir: string | undefined,
  projectId: string | undefined,
): string {
  if (!projectId) return cwd;
  const root = dataDir?.trim() ? path.resolve(dataDir) : path.join(path.resolve(cwd), '.od');
  const candidate = path.join(root, 'projects', projectId);
  try {
    if (fs.statSync(candidate).isDirectory()) return candidate;
  } catch {
    // Not a managed project directory — fall through.
  }
  return cwd;
}

/**
 * Reduce a page path to the project-relative form the receipt is keyed by.
 *
 * The receipt filename is derived from this value, and the daemon's QA gate
 * looks receipts up by the project-relative path. An absolute path left
 * unnormalized therefore writes a receipt under a name the gate never checks,
 * and the page reads as unverified however many times the audit is run.
 *
 * Paths outside the project are returned untouched so the writer's escape
 * check still rejects them, rather than being quietly rewritten into a
 * successful audit of the wrong file.
 */
export function toProjectRelativePagePath(projectRoot: string, pagePath: string): string {
  if (!path.isAbsolute(pagePath)) return pagePath;
  const root = path.resolve(projectRoot);
  const full = path.resolve(pagePath);
  if (full !== root && !full.startsWith(`${root}${path.sep}`)) return pagePath;
  return path.relative(root, full).split(path.sep).join('/');
}
