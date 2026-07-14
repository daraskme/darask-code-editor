# Darask Code Editor — アーキテクチャ設計書

> 策定: Claude Fable 5(アーキテクト/レビュアー)/ 実装: Claude Sonnet 5
> 最終更新: 2026-07-14

## 1. ビジョン

Zed のようにエディタ内で AI エージェント(Claude Code / Codex)をネイティブに使え、
Cloudflare Workers AI / OpenRouter を API キーまたはログインで利用できる、
**とにかく高速な** AI コードエディタ。VSCode の主要機能を網羅する。

差別化の核は **ロールベースのモデルルーティング**:
- 設計・レビュー役(architect / reviewer)→ 高知能モデル(Claude Fable 5, GPT-5.6 sol など)
- 実装役(coder)→ 高速・安価なコーディングモデル(GLM 5.2, Kimi 2.7 など)
を設定で割り当て、Plan → Code → Review のパイプラインをエディタ内で回す。

## 2. 技術スタック(決定事項)

| レイヤ | 選定 | 理由 |
|---|---|---|
| アプリシェル | **Tauri 2**(Rust) | Electron 比で起動・メモリ・バイナリサイズが圧倒的に軽い。「とにかく高速」の要件に合致。Windows は WebView2 |
| フロントエンド | **React 18 + TypeScript(strict)+ Vite** | エコシステムが最大で AI エージェントによる実装・保守が最も安定する |
| 状態管理 | **Zustand** | ボイラープレート最小、セレクタで再レンダリング制御が容易 |
| エディタコア | **Monaco Editor** | VSCode 本体のエディタ。マルチカーソル・ミニマップ・検索置換・diff・折りたたみ等「VSCode にある機能」を最短で網羅 |
| ターミナル | **xterm.js + portable-pty(Rust)** | Phase 2 |
| 全文検索 | **ripgrep**(Rust 側 `grep` クレート or サイドカー) | Phase 2 |
| Git | **git2-rs** + CLI 併用 | Phase 2 |
| シークレット保管 | **keyring クレート**(Windows Credential Manager) | API キーを平文設定ファイルに置かない |
| フォント | **JetBrains Mono**(同梱、デフォルト) | 要件 |

### なぜ Zed 本体のような GPU ネイティブ UI にしないか
Zed(GPUI)級の描画性能は魅力だが、UI フレームワークの自作は工数が桁違い。
Tauri + Monaco は「体感高速」と「VSCode 機能網羅」と「AI エージェントで開発を回せる保守性」の
最適バランス。ホットパス(検索・fs・pty・git)はすべて Rust 側に置くことで速度を確保する。

## 3. プロセス構成

```
┌───────────────────────────────────────────────┐
│ Tauri (Rust) メインプロセス                     │
│  - fs コマンド(read_dir / read_file / write) │
│  - ripgrep 検索, git, pty                      │
│  - ACP エージェントのサブプロセス管理・中継     │
│  - keyring(シークレット)                     │
└──────────────┬────────────────────────────────┘
               │ invoke / event (IPC)
┌──────────────┴────────────────────────────────┐
│ WebView (React + Monaco)                       │
│  - レイアウト / エクスプローラ / タブ / パレット│
│  - AI パネル(チャット・エージェント・インライン)│
└───────────────────────────────────────────────┘
外部サブプロセス(Rust 側が spawn・stdio 中継):
  claude-code-acp(Claude Code) / codex acp(Codex) / 任意の ACP エージェント
```

## 4. AI 統合(概要 — 詳細は AI-DESIGN.md)

2 系統を明確に分離する:

1. **エージェント系(ACP)** — Zed 発の Agent Client Protocol(JSON-RPC over stdio)で
   Claude Code・Codex をサブプロセスとして接続。ツール実行承認・差分プレビュー・
   ファイル編集をエディタ UI に統合。「Zed のように使える」の実体。
2. **プロバイダ系(直接 API)** — Anthropic / OpenAI / OpenRouter / Cloudflare Workers AI を
   統一 `ChatProvider` インターフェースで抽象化。チャットパネル・インラインアシスト・
   ロールベースルーティングのバックエンド。OpenRouter は OAuth PKCE ログインにも対応。

## 5. ディレクトリ構成

```
darask-code-editor/
├─ CLAUDE.md               # エージェント向けプロジェクト規約
├─ docs/                   # 設計文書(本書ほか)
├─ public/fonts/           # JetBrains Mono (woff2) + OFL ライセンス
├─ src/                    # フロントエンド
│  ├─ main.tsx / App.tsx
│  ├─ components/
│  │  ├─ layout/           # ActivityBar, SideBar, StatusBar, MainArea
│  │  ├─ explorer/         # ファイルツリー
│  │  ├─ editor/           # EditorPane, EditorTabs, WelcomeView
│  │  ├─ palette/          # CommandPalette, QuickOpen
│  │  ├─ terminal/         # Phase 2
│  │  └─ ai/               # Phase 3
│  ├─ state/               # Zustand ストア(ui / workspace / editor)
│  ├─ themes/              # テーマ定義(light / dark / paper)+ Monaco テーマ
│  ├─ lib/                 # fs ラッパ, commands, keybindings, monacoSetup
│  ├─ styles/              # global.css, fonts.css
│  └─ types/
└─ src-tauri/              # Rust バックエンド
   ├─ tauri.conf.json
   └─ src/ (main.rs, lib.rs, commands/)
```

## 6. テーマシステム

- CSS 変数ベース。`Theme = { id, label, kind, cssVars, monaco }`。
- `applyTheme()` が `<html data-theme>` + CSS 変数 + `monaco.editor.setTheme` を同時切替、localStorage に永続化。
- 組み込み 3 テーマ(初期実装必須):
  - `darask-light` — 白背景
  - `darask-dark` — 黒背景
  - `darask-paper` — 古い紙・薄いコーヒー色(セピア)背景
- エディタフォントは JetBrains Mono をデフォルトとして同梱(ライセンス: SIL OFL)。

## 7. パフォーマンス原則

1. ホットパス(fs 列挙・検索・git status・pty)は必ず Rust 側で実行する。
2. ファイルツリーは遅延読み込み(展開時に `read_dir`)。大規模リポでも初期表示を止めない。
3. Monaco のモデルはタブごとに保持し、切替はモデルスワップ(再パース回避)。
4. Zustand はセレクタ購読で再レンダリングを最小化。リスト系は仮想化(Phase 2 で react-window)。
5. AI ストリーミングはトークン到着ごとに直接バッファへ append(状態ツリー全体を更新しない)。
6. 起動時に重い処理をしない。ワークスペース復元は非同期。

## 8. セキュリティ原則

- API キー・トークンは keyring(Windows Credential Manager)のみ。設定 JSON・localStorage 禁止。
- ACP エージェントのツール実行は承認 UI を必須とする(auto-approve はユーザーが明示的に選んだ場合のみ)。
- Tauri の capability は最小権限。`shell` 系はエージェント・pty 用途に限定。

## 9. VSCode 機能パリティ方針

Monaco が持つもの(編集系)は無料で手に入る。シェル側で作るもの:
エクスプローラ / タブ / コマンドパレット / Quick Open / 全文検索 / ターミナル / Git UI /
設定(JSON + GUI)/ キーバインドカスタマイズ / 分割エディタ / LSP(Phase 4)/ デバッグ(Phase 4+)。
拡張機能は VSCode 互換 API を目指さず、**AI エージェント + LSP + タスク**を一級市民にする方針
(Zed と同じ割り切り)。ロードマップは ROADMAP.md 参照。
