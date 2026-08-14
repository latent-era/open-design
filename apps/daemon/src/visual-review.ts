import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

export type VisualReviewVerdict = 'satisfied' | 'not-satisfied' | 'unknown';

export interface VisualReviewOutcome {
  verdict: VisualReviewVerdict;
  note: string;
  reviewer?: 'local' | 'codex';
}

/**
 * Ask a vision model whether the rendered page actually shows the change.
 *
 * The failure this exists to catch is a turn reporting work it never looked
 * at — describing a countdown as "inline" while the screenshot shows it
 * clipped. So the instruction points at the screenshot rather than at the
 * change description, and demands a leading YES/NO so the verdict does not
 * depend on parsing prose.
 */
export function buildVisualReviewPrompt(request: string): string {
  return [
    'You are checking a screenshot of a user interface after a change was requested.',
    '',
    `The request was: ${request}`,
    '',
    'Judge ONLY what is visible in the screenshot. Do not assume the change was',
    'made. Look for clipped or overlapping text, controls that collide, and',
    'anything cut off at an edge.',
    '',
    'Answer with YES or NO as the very first word: YES if the screenshot shows',
    'the request satisfied and nothing is visibly broken, NO otherwise. Then one',
    'short sentence naming the evidence you saw.',
  ].join('\n');
}

/**
 * Read the verdict out of a model's answer.
 *
 * Anything that does not clearly commit is `unknown`, never `satisfied`: an
 * unreadable answer must not be able to wave a turn through, which would
 * reintroduce exactly the silent approval this check exists to remove.
 */
export function parseVisualReviewVerdict(answer: string): VisualReviewOutcome {
  const withoutThinking = answer.replace(/<think>[\s\S]*?<\/think>/giu, '').trim();
  const note = (withoutThinking || answer).trim().slice(0, 500);
  // A standalone leading token only — "NOT", "NOTHING" and friends start with
  // NO but are prose, not a verdict.
  const leading = /^\W*(yes|no)\b/iu.exec(withoutThinking);
  if (!leading) return { verdict: 'unknown', note };
  return {
    verdict: leading[1]!.toLowerCase() === 'yes' ? 'satisfied' : 'not-satisfied',
    note,
  };
}

function imageDataUrl(screenshotPath: string): string {
  const base64 = fs.readFileSync(screenshotPath).toString('base64');
  const ext = path.extname(screenshotPath).toLowerCase();
  const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'image/png';
  return `data:${mime};base64,${base64}`;
}

/** Ask the local vision-capable model. */
async function reviewWithLocalModel(input: {
  screenshotPath: string;
  request: string;
  endpoint: string;
  model: string;
  timeoutMs: number;
}): Promise<VisualReviewOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    const response = await fetch(`${input.endpoint.replace(/\/$/u, '')}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: input.model,
        // Thinking models spend most of the budget before answering, and a
        // truncated answer parses as `unknown`.
        max_tokens: 700,
        temperature: 0,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: buildVisualReviewPrompt(input.request) },
            { type: 'image_url', image_url: { url: imageDataUrl(input.screenshotPath) } },
          ],
        }],
      }),
    });
    if (!response.ok) throw new Error(`local vision review failed: HTTP ${response.status}`);
    const body = await response.json() as {
      choices?: Array<{ message?: { content?: string | null } }>;
    };
    const content = body.choices?.[0]?.message?.content ?? '';
    return { ...parseVisualReviewVerdict(content), reviewer: 'local' };
  } finally {
    clearTimeout(timer);
  }
}

/** Ask codex, via the existing visual-review helper. */
async function reviewWithCodex(input: {
  screenshotPath: string;
  request: string;
  scriptPath: string;
  timeoutMs: number;
}): Promise<VisualReviewOutcome> {
  const answer = await new Promise<string>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        input.scriptPath,
        '--image', input.screenshotPath,
        '--prompt', buildVisualReviewPrompt(input.request),
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('codex visual review timed out'));
    }, input.timeoutMs);
    child.stdout.on('data', (chunk) => { out += String(chunk); });
    child.stderr.on('data', (chunk) => { err += String(chunk); });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(err.trim() || `codex visual review exited ${code}`));
    });
  });
  return { ...parseVisualReviewVerdict(answer), reviewer: 'codex' };
}

/**
 * Review a rendered page, preferring the local model.
 *
 * Local first by policy: the host runs vision itself, and routing every turn
 * through a cloud model would make local runs depend on it. Codex remains
 * wired as a fallback for when the local host is busy, swapped to a text-only
 * model, or errors.
 *
 * Returns null when no reviewer is configured, so a deployment without vision
 * behaves exactly as before rather than reporting a false verdict.
 */
export async function reviewRenderedPage(input: {
  screenshotPath: string;
  request: string;
  localEndpoint?: string | undefined;
  localModel?: string | undefined;
  codexScriptPath?: string | undefined;
  timeoutMs?: number;
}): Promise<VisualReviewOutcome | null> {
  if (!fs.existsSync(input.screenshotPath)) return null;
  const timeoutMs = input.timeoutMs ?? 120_000;
  const failures: string[] = [];

  if (input.localEndpoint && input.localModel) {
    try {
      return await reviewWithLocalModel({
        screenshotPath: input.screenshotPath,
        request: input.request,
        endpoint: input.localEndpoint,
        model: input.localModel,
        timeoutMs,
      });
    } catch (err) {
      failures.push(`local: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (input.codexScriptPath && fs.existsSync(input.codexScriptPath)) {
    try {
      return await reviewWithCodex({
        screenshotPath: input.screenshotPath,
        request: input.request,
        scriptPath: input.codexScriptPath,
        timeoutMs,
      });
    } catch (err) {
      failures.push(`codex: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (failures.length === 0) return null;
  // Every reviewer failed. Report that rather than silently passing, but do
  // not claim the page is broken either.
  return { verdict: 'unknown', note: `visual review unavailable (${failures.join('; ')})` };
}
