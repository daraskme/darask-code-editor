import { create } from 'zustand';
import { documentManager, type DocumentId } from '../lib/documentManager';
import { readFile, writeFile, type FileRevision } from '../lib/fs';
import { detectLanguage } from '../lib/monacoSetup';
import { notifyError } from './notificationStore';

function basename(path: string): string {
  const normalized = path.replace(/[\\/]+$/, '');
  const parts = normalized.split(/[\\/]/);
  return parts[parts.length - 1] ?? normalized;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizePath(path: string): string {
  return path.replace(/[\\/]+/g, '/').replace(/\/+$/, '');
}

/** Returns `path` moved from one path subtree to another, or null when it is unaffected. */
function rebasePath(path: string, fromPath: string, toPath: string): string | null {
  const normalizedPath = normalizePath(path);
  const normalizedFrom = normalizePath(fromPath);
  const isWindowsPath = path.includes('\\') || fromPath.includes('\\') || toPath.includes('\\');
  const comparablePath = isWindowsPath ? normalizedPath.toLocaleLowerCase() : normalizedPath;
  const comparableFrom = isWindowsPath ? normalizedFrom.toLocaleLowerCase() : normalizedFrom;

  if (comparablePath !== comparableFrom && !comparablePath.startsWith(`${comparableFrom}/`)) {
    return null;
  }

  const suffix = normalizedPath.slice(normalizedFrom.length);
  const separator = toPath.includes('\\') ? '\\' : '/';
  const target = toPath.replace(/[\\/]+$/, '');
  return suffix.length === 0 ? target : `${target}${suffix.replaceAll('/', separator)}`;
}

/**
 * ここには React が描画する軽量なメタデータだけを置く。本文と undo 履歴は
 * documentManager が所有する Monaco model にのみ存在する。
 */
export interface EditorTab {
  documentId: DocumentId;
  path: string;
  name: string;
  language: string;
  modelUri: string;
  dirty: boolean;
  saving: boolean;
  revision: FileRevision;
  hasBom: boolean;
  error: string | null;
}

interface EditorState {
  tabs: EditorTab[];
  activePath: string | null;
  /** workspace 切替ごとに増やし、古い非同期 read 結果を無効にする。 */
  workspaceGeneration: number;
  lastError: string | null;
  openFile(path: string): Promise<void>;
  closeTab(path: string): void;
  closeAllTabs(): void;
  /** dirty 確認の完了後に呼ぶ。全 model を破棄し、実行中の古い open を無効化する。 */
  resetForWorkspace(): void;
  setActive(path: string): void;
  saveActive(): Promise<void>;
  saveFile(path: string): Promise<void>;
  clearError(path: string): void;
  /** Updates open documents after a successful file or directory rename. */
  reconcileRenamedPath(fromPath: string, toPath: string): void;
  /** Closes every open document at or below a path after it was deleted. */
  closeTabsAtPath(path: string): void;
}

const inFlightOpens = new Map<string, Promise<Awaited<ReturnType<typeof readFile>>>>();
const saveQueues = new Map<string, Promise<void>>();
const pendingSaveCounts = new Map<string, number>();
let nextOpenRequestId = 0;
let latestOpenRequestId = 0;
let pendingOpenGeneration = 0;

function invalidatePendingOpens(): void {
  pendingOpenGeneration += 1;
  latestOpenRequestId = ++nextOpenRequestId;
}

function cleanupOpen(path: string, promise: Promise<Awaited<ReturnType<typeof readFile>>>): void {
  if (inFlightOpens.get(path) === promise) {
    inFlightOpens.delete(path);
  }
}

function setTabSaving(path: string, saving: boolean): void {
  useEditorStore.setState((state) => {
    const tab = state.tabs.find((candidate) => candidate.path === path);
    if (!tab || tab.saving === saving) return state;
    return {
      tabs: state.tabs.map((candidate) => (candidate.path === path ? { ...candidate, saving } : candidate)),
    };
  });
}

function incrementPendingSave(path: string): void {
  const count = (pendingSaveCounts.get(path) ?? 0) + 1;
  pendingSaveCounts.set(path, count);
  setTabSaving(path, true);
}

function decrementPendingSave(path: string): void {
  const previous = pendingSaveCounts.get(path) ?? 0;
  const count = Math.max(0, previous - 1);
  if (count === 0) {
    pendingSaveCounts.delete(path);
  } else {
    pendingSaveCounts.set(path, count);
  }
  setTabSaving(path, count > 0);
}

async function saveOne(path: string): Promise<void> {
  const tab = useEditorStore.getState().tabs.find((candidate) => candidate.path === path);
  if (!tab) return;

  const snapshot = documentManager.captureSaveSnapshot(path);
  if (!snapshot || snapshot.documentId !== tab.documentId) {
    const error = new Error('保存対象のドキュメントが見つかりません');
    useEditorStore.setState((state) => ({
      tabs: state.tabs.map((candidate) =>
        candidate.path === path && candidate.documentId === tab.documentId
          ? { ...candidate, error: error.message }
          : candidate,
      ),
    }));
    throw error;
  }

  useEditorStore.setState((state) => ({
    tabs: state.tabs.map((candidate) =>
      candidate.path === path && candidate.documentId === snapshot.documentId
        ? { ...candidate, error: null }
        : candidate,
    ),
  }));

  try {
    const result = await writeFile(snapshot.path, snapshot.contents, {
      expectedRevision: snapshot.revision,
      hasBom: snapshot.hasBom,
    });
    const saved = documentManager.markSaved(snapshot, result.revision);
    if (!saved) return;

    useEditorStore.setState((state) => ({
      tabs: state.tabs.map((candidate) =>
        candidate.path === path && candidate.documentId === snapshot.documentId
          ? {
              ...candidate,
              revision: saved.revision,
              hasBom: saved.hasBom,
              dirty: saved.dirty,
              error: null,
            }
          : candidate,
      ),
    }));
  } catch (error) {
    const message = errorMessage(error);
    const currentDocument = documentManager.getDocument(path);
    const currentDirty =
      currentDocument?.documentId === snapshot.documentId ? currentDocument.dirty : undefined;
    useEditorStore.setState((state) => ({
      tabs: state.tabs.map((candidate) =>
        candidate.path === path && candidate.documentId === snapshot.documentId
          ? { ...candidate, dirty: currentDirty ?? candidate.dirty, error: message }
          : candidate,
      ),
    }));
    throw error;
  }
}

function enqueueSave(path: string): Promise<void> {
  incrementPendingSave(path);
  const previous = saveQueues.get(path);
  const start = previous ? previous.catch(() => undefined) : Promise.resolve();
  const operation = start.then(() => saveOne(path));
  saveQueues.set(path, operation);

  void operation.then(
    () => {
      decrementPendingSave(path);
      if (saveQueues.get(path) === operation) saveQueues.delete(path);
    },
    () => {
      decrementPendingSave(path);
      if (saveQueues.get(path) === operation) saveQueues.delete(path);
    },
  );
  return operation;
}

export const useEditorStore = create<EditorState>()((set, get) => ({
  tabs: [],
  activePath: null,
  workspaceGeneration: 0,
  lastError: null,

  async openFile(path: string) {
    const requestId = ++nextOpenRequestId;
    latestOpenRequestId = requestId;
    const generation = get().workspaceGeneration;
    const openGeneration = pendingOpenGeneration;
    const existing = get().tabs.find((tab) => tab.path === path);
    if (existing) {
      set({ activePath: path, lastError: null });
      return;
    }

    let readPromise = inFlightOpens.get(path);
    if (!readPromise) {
      const createdPromise = readFile(path);
      readPromise = createdPromise;
      inFlightOpens.set(path, createdPromise);
      void createdPromise.then(
        () => cleanupOpen(path, createdPromise),
        () => cleanupOpen(path, createdPromise),
      );
    }

    try {
      const result = await readPromise;
      if (generation !== get().workspaceGeneration || openGeneration !== pendingOpenGeneration) return;

      const document = await documentManager.createOrGetDocument({
        path,
        content: result.content,
        language: detectLanguage(path),
        revision: result.revision,
        hasBom: result.hasBom,
        isCurrent: () =>
          generation === get().workspaceGeneration && openGeneration === pendingOpenGeneration,
      });
      if (!document || generation !== get().workspaceGeneration || openGeneration !== pendingOpenGeneration) {
        const currentDocument = documentManager.getDocument(path);
        if (document && currentDocument?.documentId === document.documentId) {
          documentManager.disposeDocument(path);
        }
        return;
      }

      set((state) => {
        const existingTab = state.tabs.find((tab) => tab.path === path);
        const tab: EditorTab = existingTab ?? {
          documentId: document.documentId,
          path,
          name: basename(path),
          language: document.language,
          modelUri: document.modelUri,
          dirty: document.dirty,
          saving: false,
          revision: document.revision,
          hasBom: document.hasBom,
          error: null,
        };
        return {
          tabs: existingTab ? state.tabs : [...state.tabs, tab],
          activePath: requestId === latestOpenRequestId ? path : state.activePath,
          lastError: null,
        };
      });
    } catch (error) {
      const message = errorMessage(error);
      if (
        generation === get().workspaceGeneration &&
        openGeneration === pendingOpenGeneration &&
        requestId === latestOpenRequestId
      ) {
        set({ lastError: message });
        notifyError(`ファイルを開けませんでした: ${message}`);
      }
      console.error(`openFile failed for "${path}":`, error);
    }
  },

  closeTab(path: string) {
    const { tabs, activePath } = get();
    const index = tabs.findIndex((tab) => tab.path === path);
    if (index === -1) return;

    const nextTabs = tabs.filter((tab) => tab.path !== path);
    let nextActive = activePath;
    if (activePath === path) {
      const neighbor = nextTabs[index] ?? nextTabs[index - 1];
      nextActive = neighbor?.path ?? null;
    }

    set({ tabs: nextTabs, activePath: nextActive });
    documentManager.disposeDocument(path);
  },

  closeAllTabs() {
    invalidatePendingOpens();
    set({ tabs: [], activePath: null });
    documentManager.disposeAllDocuments();
  },

  resetForWorkspace() {
    // 結果を待っている readFile が後から戻ってきても、この世代と一致しないため無視される。
    const workspaceGeneration = get().workspaceGeneration + 1;
    invalidatePendingOpens();
    inFlightOpens.clear();
    set({ tabs: [], activePath: null, lastError: null, workspaceGeneration });
    documentManager.disposeAllDocuments();
  },

  setActive(path: string) {
    if (get().tabs.some((tab) => tab.path === path)) {
      set({ activePath: path });
    }
  },

  async saveActive() {
    const activePath = get().activePath;
    if (!activePath) return;
    await get().saveFile(activePath);
  },

  async saveFile(path: string) {
    if (!get().tabs.some((tab) => tab.path === path)) return;
    await enqueueSave(path);
  },

  clearError(path: string) {
    set((state) => ({
      tabs: state.tabs.map((tab) => (tab.path === path ? { ...tab, error: null } : tab)),
    }));
  },

  reconcileRenamedPath(fromPath, toPath) {
    invalidatePendingOpens();
    const activePath = get().activePath;
    let nextActivePath = activePath;

    const tabs = get().tabs.map((tab) => {
      const nextPath = rebasePath(tab.path, fromPath, toPath);
      if (!nextPath) return tab;

      const document = documentManager.renameDocument(tab.path, nextPath, detectLanguage(nextPath));
      if (!document) return tab;

      if (activePath === tab.path) nextActivePath = nextPath;
      return {
        ...tab,
        path: nextPath,
        name: basename(nextPath),
        language: document.language,
        modelUri: document.modelUri,
      };
    });

    set({ tabs, activePath: nextActivePath });
  },

  closeTabsAtPath(path) {
    invalidatePendingOpens();
    const paths = get().tabs
      .filter((tab) => rebasePath(tab.path, path, path) !== null)
      .map((tab) => tab.path);
    for (const tabPath of paths) {
      get().closeTab(tabPath);
    }
  },
}));

// Monaco の content event では本文を Zustand に複製せず、dirty の遷移時だけ UI metadata を更新する。
documentManager.subscribe((change) => {
  useEditorStore.setState((state) => {
    const tab = state.tabs.find(
      (candidate) => candidate.path === change.path && candidate.documentId === change.documentId,
    );
    if (!tab || tab.dirty === change.dirty) return state;
    return {
      tabs: state.tabs.map((candidate) =>
        candidate.path === change.path && candidate.documentId === change.documentId
          ? { ...candidate, dirty: change.dirty }
          : candidate,
      ),
    };
  });
});
