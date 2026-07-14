import type * as monaco from 'monaco-editor';
import type { ThemeId } from '../types';

export interface Theme {
  id: ThemeId;
  label: string;
  kind: 'light' | 'dark';
  cssVars: Record<string, string>;
  monaco: monaco.editor.IStandaloneThemeData;
}
