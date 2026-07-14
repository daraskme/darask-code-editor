import { create } from 'zustand';
import type { PaletteMode, ThemeId } from '../types';
import { applyTheme } from '../themes';

const THEME_STORAGE_KEY = 'darask.theme';

function isThemeId(value: string | null): value is ThemeId {
  return value === 'darask-light' || value === 'darask-dark' || value === 'darask-paper';
}

function initialThemeId(): ThemeId {
  const stored = typeof localStorage !== 'undefined' ? localStorage.getItem(THEME_STORAGE_KEY) : null;
  return isThemeId(stored) ? stored : 'darask-dark';
}

interface UiState {
  themeId: ThemeId;
  sidebarVisible: boolean;
  paletteMode: PaletteMode;
  cursorLine: number;
  cursorCol: number;
  setTheme(id: ThemeId): void;
  toggleSidebar(): void;
  setPaletteMode(mode: PaletteMode): void;
  setCursorPos(line: number, col: number): void;
}

export const useUiStore = create<UiState>()((set) => ({
  themeId: initialThemeId(),
  sidebarVisible: true,
  paletteMode: 'none',
  cursorLine: 1,
  cursorCol: 1,
  setTheme(id) {
    applyTheme(id);
    set({ themeId: id });
  },
  toggleSidebar() {
    set((s) => ({ sidebarVisible: !s.sidebarVisible }));
  },
  setPaletteMode(mode) {
    set({ paletteMode: mode });
  },
  setCursorPos(line, col) {
    set({ cursorLine: line, cursorCol: col });
  },
}));
