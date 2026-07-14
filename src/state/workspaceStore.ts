import { create } from 'zustand';
import { open } from '@tauri-apps/plugin-dialog';
import type { DirEntry } from '../types';
import {
  createDir as createDirOnDisk,
  createFile as createFileOnDisk,
  deleteToTrash,
  isTauri,
  readDir,
  renamePath,
  setWorkspaceRoot,
} from '../lib/fs';
import { prepareTabsForExternalChange, requestCloseAllTabs } from '../lib/editorLifecycle';
import { useEditorStore } from './editorStore';

function basename(path: string): string {
  const normalized = path.replace(/[\\/]+$/, '');
  const parts = normalized.split(/[\\/]/);
  return parts[parts.length - 1] ?? normalized;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function pathSeparator(path: string): '\\' | '/' {
  return path.includes('\\') ? '\\' : '/';
}

function joinPath(parentPath: string, name: string): string {
  const parent = parentPath.replace(/[\\/]+$/, '');
  return `${parent}${pathSeparator(parentPath)}${name}`;
}

function parentPath(path: string): string {
  const normalized = path.replace(/[\\/]+$/, '');
  const separatorIndex = Math.max(normalized.lastIndexOf('\\'), normalized.lastIndexOf('/'));
  if (separatorIndex < 0) return normalized;
  if (separatorIndex === 0) return normalized.slice(0, 1);
  if (separatorIndex === 2 && /^[A-Za-z]:/.test(normalized)) return normalized.slice(0, 3);
  return normalized.slice(0, separatorIndex);
}

function isSameOrDescendant(candidate: string, ancestor: string): boolean {
  const normalizedAncestor = ancestor.replace(/[\\/]+$/, '');
  return (
    candidate === normalizedAncestor ||
    candidate.startsWith(`${normalizedAncestor}\\`) ||
    candidate.startsWith(`${normalizedAncestor}/`)
  );
}

function withoutSubtree<T>(record: Record<string, T>, path: string): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([candidate]) => !isSameOrDescendant(candidate, path)));
}

function openDocumentPathsAt(path: string): string[] {
  return useEditorStore
    .getState()
    .tabs.filter((tab) => isSameOrDescendant(tab.path, path))
    .map((tab) => tab.path);
}

export function validateEntryName(value: string): string | null {
  const name = value.trim();
  if (name.length === 0) return '名前を入力してください。';
  if (name === '.' || name === '..') return '「.」と「..」は名前に使用できません。';
  if (/[\\/]/.test(name)) return '名前に「/」または「\\」は使用できません。';
  if (name.includes('\0')) return '名前に使用できない文字が含まれています。';
  return null;
}

function validNameOrThrow(value: string): string {
  const validationError = validateEntryName(value);
  if (validationError) throw new Error(validationError);
  return value.trim();
}

interface WorkspaceState {
  rootPath: string | null;
  rootName: string | null;
  generation: number;
  children: Record<string, DirEntry[]>;
  expandedDirs: Record<string, boolean>;
  loadingDirs: Record<string, boolean>;
  dirErrors: Record<string, string>;
  openingFolder: boolean;
  workspaceError: string | null;
  openFolder(): Promise<boolean>;
  loadDir(path: string): Promise<void>;
  toggleDir(path: string): Promise<void>;
  createFile(parentPath: string, name: string): Promise<string>;
  createDir(parentPath: string, name: string): Promise<string>;
  renameEntry(from: string, newName: string): Promise<string>;
  deleteEntry(path: string): Promise<void>;
  refreshParent(path: string): Promise<void>;
}

let loadRequestCounter = 0;
const latestLoadRequest = new Map<string, number>();

export const useWorkspaceStore = create<WorkspaceState>()((set, get) => ({
  rootPath: null,
  rootName: null,
  generation: 0,
  children: {},
  expandedDirs: {},
  loadingDirs: {},
  dirErrors: {},
  openingFolder: false,
  workspaceError: null,

  async openFolder() {
    if (get().openingFolder) return false;
    if (!isTauri()) {
      set({ workspaceError: 'フォルダを開くには Tauri アプリで実行してください。' });
      return false;
    }

    set({ openingFolder: true, workspaceError: null });
    try {
      const selected = await open({ directory: true, multiple: false });
      if (typeof selected !== 'string') return false;

      // 保存は旧 workspace root に対して実行する必要があるため、境界を切り替える前に確認する。
      if (!(await requestCloseAllTabs())) return false;

      // Rust 側のワークスペース境界の更新に失敗した場合、表示中の root は変更しない。
      const canonicalRoot = await setWorkspaceRoot(selected);
      useEditorStore.getState().resetForWorkspace();

      const generation = get().generation + 1;
      latestLoadRequest.clear();
      set({
        rootPath: canonicalRoot,
        rootName: basename(canonicalRoot),
        generation,
        children: {},
        expandedDirs: {},
        loadingDirs: {},
        dirErrors: {},
        workspaceError: null,
      });
      await get().loadDir(canonicalRoot);
      return true;
    } catch (error) {
      const message = errorMessage(error);
      console.error('openFolder failed:', error);
      set({ workspaceError: `フォルダを開けませんでした: ${message}` });
      return false;
    } finally {
      set({ openingFolder: false });
    }
  },

  async loadDir(path: string) {
    const generation = get().generation;
    const requestId = ++loadRequestCounter;
    latestLoadRequest.set(path, requestId);
    set((state) => {
      const dirErrors = { ...state.dirErrors };
      delete dirErrors[path];
      return {
        loadingDirs: { ...state.loadingDirs, [path]: true },
        dirErrors,
      };
    });

    try {
      const entries = await readDir(path);
      if (get().generation !== generation || latestLoadRequest.get(path) !== requestId) return;
      set((state) => ({ children: { ...state.children, [path]: entries } }));
    } catch (error) {
      if (get().generation !== generation || latestLoadRequest.get(path) !== requestId) return;
      const message = errorMessage(error);
      console.error(`loadDir failed for "${path}":`, error);
      set((state) => ({ dirErrors: { ...state.dirErrors, [path]: message } }));
    } finally {
      if (get().generation === generation && latestLoadRequest.get(path) === requestId) {
        set((state) => {
          const loadingDirs = { ...state.loadingDirs };
          delete loadingDirs[path];
          return { loadingDirs };
        });
      }
    }
  },

  async toggleDir(path: string) {
    const wasExpanded = get().expandedDirs[path] === true;
    const nextExpanded = !wasExpanded;
    set((state) => ({ expandedDirs: { ...state.expandedDirs, [path]: nextExpanded } }));
    if (nextExpanded && !get().children[path] && !get().loadingDirs[path]) {
      await get().loadDir(path);
    }
  },

  async createFile(parent, name) {
    const target = joinPath(parent, validNameOrThrow(name));
    await createFileOnDisk(target);
    set((state) => ({ expandedDirs: { ...state.expandedDirs, [parent]: true } }));
    await get().loadDir(parent);
    return target;
  },

  async createDir(parent, name) {
    const target = joinPath(parent, validNameOrThrow(name));
    await createDirOnDisk(target);
    set((state) => ({ expandedDirs: { ...state.expandedDirs, [parent]: true } }));
    await get().loadDir(parent);
    return target;
  },

  async renameEntry(from, newName) {
    const target = joinPath(parentPath(from), validNameOrThrow(newName));
    if (target === from) return from;
    const affectedPaths = openDocumentPathsAt(from);
    if (!(await prepareTabsForExternalChange(affectedPaths))) return from;

    const result = await renamePath(from, target);
    useEditorStore.getState().reconcileRenamedPath(from, result.path);
    set((state) => ({
      children: withoutSubtree(state.children, from),
      expandedDirs: withoutSubtree(state.expandedDirs, from),
      loadingDirs: withoutSubtree(state.loadingDirs, from),
      dirErrors: withoutSubtree(state.dirErrors, from),
    }));
    await get().refreshParent(result.path);
    return result.path;
  },

  async deleteEntry(path) {
    const affectedPaths = openDocumentPathsAt(path);
    if (!(await prepareTabsForExternalChange(affectedPaths))) return;

    await deleteToTrash(path);
    useEditorStore.getState().closeTabsAtPath(path);
    set((state) => ({
      children: withoutSubtree(state.children, path),
      expandedDirs: withoutSubtree(state.expandedDirs, path),
      loadingDirs: withoutSubtree(state.loadingDirs, path),
      dirErrors: withoutSubtree(state.dirErrors, path),
    }));
    await get().refreshParent(path);
  },

  async refreshParent(path) {
    const parent = parentPath(path);
    if (parent !== path) await get().loadDir(parent);
  },
}));
