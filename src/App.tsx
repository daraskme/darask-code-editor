import { lazy, Suspense, useEffect, useRef, useState, type JSX } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { ActivityBar } from './components/layout/ActivityBar';
import { SideBar } from './components/layout/SideBar';
import { MainArea } from './components/layout/MainArea';
import { StatusBar } from './components/layout/StatusBar';
import { CommandPalette } from './components/palette/CommandPalette';
import { QuickOpen } from './components/palette/QuickOpen';
import { useUiStore } from './state/uiStore';
import { useWorkspaceStore } from './state/workspaceStore';
import { useEditorStore } from './state/editorStore';
import { useAiStore } from './state/aiStore';
import { applyTheme } from './themes';
import { executeCommand, registerCommand } from './lib/commands';
import { initKeybindings } from './lib/keybindings';
import { ErrorBoundary } from './components/ErrorBoundary';
import { UnsavedChangesDialog } from './components/dialogs/UnsavedChangesDialog';
import { ToastHost } from './components/notifications/ToastHost';
import { isTauri } from './lib/fs';
import { requestCloseAllTabs, requestCloseTab } from './lib/editorLifecycle';
import { notifyError } from './state/notificationStore';

const AiPanel = lazy(async () => {
  const module = await import('./components/ai/AiPanel');
  return { default: module.AiPanel };
});

// 組み込みコマンド(PHASE1-SPEC 4.5)。App マウント時に一度だけ登録する。
function registerBuiltinCommands(): void {
  registerCommand({
    id: 'workbench.openFolder',
    title: 'フォルダを開く',
    run: async () => {
      await useWorkspaceStore.getState().openFolder();
    },
  });
  registerCommand({
    id: 'file.save',
    title: '保存',
    keybinding: 'Ctrl+S',
    run: () => useEditorStore.getState().saveActive(),
  });
  registerCommand({
    id: 'file.closeTab',
    title: 'タブを閉じる',
    keybinding: 'Ctrl+W',
    run: async () => {
      const { activePath } = useEditorStore.getState();
      if (activePath) await requestCloseTab(activePath);
    },
  });
  registerCommand({
    id: 'view.toggleSidebar',
    title: 'サイドバー切替',
    keybinding: 'Ctrl+B',
    run: () => useUiStore.getState().toggleSidebar(),
  });
  registerCommand({
    id: 'workbench.quickOpen',
    title: 'Quick Open',
    keybinding: 'Ctrl+P',
    run: () => useUiStore.getState().setPaletteMode('files'),
  });
  registerCommand({
    id: 'workbench.commandPalette',
    title: 'コマンドパレット',
    keybinding: 'Ctrl+Shift+P',
    run: () => useUiStore.getState().setPaletteMode('commands'),
  });
  registerCommand({
    id: 'theme.light',
    title: 'テーマ: ライト',
    run: () => useUiStore.getState().setTheme('darask-light'),
  });
  registerCommand({
    id: 'theme.dark',
    title: 'テーマ: ダーク',
    run: () => useUiStore.getState().setTheme('darask-dark'),
  });
  registerCommand({
    id: 'theme.paper',
    title: 'テーマ: 用紙',
    run: () => useUiStore.getState().setTheme('darask-paper'),
  });
  registerCommand({
    id: 'ai.usageDashboard',
    title: '使用量ダッシュボードを開く',
    keybinding: 'Ctrl+Shift+U',
    run: () => useAiStore.getState().openPanel('usage'),
  });
}

export default function App(): JSX.Element {
  const paletteMode = useUiStore((s) => s.paletteMode);
  const aiPanelOpen = useAiStore((s) => s.panelOpen);
  const [activeActivity, setActiveActivity] = useState('files');
  const allowNativeClose = useRef(false);

  useEffect(() => {
    applyTheme(useUiStore.getState().themeId);
    registerBuiltinCommands();
    const disposeKeybindings = initKeybindings();
    return disposeKeybindings;
  }, []);

  useEffect(() => {
    if (!isTauri()) return undefined;

    const appWindow = getCurrentWindow();
    let disposed = false;
    let unlisten: (() => void) | undefined;

    void appWindow
      .onCloseRequested(async (event) => {
        if (allowNativeClose.current) return;

        event.preventDefault();
        if (!(await requestCloseAllTabs())) return;

        allowNativeClose.current = true;
        try {
          await appWindow.close();
        } catch (error) {
          allowNativeClose.current = false;
          const message = error instanceof Error ? error.message : String(error);
          notifyError(`ウィンドウを閉じられませんでした: ${message}`);
        }
      })
      .then((dispose) => {
        if (disposed) {
          dispose();
        } else {
          unlisten = dispose;
        }
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error('failed to register close handler:', error);
        notifyError(`終了確認を初期化できませんでした: ${message}`);
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  function handleActivitySelect(id: string): void {
    if (id === 'files') {
      setActiveActivity(id);
      void executeCommand('view.toggleSidebar');
    }
  }

  return (
    <div className="app-shell">
      <div className="app-shell__body">
        <ActivityBar activeId={activeActivity} onSelect={handleActivitySelect} />
        <SideBar />
        <MainArea />
        {aiPanelOpen && (
          <ErrorBoundary label="AIパネルでエラーが発生しました">
            <Suspense fallback={<aside className="ai-panel ai-panel__placeholder">AI パネルを読み込み中...</aside>}>
              <AiPanel />
            </Suspense>
          </ErrorBoundary>
        )}
      </div>
      <StatusBar />
      {paletteMode === 'commands' && <CommandPalette />}
      {paletteMode === 'files' && <QuickOpen />}
      <UnsavedChangesDialog />
      <ToastHost />
    </div>
  );
}
