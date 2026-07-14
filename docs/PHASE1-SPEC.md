# Phase 1 実装仕様(実装契約)

> 策定: Fable 5 / 実装: Sonnet 5 エージェント。**この契約からの逸脱は禁止**。
> 曖昧な点は最も単純な解釈を選び、TODO コメントを残すこと。

## 0. 共通ルール

- TypeScript strict。`any` 禁止(やむを得ない場合 `unknown` + 絞り込み)。
- コメントは最小限。関数は小さく。ライブラリ追加は本仕様に記載のもののみ。
- Node は `%USERPROFILE%\.local\node` にある。シェル実行時は必ず PATH を通す:
  - PowerShell: `$env:Path = "$env:USERPROFILE\.local\node;$env:Path"`
  - Bash: `export PATH="$HOME/.local/node:$PATH"`
- 検証コマンド: `npm run build`(tsc && vite build)と `cargo check`(src-tauri 内)。

## 1. 依存パッケージ(package.json)

- dependencies: `react`, `react-dom`, `zustand`, `monaco-editor`, `@monaco-editor/react`,
  `@tauri-apps/api`, `@tauri-apps/plugin-dialog`
- devDependencies: `typescript`, `vite`, `@vitejs/plugin-react`, `@types/react`, `@types/react-dom`,
  `@tauri-apps/cli`
- scripts: `dev`(vite), `build`(tsc && vite build), `preview`, `tauri`
- すべて最新安定版(`npm install <pkg>` で入る版)を使用。

## 2. Tauri 設定

- `tauri.conf.json`: productName `Darask`, identifier `me.darask.editor`,
  window: 1440x900, min 800x600, title `Darask`, `dragDropEnabled: false`(Monaco の D&D と干渉するため)。
- Rust クレート: `tauri`(features: 標準), `tauri-plugin-dialog`, `serde`, `serde_json`。
- dev では Vite は port 1420 固定(`strictPort: true`)。
- vite.config.ts に `server.watch.ignored: ['**/src-tauri/**']` を必ず設定する。
  無いと Windows で cargo のビルド成果物(ロック中の .exe)を chokidar が watch しようとして
  EBUSY で vite がクラッシュし、`tauri dev` が落ちる(実際に発生・修正済み)。

### 2.1 Rust コマンド(src-tauri/src/commands/fs.rs)

```rust
#[derive(serde::Serialize)]
pub struct DirEntry { pub name: String, pub path: String, pub is_dir: bool }

#[tauri::command] // ディレクトリ直下を列挙。dirs先・名前昇順(大文字小文字無視)。
pub fn read_dir(path: String) -> Result<Vec<DirEntry>, String>
// 隠しファイルも返すが、`.git`, `node_modules`, `target` はそのまま返す(フィルタは UI 側の責務ではなく、Phase1 ではフィルタしない)

#[tauri::command] // UTF-8 テキストとして読む。10MB 超 → Err("file too large")、非UTF-8 → Err("binary file")
pub fn read_file(path: String) -> Result<String, String>

#[tauri::command]
pub fn write_file(path: String, contents: String) -> Result<(), String>
```

- `lib.rs` で `invoke_handler` に登録。エラーは `e.to_string()` で String 化。

## 3. フロントエンド構成(ファイル所有権)

各ファイルの「所有エージェント」を明記。**自分の所有ファイル以外は編集禁止**(読むのは自由)。

### 3.1 Agent A(scaffold/core)所有

```
package.json, vite.config.ts, tsconfig.json, tsconfig.node.json, index.html, .gitignore
src/main.tsx, src/App.tsx, src/vite-env.d.ts
src/components/layout/ActivityBar.tsx, SideBar.tsx, StatusBar.tsx, MainArea.tsx
src/state/uiStore.ts, workspaceStore.ts, editorStore.ts
src/lib/fs.ts, commands.ts, keybindings.ts, monacoSetup.ts, platform.ts
src/types/index.ts
src/styles/global.css(レイアウト骨格のみ。色は必ず CSS 変数 var(--xxx) 参照)
src-tauri/ 一式(Cargo.toml, tauri.conf.json, build.rs, src/*.rs)
```

### 3.2 Agent B(テーマ/フォント)所有

```
src/themes/types.ts, light.ts, dark.ts, paper.ts, index.ts
src/styles/fonts.css
public/fonts/(JetBrains Mono woff2 + OFL.txt)
```

### 3.3 Agent C(エクスプローラ)所有

```
src/components/explorer/FileExplorer.tsx, FileTreeItem.tsx, explorer.css
```

### 3.4 Agent D(エディタ)所有

```
src/components/editor/EditorPane.tsx, EditorTabs.tsx, WelcomeView.tsx, editor.css
```

### 3.5 Agent E(パレット)所有

```
src/components/palette/CommandPalette.tsx, QuickOpen.tsx, palette.css
```

## 4. 型・ストア契約(全エージェント共通の前提)

### 4.1 src/types/index.ts

```ts
export interface DirEntry { name: string; path: string; isDir: boolean }
// 注意: Rust は is_dir で返す。lib/fs.ts で isDir へ変換する。
export type ThemeId = 'darask-light' | 'darask-dark' | 'darask-paper';
export type PaletteMode = 'none' | 'commands' | 'files';
```

### 4.2 src/state/uiStore.ts

```ts
interface UiState {
  themeId: ThemeId;                   // 初期値: localStorage('darask.theme') ?? 'darask-dark'
  sidebarVisible: boolean;            // 初期 true
  paletteMode: PaletteMode;           // 初期 'none'
  setTheme(id: ThemeId): void;        // themes/index.ts の applyTheme を呼ぶ
  toggleSidebar(): void;
  setPaletteMode(mode: PaletteMode): void;
}
export const useUiStore = create<UiState>()(...)
```

### 4.3 src/state/workspaceStore.ts

```ts
interface WorkspaceState {
  rootPath: string | null;
  rootName: string | null;
  children: Record<string, DirEntry[]>; // key: dir path
  expandedDirs: Record<string, boolean>;
  openFolder(): Promise<void>;      // plugin-dialog の open({directory:true}) → 選択時 root 設定+直下ロード
  loadDir(path: string): Promise<void>;   // read_dir を呼び children[path] を更新
  toggleDir(path: string): Promise<void>; // 展開時に未ロードなら loadDir
}
export const useWorkspaceStore = create<WorkspaceState>()(...)
```

### 4.4 src/state/editorStore.ts

```ts
interface EditorTab {
  path: string; name: string; language: string; // language は monacoSetup の detectLanguage(path)
  content: string; savedContent: string;
}
interface EditorState {
  tabs: EditorTab[];
  activePath: string | null;
  openFile(path: string): Promise<void>; // 既に開いていれば activate のみ。read_file 失敗時は console.error + 何もしない
  closeTab(path: string): void;          // dirty でも確認なしで閉じる(Phase1 割り切り)
  setActive(path: string): void;
  updateContent(path: string, content: string): void;
  saveActive(): Promise<void>;           // write_file 後 savedContent 同期
}
// dirty 判定は content !== savedContent(セレクタで導出、フィールドに持たない)
export const useEditorStore = create<EditorState>()(...)
```

### 4.5 src/lib/*(Agent A 実装、他エージェントは import して使う)

```ts
// fs.ts — invoke ラッパ。isTauri() が false なら reject(ブラウザプレビュー時)
export function isTauri(): boolean            // '__TAURI_INTERNALS__' in window
export async function readDir(path: string): Promise<DirEntry[]>
export async function readFile(path: string): Promise<string>
export async function writeFile(path: string, contents: string): Promise<void>

// commands.ts — コマンドレジストリ
export interface AppCommand { id: string; title: string; keybinding?: string; run(): void | Promise<void> }
export function registerCommand(cmd: AppCommand): void
export function getCommands(): AppCommand[]
export function executeCommand(id: string): void
// 組み込みコマンド(App.tsx 起動時に登録):
// 'workbench.openFolder' フォルダを開く / 'file.save' 保存 / 'file.closeTab' タブを閉じる
// 'view.toggleSidebar' サイドバー切替 / 'workbench.quickOpen' / 'workbench.commandPalette'
// 'theme.light' / 'theme.dark' / 'theme.paper'(タイトルは「テーマ: ライト」等)

// keybindings.ts — window keydown(capture)で発火。Monaco フォーカス中も奪う
// Ctrl+P→quickOpen, Ctrl+Shift+P→commandPalette, Ctrl+S→save, Ctrl+W→closeTab, Ctrl+B→toggleSidebar
// Escape はパレットを閉じる(パレット側で処理)

// monacoSetup.ts
// - vite の ?worker import で editor/json/css/html/ts の 5 worker を MonacoEnvironment に設定
// - loader.config({ monaco }) で CDN ではなくバンドル版 monaco を使用(オフライン動作必須)
// - export function detectLanguage(path: string): string(拡張子→言語。不明は 'plaintext')
// - export function defineAllThemes(monaco): void(themes/index.ts の全テーマを defineTheme)
```

## 5. テーマ契約(Agent B)

### 5.1 型

```ts
// src/themes/types.ts
import type * as monaco from 'monaco-editor';
export interface Theme {
  id: ThemeId; label: string; kind: 'light' | 'dark';
  cssVars: Record<string, string>;   // '--app-bg': '#ffffff' 形式
  monaco: monaco.editor.IStandaloneThemeData;
}
```

### 5.2 CSS 変数(全テーマで全キー必須)

```
--app-bg --panel-bg --sidebar-bg --titlebar-bg --statusbar-bg --statusbar-fg
--fg --fg-muted --fg-faint --border --focus-border
--accent --accent-fg --hover-bg --active-bg --selection-bg
--tab-bar-bg --tab-active-bg --tab-active-fg --tab-inactive-fg
--input-bg --input-border --list-active-bg --list-active-fg
--scrollbar-thumb --shadow --error --warning --success
--editor-font-family (全テーマ共通: "'JetBrains Mono', Consolas, monospace")
--ui-font-family (全テーマ共通: system-ui スタック)
```

### 5.3 パレット指針

- **darask-light**: `--app-bg #ffffff`、fg はほぼ黒 `#1f1f1f`、アクセント青 `#0969da` 系。Monaco base `vs`
- **darask-dark**: `--app-bg #0e0e0e`(真の黒に近い)、fg `#d4d4d4`、アクセント `#4da3ff` 系。Monaco base `vs-dark`
- **darask-paper**: 古い紙・薄いコーヒー色。`--app-bg #f3ead7` 前後のセピア、パネルはやや濃い `#eaddc3` 系、
  fg はダークブラウン `#41352a`、アクセントはシエナ/コーヒー `#8b5a2b` 系。Monaco base `vs` に対し
  背景 `#f3ead7`・コメントは薄茶イタリック・キーワードは焦茶・文字列はオリーブ等、**紙にインクで書いた趣**に。
  白背景テーマの色相を回しただけの手抜きは禁止。3 テーマとも WCAG AA(通常テキスト 4.5:1)を満たすこと
- Monaco テーマは `colors`(editor.background, editor.foreground, editorLineNumber.foreground,
  editor.selectionBackground, editorCursor.foreground など主要キー)+ `rules`(comment, keyword, string,
  number, type, function, variable, constant, operator, delimiter)を各テーマで定義

### 5.4 applyTheme(src/themes/index.ts)

```ts
export const themes: Theme[]                    // [light, dark, paper]
export function applyTheme(id: ThemeId): void
// 1) documentElement.style で cssVars を全部 set
// 2) documentElement.dataset.theme = id
// 3) monaco.editor.setTheme(id)  (defineTheme は monacoSetup 側で起動時に実施済み)
// 4) localStorage.setItem('darask.theme', id)
```

### 5.5 フォント

- JetBrains Mono を https://download.jetbrains.com/fonts/JetBrainsMono-2.304.zip から取得し、
  `fonts/webfonts/` の woff2 のうち Regular / Italic / Bold / BoldItalic / Medium を
  `public/fonts/` へ配置。OFL.txt も同梱。`src/styles/fonts.css` に @font-face(font-display: swap)。

## 6. UI 契約

### 6.1 レイアウト(Agent A / App.tsx)

```
┌─────────────────────────────────────┐
│ ActivityBar │ SideBar │  MainArea   │  ActivityBar 幅48px 固定
│   (48px)    │ (260px, │ (Tabs+Editor)│  SideBar は sidebarVisible で表示切替
│             │  resize │              │  リサイズはドラッグハンドル(min180/max500)
│             │  可能)  │              │
├─────────────────────────────────────┤
│ StatusBar (22px)                     │
└─────────────────────────────────────┘
+ パレットは中央上部のオーバーレイ(paletteMode !== 'none' で表示)
```

- ActivityBar アイコン: Files(有効)/ Search / Git / AI / Settings(後3者は disabled、tooltip「Phase 2/3」)。
  アイコンは inline SVG(絵文字禁止)
- StatusBar 左: rootName または「フォルダ未選択」。右: `行 X, 列 Y`(エディタから)、言語、テーマ名
  (クリックで light→dark→paper→light と循環)

### 6.2 エクスプローラ(Agent C)

- `rootPath === null` 時: 「フォルダを開く」ボタン(`workbench.openFolder` 実行)
- ツリー: インデント 12px/階層、ディレクトリは chevron(▸/▾ の SVG)、遅延ロード、
  クリックでファイルは `openFile`、ディレクトリは `toggleDir`
- アクティブファイルは `--list-active-bg` でハイライト。ホバーは `--hover-bg`
- ファイルアイコンは Phase1 では汎用 2 種(file/folder SVG)で良い

### 6.3 エディタ(Agent D)

- `@monaco-editor/react` の `<Editor path={tab.path} ...>` でマルチモデル運用
- options: `{ fontFamily: 'JetBrains Mono', fontSize: 14, fontLigatures: true, minimap: {enabled: true}, automaticLayout: true, smoothScrolling: true, cursorBlinking: 'smooth', padding: {top: 8} }`
- タブバー: ファイル名 + dirty 時は ● を名前の左に、閉じる×(ホバー表示)。中クリックでも閉じる
- タブ 0 件時は WelcomeView: ロゴ的テキスト「Darask」+ ショートカット一覧(Ctrl+P など 4-5 個)
- カーソル位置は `onDidChangeCursorPosition` で StatusBar 用のストア(uiStore に cursorLine/cursorCol を追加してよい ← Agent A が定義)

### 6.4 パレット(Agent E)

- オーバーレイ: 上から 12vh、幅 560px、中央寄せ、`--shadow` で浮かす
- CommandPalette: 入力でコマンド title を部分一致フィルタ(大文字小文字無視)。
  ↑↓ 選択、Enter 実行+閉じる、Escape 閉じる。keybinding があれば右側に表示
- QuickOpen: workspaceStore の **ロード済み** children を再帰的に平坦化してファイル名フィルタ
  (Phase1 は全走査インデックス不要。TODO コメントで Phase2 の rg --files 置換を明記)
- 選択で `openFile` + 閉じる。両者は見た目を共通 CSS で統一

## 7. 完了条件(Definition of Done)

1. `npm run build` が警告なしで成功(tsc strict エラー 0)
2. `cargo check` が成功
3. `npm run tauri dev` でウィンドウが起動し、フォルダを開いてファイル編集・Ctrl+S 保存ができる
4. 3 テーマがコマンドパレット/ステータスバーから切り替わり、エディタ(Monaco)の配色も追従する
5. JetBrains Mono がエディタに適用されている(DevTools で確認可能)
6. ブラウザ(vite dev 単体)でも UI が崩れず表示される(fs 系ボタンは無効化されるだけ)
