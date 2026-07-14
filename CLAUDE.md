# Darask Code Editor

Tauri 2 + React + TypeScript + Monaco 製の AI コードエディタ。
Zed のようにエディタ内で AI エージェント(Claude Code / Codex)を使い、
OpenRouter / Cloudflare Workers AI をロールベースで使い分ける。

## 役割分担(このプロジェクトの開発体制)

- **Claude Fable 5**: アーキテクチャ決定・実装仕様の策定・コードレビュー(実装はしない)
- **Claude Sonnet 5**: 実装(`docs/PHASE1-SPEC.md` 等の実装契約に厳密に従う)

## 必読ドキュメント

- `docs/ARCHITECTURE.md` — 技術スタックと構成の決定事項
- `docs/ROADMAP.md` — Phase 計画と完了条件
- `docs/AI-DESIGN.md` — AI 統合(ACP / Provider / ルーティング)の実装契約
- `docs/PHASE1-SPEC.md` — Phase 1 の実装契約(ファイル所有権・型・UI 仕様)

## 環境(Windows)

- Node は **`%USERPROFILE%\.local\node`** にある(PATH 未登録)。シェル実行時は必ず:
  - PowerShell: `$env:Path = "$env:USERPROFILE\.local\node;$env:Path"`
  - Bash: `export PATH="$HOME/.local/node:$PATH"`
- Rust: rustup 標準(cargo は PATH にある)

## コマンド

- `npm run dev` — Vite 単体(ブラウザで UI 確認。Tauri API は無効)
- `npm run tauri dev` — アプリ起動
- `npm run build` — tsc + vite build(検証必須)
- `cd src-tauri && cargo check` — Rust 検証

## 規約

- TypeScript strict、`any` 禁止
- 色は必ず CSS 変数(`var(--xxx)`)。ハードコード禁止(テーマ 3 種: light / dark / paper)
- ホットパス(fs・検索・git・pty)は Rust 側に実装する
- API キー等のシークレットは keyring のみ。設定ファイル・localStorage 禁止
- エディタのデフォルトフォントは JetBrains Mono(public/fonts/ に同梱)
