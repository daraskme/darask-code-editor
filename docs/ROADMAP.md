# Darask Code Editor — ロードマップ

> Phase 1 が本セッションの実装対象。各 Phase は「動く状態」で完結させる。

## Phase 1 — エディタコア(MVP)【今回】

- [ ] Tauri 2 + React + TS + Vite scaffold(Windows で `tauri dev` 起動)
- [ ] Monaco エディタ統合(マルチカーソル・ミニマップ・検索置換は Monaco 標準で有効)
- [ ] フォルダを開く(ネイティブダイアログ)+ ファイルエクスプローラ(遅延読み込みツリー)
- [ ] タブ(複数ファイル、dirty マーク、Ctrl+W で閉じる)
- [ ] 保存(Ctrl+S)
- [ ] テーマ 3 種: darask-light(白)/ darask-dark(黒)/ darask-paper(古紙コーヒー)
- [ ] JetBrains Mono 同梱・デフォルト適用
- [ ] コマンドパレット(Ctrl+Shift+P)+ Quick Open(Ctrl+P)
- [ ] ステータスバー(カーソル位置・言語・テーマ切替)
- [ ] サイドバー切替(Ctrl+B)

## Phase 2 — シェル機能

前倒し方針は Phase 3a と同じ: 日常編集作業に効くものを先に実装する(`docs/PHASE2-SPEC.md`)。

### Phase 2a(前倒し実装対象)
- 統合ターミナル(xterm.js + portable-pty、複数タブ)
- 全文検索(ignore + grep-searcher、検索サイドバー)
- Git 基本(status・ブランチ表示・stage/commit・diff 表示)
- ファイル操作(新規・リネーム・削除(ゴミ箱)・D&D)、fs 監視(notify)

### Phase 2b(先送り)
- 設定システム(settings.json + GUI、キーバインドカスタマイズ)
- エディタ本体への Git diff ガター表示
- エディタ分割、ツリー/リスト仮想化、セッション復元
- ターミナルの ANSI 配色をテーマ3種に正式統合

## Phase 3 — AI 統合(本命)

- ACP クライアント実装(Rust でサブプロセス管理、JSON-RPC 中継)
  - Claude Code(`@zed-industries/claude-code-acp`)
  - Codex(ACP アダプタ or `codex exec --json`)
  - エージェントパネル: ストリーミング表示・ツール承認 UI・差分プレビュー・チェックポイント
- プロバイダ層: Anthropic / OpenAI / OpenRouter / Cloudflare Workers AI
  - OpenRouter: API キー + OAuth PKCE ログイン
  - Cloudflare: Account ID + API Token(OpenAI 互換エンドポイント)
  - keyring による安全な保管、接続テスト UI
- ロールベースルーティング(architect / reviewer / coder / fast)
  - Plan → Code → Review パイプライン(モデル横断オーケストレーション)
- チャットパネル(ファイル・選択範囲のコンテキスト添付)
- インラインアシスト(Ctrl+K: 選択範囲を指示で書き換え、diff 承認)
- **使用量・クォータダッシュボード**(AI-DESIGN.md 7 章)
  - Claude / Codex / OpenRouter / Cloudflare の使用トークン・クレジット・5時間/週間/月間制限・
    無料枠の消費と残りを一画面で表示(ステータスバー常時ゲージ + Ctrl+Shift+U)
  - 全 AI リクエストのローカル使用量記録(SQLite)を土台に、各プロバイダ API で補強

## Phase 4 — プロ機能

- LSP クライアント(rust-analyzer, tsserver, pyright など。補完・定義ジャンプ・診断)
- AI インライン補完(ghost text、FIM 対応モデル)
- デバッグ(DAP)
- 拡張ポイント(テーマ・言語文法の追加、WASM プラグイン検討)
- クロスプラットフォームビルド(macOS / Linux)・自動アップデート

## マイルストーン判定

- P1 完了 = `npm run tauri dev` でフォルダを開いて編集・保存でき、3 テーマが切り替わる
- P2 完了 = ターミナルと検索だけで日常編集作業が完結する
- P3 完了 = エディタ内で Claude Code に実装させ、レビューを別モデルに依頼できる
- P4 完了 = VSCode から乗り換えても主要ワークフローが崩れない
