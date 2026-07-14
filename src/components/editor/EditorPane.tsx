import type { JSX } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import type { editor } from 'monaco-editor';
import { documentManager } from '../../lib/documentManager';
import { useEditorStore } from '../../state/editorStore';
import { useUiStore } from '../../state/uiStore';
import './editor.css';

const EDITOR_OPTIONS: editor.IStandaloneEditorConstructionOptions = {
  fontFamily: 'JetBrains Mono',
  fontSize: 14,
  fontLigatures: true,
  minimap: { enabled: true },
  automaticLayout: true,
  smoothScrolling: true,
  cursorBlinking: 'smooth',
  padding: { top: 8 },
};

/** Monaco model は documentManager が作成・所有し、Editor には URI だけを渡す。 */
export function EditorPane(): JSX.Element | null {
  const activeTab = useEditorStore((state) => state.tabs.find((tab) => tab.path === state.activePath));
  const themeId = useUiStore((state) => state.themeId);

  if (!activeTab) return null;

  // Tab が描画される前に manager が model を作る契約。破棄済みなら空モデルを作らず次の描画を待つ。
  const model = documentManager.getModel(activeTab.path);
  if (!model || model.uri.toString() !== activeTab.modelUri) {
    return <div className="dx-editor-pane dx-editor-pane--loading">エディタを準備しています…</div>;
  }

  const handleMount: OnMount = (editorInstance) => {
    editorInstance.onDidChangeCursorPosition((event) => {
      useUiStore.getState().setCursorPos(event.position.lineNumber, event.position.column);
    });
  };

  return (
    <div className="dx-editor-pane">
      <Editor
        path={activeTab.modelUri}
        language={activeTab.language}
        theme={themeId}
        keepCurrentModel
        options={EDITOR_OPTIONS}
        onMount={handleMount}
      />
    </div>
  );
}
