# Darask — AI 統合設計書(Phase 3 実装契約)

> 策定: Claude Fable 5。Phase 3 の実装はこの契約に従うこと。

## 1. 全体像 — 2 系統アーキテクチャ

```
                    ┌─────────────────────────────┐
                    │        AI パネル (UI)         │
                    │  Agent / Chat / Inline Assist │
                    └───────┬──────────────┬───────┘
                            │              │
                 ┌──────────┴───┐   ┌──────┴───────────┐
                 │ ACP クライアント│   │ Provider レイヤ    │
                 │ (エージェント系) │   │ (直接 API 系)      │
                 └──────────┬───┘   └──────┬───────────┘
                            │              │
              Claude Code / Codex     Anthropic / OpenAI /
              (サブプロセス, stdio)    OpenRouter / CF Workers AI
```

- **ACP 系** = 自律エージェント。ファイル編集・コマンド実行・マルチターンのタスク遂行。
- **Provider 系** = ステートレスなチャット/補完 API。ルーティング・チャット・インラインアシスト用。

## 2. ACP(Agent Client Protocol)クライアント

### 2.1 プロトコル(2026-07 時点で実 API を確認済み)
- **JSON-RPC 2.0 over stdio。フレーミングは改行区切り(newline-delimited)**——
  LSP/MCP-stdio の Content-Length ヘッダー方式**ではない**。1 メッセージ = 1 行の UTF-8 JSON
  + `\n`。実装時にヘッダーフレーミングと混同すると即座に通信不能になるため要注意。
  仕様: https://agentclientprotocol.com
- 主要メソッド(`initialize` の `protocolVersion` は整数のメジャーバージョンのみ。
  クライアントが対応する最新版を送り、エージェントが対応できなければエージェント側が
  対応可能な最新版を返す):

| メソッド | 方向 | 用途 |
|---|---|---|
| `initialize` | client→agent | バージョン・capabilities 交渉、`authMethods` 取得 |
| `session/new` | client→agent | 作業ディレクトリ・MCP サーバ指定でセッション作成 |
| `session/prompt` | client→agent | ユーザーメッセージ送信 |
| `session/cancel` | client→agent | 実行中操作の中断 |
| `session/load` / `session/list` / `session/delete` | client→agent | セッション管理(Phase 3a では未使用可) |
| `authenticate` | client→agent | `authMethods` から選んだ方式で認証 |
| `session/update`(通知) | agent→client | ストリーミング本体。variant: `agent_message_chunk` /
  `agent_thought_chunk` / `plan` / `tool_call` / `tool_call_update` / `usage_update` |
| `session/request_permission` | agent→client | ツール実行前の承認要求。`options` 配列(id/name/kind)を
  エディタが提示し、選択された optionId を返す。**選択肢の具体的な kind 文字列は
  エージェント依存のため固定値でハードコードせず、options をそのまま描画すること** |
| `fs/read_text_file` / `fs/write_text_file` | agent→client | エディタ側 fs 提供(Phase 3a は
  ディスク直読み書き。未保存バッファ連携は Phase 3b で対応、TODO コメント必須) |
| `terminal/*` | agent→client | Phase 1 にターミナル未実装のため **capabilities で unsupported を明示**し
  エージェント側にフォールバックさせる(省略 = 非対応 が ACP の規約) |

- クライアント capabilities(`initialize` で送る): `fs.readTextFile: true`, `fs.writeTextFile: true`,
  `terminal: false`(Phase 1 未実装のため)。

### 2.2 プロセス管理(Rust 側)
- `AcpAgentManager` が各エージェントを子プロセス(`tokio::process::Command`、stdin/stdout を
  `Stdio::piped()`)として spawn し、改行区切り JSON-RPC を読み書きする。
  受信した `session/update` 等は Tauri イベント(`acp://{session_id}/update`)で中継する。
- 登録エージェント(設定で追加可能な `agents.json`。**パッケージ名は 2026-07 時点で実在確認済み**):

| ID | 起動コマンド | 備考 |
|---|---|---|
| `claude-code` | `npx -y @agentclientprotocol/claude-agent-acp`(bin: `claude-agent-acp`) | 旧 `@zed-industries/claude-code-acp` は非推奨(deprecated、改名済み)。ANTHROPIC_API_KEY または Claude Code CLI ログイン済み資格情報を利用 |
| `codex` | `npx -y @agentclientprotocol/codex-acp`(bin: `codex-acp`) | ChatGPT ログイン(`NO_BROWSER=1` で無効化可)/ `CODEX_API_KEY` or `OPENAI_API_KEY` |
| カスタム | 任意コマンド | Gemini CLI など ACP 対応エージェント全般 |

### 2.3 UI 要件
- エージェントパネル(右サイド、幅可変): セッションタブ、ストリーミング Markdown、
  ツール呼び出しカード(実行コマンド・ファイル diff を展開表示)、承認ボタン(許可/常に許可/拒否)。
- 差分は Monaco Diff Editor でプレビューし、適用前にユーザーが確認できる。
- 停止ボタン(`session/cancel`)。セッションはワークスペース単位で永続化。

## 3. Provider レイヤ

### 3.1 統一インターフェース(TypeScript)

```ts
interface ChatProvider {
  id: 'anthropic' | 'openai' | 'openrouter' | 'cloudflare';
  listModels(): Promise<ModelInfo[]>;
  chat(req: ChatRequest, onDelta: (d: Delta) => void, signal: AbortSignal): Promise<ChatResult>;
  // ChatRequest: { model, messages, system?, tools?, maxTokens?, temperature? }
  // Delta: { type: 'text' | 'tool_call' | 'usage', ... } — SSE ストリーミング必須
}
```

- 実送信は Rust 側 `ai_chat_stream` コマンド経由(CORS 回避・キー秘匿のため fetch は WebView から直接行わない)。
- レスポンスは Tauri イベントでトークン単位ストリーミング。

### 3.2 各プロバイダ

| プロバイダ | エンドポイント | 認証 |
|---|---|---|
| Anthropic | `https://api.anthropic.com/v1/messages` | `x-api-key` |
| OpenAI | `https://api.openai.com/v1/chat/completions` | Bearer |
| OpenRouter | `https://openrouter.ai/api/v1/chat/completions`(OpenAI 互換) | Bearer。**API キー** or **OAuth PKCE ログイン** |
| Cloudflare Workers AI | `https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1/chat/completions`(OpenAI 互換) | Bearer(API Token)+ Account ID |

**OpenRouter OAuth PKCE フロー**(「ログインして使える」の実体):
1. `code_verifier` 生成 → S256 で `code_challenge`
2. 既定ブラウザで `https://openrouter.ai/auth?callback_url=http://localhost:{port}/callback&code_challenge=...&code_challenge_method=S256` を開く
3. ローカル一時 HTTP サーバ(Rust)で `code` を受領
4. `POST https://openrouter.ai/api/v1/auth/keys` に `{ code, code_verifier, code_challenge_method }` → API キー取得
5. keyring に保存。以後は API キーと同じ扱い

### 3.3 シークレット管理
- Rust `keyring` クレート(service = `darask`, user = `provider:{id}`)。
- フロントには存在有無のみ返す(`has_key(provider) -> bool`)。キー本体は WebView に渡さない。
- 設定 UI: キー入力(paste)→ 接続テスト(`listModels`)→ 保存。

## 4. ロールベース・モデルルーティング

### 4.1 設定スキーマ(settings.json 内 `ai` セクション)

```jsonc
{
  "ai": {
    "roles": {
      "architect": { "provider": "anthropic",  "model": "claude-fable-5" },
      "reviewer":  { "provider": "anthropic",  "model": "claude-fable-5" },
      "coder":     { "provider": "openrouter", "model": "z-ai/glm-5.2" },
      "coder2":    { "provider": "openrouter", "model": "moonshotai/kimi-2.7" },
      "fast":      { "provider": "cloudflare", "model": "@cf/meta/llama-4-scout" }
    },
    "pipeline": { "plan": "architect", "implement": ["coder", "coder2"], "review": "reviewer" }
  }
}
```

- ロール名は自由に追加可。UI のモデルピッカーは「ロール」を第一選択肢、生モデル指定を第二とする。

### 4.2 Plan → Code → Review パイプライン(エディタ内オーケストレーション)

1. **Plan**: architect ロールがタスクを分解し、変更対象ファイルと手順を JSON で出力
2. **Code**: 手順ごとに coder ロールへ委譲(複数 coder の並列も可)。出力は unified diff /
   ファイル全文で受け、ワークスペースに適用前プレビュー
3. **Review**: reviewer ロールが diff をレビュー。指摘は「修正して再実行」or「無視」を選べる
4. 全段階でストリーミング表示・中断・やり直しが可能。各段階の使用モデルをカードに明示

※ ACP エージェント(Claude Code 等)を「implement」段に割り当てることも可能にする
(その場合 Plan の出力をプロンプトとして `session/prompt` に流す)。

## 5. インラインアシスト(Ctrl+K)

- 選択範囲 + 指示 → 既定ロール(`coder`)で書き換え、Monaco の inline diff で承認/破棄。
- コンテキスト: 対象ファイル全文 + カーソル周辺 + ユーザー指示。system prompt は
  「diff のみ返す」形式を強制し、パースは fenced code block 抽出で行う。

## 6. 実装順(Phase 3 内)

1. keyring + 設定スキーマ + プロバイダ設定 UI(接続テスト含む)
2. Rust `ai_chat_stream`(SSE パース、reqwest)+ ChatProvider 4 種 + **ローカル使用量記録(7.2)**
3. チャットパネル(ロール選択・コンテキスト添付)
4. OpenRouter OAuth PKCE
5. **使用量・クォータダッシュボード(7 章)**
6. ACP クライアント(Rust 中継 + パネル UI + 承認フロー)— Claude Code 接続
7. Codex 接続、インラインアシスト、パイプライン UI

## 7. 使用量・クォータダッシュボード(実装契約)

> 要件: Claude / Codex / OpenRouter / Cloudflare Workers AI の「使用トークン・クレジット・
> 5 時間制限・週間制限・月間制限・無料枠の消費と残り」が**一発で見てわかる**こと。

### 7.1 統一データモデル

```ts
type UsageUnit = 'tokens' | 'credits' | 'neurons' | 'requests' | 'percent' | 'usd';

interface UsageWindow {           // 「5時間」「週間」「月間」「無料枠(日次)」を全部これで表現
  id: string;                     // '5h' | 'week' | 'month' | 'free-daily' など
  label: string;                  // 表示名(例: '5時間枠', '週間', '無料枠(今日)')
  used: number;                   // 消費量
  limit: number | null;           // 上限(不明なら null → バー非表示で実数のみ)
  unit: UsageUnit;
  usedPercent: number | null;     // プロバイダが%のみ返す場合(Codex 等)は used/limit なしでこれだけ
  resetsAt: string | null;        // ISO 8601。UI は「あと2時間14分」形式で表示
}

interface UsageSnapshot {
  providerId: 'claude-code' | 'anthropic' | 'codex' | 'openai' | 'openrouter' | 'cloudflare';
  plan: string | null;            // 'Max 20x', 'ChatGPT Pro', 'Free tier' など判明する範囲で
  windows: UsageWindow[];         // 一番重要。5h/週/月/無料枠をここに並べる
  credits: { remaining: number; total: number | null; currency: 'USD' } | null; // OpenRouter 等
  today: { inputTokens: number; outputTokens: number; costUsd: number | null };  // ローカル記録集計
  thisMonth: { inputTokens: number; outputTokens: number; costUsd: number | null };
  fetchedAt: string;
  source: ('api' | 'local-logs' | 'headers' | 'agent-events')[];  // データの出どころ(UI に明示)
  error: string | null;           // 取得失敗時も snapshot は返す(stale 表示用)
}
```

### 7.2 ローカル使用量レコーダ(全プロバイダ共通の土台)

リモート API で取れない/取りにくい数値があっても「一発で見える」を保証する背骨。

- Darask 経由の**すべての** AI リクエスト(Provider 系・ACP 系とも)の usage を Rust 側で記録
- 保存先: アプリデータディレクトリの SQLite(`usage.db`、rusqlite)。
  スキーマ: `usage_events(ts, provider, model, role, input_tokens, output_tokens, cached_tokens, cost_usd, kind)`
- Provider 系: 各 API レスポンスの usage フィールド(OpenRouter は `usage: { include: true }` を必ず付ける)
- ACP 系: `session/update` 内の usage 情報・Codex の token_count イベントを記録
- 集計クエリ(today / this-month / per-model)を Tauri コマンド `usage_summary()` で提供

### 7.3 プロバイダ別の取得戦略

| プロバイダ | 5h/週/月/無料枠の取得元 | 備考 |
|---|---|---|
| **Claude Code**(サブスク) | ローカル transcript 解析: `~/.claude/projects/**/*.jsonl` の usage を集計し、5 時間ローリングブロック+週間ウィンドウを ccusage 方式で推定 | 公式クォータ API が無いため推定値と明示表示。plan は設定で入力(Max 5x/20x 等)して閾値換算 |
| **Anthropic**(API キー) | レスポンスヘッダ `anthropic-ratelimit-*-remaining` / `-reset` をリクエスト毎にキャプチャ | Admin キー保有時のみ公式 Usage & Cost API(org 単位)を追加取得(任意設定) |
| **Codex**(ChatGPT ログイン) | Codex の JSON イベント(`token_count` 等)に含まれる rate_limits(primary=5h 相当 / secondary=週間、used_percent と resets 秒)をキャプチャして永続化 | エージェント未使用時間帯は最終値+リセット時刻から補間。`~/.codex/sessions` 解析をフォールバックに |
| **OpenAI**(API キー) | ヘッダ `x-ratelimit-remaining-tokens/-requests` + ローカル記録 | 組織 Usage API は Admin キー保有時のみ(任意) |
| **OpenRouter** | `GET /api/v1/key`(usage・limit・limit_remaining・is_free_tier・rate_limit)+ `GET /api/v1/credits`(total_credits/total_usage) | 最も素直。クレジット残高・無料枠フラグを直接表示。コストは生成毎 usage をローカル記録 |
| **Cloudflare Workers AI** | GraphQL Analytics API(単一エンドポイント `POST https://api.cloudflare.com/client/v4/graphql`、データセット `aiInferenceAdaptiveGroups`)で当日/当月の Neurons 消費を取得し、無料枠 **10,000 Neurons/日**(UTC 0 時リセット)に対する消費率を算出 | Account ID + Analytics 読取権限付きトークンが必要。**データセットの具体的な集計フィールド名は実装時に GraphQL イントロスペクションで確認すること**(仕様上は存在確認済みだがフィールド名は未検証)。取れない場合はローカル記録から推定 |

設計原則: **取れる数値は API から、取れない数値はローカル記録から、推定値には「≈」を付けて出どころを UI に明示する。**嘘の精度を見せない。

### 7.4 UI 契約

1. **ステータスバー(常時)**: コンパクトゲージ。例 `Claude 5h ▓▓▓░ 62% ・ OR $12.40`。
   最も逼迫しているウィンドウを自動選択して表示。80% で `--warning`、95% で `--error` 色。クリックでダッシュボードを開く
2. **Usage ダッシュボード**(コマンド `ai.usageDashboard`、Ctrl+Shift+U):
   - プロバイダごとのカード。カード内は上から:
     プラン名 / **ウィンドウごとの横バー**(5 時間・週間・月間・無料枠 — used/limit、%、リセットまでの残り時間)/
     クレジット残高(残 $X.XX / 総 $Y)/ 今日・今月のトークン(入出力別)と推定コスト
   - 全カード共通: 最終更新時刻、出どころバッジ(API / ローカル推定)、手動更新ボタン、取得エラー時は stale 表示
   - 下部に過去 7 日のトークン/コストのスパークライン(ローカル記録から)
3. **更新ポリシー**: ダッシュボード表示中 60 秒毎 + リクエスト完了毎に該当プロバイダを更新。
   バックグラウンドポーリングはしない(高速起動の原則)
4. **閾値通知**: いずれかのウィンドウが 80% / 95% を跨いだらトースト通知(設定でオフ可)

## 8. リスクと対策

- **ACP 仕様の変化**: プロトコルバージョンを `initialize` でネゴシエート。アダプタ層を薄く保つ
- **CLI 未インストール**: 起動失敗時に導線 UI(インストールコマンド提示・再試行)
- **モデル ID の変動**(GLM/Kimi 等): ハードコードせず `listModels()` + 設定で自由指定
- **ストリーミング大量更新で UI が重い**: パネルは requestAnimationFrame バッチで flush
