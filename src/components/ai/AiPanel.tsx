import type { JSX } from 'react';
import { useAiStore, type AiPanelTab } from '../../state/aiStore';
import { AgentSessionView } from './agent/AgentSessionView';
import { AiSettingsPanel } from '../settings/AiSettingsPanel';
import { UsageDashboard } from './usage/UsageDashboard';

const TABS: { id: AiPanelTab; label: string }[] = [
  { id: 'agent', label: 'エージェント' },
  { id: 'settings', label: '設定' },
  { id: 'usage', label: '使用量' },
];

// 右サイドパネルの外枠(PHASE3A-SPEC.md 2.1)。panelOpen の間だけ表示。
// 各タブの中身は他エージェントが実装する。統合時に以下の TODO を実コンポーネントの import に置き換える。
export function AiPanel(): JSX.Element | null {
  const panelOpen = useAiStore((s) => s.panelOpen);
  const activeTab = useAiStore((s) => s.activeTab);
  const setActiveTab = useAiStore((s) => s.setActiveTab);
  const closePanel = useAiStore((s) => s.closePanel);

  if (!panelOpen) return null;

  return (
    <aside className="ai-panel" aria-label="AI パネル">
      <div className="ai-panel__tabs">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={tab.id === activeTab ? 'ai-panel__tab ai-panel__tab--active' : 'ai-panel__tab'}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
        <button type="button" className="ai-panel__close" onClick={closePanel} aria-label="AI パネルを閉じる" title="閉じる">
          ×
        </button>
      </div>
      <div className="ai-panel__content">
        {activeTab === 'agent' && <AgentSessionView />}
        {activeTab === 'settings' && <AiSettingsPanel />}
        {activeTab === 'usage' && <UsageDashboard />}
      </div>
    </aside>
  );
}
