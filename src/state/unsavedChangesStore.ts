import { create } from 'zustand';

export type UnsavedChangesDecision = 'save' | 'discard' | 'cancel';

export interface UnsavedFile {
  path: string;
  name: string;
}

interface UnsavedChangesState {
  files: UnsavedFile[] | null;
  decide(decision: UnsavedChangesDecision): void;
}

let resolveActiveRequest: ((decision: UnsavedChangesDecision) => void) | null = null;

export const useUnsavedChangesStore = create<UnsavedChangesState>()((set) => ({
  files: null,

  decide(decision) {
    const resolve = resolveActiveRequest;
    resolveActiveRequest = null;
    set({ files: null });
    resolve?.(decision);
  },
}));

export function confirmUnsavedChanges(files: UnsavedFile[]): Promise<UnsavedChangesDecision> {
  if (files.length === 0) return Promise.resolve('discard');
  if (resolveActiveRequest) return Promise.resolve('cancel');

  return new Promise((resolve) => {
    resolveActiveRequest = resolve;
    useUnsavedChangesStore.setState({ files });
  });
}
