import { useEffect } from 'react';
import type { JSX } from 'react';
import './usage.css';
import { useUsageStore } from '../../../state/usageStore';
import { ProviderUsageCard } from './ProviderUsageCard';

// Agent G 所有 (PHASE3A-SPEC.md 3.3)。
// コマンド 'ai.usageDashboard'(Ctrl+Shift+U)からこのタブが開かれる想定(配線は Agent A)。

const REFRESH_INTERVAL_MS = 60_000;

export function UsageDashboard(): JSX.Element {
  const snapshots = useUsageStore((s) => s.snapshots);
  const loading = useUsageStore((s) => s.loading);
  const lastFetchedAt = useUsageStore((s) => s.lastFetchedAt);
  const refresh = useUsageStore((s) => s.refresh);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  return (
    <div className="dx-usage-dashboard">
      <div className="dx-usage-dashboard__toolbar">
        <button
          type="button"
          className="dx-usage-dashboard__refresh"
          onClick={() => void refresh()}
          disabled={loading}
        >
          {loading ? '更新中…' : '手動更新'}
        </button>
        {lastFetchedAt && (
          <span className="dx-usage-dashboard__last-fetched">
            最終更新: {new Date(lastFetchedAt).toLocaleTimeString('ja-JP')}
          </span>
        )}
      </div>

      {snapshots.length === 0 ? (
        <div className="dx-usage-dashboard__empty">
          {loading ? 'データを取得中…' : 'データがありません(プロバイダの API キーを設定タブで登録してください)'}
        </div>
      ) : (
        <div className="dx-usage-dashboard__cards">
          {snapshots.map((snapshot) => (
            <ProviderUsageCard key={snapshot.providerId} snapshot={snapshot} />
          ))}
        </div>
      )}
    </div>
  );
}
