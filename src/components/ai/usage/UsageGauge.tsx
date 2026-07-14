import type { JSX } from 'react';
import './usage.css';
import {
  computeWindowPercent,
  PROVIDER_LABELS,
  type UsageProviderId,
  type UsageSnapshot,
  type UsageWindow,
} from '../../../state/usageStore';

// Agent G 所有 (PHASE3A-SPEC.md 3.3)。
// StatusBar.tsx への組み込み配線は Agent A が行う。このファイルは単体の表示コンポーネントのみを提供する。

const BAR_SEGMENTS = 5;

interface MostUrgent {
  providerId: UsageProviderId;
  window: UsageWindow;
  percent: number;
}

function findMostUrgent(snapshots: UsageSnapshot[]): MostUrgent | null {
  let best: MostUrgent | null = null;
  for (const snapshot of snapshots) {
    for (const win of snapshot.windows) {
      const percent = computeWindowPercent(win);
      if (percent === null) continue;
      if (best === null || percent > best.percent) {
        best = { providerId: snapshot.providerId, window: win, percent };
      }
    }
  }
  return best;
}

function renderBar(percent: number): string {
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clamped / 100) * BAR_SEGMENTS);
  return '▓'.repeat(filled) + '░'.repeat(BAR_SEGMENTS - filled);
}

function levelClass(percent: number): string {
  if (percent >= 95) return 'dx-usage-gauge--error';
  if (percent >= 80) return 'dx-usage-gauge--warning';
  return 'dx-usage-gauge--normal';
}

export interface UsageGaugeProps {
  snapshots: UsageSnapshot[];
  onClick?: () => void;
}

/** 最も逼迫しているウィンドウ1件をコンパクトな1行で表示する(例: "Claude 5h ▓▓▓░ 62%")。 */
export function UsageGauge({ snapshots, onClick }: UsageGaugeProps): JSX.Element | null {
  const urgent = findMostUrgent(snapshots);
  if (!urgent) return null;

  const percent = Math.round(Math.max(0, Math.min(100, urgent.percent)));
  const label = PROVIDER_LABELS[urgent.providerId] ?? urgent.providerId;

  return (
    <button
      type="button"
      className={`dx-usage-gauge ${levelClass(urgent.percent)}`}
      onClick={onClick}
      title={`${label} ${urgent.window.label}: ${percent}%`}
    >
      <span className="dx-usage-gauge__label">
        {label} {urgent.window.label}
      </span>
      <span className="dx-usage-gauge__bar">{renderBar(urgent.percent)}</span>
      <span className="dx-usage-gauge__percent">{percent}%</span>
    </button>
  );
}
