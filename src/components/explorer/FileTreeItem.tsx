import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type JSX,
  type KeyboardEvent,
  type MouseEvent,
} from 'react';
import { useWorkspaceStore, validateEntryName } from '../../state/workspaceStore';
import { useEditorStore } from '../../state/editorStore';
import type { DirEntry } from '../../types';

const INDENT_PX = 12;
const BASE_PADDING_PX = 6;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function ChevronIcon({ open }: { open: boolean }): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" className="dx-explorer-chevron" aria-hidden="true">
      {open ? (
        <path
          d="M6 9l6 6 6-6"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ) : (
        <path
          d="M9 6l6 6-6 6"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
    </svg>
  );
}

function FolderIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" className="dx-explorer-icon" aria-hidden="true">
      <path
        d="M4 5.5A1.5 1.5 0 0 1 5.5 4h4l2 2.5h8A1.5 1.5 0 0 1 21 8v10.5A1.5 1.5 0 0 1 19.5 20h-14A1.5 1.5 0 0 1 4 18.5z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function FileIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" className="dx-explorer-icon" aria-hidden="true">
      <path
        d="M6 3.5h7l5 5v12a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-16a1 1 0 0 1 1-1z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path d="M13 3.5V8h5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

export interface InlineNameFormProps {
  label: string;
  submitLabel: string;
  initialValue?: string;
  indentPx?: number;
  onSubmit(name: string): Promise<void>;
  onCancel(): void;
}

export function InlineNameForm({
  label,
  submitLabel,
  initialValue = '',
  indentPx,
  onSubmit,
  onCancel,
}: InlineNameFormProps): JSX.Element {
  const [value, setValue] = useState(initialValue);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (submitting) return;
    const validationError = validateEntryName(value);
    if (validationError) {
      setError(validationError);
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      await onSubmit(value.trim());
    } catch (submitError) {
      setError(errorMessage(submitError));
    } finally {
      setSubmitting(false);
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'Enter' && event.nativeEvent.isComposing) {
      event.preventDefault();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      onCancel();
    }
  }

  return (
    <form
      className="dx-explorer-inline-form"
      style={indentPx === undefined ? undefined : { paddingLeft: indentPx }}
      onSubmit={(event) => void handleSubmit(event)}
    >
      <label className="dx-explorer-inline-form__label">
        <span>{label}</span>
        <input
          ref={inputRef}
          className="dx-explorer-inline-form__input"
          value={value}
          disabled={submitting}
          aria-invalid={error !== null}
          onChange={(event) => {
            setValue(event.target.value);
            if (error) setError(null);
          }}
          onKeyDown={handleKeyDown}
        />
      </label>
      {error && (
        <span className="dx-explorer-inline-form__error" role="alert">
          {error}
        </span>
      )}
      <div className="dx-explorer-inline-form__actions">
        <button type="submit" className="dx-explorer-form-button" disabled={submitting}>
          {submitting ? '処理中…' : submitLabel}
        </button>
        <button
          type="button"
          className="dx-explorer-form-button dx-explorer-form-button--secondary"
          disabled={submitting}
          onClick={onCancel}
        >
          キャンセル
        </button>
      </div>
    </form>
  );
}

interface DeleteConfirmProps {
  entry: DirEntry;
  indentPx: number;
  onCancel(): void;
}

function DeleteConfirm({ entry, indentPx, onCancel }: DeleteConfirmProps): JSX.Element {
  const deleteEntry = useWorkspaceStore((state) => state.deleteEntry);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleDelete(): Promise<void> {
    if (deleting) return;
    setDeleting(true);
    setError(null);
    try {
      await deleteEntry(entry.path);
      onCancel();
    } catch (deleteError) {
      setError(errorMessage(deleteError));
      setDeleting(false);
    }
  }

  return (
    <div className="dx-explorer-delete-confirm" style={{ paddingLeft: indentPx }} role="group">
      <span className="dx-explorer-delete-confirm__message">
        「{entry.name}」をゴミ箱へ移動しますか？
      </span>
      {error && (
        <span className="dx-explorer-inline-form__error" role="alert">
          {error}
        </span>
      )}
      <div className="dx-explorer-inline-form__actions">
        <button
          type="button"
          className="dx-explorer-form-button dx-explorer-form-button--danger"
          disabled={deleting}
          onClick={() => void handleDelete()}
        >
          {deleting ? '削除中…' : '削除'}
        </button>
        <button
          type="button"
          className="dx-explorer-form-button dx-explorer-form-button--secondary"
          disabled={deleting}
          onClick={onCancel}
        >
          キャンセル
        </button>
      </div>
    </div>
  );
}

interface FileTreeItemProps {
  entry: DirEntry;
  depth: number;
}

type EntryAction = 'create-file' | 'create-dir' | 'rename' | 'delete' | null;

export function FileTreeItem({ entry, depth }: FileTreeItemProps): JSX.Element {
  const expanded = useWorkspaceStore((state) => state.expandedDirs[entry.path] === true);
  const childEntries = useWorkspaceStore((state) => state.children[entry.path]);
  const loading = useWorkspaceStore((state) => state.loadingDirs[entry.path] === true);
  const loadError = useWorkspaceStore((state) => state.dirErrors[entry.path]);
  const toggleDir = useWorkspaceStore((state) => state.toggleDir);
  const loadDir = useWorkspaceStore((state) => state.loadDir);
  const createFile = useWorkspaceStore((state) => state.createFile);
  const createDir = useWorkspaceStore((state) => state.createDir);
  const renameEntry = useWorkspaceStore((state) => state.renameEntry);
  const openFile = useEditorStore((state) => state.openFile);
  const isActive = useEditorStore((state) => !entry.isDir && state.activePath === entry.path);
  const [action, setAction] = useState<EntryAction>(null);

  const rowPadding = depth * INDENT_PX + BASE_PADDING_PX;
  const formPadding = (depth + 1) * INDENT_PX + BASE_PADDING_PX;

  function handleOpen(): void {
    if (entry.isDir) {
      void toggleDir(entry.path);
    } else {
      void openFile(entry.path);
    }
  }

  function showAction(event: MouseEvent<HTMLButtonElement>, nextAction: EntryAction): void {
    event.stopPropagation();
    setAction(nextAction);
  }

  async function handleCreateFile(name: string): Promise<void> {
    const path = await createFile(entry.path, name);
    setAction(null);
    await openFile(path);
  }

  async function handleCreateDir(name: string): Promise<void> {
    await createDir(entry.path, name);
    setAction(null);
  }

  async function handleRename(name: string): Promise<void> {
    await renameEntry(entry.path, name);
    setAction(null);
  }

  return (
    <div className="dx-explorer-node">
      <div
        className={isActive ? 'dx-explorer-row dx-explorer-row--active' : 'dx-explorer-row'}
        style={{ paddingLeft: rowPadding }}
        role="treeitem"
        aria-expanded={entry.isDir ? expanded : undefined}
        aria-selected={entry.isDir ? undefined : isActive}
      >
        <button type="button" className="dx-explorer-row__open" title={entry.name} onClick={handleOpen}>
          {entry.isDir ? <ChevronIcon open={expanded} /> : <span className="dx-explorer-chevron-spacer" />}
          {entry.isDir ? <FolderIcon /> : <FileIcon />}
          <span className="dx-explorer-name">{entry.name}</span>
        </button>
        <span className="dx-explorer-row__actions" aria-label={`${entry.name} の操作`}>
          {entry.isDir && (
            <>
              <button
                type="button"
                className="dx-explorer-action-button"
                aria-label={`${entry.name} に新規ファイルを作成`}
                title="新規ファイル"
                onClick={(event) => showAction(event, 'create-file')}
              >
                F+
              </button>
              <button
                type="button"
                className="dx-explorer-action-button"
                aria-label={`${entry.name} に新規フォルダを作成`}
                title="新規フォルダ"
                onClick={(event) => showAction(event, 'create-dir')}
              >
                D+
              </button>
            </>
          )}
          <button
            type="button"
            className="dx-explorer-action-button"
            aria-label={`${entry.name} の名前を変更`}
            title="名前を変更"
            onClick={(event) => showAction(event, 'rename')}
          >
            編集
          </button>
          <button
            type="button"
            className="dx-explorer-action-button"
            aria-label={`${entry.name} をゴミ箱へ移動`}
            title="削除"
            onClick={(event) => showAction(event, 'delete')}
          >
            削除
          </button>
        </span>
      </div>

      {action === 'create-file' && (
        <InlineNameForm
          label="新規ファイル名"
          submitLabel="作成"
          indentPx={formPadding}
          onSubmit={handleCreateFile}
          onCancel={() => setAction(null)}
        />
      )}
      {action === 'create-dir' && (
        <InlineNameForm
          label="新規フォルダ名"
          submitLabel="作成"
          indentPx={formPadding}
          onSubmit={handleCreateDir}
          onCancel={() => setAction(null)}
        />
      )}
      {action === 'rename' && (
        <InlineNameForm
          label="新しい名前"
          submitLabel="変更"
          initialValue={entry.name}
          indentPx={formPadding}
          onSubmit={handleRename}
          onCancel={() => setAction(null)}
        />
      )}
      {action === 'delete' && (
        <DeleteConfirm entry={entry} indentPx={formPadding} onCancel={() => setAction(null)} />
      )}

      {entry.isDir && expanded && (
        <div className="dx-explorer-children" role="group">
          {loading && (
            <div className="dx-explorer-state" style={{ paddingLeft: formPadding }} role="status">
              読み込み中…
            </div>
          )}
          {loadError && (
            <div className="dx-explorer-state dx-explorer-state--error" style={{ paddingLeft: formPadding }}>
              <span>読込エラー: {loadError}</span>
              <button type="button" className="dx-explorer-retry-button" onClick={() => void loadDir(entry.path)}>
                再試行
              </button>
            </div>
          )}
          {!loading && !loadError && childEntries?.length === 0 && (
            <div className="dx-explorer-state" style={{ paddingLeft: formPadding }}>
              空のフォルダ
            </div>
          )}
          {childEntries?.map((child) => (
            <FileTreeItem key={child.path} entry={child} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}
