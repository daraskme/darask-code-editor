# Darask Code

[![CI](https://github.com/daraskme/darask-code-editor/actions/workflows/ci.yml/badge.svg)](https://github.com/daraskme/darask-code-editor/actions/workflows/ci.yml)

Darask Code は、Tauri 2・React・TypeScript・Monaco Editor で作る Windows 向けデスクトップコードエディタです。現在はベータ段階です。

## できること

- ワークスペースを開き、Explorer からファイル・フォルダーを操作
- Monaco Editor によるシンタックスハイライト、複数タブ、Quick Open
- ライト・ダーク・ペーパーのテーマ切り替え
- 未保存変更を保護するファイル操作と、Rust 側で制限したワークスペースアクセス
- AI プロバイダー／エージェント連携の基盤

## ベータ版を入手する

Windows 10 / 11 x64 を対象にしています。最新のベータ版は [Releases](https://github.com/daraskme/darask-code-editor/releases) から取得できます。

- `Darask-Code-…-setup.exe`: NSIS インストーラー
- `Darask-Code-…-portable.exe`: インストール不要のポータブル版

現在のベータビルドはコード署名されていないため、Windows SmartScreen の警告が表示されることがあります。必ずこのリポジトリの Releases から取得してください。

## 開発

必要環境: Node.js 22 以降、Rust stable、Windows 10 / 11。

```powershell
npm ci
npm run tauri dev
```

検証コマンド:

```powershell
npm run build
Set-Location src-tauri
cargo fmt --all -- --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test
```

## リリース手順

`main` への push と pull request では GitHub Actions がフロントエンドのビルド、Rust の整形・lint・テストを実行します。

ベータ版を公開するには、バージョンを更新して `v0.1.0-beta.1` のようなタグを push します。Release ワークフローが Windows x64 の NSIS インストーラーとポータブル EXE を GitHub Releases の prerelease として公開します。

ライセンスはまだ指定していません。利用・再配布条件は別途明記する予定です。
