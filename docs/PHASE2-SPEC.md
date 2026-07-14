# Phase 2a 実装仕様(ターミナル・検索・Git・ファイル操作)

> 策定: Fable 5 / 実装: Sonnet 5 エージェント。**この契約からの逸脱は禁止**。
> 曖昧な点は最も単純な解釈を選び、TODO コメントを残すこと。

## 0. スコープ

`docs/ROADMAP.md` の Phase 2 のうち、日常編集作業に最も効くものを前倒しする(前倒し方針は
Phase 3a と同じ)。

**含む(今回)**: 統合ターミナル、全文検索/置換、Git 基本(status・diff・stage・commit)、
ファイル操作(新規・リネーム・削除→ゴミ箱・D&D)、fs 監視によるツリー自動更新。

**含まない(Phase 2b に先送り)**: 設定システム(settings.json + GUI・キーバインドカスタマイズ)、
エディタ分割、ツリー/リスト仮想化、セッション復元、エディタ本体への Git diff ガター表示
(今回は Git 専用パネルでの diff 表示のみ)。

## 0.1 事実確認済み事項(2026-07-14 時点)

- ターミナル: `portable-pty`(wezterm 製、crates.io 最新安定版 `0.9`)。API:
  `native_pty_system()` → `pty_system.openpty(PtySize{rows,cols,pixel_width:0,pixel_height:0})`
  → `pair.slave.spawn_command(CommandBuilder::new(shell))` → `pair.master.try_clone_reader()` /
  `pair.master.take_writer()`。Windows は内部で ConPTY を使う(Windows 10 以降前提、追加の
  feature flag 指定は不要、そのまま `portable-pty = "0.9"` でよい)。
- フロント側ターミナル UI: `@xterm/xterm`(新パッケージ名。旧 `xterm` はメンテ終了)+
  `@xterm/addon-fit`(コンテナサイズへの自動フィット)。React 専用ラッパーは使わず、
  `useEffect` 内で `new Terminal()` を生成し DOM に `open()` する薄いコンポーネントを自作する
  (xterm.js は命令的 DOM API のため React ラッパーは必須ではない)。
- 全文検索: ripgrep 本体が内部で使っているクレート群 `ignore`(.gitignore を尊重したファイル
  走査、`WalkBuilder`)+ `grep-regex` + `grep-searcher`(`Searcher` + `RegexMatcher` + 自前の
  `Sink` 実装でマッチ行を収集)。ripgrep バイナリを別途バンドルする必要はない。
- Git: `git2`(libgit2 バインディング、crates.io 最新安定版 `0.21`)。
  `Repository::open(path)`、`repo.statuses(None)` で変更ファイル一覧、
  `repo.diff_index_to_workdir(None, None)` / `diff_tree_to_workdir(...)` で diff、
  `Index::add_path` + `index.write()` で stage、`repo.commit(...)` でコミット、
  `repo.head()?.shorthand()` でブランチ名。
- fs 監視: `notify`(crates.io 最新安定版 `8`)。`notify::recommended_watcher(closure)?` +
  `watcher.watch(path, RecursiveMode::Recursive)`。
- ゴミ箱削除: `trash`(crates.io 最新安定版 `5`)。`trash::delete(path)` で OS のゴミ箱に移動
  (完全削除ではない)。

## 1. 依存追加(Agent A が Cargo.toml に追加)

```toml
[dependencies]
# 既存(Phase1/3a)は維持しつつ追加
portable-pty = "0.9"
ignore = "0.4"
grep-searcher = "0.1"
grep-regex = "0.1"
grep-matcher = "0.1"
git2 = "0.21"
notify = "8"
trash = "5"
```

フロント: `npm install @xterm/xterm @xterm/addon-fit`(Agent A が package.json に追加)。

## 2. Rust 側モジュール構成とファイル所有権

`src-tauri/Cargo.toml` と `src-tauri/src/lib.rs` は **Agent A(scaffold)のみ**が編集する
(Phase 1/3a と同じ運用: 他エージェントは自分のモジュールに `#[tauri::command]` を実装し、
lib.rs への `invoke_handler!` 登録は「Integrate」段階でまとめて行う)。

### 2.1 Agent A(scaffold)

```
src-tauri/Cargo.toml(依存追加)
src-tauri/src/lib.rs(mod 宣言 + invoke_handler 登録は Integrate 段階の担当に委ねてよいが、
  骨格・既存 AppState への追記可否の判断はここで行う)
package.json(xterm 依存追加)
src/components/terminal/TerminalPanel.tsx の外枠だけ(下部ドックの開閉制御)
src/state/layoutStore.ts(新規。ターミナルドック開閉・高さ、サイドバーのアクティブタブ
  'explorer'|'search'|'git' を持つ)
src/components/layout/ActivityBar.tsx(Search / Git アイコンを enabled にし、
  layoutStore のサイドバータブ切替に配線。既存の Files 切替ロジックとは独立させてよい)
src/components/layout/SideBar.tsx(layoutStore のアクティブタブに応じて FileExplorer /
  SearchPanel / GitPanel を出し分けるよう変更)
src/lib/keybindings.ts に Ctrl+` (ターミナル開閉)、Ctrl+Shift+F(検索パネルを開く)を追加
```

- `layoutStore.ts`: `{ sidebarTab: 'explorer'|'search'|'git', setSidebarTab(tab), terminalOpen: boolean, terminalHeight: number, toggleTerminal(), setTerminalHeight(h) }`。
- ActivityBar の並びは既存どおり(Files/Search/Git/AI/Settings)。Search/Git クリックで
  `setSidebarTab` を呼び、まだサイドバーが閉じていれば開く(既存の `sidebarVisible` と
  `sidebarTab` は独立した状態。両方 true/表示対象タブの場合のみサイドバーの中身が見える)。

### 2.2 Agent B(ターミナル)

```
src-tauri/src/terminal/mod.rs
src-tauri/src/terminal/manager.rs
src/components/terminal/TerminalPanel.tsx(中身)、TerminalTabs.tsx、terminal.css
src/state/terminalStore.ts
src/lib/terminal.ts
```

- Rust: `TerminalManagerState`(`terminal_id -> { master: Box<dyn MasterPty>, writer, child }`
  を保持)。コマンド:
  - `terminal_create(state, app, cwd: String) -> Result<String, String>`
    (`native_pty_system().openpty(PtySize{rows:24,cols:80,..})` → シェルを spawn。
    Windows は `CommandBuilder::new("powershell.exe")`、それ以外は `$SHELL` 環境変数 or
    `/bin/bash` にフォールバック)。読み取りスレッドを起動し、出力を
    `terminal://{id}/data` イベント(バイト列を Base64 か Vec<u8> で送る。UTF-8 保証がない
    ため生バイトを Base64 文字列にして送るのが安全)で emit する。
  - `terminal_write(state, id: String, data: String) -> Result<(), String>`
    (`master.take_writer()` へ書き込み。呼び出し毎に writer を取り直すのではなく、
    生成時に確保した `Box<dyn Write + Send>` を state に保持し使い回すこと)。
  - `terminal_resize(state, id: String, rows: u16, cols: u16) -> Result<(), String>`
    (`master.resize(PtySize{...})`)。
  - `terminal_close(state, id: String) -> Result<(), String>`(child kill + state から除去)。
  - `portable-pty` の読み取りは blocking API(`std::io::Read`)のため、
    `tokio::task::spawn_blocking` の中でループさせ、読めたバイト列を
    `app.emit(...)` すること(async ランタイムをブロックしない)。
- フロント: `TerminalPanel.tsx` は `@xterm/xterm` の `Terminal` インスタンスを `useEffect` で
  生成し、`FitAddon` をロード、コンテナ div に `.open()`。`onData` で
  `invoke('terminal_write', { id, data })`。`terminal://{id}/data` を購読し
  `term.write(base64Decode(payload))`。`ResizeObserver` でコンテナサイズ変化を検知して
  `fitAddon.fit()` + `terminal_resize` を呼ぶ。フォントは JetBrains Mono
  (`var(--editor-font-family)` 相当、xterm.js の `fontFamily` オプションに直接指定)。
  テーマは `--app-bg`/`--fg` 等の CSS 変数を JS から `getComputedStyle` で読み、
  xterm の `theme` オプション(background/foreground/cursor 等)に反映する
  (テーマ切替時に再生成 or `term.options.theme = ...` で更新。TODO コメントで
  「テーマ切替イベントへの購読は Phase2b で検討」としてよい。初期表示だけ正しければ可)。
- `TerminalTabs.tsx`: 複数ターミナルをタブ切替(EditorTabs.tsx の見た目パターンを踏襲)。
  「+」ボタンで `terminal_create`。

### 2.3 Agent C(全文検索)

```
src-tauri/src/search/mod.rs
src/components/search/SearchPanel.tsx、SearchResultItem.tsx、search.css
src/state/searchStore.ts
```

- Rust: `#[tauri::command] pub async fn search_in_files(root: String, query: String, case_sensitive: bool, whole_word: bool) -> Result<Vec<SearchFileResult>, String>`。
  `ignore::WalkBuilder::new(root).build()` でファイル走査(`.gitignore` 自動尊重。
  バイナリファイルは `grep_searcher::Searcher::new()` がヒューリスティックで検出しスキップする
  ため明示チェック不要)。`grep_regex::RegexMatcher::new_line_matcher` を case_sensitive /
  whole_word オプションに応じて構築(whole_word は正規表現側で `\b` を付与するか、
  `RegexMatcherBuilder::whole_word(true)` を使う)。`Sink` を自前実装し、ファイルごとに
  `{ path, matches: Vec<{ line_number, line_text, column }> }` を集める。
  結果は最大 500 ファイル・ファイルあたり最大 50 マッチでキャップし(実装が簡単な固定上限。
  超過時は `truncated: bool` フィールドを立てて UI 側で「結果が多いため一部のみ表示」と
  出す)、`Vec<SearchFileResult> { path: String, matches: Vec<SearchMatch>, truncated: bool }`
  で返す。1 万ファイル級のリポジトリでも UI がフリーズしないよう、`tokio::task::spawn_blocking`
  内で実行すること(ファイル I/O が同期 API のため)。
- フロント: `searchStore.ts`(`query, caseSensitive, wholeWord, results, loading, search()`)。
  `SearchPanel.tsx`: クエリ入力 + オプショントグル2つ + 結果一覧(ファイル毎にグループ化、
  クリックで `editorStore.openFile` → Monaco の `revealLineInCenter` +
  該当行選択(`onMount` 時の editor インスタンスを保持する仕組みが必要な場合、
  EditorPane.tsx に「外部からジャンプ要求を受け取る」ための最小限の拡張が必要になる場合は
  Agent D(EditorPane 所有、Phase1)ではなく **今回の Integrate 担当が** EditorPane.tsx に
  小さな追記(ジャンプ用の pending state 購読)を行うことで解決してよい。検索エージェント自身は
  EditorPane.tsx を編集しない)。

### 2.4 Agent D(Git 基本)

```
src-tauri/src/git/mod.rs
src/components/git/GitPanel.tsx、GitFileRow.tsx、GitDiffView.tsx、git.css
src/state/gitStore.ts
```

- Rust: `#[tauri::command] pub fn git_status(root: String) -> Result<GitStatusInfo, String>`
  (`Repository::open(root)` 失敗時は「Git リポジトリではない」を表す `Err` ではなく
  `Ok(GitStatusInfo{ is_repo: false, .. })` を返す設計にする。UI 側で
  「このフォルダは Git リポジトリではありません」を出しやすくするため)。
  `repo.statuses(None)` から `{ path, status: "modified"|"added"|"deleted"|"untracked"|"renamed" }`
  の配列と、`repo.head()?.shorthand()` のブランチ名を返す。
  `#[tauri::command] pub fn git_diff(root: String, path: String, staged: bool) -> Result<String, String>`
  (`staged=false` なら `diff_index_to_workdir`、`true` なら `diff_tree_to_workdir_with_index`
  相当で HEAD との差分。結果は unified diff 形式の文字列にフォーマットして返す
  `git2::Diff` の `print()` コールバックでテキスト連結する)。
  `#[tauri::command] pub fn git_stage(root: String, paths: Vec<String>) -> Result<(), String>`
  / `git_unstage` / `#[tauri::command] pub fn git_commit(root: String, message: String) -> Result<(), String>`
  (署名は `repo.signature()`(グローバル git config から取得)を使う。config が無い環境では
  分かりやすいエラー文字列を返す)。
- フロント: `gitStore.ts`(`isRepo, branch, files: GitFileEntry[], selectedPath, diffText,
  refresh(), stage(paths), unstage(paths), commit(message)`)。`GitPanel.tsx`:
  ブランチ名表示 + 変更ファイル一覧(status に応じたアイコン/色: added=success,
  modified=warning, deleted=error, untracked=fg-muted)+ 全選択/個別 stage チェックボックス +
  コミットメッセージ入力 + コミットボタン。`GitDiffView.tsx`: 選択中ファイルの diff を
  `@monaco-editor/react` の `DiffEditor`(after 側のみ意味を持たせ、before/after 分割ではなく
  unified テキストをそのまま `<Editor language="diff">` の読み取り専用表示で見せる簡易実装で
  よい。DiffEditor の本格的な2ペイン表示は Phase2b で検討、と TODO コメントを残す)。

### 2.5 Agent E(ファイル操作 + fs 監視)

```
src-tauri/src/commands/fs.rs への追記(新規コマンドのみ追加、既存 read_dir/read_file/write_file
  のシグネチャは変更しない)
src-tauri/src/fswatch/mod.rs(新規)
src/components/explorer/ の FileTreeItem.tsx / FileExplorer.tsx への追記(コンテキストメニュー・
  D&D)、explorer.css への追記
src/state/workspaceStore.ts への追記(新規コマンド呼び出し・fs 監視イベント購読)
```

- Rust `commands/fs.rs` に追加: `create_file(path: String) -> Result<(), String>`
  (`std::fs::File::create_new` 相当。既に存在する場合はエラー)、
  `create_dir(path: String) -> Result<(), String>`、
  `rename_path(from: String, to: String) -> Result<(), String>`、
  `delete_to_trash(path: String) -> Result<(), String>`(`trash::delete`)、
  `move_path(from: String, to: String) -> Result<(), String>`(D&D 移動。ディレクトリ跨ぎの
  移動は `std::fs::rename` が失敗する場合(別ドライブ等)、コピー+削除にフォールバック)。
- `fswatch/mod.rs`: `#[tauri::command] pub fn watch_dir(app, state, path: String) -> Result<(), String>`
  (`notify::recommended_watcher` で `path` 直下のみ監視(`RecursiveMode::NonRecursive`。
  ツリーは遅延展開なので展開済みディレクトリだけ個別に watch する設計。既存の
  `workspaceStore.toggleDir` が呼ぶ `loadDir` のタイミングで併せて `watch_dir` を呼ぶよう
  フロント側を変更する)。変更検知で `app.emit("fswatch://changed", { dir: path })` を送る。
  `#[tauri::command] pub fn unwatch_dir(state, path: String) -> Result<(), String>`
  (ディレクトリが折り畳まれた時に呼ぶ。監視ハンドルの生存期間を `HashMap<String, RecommendedWatcher>`
  で管理)。
- フロント: `FileTreeItem.tsx` に右クリックコンテキストメニュー(新規ファイル/新規フォルダ/
  名前変更/削除/コピー/切り取り/貼り付け 程度。クリップボード的な状態はストアに簡易実装)、
  D&D(`draggable` + `onDragStart`/`onDrop` で `move_path` 呼び出し)。
  `workspaceStore.ts` に `fswatch://changed` の購読を追加し、対象ディレクトリが `children` に
  ロード済みなら `loadDir` を再実行してツリーを自動更新する。

## 3. UI 配置

```
┌───────────────────────────────────────────────┐
│ ActivityBar │ SideBar(Explorer/Search/Git切替) │ MainArea │
│             │                                   │          │
├───────────────────────────────────────────────┤
│ TerminalPanel(下部ドック。Ctrl+` で開閉、ドラッグでリサイズ)│
├───────────────────────────────────────────────┤
│ StatusBar                                       │
└───────────────────────────────────────────────┘
```

- TerminalPanel は MainArea の下、StatusBar の上に配置。`layoutStore.terminalOpen` が
  false の間は高さ 0(レンダリングしない)。
- 色は全て既存の CSS 変数(`var(--xxx)`)を使う。新規変数が必要な場合(ターミナル固有の
  ANSI 色等)は各テーマファイル(`src/themes/{light,dark,paper}.ts`)に追記してよいが、
  **Agent B がテーマファイルを直接編集するのではなく**、`--terminal-ansi-*` のような
  新規 CSS 変数を使う場合は Integrate 担当がテーマ3ファイルへ追記する
  (Phase1 の所有権ルールを踏襲: テーマファイルは他 Phase のエージェントが乱雑に触らない)。
  簡略化のため、Agent B は当面 ANSI カラーを xterm.js のデフォルトパレットのまま使い、
  背景/前景色のみ `--app-bg`/`--fg` に合わせる実装で可(TODO: Phase2b で ANSI 配色の
  テーマ統合)。

## 4. 完了条件(Definition of Done)

1. `cargo check` / `npm run build` がエラー0で成功
2. `npm run tauri dev` でウィンドウが起動し、Phase1/3a の既存機能(エディタ・テーマ・AI パネル)
   が退行していないこと
3. Ctrl+` でターミナルが開き、シェルが起動してコマンド実行・出力表示ができる
4. Ctrl+Shift+F で検索パネルが開き、ワークスペース内のテキスト検索結果が一覧表示され、
   クリックでエディタにジャンプできる
5. Git リポジトリを開いている場合、Git パネルに変更ファイル一覧・ブランチ名が表示され、
   stage → コミットメッセージ入力 → コミットの一連が実行できる
6. エクスプローラで右クリックから新規ファイル作成・リネーム・削除(ゴミ箱)ができ、
   外部でファイルを追加/削除した際にツリーが自動更新される(fs 監視)
