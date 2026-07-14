import * as monaco from 'monaco-editor';
import type { ThemeId } from '../types';
import type { Theme } from './types';
import { lightTheme } from './light';
import { darkTheme } from './dark';
import { paperTheme } from './paper';

export type { Theme } from './types';

const THEME_STORAGE_KEY = 'darask.theme';

export const themes: Theme[] = [lightTheme, darkTheme, paperTheme];

// defineTheme は monacoSetup 側(起動時)の責務。ここでは setTheme のみ呼ぶ。
export function applyTheme(id: ThemeId): void {
  const theme = themes.find((t) => t.id === id) ?? themes[0];
  const root = document.documentElement;
  for (const [key, value] of Object.entries(theme.cssVars)) {
    root.style.setProperty(key, value);
  }
  root.dataset.theme = theme.id;
  monaco.editor.setTheme(theme.id);
  localStorage.setItem(THEME_STORAGE_KEY, theme.id);
}
