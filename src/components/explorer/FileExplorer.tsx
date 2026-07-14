import { useEffect, useState, type JSX } from 'react';
import { useWorkspaceStore } from '../../state/workspaceStore';
import { useEditorStore } from '../../state/editorStore';
import { executeCommand } from '../../lib/commands';
import { isTauri } from '../../lib/fs';
import { FileTreeItem, InlineNameForm } from './FileTreeItem';
import './explorer.css';

type RootAction = 'create-file' | 'create-dir' | null;

export function FileExplorer(): JSX.Element {
  const rootPath = useWorkspaceStore((state) => state.rootPath);
  const rootName = useWorkspaceStore((state) => state.rootName);
  const rootChildren = useWorkspaceStore((state) =>
    state.rootPath ? state.children[state.rootPath] : undefined,
  );
  const rootLoading = useWorkspaceStore((state) =>
    state.rootPath ? state.loadingDirs[state.rootPath] === true : false,
  );
  const rootLoadError = useWorkspaceStore((state) =>
    state.rootPath ? state.dirErrors[state.rootPath] : undefined,
  );
  const workspaceError = useWorkspaceStore((state) => state.workspaceError);
  const openingFolder = useWorkspaceStore((state) => state.openingFolder);
  const loadDir = useWorkspaceStore((state) => state.loadDir);
  const createFile = useWorkspaceStore((state) => state.createFile);
  const createDir = useWorkspaceStore((state) => state.createDir);
  const openFile = useEditorStore((state) => state.openFile);
  const [rootAction, setRootAction] = useState<RootAction>(null);

  useEffect(() => {
    setRootAction(null);
  }, [rootPath]);

  async function handleCreateFile(name: string): Promise<void> {
    if (!rootPath) return;
    const path = await createFile(rootPath, name);
    setRootAction(null);
    await openFile(path);
  }

  async function handleCreateDir(name: string): Promise<void> {
    if (!rootPath) return;
    await createDir(rootPath, name);
    setRootAction(null);
  }

  if (rootPath === null) {
    return (
      <div className="dx-explorer dx-explorer--empty">
        <button
          type="button"
          className="dx-explorer-open-btn"
          disabled={!isTauri() || openingFolder}
          onClick={() => executeCommand('workbench.openFolder')}
        >
          {openingFolder ? '選択中…' : 'フォルダを開く'}
        </button>
        {!isTauri() && <p className="dx-explorer-empty-hint">Tauri アプリで利用できます。</p>}
        {workspaceError && (
          <p className="dx-explorer-workspace-error" role="alert">
            {workspaceError}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="dx-explorer">
      <div className="dx-explorer-root-header">
        <span className="dx-explorer-root-label" title={rootPath}>
          {rootName}
        </span>
        <span className="dx-explorer-root-actions" role="group" aria-label="ワークスペースの操作">
          <button
            type="button"
            className="dx-explorer-action-button"
            aria-label="ルートに新規ファイルを作成"
            title="新規ファイル"
            onClick={() => setRootAction('create-file')}
          >
            F+
          </button>
          <button
            type="button"
            className="dx-explorer-action-button"
            aria-label="ルートに新規フォルダを作成"
            title="新規フォルダ"
            onClick={() => setRootAction('create-dir')}
          >
            D+
          </button>
          <button
            type="button"
            className="dx-explorer-action-button"
            aria-label="エクスプローラを更新"
            title="更新"
            disabled={rootLoading}
            onClick={() => void loadDir(rootPath)}
          >
            更新
          </button>
        </span>
      </div>

      {workspaceError && (
        <div className="dx-explorer-workspace-error" role="alert">
          {workspaceError}
        </div>
      )}
      {rootAction === 'create-file' && (
        <InlineNameForm
          label="新規ファイル名"
          submitLabel="作成"
          indentPx={8}
          onSubmit={handleCreateFile}
          onCancel={() => setRootAction(null)}
        />
      )}
      {rootAction === 'create-dir' && (
        <InlineNameForm
          label="新規フォルダ名"
          submitLabel="作成"
          indentPx={8}
          onSubmit={handleCreateDir}
          onCancel={() => setRootAction(null)}
        />
      )}

      <div className="dx-explorer-tree" role="tree" aria-label={rootName ?? 'Explorer'}>
        {rootLoading && (
          <div className="dx-explorer-state" role="status">
            読み込み中…
          </div>
        )}
        {rootLoadError && (
          <div className="dx-explorer-state dx-explorer-state--error">
            <span>読込エラー: {rootLoadError}</span>
            <button type="button" className="dx-explorer-retry-button" onClick={() => void loadDir(rootPath)}>
              再試行
            </button>
          </div>
        )}
        {!rootLoading && !rootLoadError && rootChildren?.length === 0 && (
          <div className="dx-explorer-state">空のフォルダ</div>
        )}
        {rootChildren?.map((entry) => (
          <FileTreeItem key={entry.path} entry={entry} depth={0} />
        ))}
      </div>
    </div>
  );
}
