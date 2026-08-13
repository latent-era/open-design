/**
 * Per-model context windows, mirrored from the Talos app's
 * `MODEL_CONTEXT_WINDOW` rather than re-derived. These are the figures a
 * conversation actually gets, which for the local models is the server's
 * `-c` pool divided by its `--parallel` slot count — not the raw pool.
 *
 * A missing entry is deliberately not filled with a guess: a fabricated
 * denominator under-reports usage, and the user hits the ceiling with no
 * warning. Callers must handle null by showing no meter.
 */
export const MODEL_CONTEXT_WINDOW: Record<string, number> = {
  'claude-opus-4-8': 1_000_000,
  'claude-opus-4-7': 1_000_000,
  'claude-opus-4-6': 1_000_000,
  'claude-sonnet-4-6': 1_000_000,
  'claude-haiku-4-5-20251001': 200_000,
  'gpt-5.5': 256_000,
  'codex-gpt-5.6-sol': 1_000_000,
  'gpt-5.4': 256_000,
  'gpt-5.4-mini': 128_000,
  'gemini-3.1-pro-preview': 2_000_000,
  'gemini-2.5-pro': 2_000_000,
  'gemini-2.5-flash': 1_000_000,
  'qwen3.6-35b': 65_536, // 196608 / --parallel 3
  'qwen3.6-27b': 98_304, // 196608 / --parallel 2
};

/** Fraction of the window past which the meter warns. */
export const CONTEXT_USAGE_WARN_RATIO = 0.8;

export type ContextUsageLevel = 'ok' | 'warn' | 'over';

export interface ContextUsage {
  used: number;
  limit: number;
  ratio: number;
  level: ContextUsageLevel;
}

export function contextWindowForModel(model: string | null | undefined): number | null {
  if (!model) return null;
  return MODEL_CONTEXT_WINDOW[model] ?? null;
}

/**
 * Where a conversation sits against its model's ceiling.
 *
 * `over` is a real state, not a clamp: a conversation past the ceiling fails
 * every turn, and before this the only signal was the failure itself.
 */
export function contextUsage(input: {
  inputTokens: number | null | undefined;
  model: string | null | undefined;
}): ContextUsage | null {
  const limit = contextWindowForModel(input.model);
  if (limit === null) return null;
  if (typeof input.inputTokens !== 'number' || !Number.isFinite(input.inputTokens)) return null;
  const used = input.inputTokens;
  const ratio = used / limit;
  const level: ContextUsageLevel =
    ratio >= 1 ? 'over' : ratio > CONTEXT_USAGE_WARN_RATIO ? 'warn' : 'ok';
  return { used, limit, ratio, level };
}
