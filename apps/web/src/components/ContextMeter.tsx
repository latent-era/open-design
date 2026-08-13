import type { ContextUsage } from '@open-design/contracts';

import { useT } from '../i18n';
import styles from './ContextMeter.module.css';

function compactTokens(value: number): string {
  if (value < 1_000) return String(value);
  const thousands = value / 1_000;
  return `${thousands >= 100 ? Math.round(thousands) : Math.round(thousands * 10) / 10}k`;
}

/**
 * How full the conversation's context is, and a way to act on it.
 *
 * Renders nothing when the model's window is unknown — a meter against a
 * guessed denominator would under-report and let the user hit the ceiling
 * unwarned, which is the failure this exists to prevent.
 */
export function ContextMeter({
  usage,
  onCompact,
  compacting = false,
  stage = 'idle',
}: {
  usage: ContextUsage | null;
  onCompact?: () => void;
  compacting?: boolean;
  /** `ready` once a handoff has been written and the conversation can be
   *  continued in a fresh one. */
  stage?: 'idle' | 'ready';
}) {
  const t = useT();
  if (!usage) return null;

  const percent = Math.min(100, Math.round(usage.ratio * 100));
  const label = t('contextMeter.usage', {
    used: compactTokens(usage.used),
    limit: compactTokens(usage.limit),
  });

  return (
    <div
      className={styles.meter}
      data-level={usage.level}
      data-testid="context-meter"
      role="status"
    >
      <span className={styles.count}>{label}</span>
      <span
        className={styles.track}
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label}
      >
        <span className={styles.fill} style={{ width: `${percent}%` }} />
      </span>
      {usage.level === 'over' ? (
        <span data-testid="context-meter-over">{t('contextMeter.over')}</span>
      ) : null}
      {onCompact && (usage.level !== 'ok' || stage === 'ready') ? (
        <button
          type="button"
          className={styles.action}
          onClick={onCompact}
          disabled={compacting}
          data-testid="context-meter-compact"
        >
          {compacting
            ? t('contextMeter.compacting')
            : stage === 'ready'
              ? t('contextMeter.continue')
              : t('contextMeter.compact')}
        </button>
      ) : null}
    </div>
  );
}
