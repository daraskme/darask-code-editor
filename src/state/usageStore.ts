import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { isTauri } from '../lib/fs';

// Agent G 所有 (PHASE3A-SPEC.md 3.3)。
// 使用量ダッシュボードの統一データモデル(docs/AI-DESIGN.md 7.1)。
// src/types/index.ts にはまだ Usage 系の型が存在しないため、このタスクの範囲内でローカル定義する。
// TODO(integrate): 他タブでも共通化したくなったら src/types/index.ts への移動を検討する。

export type UsageUnit = 'tokens' | 'credits' | 'neurons' | 'requests' | 'percent' | 'usd';

export interface UsageWindow {
  id: string; // '5h' | 'week' | 'month' | 'free-daily' など
  label: string; // 表示名(例: '5時間枠', '週間', '無料枠(今日)')
  used: number;
  limit: number | null; // 不明なら null → バー非表示で実数のみ
  unit: UsageUnit;
  usedPercent: number | null; // プロバイダが%のみ返す場合(Codex 等)はこちらを使う
  resetsAt: string | null; // ISO 8601
}

export type UsageProviderId = 'claude-code' | 'anthropic' | 'codex' | 'openai' | 'openrouter' | 'cloudflare';

export type UsageSource = 'api' | 'local-logs' | 'headers' | 'agent-events';

export interface UsageSnapshot {
  providerId: UsageProviderId;
  plan: string | null;
  windows: UsageWindow[];
  credits: { remaining: number; total: number | null; currency: 'USD' } | null;
  today: { inputTokens: number; outputTokens: number; costUsd: number | null };
  thisMonth: { inputTokens: number; outputTokens: number; costUsd: number | null };
  fetchedAt: string;
  source: UsageSource[];
  error: string | null;
}

// UI 表示用の日本語ラベル(UsageGauge / ProviderUsageCard 共通)。
export const PROVIDER_LABELS: Record<UsageProviderId, string> = {
  'claude-code': 'Claude Code',
  anthropic: 'Anthropic',
  codex: 'Codex',
  openai: 'OpenAI',
  openrouter: 'OpenRouter',
  cloudflare: 'Cloudflare',
};

/** used/limit または usedPercent から 0-100 の割合を算出する。両方欠けていれば null。 */
export function computeWindowPercent(win: UsageWindow): number | null {
  if (win.usedPercent !== null) return win.usedPercent;
  if (win.limit !== null && win.limit > 0) return (win.used / win.limit) * 100;
  return null;
}

interface UsageState {
  snapshots: UsageSnapshot[];
  loading: boolean;
  lastFetchedAt: string | null;
  refresh(): Promise<void>;
}

const CACHE_KEY = 'darask.usage.cache';

interface CachedUsage {
  snapshots: UsageSnapshot[];
  lastFetchedAt: string;
}

// アプリ再起動後もタブを開いた瞬間に前回値を表示できるよう、直近の取得結果を
// localStorage にキャッシュする(「すぐ表示され、あとから refresh() で更新される」という
// stale-while-revalidate の体験にするため。値そのものは機密ではない使用量統計のみ)。
function loadCachedUsage(): CachedUsage | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === 'object' &&
      Array.isArray((parsed as CachedUsage).snapshots) &&
      typeof (parsed as CachedUsage).lastFetchedAt === 'string'
    ) {
      return parsed as CachedUsage;
    }
    return null;
  } catch {
    return null;
  }
}

function saveCachedUsage(cache: CachedUsage): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
  } catch {
    // 容量超過等は無視してよい(キャッシュは無くても動作に支障はない)。
  }
}

const cached = loadCachedUsage();

export const useUsageStore = create<UsageState>()((set) => ({
  snapshots: cached?.snapshots ?? [],
  loading: false,
  lastFetchedAt: cached?.lastFetchedAt ?? null,

  async refresh() {
    // snapshots は意図的にクリアしない: 直前の(または前回起動時にキャッシュされた)値を
    // 表示したまま裏で取得し、成功したら差し替える(タブを開くたびに空表示へ戻さない)。
    set({ loading: true });
    if (!isTauri()) {
      // ブラウザプレビュー(npm run dev)では Tauri コマンドを呼べない。
      console.error('usageStore.refresh: Tauri ランタイム外のため usage_summary を呼べません');
      set({ loading: false });
      return;
    }
    try {
      const snapshots = await invoke<UsageSnapshot[]>('usage_summary');
      const lastFetchedAt = new Date().toISOString();
      set({ snapshots, loading: false, lastFetchedAt });
      saveCachedUsage({ snapshots, lastFetchedAt });
    } catch (err) {
      console.error('usage_summary の取得に失敗しました:', err);
      set({ loading: false });
    }
  },
}));
