# Phase 3a 実装仕様(前倒し: ACP + Provider + Usage Dashboard)

> 策定: Fable 5 / 実装: Sonnet 5 エージェント。**この契約からの逸脱は禁止**。
> 本書は docs/AI-DESIGN.md の設計を、今回の前倒しスコープに絞って実装可能な形に具体化したもの。
> 曖昧な点は最も単純な解釈を選び、TODO コメントを残すこと。

## 0. 今回のスコープ(前倒し対象)

ユーザー要望: 「ACP で Claude Code 接続 → プロバイダ層(OpenRouter/Cloudflare)→ 使用量ダッシュボード」

含む: ACP クライアント(Claude Code 接続。Codex も同じコードパスで動くが検証対象は Claude Code)、
OpenRouter/Cloudflare Provider(APIキーのみ。OAuth PKCE ログインは対象外)、使用量ダッシュボード。

**含まない(Phase 3b 以降に先送り)**: Anthropic/OpenAI 直叩き Provider、OpenRouter OAuth PKCE ログイン、
Plan→Code→Review パイプライン UI、インラインアシスト(Ctrl+K)、未保存バッファと ACP fs 呼び出しの連携
(Phase 3a はディスク直読み書きで簡略化。TODO コメント必須)、ターミナル(`terminal/*` は capabilities で
unsupported を明示)。

## 0.1 事実確認済み事項(2026-07-14 時点。実装時にこれらを疑って調べ直さないこと)

- ACP は **改行区切り JSON-RPC 2.0 over stdio**(Content-Length ヘッダーではない)。1 行 = 1 JSON メッセージ。
- Claude Code 用 ACP アダプタ: npm パッケージ `@agentclientprotocol/claude-agent-acp`(bin: `claude-agent-acp`)。
  旧 `@zed-industries/claude-code-acp` は deprecated(非推奨、改名済み)。**旧パッケージ名を使わないこと**。
- Codex 用 ACP アダプタ: npm パッケージ `@agentclientprotocol/codex-acp`(bin: `codex-acp`)。
- OpenRouter: `POST https://openrouter.ai/api/v1/chat/completions`(OpenAI 互換、`stream: true` で SSE)、
  `GET https://openrouter.ai/api/v1/key`(レート制限・使用量)、`GET https://openrouter.ai/api/v1/credits`
  (`total_credits` / `total_usage`)、`GET https://openrouter.ai/api/v1/models`。認証は `Authorization: Bearer <key>`。
- Cloudflare Workers AI: `POST https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1/chat/completions`
  (OpenAI 互換、`Authorization: Bearer <api_token>`)。無料枠 10,000 Neurons/日(UTC 0 時リセット)。
  Analytics は `POST https://api.cloudflare.com/client/v4/graphql`(データセット `aiInferenceAdaptiveGroups`。
  **具体的な集計フィールド名は実装時に GraphQL イントロスペクション(`{ __schema { ... } }`)で確認すること**)。
- Rust クレート版数(crates.io 2026-07-14 時点の最新安定版。Cargo.toml は `^` 指定で可):
  `reqwest 0.13`(features: `json`, `stream`)、`rusqlite 0.40`(features: `bundled`)、`keyring 4.1`
  (features: `windows-native-keyring-store` — Windows 専用ビルドのため必須)、`tokio 1.52`
  (features: `process`, `io-util`, `rt-multi-thread`, `macros`, `sync`)。
- Tauri 2 でフロントへイベント送出するには `use tauri::Emitter;` を import し `app_handle.emit(event, payload)`
  を呼ぶ(`emit_all` ではない)。State 内で await をまたぐロックには `tokio::sync::Mutex` を使う
  (`std::sync::Mutex` は async fn 内で await をまたいで保持すると危険)。

## 1. 依存追加

### 1.1 src-tauri/Cargo.toml に追加

```toml
[dependencies]
reqwest = { version = "0.13", features = ["json", "stream"] }
rusqlite = { version = "0.40", features = ["bundled"] }
keyring = { version = "4.1", features = ["windows-native-keyring-store"] }
tokio = { version = "1", features = ["process", "io-util", "rt-multi-thread", "macros", "sync"] }
futures-util = "0.3"
tokio-util = { version = "0.7", features = ["io"] }
```

フロントエンドは新規 npm パッケージ追加なし(既存 `@tauri-apps/api` の `invoke` / `listen` のみで足りる)。

## 2. Rust 側モジュール構成とファイル所有権

各ファイルの「所有エージェント」を明記。**自分の所有ファイル以外は編集禁止**(読むのは自由)。
`src-tauri/src/lib.rs` と `src-tauri/Cargo.toml` は **Agent A(scaffold)のみ**が編集する
(他エージェントは「lib.rs にこの関数を登録してほしい」という前提でコードを書き、実際の登録は
Agent A が行う。関数シグネチャは本書の記載通りに実装すること)。

### 2.1 Agent A(scaffold: Rust 基盤 + フロント統合口)

```
src-tauri/Cargo.toml(依存追加)
src-tauri/src/lib.rs(全 invoke_handler 登録、AppState 定義、tokio Mutex 管理)
src-tauri/src/secrets.rs(keyring ラッパ)
src-tauri/src/commands/mod.rs(サブモジュール re-export)
src/state/aiStore.ts(AI パネル開閉・アクティブタブ・アクティブセッション ID などの薄い UI 状態)
src/components/ai/AiPanel.tsx(右サイドパネルの外枠。タブ: エージェント / 使用量)
src/lib/tauriEvents.ts(listen() の型安全ラッパ)
既存ファイルへの追記(所有権は維持しつつ配線のみ): src/App.tsx(AiPanel マウント、
  'ai.usageDashboard' コマンド登録 + Ctrl+Shift+U キーバインド)、
  src/components/layout/ActivityBar.tsx(AI アイコンを enabled に変更し、
  クリックで aiStore の openPanel をトグル)、src/lib/keybindings.ts(Ctrl+Shift+U 追加)
```

#### secrets.rs 契約

```rust
// service = "darask", user = format!("provider:{id}") 形式で keyring::Entry を使う
#[tauri::command]
pub fn has_secret(id: String) -> bool
#[tauri::command]
pub fn set_secret(id: String, value: String) -> Result<(), String>
#[tauri::command]
pub fn delete_secret(id: String) -> Result<(), String>
// 値そのものを返す get_secret はフロント向け invoke コマンドとしては公開しない(値はRust内部でのみ使用)。
// Rust 内部の他モジュールから呼ぶための非 tauri::command な get_secret(id: &str) -> Result<String, String> も用意する。
```

#### lib.rs 契約(Agent A が全体を統括)

- `AppState { acp: tokio::sync::Mutex<AcpManagerState>, usage_db: tokio::sync::Mutex<rusqlite::Connection> }`
  を `.manage(AppState { .. })` する。
- `invoke_handler` に fs 系(既存)+ secrets 系 + acp 系(2.2 節)+ providers 系(2.3 節)+
  usage 系(2.4 節)の全コマンドを登録する。
- アプリ起動時(`setup` フック)に usage.db を `app_handle.path().app_data_dir()` 配下に作成・
  マイグレーション実行。

### 2.2 Agent B(ACP クライアント)

```
src-tauri/src/acp/mod.rs
src-tauri/src/acp/protocol.rs   -- JSON-RPC 型定義(serde)
src-tauri/src/acp/manager.rs    -- プロセス管理・フレーミング・相関
src-tauri/src/acp/agents_config.rs -- agents.json 読み書き(既定2件を同梱)
```

- **フレーミング**: 子プロセスの stdout を `tokio::io::BufReader` + `lines()` で1行ずつ読み、
  各行を `serde_json::from_str` でパース。送信も1メッセージ1行 + `\n` で stdin に書き込む。
  **Content-Length ヘッダーは付けない**。
- JSON-RPC リクエスト ID はプロセス単位のインクリメンタル `u64`。送信した ID をペンディング
  `HashMap<u64, oneshot::Sender<Value>>` で管理し、応答受信時に対応する oneshot へ send して相関する。
- エージェントからの逆方向リクエスト(`session/request_permission`, `fs/read_text_file`,
  `fs/write_text_file`)はエージェント視点でのリクエストなのでこちらが JSON-RPC レスポンスを返す
  必要がある。`fs/*` は Phase3a では `std::fs` に直接読み書きして即座に応答してよい
  (`// TODO(Phase3b): エディタの未保存バッファ(editorStore)と連携する` を残すこと)。
  `session/request_permission` は Tauri イベント `acp://permission-request` でフロントへ転送し、
  フロントからの応答を待つ(`oneshot` で待機、フロント側は専用コマンド `acp_respond_permission` で解決)。
- `initialize` の capabilities: `{ fs: { readTextFile: true, writeTextFile: true }, terminal: false }` を送る。
- 公開 Tauri コマンド(すべて `#[tauri::command] async fn`、State は `tauri::State<'_, AppState>`):

```rust
pub async fn acp_list_agents(state) -> Result<Vec<AgentConfig>, String>          // agents.json 読み込み
pub async fn acp_start_session(state, app: AppHandle, agent_id: String, cwd: String) -> Result<String, String>
  // 起動済みでなければ子プロセス spawn + initialize + session/new。戻り値は session_id。
  // 以後の session/update 等は app.emit(&format!("acp://{session_id}/update"), payload) で転送。
pub async fn acp_send_prompt(state, session_id: String, text: String) -> Result<(), String>
pub async fn acp_cancel(state, session_id: String) -> Result<(), String>
pub async fn acp_respond_permission(state, request_id: String, option_id: String) -> Result<(), String>
pub async fn acp_close_session(state, session_id: String) -> Result<(), String>
```

- エージェント起動失敗(`npx` が見つからない、パッケージ未取得等)は `Err(String)` で理由を返す。
  フロント側でエラーメッセージ + 「インストールコマンドをコピー」導線を表示できるよう、
  エラー文字列に実行しようとしたコマンドを含めること。

### 2.3 Agent C(Provider 層: OpenRouter / Cloudflare)

```
src-tauri/src/providers/mod.rs      -- ChatProvider トレイト定義、共通 SSE パースヘルパ
src-tauri/src/providers/openrouter.rs
src-tauri/src/providers/cloudflare.rs
```

- 共通トレイト:

```rust
#[derive(serde::Deserialize)]
pub struct ChatMessage { pub role: String, pub content: String }

#[derive(serde::Deserialize)]
pub struct ChatRequest { pub provider: String, pub model: String, pub messages: Vec<ChatMessage> }

pub trait ChatProvider {
    async fn chat_stream(&self, req: &ChatRequest, on_delta: impl FnMut(String) + Send)
        -> Result<ChatUsage, String>;
    async fn list_models(&self) -> Result<Vec<ModelInfo>, String>;
}
```

  実装は trait object にせず、`ai_chat_stream` コマンド内で `match provider_id { "openrouter" => ..., "cloudflare" => ... }`
  で分岐する具体実装呼び出しでよい(Phase3a はプロバイダ2種のみのため過剰な抽象化をしない)。

- SSE パース共通ヘルパ: `reqwest::Response::bytes_stream()` を `\n\n` 区切りでバッファし、
  各イベントの `data: ` 行を取り出す。`data: [DONE]` で終了。JSON パースして
  OpenAI 互換の `choices[0].delta.content` を `on_delta` に渡す。usage は最終チャンクまたは
  `stream_options: {"include_usage": true}` を リクエストに含めて取得(OpenRouter は
  `usage: { include: true }` を body に追加すると最終チャンクに usage が乗る)。

- 公開 Tauri コマンド:

```rust
#[tauri::command]
pub async fn ai_chat_stream(app: AppHandle, state, stream_id: String, req: ChatRequest) -> Result<(), String>
  // ストリーミング中は app.emit(&format!("ai://{stream_id}/delta"), text_chunk)
  // 完了時に app.emit(&format!("ai://{stream_id}/done"), ChatUsage) し、usage を usage.rs の
  // insert_usage_event 経由で記録する(Agent D の関数を呼ぶ。シグネチャは 2.4 節参照)。

#[tauri::command]
pub async fn ai_list_models(provider: String) -> Result<Vec<ModelInfo>, String>

#[tauri::command]
pub async fn ai_test_connection(provider: String) -> Result<bool, String>
  // list_models 相当を1回呼んで成否のみ返す(設定 UI の「接続テスト」用)

#[tauri::command]
pub async fn openrouter_key_info() -> Result<OpenRouterKeyInfo, String>   // GET /api/v1/key
#[tauri::command]
pub async fn openrouter_credits() -> Result<OpenRouterCredits, String>   // GET /api/v1/credits
```

  API キーは `secrets::get_secret("provider:openrouter")` / `"provider:cloudflare_token"` から取得。
  Cloudflare は account_id も必要なため `"provider:cloudflare_account_id"` を平文設定(機密でないため
  Rust 側の小さな JSON 設定ファイルでよい。keyring には token のみ入れる)。
  モデル一覧が取れないプロバイダ(Cloudflare は OpenAI 互換エンドポイントに listModels 相当が
  未確認のため)は既知モデル ID の小さな静的リストをフロントの候補表示用に用意し、
  自由入力も許可する(嘘のエンドポイントを叩かない)。

### 2.4 Agent D(使用量レコーダ + ダッシュボードデータ)

```
src-tauri/src/usage/mod.rs
src-tauri/src/usage/store.rs        -- rusqlite スキーマ・insert・集計クエリ
src-tauri/src/usage/cloudflare_analytics.rs  -- GraphQL 経由の Neurons 取得
src-tauri/src/usage/claude_code_local.rs     -- ~/.claude/projects/**/*.jsonl 解析
```

- スキーマ: `usage_events(id INTEGER PRIMARY KEY, ts TEXT, provider TEXT, model TEXT, role TEXT,
  input_tokens INTEGER, output_tokens INTEGER, cost_usd REAL, kind TEXT)`。`ts` は ISO8601 UTC。
- `pub fn insert_usage_event(conn: &Connection, ev: &UsageEvent) -> Result<(), String>`
  (Agent C の `ai_chat_stream` と Agent B の ACP セッション完了時から呼ばれる。関数シグネチャは
  この形で固定し、他エージェントはこれをそのまま import して使う)。
- 集計コマンド:

```rust
#[tauri::command]
pub async fn usage_summary(state) -> Result<Vec<UsageSnapshot>, String>
  // provider ごとに today/thisMonth の input/output tokens・cost_usd をローカル記録から集計。
  // OpenRouter は openrouter_credits/key_info の結果もマージ(Agent C の関数を呼ぶ)。
  // Cloudflare は cloudflare_analytics::fetch_today_neurons(account_id, token) の結果をマージ。
  // Claude Code は claude_code_local::estimate_5h_and_week_windows() の結果をマージ。
  // 個々の取得元が失敗しても他が返せるよう、部分失敗を UsageSnapshot.error に格納して握り潰さない。
```

- `claude_code_local.rs`: **Windows では `%USERPROFILE%\.claude\projects\**\*.jsonl`**
  (`dirs` クレート不要。`std::env::var("USERPROFILE")` で取得)配下の jsonl を新しい順に読み、
  各行の usage フィールド(`message.usage.input_tokens` 等、Claude Code の transcript 形式)を
  直近 5 時間・直近 7 日で集計する。ファイル形式の詳細が不明な箇所は保守的にスキップし
  panic させないこと(壊れた行は無視して継続)。推定値には `UsageWindow.label` に
  「(推定)」を含めるか、AI-DESIGN.md 7.1 の `source: 'local-logs'` を設定して出どころを明示する。
- `cloudflare_analytics.rs`: GraphQL クエリは実装前に `{ __schema { types { name } } }` 相当の
  イントロスペクションで `aiInferenceAdaptiveGroups` の実フィールドを確認してから集計クエリを書くこと
  (本書に書かれたデータセット名は確認済みだが、フィールド名は未確認のため)。
  確認できない場合は無理に実装せず `Err` を返し、フロントは「取得不可・ローカル推定のみ表示」に
  フォールバックすること(嘘の値を出さない)。

## 3. フロントエンド構成とファイル所有権

### 3.1 Agent E(Provider 設定 UI)

```
src/components/settings/AiSettingsPanel.tsx
src/components/settings/ProviderKeyRow.tsx
src/components/settings/settings.css
src/state/providerStore.ts
```

- `providerStore.ts`: `{ providers: Record<'openrouter'|'cloudflare', { configured: boolean }>,
  refreshStatus(): Promise<void>(has_secret を呼ぶ), saveKey(id, value): Promise<void>,
  testConnection(id): Promise<boolean> }`。
- UI: OpenRouter は API キー入力1つ。Cloudflare は Account ID + API Token の2入力。
  「接続テスト」ボタンで `ai_test_connection` invoke → 成否をトースト的に表示(簡易 `<span>` で可、
  トーストコンポーネントは Phase3a では作らない)。
- AiSettingsPanel は AiPanel.tsx(Agent A 作成)の「設定」タブとして表示される想定。
  import パスは `../ai/AiPanel` からこのコンポーネントを参照する形(Agent A 側で配線)。

### 3.2 Agent F(ACP エージェントパネル: チャット・ツール承認・diff)

```
src/components/ai/agent/AgentSessionView.tsx
src/components/ai/agent/MessageStream.tsx
src/components/ai/agent/ToolCallCard.tsx
src/components/ai/agent/PermissionPrompt.tsx
src/components/ai/agent/DiffPreview.tsx
src/components/ai/agent/agent.css
src/state/acpStore.ts
src/lib/acp.ts
```

- `src/lib/acp.ts`: invoke ラッパ(`listAgents`, `startSession`, `sendPrompt`, `cancel`,
  `respondPermission`, `closeSession`)+ `tauriEvents.ts`(Agent A 作成)経由で
  `acp://{sessionId}/update` を購読するヘルパ `subscribeSessionUpdates(sessionId, onEvent)`。
- `acpStore.ts`: セッション一覧・各セッションのメッセージ/ツールコール配列・保留中の
  permission request 一覧を保持。`session/update` の variant(`agent_message_chunk` は
  末尾に追記、`tool_call`/`tool_call_update` は id で upsert、`plan` はそのまま保持)。
- `PermissionPrompt.tsx`: 保留中の permission request をカードで表示し、agent から届いた
  `options` 配列をそのままボタン化(ハードコードしない)。選択で `respondPermission` を呼ぶ。
- `DiffPreview.tsx`: ツールコールの content に diff/ファイル内容が含まれる場合、
  `@monaco-editor/react` の `DiffEditor` で before/after を表示(読み取り専用)。
  Phase3a では「承認 = fs 書き込み側で既に適用済みであることの可視化」に留め、
  適用前プレビュー→承認→適用の順序制御(未保存バッファとの統合)は Phase3b の TODO とする。
- エージェント未起動時(セッションなし)は「エージェントを選択」プレースホルダ +
  `acp_list_agents` の結果からボタン一覧(claude-code / codex)を表示。

### 3.3 Agent G(使用量ダッシュボード + ステータスバー連携)

```
src/components/ai/usage/UsageDashboard.tsx
src/components/ai/usage/ProviderUsageCard.tsx
src/components/ai/usage/UsageGauge.tsx
src/components/ai/usage/usage.css
src/state/usageStore.ts
```

- `usageStore.ts`: `{ snapshots: UsageSnapshot[], loading: boolean, lastFetchedAt: string | null,
  refresh(): Promise<void>(usage_summary を invoke) }`。ダッシュボード表示中は 60 秒毎に
  `refresh()` を呼ぶ `setInterval`(コンポーネント unmount で clearInterval)。
  バックグラウンドポーリングはしない(AI-DESIGN.md 7.4 の方針通り)。
- `UsageGauge.tsx`: 最も逼迫しているウィンドウ(`usedPercent` 最大)を選んで
  コンパクト表示。80% で `--warning`、95% で `--error` 色。
  **このコンポーネントを StatusBar.tsx に追加する配線は Agent A が行う**
  (Agent G は UsageGauge.tsx を作るだけで、StatusBar.tsx 自体は編集しない)。
- `ProviderUsageCard.tsx`: プラン名 / ウィンドウ横バー(5時間・週間・月間・無料枠)/
  クレジット残高 / 今日・今月のトークンと推定コスト / 出どころバッジ(API・ローカル推定)/
  最終更新時刻。取得エラー時は stale 表示 + 再取得ボタン。
- コマンド `ai.usageDashboard`(Ctrl+Shift+U)は Agent A が App.tsx に登録し、
  `aiStore` の状態を「AI パネルを開く + 使用量タブをアクティブにする」に設定する。

## 4. 完了条件(Definition of Done)

1. `cargo check`(src-tauri)が成功(新規クレート込み)
2. `npm run build` が tsc エラー 0 で成功
3. `npm run tauri dev` でウィンドウが起動し、AI アイコンでパネルが開く
4. 設定タブで OpenRouter / Cloudflare の入力欄が表示され、保存後に `has_secret` で
   configured 状態が反映される(実キーでの実通信検証は必須ではないが、キーを1つ設定できる
   環境があれば `ai_test_connection` が実際に成功することを確認する)
5. エージェントタブに claude-code / codex がリスト表示され、
   `npx -y @agentclientprotocol/claude-agent-acp --version` 相当が実行可能な環境であれば
   セッション開始 → プロンプト送信 → ストリーミング表示が一通り動く
   (実行不能環境では「起動失敗」が正しくエラー表示されることを確認すれば可)
6. 使用量タブが空データでもクラッシュせず描画され、いずれかのプロバイダにキーがあれば
   実データ(またはローカル推定)が表示される
7. Phase 1 の DoD(3 テーマ・エディタ・保存等)を退行させていないこと
