import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { load } from 'cheerio';
import puppeteer, { type ConsoleMessage, type HTTPRequest, type Page } from 'puppeteer-core';

export const PROTOTYPE_QA_RECEIPT_VERSION = 2;

export interface PrototypeQaViewport {
  name: 'mobile' | 'mobile-wide' | 'desktop';
  width: number;
  height: number;
}

export const PROTOTYPE_QA_VIEWPORTS: readonly PrototypeQaViewport[] = [
  { name: 'mobile', width: 390, height: 844 },
  // A second phone width, deliberately ABOVE the 390px breakpoint most mobile
  // media queries are written against. With only 390 and 1280, a fix scoped to
  // `@media (max-width: 390px)` passed both — the rule applied at 390 and there
  // was room at 1280 — while every width between stayed broken. 430 is a real
  // device width (iPhone 15 Pro Max) and lands squarely in that gap.
  { name: 'mobile-wide', width: 430, height: 932 },
  { name: 'desktop', width: 1280, height: 900 },
];

export interface PrototypeQaIssue {
  type: 'console' | 'page-error' | 'request' | 'overflow' | 'icon-font' | 'touch-target' | 'broken-link' | 'sparse';
  message: string;
  selector?: string;
  url?: string;
  width?: number;
  height?: number;
  /**
   * Worth reporting, not worth failing a turn over.
   *
   * A blocking check has to be one nobody would argue with — an element off
   * the side of the screen is a defect in any design. Judgements about whether
   * a layout looks finished are not in that class: airy is sometimes the point.
   * Advisory issues reach the receipt and the agent, and leave `passed` alone.
   */
  advisory?: boolean;
}

export interface PrototypeQaViewportResult {
  viewport: PrototypeQaViewport;
  screenshot: string;
  issues: PrototypeQaIssue[];
}

/**
 * A named way to perturb the page before it is captured.
 *
 * Empty, loading, error and modal states are data states: a static prototype
 * has no data layer, so the only thing that can express them is the page's own
 * CSS, keyed off a class. Hover is different — the browser can produce it
 * directly — but the audit still has to be told which element to hover.
 */
export interface PrototypeQaState {
  name: string;
  className?: string;
  hoverSelector?: string;
  /**
   * The elements this state's rules act on.
   *
   * State rules live in a shared stylesheet, so every page linking it declares
   * every state in it. These selectors are what lets the audit decide, before
   * paying for a render, whether the state can do anything on THIS page.
   *
   * Empty means the rules restyle the root element itself, so the state always
   * applies and there is nothing to look for.
   */
  targetSelectors?: string[];
}

export interface PrototypeQaStateResult {
  state: string;
  viewport: PrototypeQaViewport;
  screenshot: string;
  issues: PrototypeQaIssue[];
}

/**
 * Ceiling on states rendered per page. Every state is another full render and
 * screenshot, and this project has already been bitten once by verification
 * cost scaling with something the author did not choose deliberately — a
 * shared-stylesheet edit demanding an audit of every page it touched. A page
 * whose CSS names forty states gets the first few, not forty renders.
 */
export const MAX_PROTOTYPE_QA_STATES = 6;

const STATE_CLASS_PATTERN = /\bod-state-([a-z0-9]+(?:-[a-z0-9]+)*)/giu;
const HOVER_ATTRIBUTE = 'data-od-hover';

/**
 * Work out which states a page declares, by reading its own source.
 *
 * Discovery rather than configuration is the whole point. A per-page config
 * file describing states is one more thing to write and keep in step, so it
 * would sit empty and the feature would go unused — the same fate as
 * `od brand extract-from-html`. Writing the rule that implements a state is
 * what declares it: `.od-state-empty .list { display: none }` is both the
 * implementation and the declaration.
 *
 * Pass the page's HTML plus the contents of its local stylesheets.
 */
/**
 * Pull the descendant selectors out of a state's rules.
 *
 * A deliberately small reader, not a CSS parser: it walks rule preludes and,
 * for those mentioning `od-state-<name>`, keeps whatever follows the state
 * class. `html.od-state-empty .sessions-list` yields `.sessions-list`. A
 * prelude that IS the state class yields nothing, meaning the state restyles
 * the root and always applies. Comments carry no prelude, so the comment naming
 * the class above the rules contributes nothing.
 */
function stateTargetSelectors(sources: readonly string[], name: string): string[] {
  const targets = new Set<string>();
  const rulePattern = /([^{}]+)\{[^{}]*\}/gu;
  const statePattern = new RegExp(`(?:^|[^\\w-])(?:[a-z]+)?\\.od-state-${name}(?![\\w-])`, 'iu');
  for (const source of sources) {
    if (typeof source !== 'string' || !source.includes(`od-state-${name}`)) continue;
    rulePattern.lastIndex = 0;
    let rule = rulePattern.exec(source);
    while (rule) {
      for (const selector of (rule[1] ?? '').split(',')) {
        const trimmed = selector.trim();
        const match = statePattern.exec(trimmed);
        if (!match) continue;
        const remainder = trimmed.slice(match.index + match[0].length).trim();
        if (remainder) targets.add(remainder);
      }
      rule = rulePattern.exec(source);
    }
  }
  return [...targets].sort();
}

export function discoverPrototypeStates(
  sources: readonly string[],
): PrototypeQaState[] {
  const names = new Set<string>();
  let hover = false;
  for (const source of sources) {
    if (typeof source !== 'string' || !source.trim()) continue;
    if (source.includes(HOVER_ATTRIBUTE)) hover = true;
    // Fresh lastIndex per source: the regex is global and module-scoped.
    STATE_CLASS_PATTERN.lastIndex = 0;
    let match = STATE_CLASS_PATTERN.exec(source);
    while (match) {
      const name = match[1];
      if (name) names.add(name.toLowerCase());
      match = STATE_CLASS_PATTERN.exec(source);
    }
  }
  const states: PrototypeQaState[] = [...names]
    .sort()
    .map((name) => ({
      name,
      className: `od-state-${name}`,
      targetSelectors: stateTargetSelectors(sources, name),
    }));
  if (hover) states.push({ name: 'hover', hoverSelector: `[${HOVER_ATTRIBUTE}]` });
  return states.slice(0, MAX_PROTOTYPE_QA_STATES);
}

/** Read the sources discovery needs: the page plus its local stylesheets. */
export function prototypeStateSources(projectRoot: string, relpath: string): string[] {
  const sources: string[] = [];
  try {
    sources.push(fs.readFileSync(safeProjectFile(projectRoot, relpath), 'utf8'));
  } catch {
    return sources;
  }
  for (const dependency of localDependencyPaths(projectRoot, relpath)) {
    if (!/\.css$/iu.test(dependency)) continue;
    try {
      sources.push(fs.readFileSync(safeProjectFile(projectRoot, dependency), 'utf8'));
    } catch {
      // A missing stylesheet is already reported as a failed request by the
      // render itself; it must not take state discovery down with it.
    }
  }
  return sources;
}

export interface PrototypeQaReceipt {
  version: number;
  projectId: string;
  file: string;
  fileSha256: string;
  auditedAt: string;
  passed: boolean;
  viewports: PrototypeQaViewportResult[];
  /**
   * Optional, and deliberately not a receipt-version bump: every existing
   * receipt on disk stays valid, where a bump would mark the whole corpus
   * stale and force a full re-audit of every page to gain a field most pages
   * will never populate.
   */
  states?: PrototypeQaStateResult[];
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

function screenshotPath(
  projectRoot: string,
  outputDir: string,
  relpath: string,
  viewport: PrototypeQaViewport,
  stateName?: string,
): string {
  const outputRoot = safeProjectFile(projectRoot, outputDir);
  fs.mkdirSync(outputRoot, { recursive: true });
  const suffix = stateName ? `-${viewport.name}-${stateName}` : `-${viewport.name}`;
  return path.join(outputRoot, `${receiptStem(relpath)}${suffix}.png`);
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

    // A screen that renders mostly nothing.
    //
    // The audit could already tell you an element was clipped or off-screen,
    // but not that a screen simply looked unfinished — and that is the failure
    // someone who does not build apps is least able to diagnose and most likely
    // to hit, because it is what an empty or loading state does when it hides a
    // list and puts nothing in its place.
    //
    // Measured as the largest continuous band of viewport with no content in
    // it, which is what the eye actually registers. Only counted when the page
    // does not scroll: on a scrolling page the space below the fold is the next
    // screenful, not a hole.
    const viewportHeight = document.documentElement.clientHeight;
    const scrolls = document.documentElement.scrollHeight > viewportHeight + 1;
    if (!scrolls && viewportHeight > 0) {
      const bands: Array<{ top: number; bottom: number }> = [];
      for (const element of Array.from(document.querySelectorAll('body *')) as any[]) {
        if (!visible(element)) continue;
        const hasOwnInk = Array.from(element.childNodes).some(
          (node: any) => node.nodeType === 3 && (node.textContent || '').trim().length > 0,
        ) || ['IMG', 'SVG', 'VIDEO', 'CANVAS', 'INPUT', 'BUTTON', 'SELECT', 'TEXTAREA'].includes(element.tagName);
        if (!hasOwnInk) continue;
        const rect = element.getBoundingClientRect();
        const top = Math.max(0, rect.top);
        const bottom = Math.min(viewportHeight, rect.bottom);
        if (bottom > top) bands.push({ top, bottom });
      }
      bands.sort((a, b) => a.top - b.top);
      let cursor = 0;
      let largestGap = 0;
      let gapAt = 0;
      for (const band of bands) {
        if (band.top - cursor > largestGap) {
          largestGap = band.top - cursor;
          gapAt = cursor;
        }
        cursor = Math.max(cursor, band.bottom);
      }
      if (viewportHeight - cursor > largestGap) {
        largestGap = viewportHeight - cursor;
        gapAt = cursor;
      }
      const ratio = largestGap / viewportHeight;
      if (ratio >= 0.3) {
        issues.push({
          type: 'sparse',
          advisory: true,
          message: `${Math.round(ratio * 100)}% of the screen is empty in one band (${Math.round(largestGap)}px from y=${Math.round(gapAt)}); the layout may read as unfinished`,
          selector: 'body',
        });
      }
    }

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
  const stateResults: PrototypeQaStateResult[] = [];
  const states = discoverPrototypeStates(prototypeStateSources(projectRoot, relpath));
  // Narrowed to the states that can affect this page, decided against the live
  // DOM during the first render. Null until that first page has loaded.
  let applicableStates: PrototypeQaState[] | null = null;
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
        // Decide here, on a page that is already loaded, which declared states
        // can actually do anything to THIS page — before any state render is
        // paid for. State rules live in shared stylesheets, so a page declares
        // every state its stylesheet mentions; the boxing project's empty state
        // is declared by all eight screens and meaningful on one. Testing the
        // live DOM rather than the source catches markup built by scripts,
        // which a static read of the HTML would miss.
        if (applicableStates === null) {
          applicableStates = [];
          for (const state of states) {
            const selectors = state.targetSelectors ?? [];
            if (selectors.length === 0) {
              // Restyles the root itself, or is a hover state with its own
              // selector — nothing to look for.
              applicableStates.push(state);
              continue;
            }
            const present = await page.evaluate((candidates: string[]) => {
              const doc = (globalThis as any).document;
              return candidates.some((selector: string) => {
                try {
                  return doc.querySelector(selector) !== null;
                } catch {
                  // An exotic selector this browser cannot parse is not a
                  // reason to drop the state; render it and let the capture
                  // speak.
                  return true;
                }
              });
            }, selectors);
            if (present) applicableStates.push(state);
          }
        }
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
    // States are captured at ONE viewport, not all of them. The base sweep
    // already covers the responsive question; what a state adds is a different
    // rendering of the same width. Multiplying states by viewports would make
    // a page with four states cost twelve extra renders, which is how
    // verification became too expensive to run last time.
    const stateViewport = (input.viewports ?? PROTOTYPE_QA_VIEWPORTS)[0];
    if (stateViewport) {
      for (const state of applicableStates ?? states) {
        const page = await browser.newPage();
        const runtimeIssues: PrototypeQaIssue[] = [];
        page.on('console', (message) => {
          const issue = conciseConsoleIssue(message);
          if (issue) runtimeIssues.push(issue);
        });
        page.on('pageerror', (error) =>
          runtimeIssues.push({ type: 'page-error', message: error.message.slice(0, 500) }));
        try {
          await page.setViewport({
            width: stateViewport.width,
            height: stateViewport.height,
            deviceScaleFactor: 1,
          });
          const apiToken = input.apiToken ?? process.env.OD_API_TOKEN;
          if (apiToken) await page.setExtraHTTPHeaders({ authorization: `Bearer ${apiToken}` });
          await page.goto(projectFileUrl(previewOrigin, input.projectId, relpath), {
            waitUntil: 'networkidle2',
            timeout: 30_000,
          });
          if (state.className) {
            await page.evaluate((className: string) => {
              (globalThis as any).document.documentElement.classList.add(className);
            }, state.className);
          }
          if (state.hoverSelector) {
            // A declared hover target that no longer exists is a stale
            // annotation, not a render failure — record it and move on.
            try {
              await page.hover(state.hoverSelector);
            } catch {
              runtimeIssues.push({
                type: 'page-error',
                message: `hover target not found: ${state.hoverSelector}`,
                selector: state.hoverSelector,
              });
            }
          }
          const screenshot = screenshotPath(
            projectRoot,
            input.outputDir ?? 'qa',
            relpath,
            stateViewport,
            state.name,
          );
          await page.screenshot({ path: screenshot as `${string}.png`, type: 'png', fullPage: false });
          stateResults.push({
            state: state.name,
            viewport: stateViewport,
            screenshot: normalizeRelpath(path.relative(projectRoot, screenshot)),
            issues: [...runtimeIssues, ...(await inspectPage(page))],
          });
        } finally {
          await page.close();
        }
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
    // A state that renders broken fails the page. This is the point of
    // capturing them: an empty state that collapses to a blank panel is a real
    // defect, and it was previously invisible to every check in the product.
    // Advisory issues are excluded deliberately. A turn whose edits succeeded
    // must not fail because a layout was judged airy — that is the shape of
    // failure that made verification feel like an obstacle rather than a help.
    passed:
      results.every((result) => result.issues.every((issue) => issue.advisory)) &&
      stateResults.every((result) => result.issues.every((issue) => issue.advisory)),
    viewports: results,
    ...(stateResults.length > 0 ? { states: stateResults } : {}),
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
/**
 * Split the affected pages into what BLOCKS, what is merely reported, and
 * what gets VERIFIED.
 *
 * `blocking` stays deliberately narrow — one page — so that editing a shared
 * stylesheet cannot demand an audit of every screen before a turn may finish.
 *
 * `verify` is a separate question and must not be tied to it. Pages that were
 * not blocking were previously never rendered or looked at, so a screen the
 * run rewrote could ship unseen while the turn reported success. Verification
 * therefore covers the focused page plus every HTML page the run actually
 * wrote — bounded by the edit, not by how many pages the stylesheet touches.
 */
export function partitionPrototypeQaFiles(input: {
  htmlFiles: string[];
  focusedFile: string | null;
  changedFiles?: string[];
}): { blocking: string[]; advisory: string[]; verify: string[] } {
  const focused = input.focusedFile ? normalizeRelpath(input.focusedFile) : null;
  const files = input.htmlFiles.map((file) => normalizeRelpath(file));
  const changed = (input.changedFiles ?? [])
    .map((file) => normalizeRelpath(file))
    .filter((file) => files.includes(file));

  const hasFocus = Boolean(focused && files.includes(focused));
  const verify = [...new Set([...(hasFocus ? [focused as string] : []), ...changed])];

  if (!hasFocus) {
    return { blocking: [], advisory: files, verify };
  }
  return {
    blocking: [focused as string],
    advisory: files.filter((file) => file !== focused),
    verify,
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
