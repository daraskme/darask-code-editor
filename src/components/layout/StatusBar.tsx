import type { JSX } from 'react';
import type { ThemeId } from '../../types';
import { useUiStore } from '../../state/uiStore';
import { useWorkspaceStore } from '../../state/workspaceStore';
import { useEditorStore } from '../../state/editorStore';
import { useAiStore } from '../../state/aiStore';
import { useUsageStore } from '../../state/usageStore';
import { UsageGauge } from '../ai/usage/UsageGauge';
import { themes } from '../../themes';

const THEME_CYCLE: ThemeId[] = ['darask-light', 'darask-dark', 'darask-paper'];

function themeLabel(id: ThemeId): string {
  return themes.find((t) => t.id === id)?.label ?? id;
}

export function StatusBar(): JSX.Element {
  const rootName = useWorkspaceStore((s) => s.rootName);
  const themeId = useUiStore((s) => s.themeId);
  const setTheme = useUiStore((s) => s.setTheme);
  const cursorLine = useUiStore((s) => s.cursorLine);
  const cursorCol = useUiStore((s) => s.cursorCol);
  const activeTab = useEditorStore((s) => s.tabs.find((t) => t.path === s.activePath));
  const usageSnapshots = useUsageStore((s) => s.snapshots);
  const openAiPanel = useAiStore((s) => s.openPanel);

  function cycleTheme(): void {
    const index = THEME_CYCLE.indexOf(themeId);
    const next = THEME_CYCLE[(index + 1) % THEME_CYCLE.length];
    setTheme(next);
  }

  return (
    <footer className="status-bar">
      <div className="status-bar__left">
        <span className="status-bar__item">{rootName ?? 'フォルダ未選択'}</span>
      </div>
      <div className="status-bar__right">
        {activeTab && (
          <>
            <span className="status-bar__item">
              行 {cursorLine}, 列 {cursorCol}
            </span>
            <span className="status-bar__item">{activeTab.language}</span>
          </>
        )}
        <span
          className="status-bar__item status-bar__item--clickable"
          onClick={cycleTheme}
          title="テーマを切り替え"
        >
          {themeLabel(themeId)}
        </span>
        <UsageGauge snapshots={usageSnapshots} onClick={() => openAiPanel('usage')} />
      </div>
    </footer>
  );
}
