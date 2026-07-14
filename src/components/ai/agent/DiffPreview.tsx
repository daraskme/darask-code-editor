import type { JSX } from 'react';
import { DiffEditor } from '@monaco-editor/react';
import type { editor } from 'monaco-editor';
import { useUiStore } from '../../../state/uiStore';

// Agent F 所有(PHASE3A-SPEC.md 3.2)。ツールコールの content に diff/ファイル内容が含まれる場合のみ
// ToolCallCard から呼ばれる、読み取り専用の before/after 表示コンポーネント。
// Phase3a では「承認 = fs 書き込み側で既に適用済みであることの可視化」に留める。
// TODO(Phase3b): 適用前プレビュー → 承認 → 適用の順序制御(未保存バッファとの統合)。
const DIFF_OPTIONS: editor.IDiffEditorConstructionOptions = {
  readOnly: true,
  renderSideBySide: true,
  minimap: { enabled: false },
  automaticLayout: true,
  fontFamily: 'JetBrains Mono',
  fontSize: 12,
  scrollBeyondLastLine: false,
};

interface DiffPreviewProps {
  beforeText: string;
  afterText: string;
  language?: string;
  path?: string;
}

export function DiffPreview({ beforeText, afterText, language, path }: DiffPreviewProps): JSX.Element {
  const themeId = useUiStore((state) => state.themeId);

  return (
    <div className="dx-agent-diff">
      {path && <div className="dx-agent-diff__path">{path}</div>}
      <div className="dx-agent-diff__editor">
        <DiffEditor
          original={beforeText}
          modified={afterText}
          language={language ?? 'plaintext'}
          theme={themeId}
          options={DIFF_OPTIONS}
          height="240px"
        />
      </div>
    </div>
  );
}
