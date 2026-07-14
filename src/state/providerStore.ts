import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { isTauri } from '../lib/fs';

// Provider (OpenRouter / Cloudflare) の設定状態(PHASE3A-SPEC.md 3.1)。
// Rust 側の secrets 系コマンド(has_secret/set_secret)・ai_test_connection と繋ぐ薄いストア。
export type ProviderId = 'openrouter' | 'cloudflare';

interface ProviderStatus {
  configured: boolean;
}

interface ProviderState {
  providers: Record<ProviderId, ProviderStatus>;
  refreshStatus(): Promise<void>;
  saveKey(id: ProviderId, value: string): Promise<void>;
  testConnection(id: ProviderId): Promise<boolean>;
}

// has_secret は「未接続(invoke_handler 未登録)」でも例外を投げるだけなので、
// ここで握りつぶして false 扱いにする(該当プロバイダは「未設定」表示になる)。
async function hasSecretSafe(id: string): Promise<boolean> {
  if (!isTauri()) return false;
  try {
    return await invoke<boolean>('has_secret', { id });
  } catch (err) {
    console.error(`providerStore: has_secret failed for "${id}":`, err);
    return false;
  }
}

export const useProviderStore = create<ProviderState>()((set, get) => ({
  providers: {
    openrouter: { configured: false },
    cloudflare: { configured: false },
  },

  async refreshStatus() {
    // Cloudflare は account_id + token の2値が必要だが、接続に必須なのは token 側なので
    // configured 判定は provider:cloudflare_token の有無で行う
    // (TODO: account_id の保存方式が Rust 側で keyring 以外(平文設定ファイル等)になった場合、
    // 別コマンドでの存在確認に切り替える必要がある。PHASE3A-SPEC 2.3 参照)。
    const [openrouterConfigured, cloudflareConfigured] = await Promise.all([
      hasSecretSafe('provider:openrouter'),
      hasSecretSafe('provider:cloudflare_token'),
    ]);
    set({
      providers: {
        openrouter: { configured: openrouterConfigured },
        cloudflare: { configured: cloudflareConfigured },
      },
    });
  },

  async saveKey(id, value) {
    if (isTauri()) {
      try {
        await invoke('set_secret', { id: `provider:${id}`, value });
      } catch (err) {
        console.error(`providerStore: saveKey failed for "${id}":`, err);
      }
    }
    await get().refreshStatus();
  },

  async testConnection(id) {
    if (!isTauri()) return false;
    try {
      return await invoke<boolean>('ai_test_connection', { provider: id });
    } catch (err) {
      console.error(`providerStore: testConnection failed for "${id}":`, err);
      return false;
    }
  },
}));
