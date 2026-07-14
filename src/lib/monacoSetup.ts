import * as monaco from 'monaco-editor';
import { loader } from '@monaco-editor/react';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import CssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import HtmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import TsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';
import { themes } from '../themes';

self.MonacoEnvironment = {
  getWorker(_moduleId: string, label: string) {
    switch (label) {
      case 'json':
        return new JsonWorker();
      case 'css':
      case 'scss':
      case 'less':
        return new CssWorker();
      case 'html':
      case 'handlebars':
      case 'razor':
        return new HtmlWorker();
      case 'typescript':
      case 'javascript':
        return new TsWorker();
      default:
        return new EditorWorker();
    }
  },
};

// CDN ではなくバンドル済み monaco-editor を @monaco-editor/react に使わせる(オフライン動作必須)
loader.config({ monaco });

export function defineAllThemes(monacoInstance: typeof monaco): void {
  for (const theme of themes) {
    monacoInstance.editor.defineTheme(theme.id, theme.monaco);
  }
}

// main.tsx がこのモジュールを副作用目的で import した時点でテーマを定義しておく。
// これにより App マウント時の applyTheme() が安全に monaco.editor.setTheme を呼べる。
defineAllThemes(monaco);

const EXTENSION_TO_LANGUAGE: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  html: 'html',
  htm: 'html',
  css: 'css',
  scss: 'scss',
  less: 'less',
  md: 'markdown',
  markdown: 'markdown',
  rs: 'rust',
  py: 'python',
  go: 'go',
  java: 'java',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  php: 'php',
  rb: 'ruby',
  sh: 'shell',
  bash: 'shell',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  xml: 'xml',
  sql: 'sql',
  txt: 'plaintext',
};

export function detectLanguage(path: string): string {
  const match = /\.([^./\\]+)$/.exec(path);
  const ext = match ? match[1].toLowerCase() : '';
  return EXTENSION_TO_LANGUAGE[ext] ?? 'plaintext';
}
