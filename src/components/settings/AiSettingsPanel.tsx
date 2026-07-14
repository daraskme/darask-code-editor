import { useEffect, useState, type JSX } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { isTauri } from '../../lib/fs';
import { useProviderStore } from '../../state/providerStore';
import { listAgents, testAgent, type AgentConfig } from '../../lib/acp';
import { ProviderKeyRow } from './ProviderKeyRow';
import './settings.css';

// エージェント認証UI(Codex/Claude Codeの接続テスト対応)向けの入力欄プレースホルダ。
// agent.id に対応が無ければ汎用プレースホルダにフォールバックする。
const AGENT_KEY_PLACEHOLDERS: Record<string, string> = {
  'claude-code': 'sk-ant-...',
  codex: 'sk-...',
};

// 各キーの取得先(2026-07-14 時点)。ProviderKeyRow の「APIキーを取得 ↗」リンクから開く。
const OPENROUTER_HELP_URL = 'https://openrouter.ai/keys';
const CLOUDFLARE_HELP_URL = 'https://dash.cloudflare.com/profile/api-tokens';
const AGENT_HELP_URLS: Record<string, string> = {
  'claude-code': 'https://console.anthropic.com/settings/keys',
  codex: 'https://platform.openai.com/api-keys',
};

interface AgentAuthEntry {
  agent: AgentConfig;
  configured: boolean;
}

// Cloudflare は2値(account_id + token)を保存する必要があるため、このコンポーネント内だけの
// ラッパーとして set_secret を2回呼ぶ(PHASE3A-SPEC.md 3.1)。
// account_id は機密情報ではないが、Rust 側(Agent C 所有)の実装契約(PHASE3A-SPEC.md 2.3)通り
// provider:cloudflare_account_id / provider:cloudflare_token の2キーで set_secret に渡す。
async function saveCloudflareKeys(accountId: string, token: string): Promise<void> {
  if (!isTauri()) return;
  await invoke('set_secret', { id: 'provider:cloudflare_account_id', value: accountId });
  await invoke('set_secret', { id: 'provider:cloudflare_token', value: token });
}

// Agent A の AiPanel.tsx から「設定」タブとして表示される想定の単体コンポーネント。
// PHASE3A-SPEC.md 3.1: AiPanel.tsx 自体はここでは編集しない。
export function AiSettingsPanel(): JSX.Element {
  const providers = useProviderStore((s) => s.providers);
  const refreshStatus = useProviderStore((s) => s.refreshStatus);
  const saveKey = useProviderStore((s) => s.saveKey);
  const testConnection = useProviderStore((s) => s.testConnection);

  // AIエージェント(Claude Code / Codex)認証状態はこのコンポーネント内のローカル state で
  // 完結させる(providerStore.ts のような専用ストアは過剰な抽象化のため新設しない)。
  const [agentAuthEntries, setAgentAuthEntries] = useState<AgentAuthEntry[]>([]);
  const [agentAuthError, setAgentAuthError] = useState<string | null>(null);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  useEffect(() => {
    void loadAgentAuthEntries();
  }, []);

  async function loadAgentAuthEntries(): Promise<void> {
    if (!isTauri()) return;
    try {
      const agents = await listAgents();
      const withSecret = agents.filter((a) => a.secretId !== null);
      const entries = await Promise.all(
        withSecret.map(async (agent) => {
          let configured = false;
          try {
            configured = await invoke<boolean>('has_secret', { id: agent.secretId });
          } catch (err) {
            console.error(`AiSettingsPanel: has_secret failed for "${agent.secretId}":`, err);
          }
          return { agent, configured };
        }),
      );
      setAgentAuthEntries(entries);
      setAgentAuthError(null);
    } catch (err) {
      console.error('AiSettingsPanel: failed to load agents:', err);
      setAgentAuthError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleSaveAgentKey(agent: AgentConfig, values: Record<string, string>): Promise<void> {
    if (!agent.secretId) return;
    try {
      await invoke('set_secret', { id: agent.secretId, value: values.apiKey ?? '' });
    } catch (err) {
      console.error(`AiSettingsPanel: failed to save secret for "${agent.secretId}":`, err);
    }
    await loadAgentAuthEntries();
  }

  async function handleSaveOpenRouter(values: Record<string, string>): Promise<void> {
    await saveKey('openrouter', values.apiKey ?? '');
  }

  async function handleSaveCloudflare(values: Record<string, string>): Promise<void> {
    try {
      await saveCloudflareKeys(values.accountId ?? '', values.token ?? '');
    } catch (err) {
      console.error('AiSettingsPanel: failed to save Cloudflare keys:', err);
    }
    await refreshStatus();
  }

  return (
    <div className="dx-settings-panel">
      <h3 className="dx-settings-panel__title">プロバイダ設定</h3>
      <p className="dx-settings-panel__hint">
        API キーはこの端末の資格情報ストア(keyring)にのみ保存され、設定ファイルには書き込まれません。
      </p>
      <ProviderKeyRow
        label="OpenRouter"
        providerId="openrouter"
        fields={[{ id: 'apiKey', label: 'API キー', placeholder: 'sk-or-v1-...' }]}
        configured={providers.openrouter.configured}
        helpUrl={OPENROUTER_HELP_URL}
        onSave={handleSaveOpenRouter}
        onTestConnection={() => testConnection('openrouter')}
      />
      <ProviderKeyRow
        label="Cloudflare Workers AI"
        providerId="cloudflare"
        fields={[
          { id: 'accountId', label: 'Account ID' },
          { id: 'token', label: 'API Token' },
        ]}
        configured={providers.cloudflare.configured}
        helpUrl={CLOUDFLARE_HELP_URL}
        onSave={handleSaveCloudflare}
        onTestConnection={() => testConnection('cloudflare')}
      />

      <h3 className="dx-settings-panel__title">AIエージェント認証</h3>
      <p className="dx-settings-panel__hint">
        Claude Code / Codex を ACP 経由で起動する際に使う API キーです。未設定の場合は
        シェルの環境変数(ANTHROPIC_API_KEY / OPENAI_API_KEY 等)が使われます。
      </p>
      {agentAuthError && <p className="dx-settings-panel__hint">エージェント一覧の取得に失敗: {agentAuthError}</p>}
      {agentAuthEntries.map(({ agent, configured }) => (
        <ProviderKeyRow
          key={agent.id}
          label={agent.name}
          providerId={agent.id}
          fields={[
            {
              id: 'apiKey',
              label: 'API キー',
              placeholder: AGENT_KEY_PLACEHOLDERS[agent.id] ?? 'sk-...',
            },
          ]}
          configured={configured}
          helpUrl={AGENT_HELP_URLS[agent.id]}
          onSave={(values) => handleSaveAgentKey(agent, values)}
          onTestConnection={() => testAgent(agent.id)}
        />
      ))}
    </div>
  );
}
