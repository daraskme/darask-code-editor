// Quick Open (PHASE1-SPEC 6.4). App 側で paletteMode === 'files' の間だけマウントされる。
import { useEffect, useMemo, useRef, useState, type JSX, type KeyboardEvent, type MouseEvent } from 'react';
import { readDir } from '../../lib/fs';
import { useEditorStore } from '../../state/editorStore';
import { useUiStore } from '../../state/uiStore';
import { useWorkspaceStore } from '../../state/workspaceStore';
import type { DirEntry } from '../../types';
import './palette.css';

const MAX_RESULTS = 100;
const MAX_INDEXED_FILES = 10_000;
const MAX_INDEXED_DIRECTORIES = 2_000;
const MAX_SCANNED_ENTRIES = 20_000;
const PUBLISH_EVERY_DIRECTORIES = 20;
const PUBLISH_EVERY_FILES = 50;
const SKIPPED_DIRECTORY_NAMES = new Set(['.git', 'node_modules', 'target']);

type IndexState = 'idle' | 'indexing' | 'ready' | 'truncated' | 'error';

interface FlatFile {
  name: string;
  path: string;
  relPath: string;
}

interface IndexProgress {
  files: number;
  directories: number;
}

function stripTrailingSlash(path: string): string {
  return path.replace(/[\\/]+$/, '');
}

function pathKey(path: string): string {
  return stripTrailingSlash(path).replace(/\\/g, '/').toLocaleLowerCase();
}

function relativePath(path: string, rootPath: string): string {
  const normalizedPath = path.replace(/\\/g, '/');
  const normalizedRoot = stripTrailingSlash(rootPath).replace(/\\/g, '/');
  const rootKey = normalizedRoot.toLocaleLowerCase();
  const pathKeyValue = normalizedPath.toLocaleLowerCase();

  if (pathKeyValue.startsWith(`${rootKey}/`)) {
    return normalizedPath.slice(normalizedRoot.length + 1);
  }

  return normalizedPath;
}

function shouldSkipDirectory(entry: DirEntry): boolean {
  return entry.isDir && SKIPPED_DIRECTORY_NAMES.has(entry.name.toLocaleLowerCase());
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function closePalette(): void {
  useUiStore.getState().setPaletteMode('none');
}

/**
 * The file list deliberately lives in this mounted palette rather than the workspace store.
 * It keeps the tree responsive and makes cancellation on palette/workspace changes explicit.
 */
export function QuickOpen(): JSX.Element {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [files, setFiles] = useState<FlatFile[]>([]);
  const [indexState, setIndexState] = useState<IndexState>('idle');
  const [progress, setProgress] = useState<IndexProgress>({ files: 0, directories: 0 });
  const [indexError, setIndexError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const indexRunRef = useRef(0);

  const rootPath = useWorkspaceStore((s) => s.rootPath);
  const workspaceGeneration = useWorkspaceStore((s) => s.generation);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const runId = indexRunRef.current + 1;
    indexRunRef.current = runId;
    let cancelled = false;

    const isCurrentRun = (): boolean => {
      const workspace = useWorkspaceStore.getState();
      return (
        !cancelled &&
        indexRunRef.current === runId &&
        workspace.rootPath === rootPath &&
        workspace.generation === workspaceGeneration
      );
    };

    if (!rootPath) {
      setFiles([]);
      setProgress({ files: 0, directories: 0 });
      setIndexError(null);
      setIndexState('idle');
      return () => {
        cancelled = true;
      };
    }

    setFiles([]);
    setProgress({ files: 0, directories: 0 });
    setIndexError(null);
    setIndexState('indexing');

    const activeRootPath = rootPath;

    async function indexWorkspace(): Promise<void> {
      const queue = [activeRootPath];
      const queuedDirectoryKeys = new Set([pathKey(activeRootPath)]);
      const discoveredFiles: FlatFile[] = [];
      let nextDirectoryIndex = 0;
      let indexedDirectories = 0;
      let scannedEntries = 0;
      let truncated = false;
      let lastPublishedFiles = 0;
      let lastPublishedDirectories = 0;

      const publish = (force = false): void => {
        const filesSincePublish = discoveredFiles.length - lastPublishedFiles;
        const directoriesSincePublish = indexedDirectories - lastPublishedDirectories;
        if (
          !force &&
          filesSincePublish < PUBLISH_EVERY_FILES &&
          directoriesSincePublish < PUBLISH_EVERY_DIRECTORIES
        ) {
          return;
        }
        if (!isCurrentRun()) return;
        lastPublishedFiles = discoveredFiles.length;
        lastPublishedDirectories = indexedDirectories;
        setFiles([...discoveredFiles]);
        setProgress({ files: discoveredFiles.length, directories: indexedDirectories });
      };

      try {
        while (
          nextDirectoryIndex < queue.length &&
          indexedDirectories < MAX_INDEXED_DIRECTORIES &&
          discoveredFiles.length < MAX_INDEXED_FILES &&
          scannedEntries < MAX_SCANNED_ENTRIES
        ) {
          if (!isCurrentRun()) return;

          const directory = queue[nextDirectoryIndex];
          nextDirectoryIndex += 1;
          if (!directory) break;
          indexedDirectories += 1;

          let entries: DirEntry[];
          try {
            entries = await readDir(directory);
          } catch (error) {
            // A single unreadable nested directory should not hide all other files.
            console.warn(`Quick Open could not read "${directory}":`, error);
            if (!isCurrentRun()) return;
            continue;
          }

          if (!isCurrentRun()) return;

          for (const entry of entries) {
            if (scannedEntries >= MAX_SCANNED_ENTRIES) {
              truncated = true;
              break;
            }
            scannedEntries += 1;

            if (entry.isDir) {
              if (shouldSkipDirectory(entry)) continue;

              const key = pathKey(entry.path);
              if (queuedDirectoryKeys.has(key)) continue;
              if (queuedDirectoryKeys.size >= MAX_INDEXED_DIRECTORIES) {
                truncated = true;
                continue;
              }

              queuedDirectoryKeys.add(key);
              queue.push(entry.path);
              continue;
            }

            if (discoveredFiles.length >= MAX_INDEXED_FILES) {
              truncated = true;
              break;
            }

            discoveredFiles.push({
              name: entry.name,
              path: entry.path,
              relPath: relativePath(entry.path, activeRootPath),
            });
          }

          publish(indexedDirectories === 1);
        }

        if (
          nextDirectoryIndex < queue.length ||
          indexedDirectories >= MAX_INDEXED_DIRECTORIES ||
          discoveredFiles.length >= MAX_INDEXED_FILES ||
          scannedEntries >= MAX_SCANNED_ENTRIES
        ) {
          truncated = true;
        }

        if (!isCurrentRun()) return;
        publish(true);
        setIndexState(truncated ? 'truncated' : 'ready');
      } catch (error) {
        if (!isCurrentRun()) return;
        setIndexError(errorMessage(error));
        setIndexState('error');
      }
    }

    void indexWorkspace();

    return () => {
      cancelled = true;
    };
  }, [rootPath, workspaceGeneration]);

  const q = query.trim().toLocaleLowerCase();
  const filtered = useMemo(() => {
    const matches = q
      ? files.filter(
          (file) =>
            file.name.toLocaleLowerCase().includes(q) ||
            file.relPath.toLocaleLowerCase().includes(q),
        )
      : files;
    return matches.slice(0, MAX_RESULTS);
  }, [files, q]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  useEffect(() => {
    setSelectedIndex((index) => Math.min(index, Math.max(filtered.length - 1, 0)));
  }, [filtered.length]);

  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  function openSelected(index: number): void {
    const file = filtered[index];
    if (!file) return;
    void useEditorStore.getState().openFile(file.path);
    closePalette();
  }

  function handleOverlayMouseDown(e: MouseEvent<HTMLDivElement>): void {
    if (e.target === e.currentTarget) closePalette();
  }

  function handleKeyDown(e: KeyboardEvent<HTMLDivElement>): void {
    if (e.nativeEvent.isComposing) return;

    switch (e.key) {
      case 'Escape':
        e.preventDefault();
        closePalette();
        break;
      case 'ArrowDown':
        e.preventDefault();
        setSelectedIndex((i) => (filtered.length === 0 ? 0 : (i + 1) % filtered.length));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setSelectedIndex((i) => (filtered.length === 0 ? 0 : (i - 1 + filtered.length) % filtered.length));
        break;
      case 'Enter':
        e.preventDefault();
        openSelected(selectedIndex);
        break;
      default:
        break;
    }
  }

  const statusText = (() => {
    if (!rootPath) return 'フォルダを開くとファイルを検索できます';
    if (indexState === 'indexing') {
      return `ファイルを検索中… ${progress.files} 件（${progress.directories} フォルダ）`;
    }
    if (indexState === 'truncated') {
      return `検索対象を上限で打ち切りました（${progress.files} ファイル / ${progress.directories} フォルダ）`;
    }
    if (indexState === 'error') return `ファイルの検索に失敗しました: ${indexError ?? '不明なエラー'}`;
    return null;
  })();

  return (
    <div className="dx-palette-overlay" onMouseDown={handleOverlayMouseDown}>
      <div className="dx-palette-box" onKeyDown={handleKeyDown}>
        <input
          ref={inputRef}
          className="dx-palette-input"
          type="text"
          placeholder="ファイル名で検索..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="dx-palette-list" ref={listRef}>
          {statusText && (
            <div className="dx-palette-status" role="status">
              {statusText}
            </div>
          )}
          {filtered.length === 0 && indexState !== 'indexing' && !indexError && (
            <div className="dx-palette-empty">一致するファイルがありません</div>
          )}
          {filtered.map((file, index) => (
            <div
              key={file.path}
              className={
                index === selectedIndex ? 'dx-palette-item dx-palette-item--active' : 'dx-palette-item'
              }
              data-active={index === selectedIndex}
              onMouseEnter={() => setSelectedIndex(index)}
              onClick={() => openSelected(index)}
            >
              <span className="dx-palette-item-title">{file.name}</span>
              <span className="dx-palette-item-path">{file.relPath}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
