import fs from 'node:fs';
import path from 'node:path';

import { listProjectHtmlFiles, prototypeStateSources } from './prototype-qa.js';

export interface ProjectBrandSources {
  /** The page handed to the extractor as the structural sample. */
  file: string;
  html: string;
  /** Every local stylesheet in the project, concatenated. */
  css: string;
}

/**
 * Pick the page that best represents the project.
 *
 * Deterministic by construction: the same project must always yield the same
 * brand source, or re-extracting a design system would produce a different
 * answer each time for no reason the user could see.
 */
export function selectBrandSourcePage(
  htmlFiles: readonly string[],
  entryFile: string | null,
): string | null {
  if (htmlFiles.length === 0) return null;
  if (entryFile && htmlFiles.includes(entryFile)) return entryFile;
  return htmlFiles.find((file) => /(?:^|\/)index\.html?$/iu.test(file)) ?? htmlFiles[0] ?? null;
}

/**
 * Turn a project folder into the inputs `extractBrandFromHtml` wants.
 *
 * This is the step whose absence left `od brand extract-from-html` unused: it
 * asks for one hand-supplied HTML document, and what anyone actually has is a
 * folder of screens sharing a stylesheet.
 *
 * One page supplies the structure, because concatenating several documents
 * produces a DOM that is not any real page. Every stylesheet supplies the
 * vocabulary, because that is where a design system actually lives and a
 * multi-screen prototype spreads its palette across screens — sampling only the
 * entry page's stylesheet would mistake one screen for the brand.
 */
export function collectProjectBrandSources(
  projectRoot: string,
  entryFile: string | null,
): ProjectBrandSources | null {
  let htmlFiles: string[];
  try {
    htmlFiles = listProjectHtmlFiles(projectRoot);
  } catch {
    return null;
  }
  const file = selectBrandSourcePage(htmlFiles, entryFile);
  if (!file) return null;

  let html: string;
  try {
    html = fs.readFileSync(path.resolve(projectRoot, file), 'utf8');
  } catch {
    return null;
  }

  // prototypeStateSources already resolves a page's local dependencies through
  // the project-root guard, so a traversal in an href cannot reach host files.
  // Its first entry is the page itself; the rest are its stylesheets.
  const seen = new Set<string>();
  const css: string[] = [];
  for (const page of htmlFiles) {
    let sources: string[];
    try {
      sources = prototypeStateSources(projectRoot, page);
    } catch {
      continue;
    }
    for (const source of sources.slice(1)) {
      if (seen.has(source)) continue;
      seen.add(source);
      css.push(source);
    }
  }

  return { file, html, css: css.join('\n') };
}
