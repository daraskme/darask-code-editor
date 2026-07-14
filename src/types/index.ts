// 全エージェント共通の型契約(PHASE1-SPEC.md 4.1)

export interface DirEntry {
  name: string;
  path: string;
  isDir: boolean;
}

export type ThemeId = 'darask-light' | 'darask-dark' | 'darask-paper';

export type PaletteMode = 'none' | 'commands' | 'files';
