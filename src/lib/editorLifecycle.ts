import { confirmUnsavedChanges, type UnsavedFile } from '../state/unsavedChangesStore';
import { useEditorStore, type EditorTab } from '../state/editorStore';
import { notifyError } from '../state/notificationStore';

function toUnsavedFile(tab: EditorTab): UnsavedFile {
  return { path: tab.path, name: tab.name };
}

function getTabs(paths?: readonly string[]): EditorTab[] {
  const tabs = useEditorStore.getState().tabs;
  if (!paths) return tabs;

  const requestedPaths = new Set(paths);
  return tabs.filter((tab) => requestedPaths.has(tab.path));
}

async function saveTabs(tabs: EditorTab[]): Promise<boolean> {
  const state = useEditorStore.getState();
  const originalActivePath = state.activePath;

  try {
    for (const tab of tabs) {
      useEditorStore.getState().setActive(tab.path);
      await useEditorStore.getState().saveActive();
      const current = useEditorStore.getState().tabs.find((candidate) => candidate.path === tab.path);
      if (!current || current.dirty) return false;
    }
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    notifyError(`保存に失敗しました: ${message}`);
    return false;
  } finally {
    if (originalActivePath && useEditorStore.getState().tabs.some((tab) => tab.path === originalActivePath)) {
      useEditorStore.getState().setActive(originalActivePath);
    }
  }
}

async function resolveUnsavedTabs(tabs: EditorTab[]): Promise<boolean> {
  const dirtyTabs = tabs.filter((tab) => tab.dirty);
  if (dirtyTabs.length === 0) return true;

  const decision = await confirmUnsavedChanges(dirtyTabs.map(toUnsavedFile));
  if (decision === 'cancel') return false;
  if (decision === 'save') return saveTabs(dirtyTabs);
  return true;
}

/**
 * 外部のファイル操作（名前変更・ごみ箱移動など）の前に、対象タブの変更を解決する。
 * 成功してもタブ自体は閉じないため、操作が失敗した場合に表示中のドキュメントを失わない。
 */
export async function prepareTabsForExternalChange(paths: readonly string[]): Promise<boolean> {
  return resolveUnsavedTabs(getTabs(paths));
}

/**
 * 未保存確認を経由して1タブを閉じる。保存失敗・キャンセル時はタブを維持する。
 */
export async function requestCloseTab(path: string): Promise<boolean> {
  const tabs = getTabs([path]);
  if (!(await resolveUnsavedTabs(tabs))) return false;

  useEditorStore.getState().closeTab(path);
  return true;
}

/**
 * ワークスペース切替やアプリ終了に使う共通の未保存確認。
 * true の場合のみ呼び出し元が closeAllTabs/resetForWorkspace を実行できる。
 */
export async function requestCloseAllTabs(): Promise<boolean> {
  return resolveUnsavedTabs(getTabs());
}
