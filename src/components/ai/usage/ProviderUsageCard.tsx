import type { JSX } from 'react';
import './usage.css';
import {
  computeWindowPercent,
  PROVIDER_LABELS,
  useUsageStore,
  type UsageSnapshot,
  type UsageSource,
  type UsageWindow,
} from '../../../state/usageStore';

// Agent G 所有 (PHASE3A-SPEC.md 3.3 / docs/AI-DESIGN.md 7.4)。

const SOURCE_LABELS: Record<UsageSource, string> = {
  api: 'API',
  'local-logs': 'ローカル推定',
  headers: 'ヘッダー',
  'agent-events': 'エージェントイベント',
};

function formatValue(n: number, unit: UsageWindow['unit']): string {
  if (unit === 'usd') return `$${n.toFixed(2)}`;
  if (unit === 'percent') return `${Math.round(n)}%`;
  return n.toLocaleString('ja-JP');
}

function formatTokens(n: number): string {
  return n.toLocaleString('ja-JP');
}

function formatCost(costUsd: number | null): string {
  if (costUsd === null) return '—';
  return `$${costUsd.toFixed(2)}`;
}

/** ISO8601 の resetsAt を「あとN時間M分」形式に変換する。パース不能なら null。 */
function formatRemaining(resetsAt: string): string | null {
  const target = new Date(resetsAt).getTime();
  if (Number.isNaN(target)) return null;
  const diffMs = target - Date.now();
  if (diffMs <= 0) return 'まもなくリセット';
  const totalMinutes = Math.floor(diffMs / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0) return `あと${hours}時間${minutes}分`;
  return `あと${minutes}分`;
}

function levelClass(percent: number): string {
  if (percent >= 95) return 'dx-usage-bar__fill--error';
  if (percent >= 80) return 'dx-usage-bar__fill--warning';
  return 'dx-usage-bar__fill--accent';
}

function WindowBar({ win }: { win: UsageWindow }): JSX.Element {
  const percent = computeWindowPercent(win);
  const hasLimit = win.limit !== null;
  const remaining = win.resetsAt ? formatRemaining(win.resetsAt) : null;

  let valueText: string;
  if (hasLimit) {
    valueText = `${formatValue(win.used, win.unit)} / ${formatValue(win.limit as number, win.unit)}`;
  } else if (percent !== null) {
    valueText = `${Math.round(percent)}%`;
  } else {
    valueText = formatValue(win.used, win.unit);
  }

  return (
    <div className="dx-usage-window">
      <div className="dx-usage-window__row">
        <span className="dx-usage-window__label">{win.label}</span>
        <span className="dx-usage-window__value">{valueText}</span>
      </div>
      <div className="dx-usage-bar">
        <div
          className={`dx-usage-bar__fill ${percent !== null ? levelClass(percent) : 'dx-usage-bar__fill--accent'}`}
          style={{ width: `${percent !== null ? Math.max(0, Math.min(100, percent)) : 0}%` }}
        />
      </div>
      {remaining && <div className="dx-usage-window__resets">{remaining}</div>}
    </div>
  );
}

export interface ProviderUsageCardProps {
  snapshot: UsageSnapshot;
}

export function ProviderUsageCard({ snapshot }: ProviderUsageCardProps): JSX.Element {
  const refresh = useUsageStore((s) => s.refresh);
  const loading = useUsageStore((s) => s.loading);
  const label = PROVIDER_LABELS[snapshot.providerId] ?? snapshot.providerId;
  const isStale = snapshot.error !== null;

  return (
    <section className={`dx-usage-card${isStale ? ' dx-usage-card--stale' : ''}`}>
      <header className="dx-usage-card__header">
        <div className="dx-usage-card__title">
          <span className="dx-usage-card__provider">{label}</span>
          {snapshot.plan && <span className="dx-usage-card__plan">{snapshot.plan}</span>}
        </div>
        <div className="dx-usage-card__sources">
          {snapshot.source.map((s) => (
            <span key={s} className="dx-usage-badge">
              {SOURCE_LABELS[s] ?? s}
            </span>
          ))}
        </div>
      </header>

      {snapshot.windows.length > 0 && (
        <div className="dx-usage-card__windows">
          {snapshot.windows.map((win) => (
            <WindowBar key={win.id} win={win} />
          ))}
        </div>
      )}

      {snapshot.credits && typeof snapshot.credits.remaining === 'number' && (
        <div className="dx-usage-card__credits">
          クレジット: 残 {`$${snapshot.credits.remaining.toFixed(2)}`}
          {typeof snapshot.credits.total === 'number' && ` / 総 $${snapshot.credits.total.toFixed(2)}`}
        </div>
      )}

      <div className="dx-usage-card__totals">
        <div className="dx-usage-card__total">
          <span className="dx-usage-card__total-label">今日</span>
          <span className="dx-usage-card__total-value">
            {formatTokens(snapshot.today.inputTokens + snapshot.today.outputTokens)} tok
          </span>
          <span className="dx-usage-card__total-value">{formatCost(snapshot.today.costUsd)}</span>
        </div>
        <div className="dx-usage-card__total">
          <span className="dx-usage-card__total-label">今月</span>
          <span className="dx-usage-card__total-value">
            {formatTokens(snapshot.thisMonth.inputTokens + snapshot.thisMonth.outputTokens)} tok
          </span>
          <span className="dx-usage-card__total-value">{formatCost(snapshot.thisMonth.costUsd)}</span>
        </div>
      </div>

      <footer className="dx-usage-card__footer">
        <span className="dx-usage-card__fetched-at">
          最終更新: {new Date(snapshot.fetchedAt).toLocaleTimeString('ja-JP')}
        </span>
        <button type="button" className="dx-usage-card__refresh" onClick={() => void refresh()} disabled={loading}>
          再取得
        </button>
      </footer>

      {isStale && (
        <div className="dx-usage-card__error-detail">
          <span className="dx-usage-card__error-title">取得エラー(古いデータ)</span>
          <span className="dx-usage-card__error-message">{snapshot.error}</span>
        </div>
      )}
    </section>
  );
}
