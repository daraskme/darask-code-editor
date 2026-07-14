import { useState, type JSX } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { isTauri } from '../../lib/fs';

// 単一プロバイダの設定行(PHASE3A-SPEC.md 3.1)。
// fields が1件なら単一キー入力(OpenRouter)、2件以上ならまとめて保存するフォーム(Cloudflare)になる。
export interface ProviderField {
  /** onSave/onTestConnection に渡す values オブジェクトのキー */
  id: string;
  label: string;
  placeholder?: string;
}

interface ProviderKeyRowProps {
  label: string;
  providerId: string;
  fields: ProviderField[];
  configured: boolean;
  /** キー取得ページの URL。指定すると見出し横に「取得 ↗」リンクを表示し、既定ブラウザで開く。 */
  helpUrl?: string;
  onSave(values: Record<string, string>): Promise<void>;
  onTestConnection(): Promise<boolean>;
}

function handleOpenHelpUrl(url: string): void {
  if (!isTauri()) {
    // ブラウザプレビュー(npm run dev)では Tauri コマンドが使えないため window.open で代替。
    window.open(url, '_blank', 'noopener,noreferrer');
    return;
  }
  // lib.rs の open_external_url コマンド経由(失敗理由が eprintln でターミナルに出る)。
  invoke('open_external_url', { url }).catch((err) =>
    console.error(`open_external_url failed for "${url}":`, err),
  );
}

type TestState = 'idle' | 'testing' | 'success' | 'failure';

export function ProviderKeyRow(props: ProviderKeyRowProps): JSX.Element {
  const { label, providerId, fields, configured, helpUrl, onSave, onTestConnection } = props;
  const [values, setValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [testState, setTestState] = useState<TestState>('idle');

  const canSave = fields.every((f) => (values[f.id] ?? '').trim().length > 0);

  async function handleSave(): Promise<void> {
    if (!canSave || saving) return;
    setSaving(true);
    try {
      await onSave(values);
      setValues({});
      setTestState('idle');
    } finally {
      setSaving(false);
    }
  }

  async function handleTest(): Promise<void> {
    if (testState === 'testing') return;
    setTestState('testing');
    const ok = await onTestConnection();
    setTestState(ok ? 'success' : 'failure');
  }

  function statusLabel(): string {
    if (testState === 'testing') return 'テスト中…';
    if (testState === 'success') return 'テスト成功';
    if (testState === 'failure') return 'テスト失敗';
    return configured ? '設定済み' : '未設定';
  }

  function statusModifier(): string {
    if (testState === 'testing') return 'dx-settings-status--muted';
    if (testState === 'success') return 'dx-settings-status--success';
    if (testState === 'failure') return 'dx-settings-status--error';
    return configured ? 'dx-settings-status--success' : 'dx-settings-status--muted';
  }

  return (
    <div className="dx-settings-row">
      <div className="dx-settings-row__header">
        <span className="dx-settings-row__label">
          {label}
          {helpUrl && (
            <button
              type="button"
              className="dx-settings-row__help-link"
              onClick={() => handleOpenHelpUrl(helpUrl)}
              title={helpUrl}
            >
              APIキーを取得 ↗
            </button>
          )}
        </span>
        <span className={`dx-settings-status ${statusModifier()}`}>{statusLabel()}</span>
      </div>
      <div className="dx-settings-row__fields">
        {fields.map((field) => {
          const inputId = `dx-settings-${providerId}-${field.id}`;
          return (
            <div key={field.id} className="dx-settings-row__field">
              <label className="dx-settings-row__field-label" htmlFor={inputId}>
                {field.label}
              </label>
              <input
                id={inputId}
                type="password"
                className="dx-settings-row__input"
                placeholder={field.placeholder ?? field.label}
                value={values[field.id] ?? ''}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => {
                  const v = e.target.value;
                  setValues((prev) => ({ ...prev, [field.id]: v }));
                }}
              />
            </div>
          );
        })}
      </div>
      <div className="dx-settings-row__actions">
        <button
          type="button"
          className="dx-settings-row__btn"
          onClick={() => void handleSave()}
          disabled={!canSave || saving}
        >
          {saving ? '保存中…' : '保存'}
        </button>
        <button
          type="button"
          className="dx-settings-row__btn dx-settings-row__btn--secondary"
          onClick={() => void handleTest()}
          disabled={testState === 'testing'}
        >
          接続テスト
        </button>
      </div>
    </div>
  );
}
