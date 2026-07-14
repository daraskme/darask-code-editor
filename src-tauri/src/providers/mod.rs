//! Provider 層(PHASE3A-SPEC.md 2.3 / Agent C 担当)。
//! OpenRouter / Cloudflare Workers AI の共通型・SSE パースヘルパ・公開 Tauri コマンドを持つ。
//!
//! NOTE: PHASE3A-SPEC.md 2.3 には `ChatProvider` トレイトの例示があるが、同節が明記する通り
//! プロバイダは2種のみで「過剰な抽象化をしない」方針のため、形式的なトレイト定義は行わず、
//! `ai_chat_stream` / `ai_list_models` 内の `match provider { .. }` で各モジュールの具体関数を
//! 直接呼び出す(曖昧点の単純な解釈)。

pub mod cloudflare;
pub mod openrouter;

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::Emitter;

/// チャットメッセージ1件。
#[derive(Debug, Clone, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

/// フロントから `ai_chat_stream` に渡されるリクエスト。
#[derive(Debug, Clone, Deserialize)]
pub struct ChatRequest {
    pub provider: String,
    pub model: String,
    pub messages: Vec<ChatMessage>,
}

/// ストリーミング完了後に得られる使用量。取得できなかったフィールドは 0 / None のまま返す
/// (嘘の精度を見せない: AI-DESIGN.md 7.3 の設計原則)。
#[derive(Debug, Clone, Default, Serialize)]
pub struct ChatUsage {
    pub input_tokens: u32,
    pub output_tokens: u32,
    pub cost_usd: Option<f64>,
}

/// モデル選択 UI 向けの簡易情報。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelInfo {
    pub id: String,
    pub label: String,
}

/// OpenAI 互換 SSE ストリームを解析する共通ヘルパ。
///
/// `reqwest::Response::bytes_stream()` を受け取り、バイト列をバッファして `"\n\n"` 区切りで
/// イベント分割し、各イベント内の `"data: "` prefix 行を取り出す。`"data: [DONE]"` で終了。
/// 各データ行を `serde_json::Value` としてパースし、`choices[0].delta.content`(あれば
/// `on_delta` に渡す)と `usage` フィールド(あれば蓄積)を抽出する。壊れた/パース不能な行は
/// スキップして継続する(panic させない)。
pub async fn parse_openai_compatible_sse(
    resp: reqwest::Response,
    mut on_delta: impl FnMut(String) + Send,
) -> Result<ChatUsage, String> {
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("HTTP {status}: {body}"));
    }

    let mut usage = ChatUsage::default();
    let mut buf = String::new();
    let mut stream = resp.bytes_stream();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        buf.push_str(&String::from_utf8_lossy(&chunk));

        // "\n\n" 区切りでイベントを分割する。バッファに残りがあれば次のチャンクへ持ち越す。
        while let Some(pos) = buf.find("\n\n") {
            let event: String = buf.drain(..pos + 2).collect();

            for line in event.lines() {
                let line = line.trim();
                let Some(data) = line.strip_prefix("data:") else {
                    continue;
                };
                let data = data.trim();
                if data.is_empty() {
                    continue;
                }
                if data == "[DONE]" {
                    return Ok(usage);
                }

                let value: serde_json::Value = match serde_json::from_str(data) {
                    Ok(v) => v,
                    Err(_) => continue, // 壊れた行は無視して継続(panicさせない)
                };

                if let Some(content) = value
                    .get("choices")
                    .and_then(|c| c.get(0))
                    .and_then(|c| c.get("delta"))
                    .and_then(|d| d.get("content"))
                    .and_then(|c| c.as_str())
                {
                    if !content.is_empty() {
                        on_delta(content.to_string());
                    }
                }

                if let Some(u) = value.get("usage") {
                    if let Some(v) = u.get("prompt_tokens").and_then(|x| x.as_u64()) {
                        usage.input_tokens = v as u32;
                    }
                    if let Some(v) = u.get("completion_tokens").and_then(|x| x.as_u64()) {
                        usage.output_tokens = v as u32;
                    }
                    // OpenRouter は usage.include=true 時に usage.cost (USD相当) を返す。
                    // フィールド名は未確定要素があるため、無ければ None のままにする。
                    if let Some(v) = u.get("cost").and_then(|x| x.as_f64()) {
                        usage.cost_usd = Some(v);
                    }
                }
            }
        }
    }

    Ok(usage)
}

/// フロントから呼ばれるストリーミングチャットコマンド。
/// `req.provider` ("openrouter" | "cloudflare") で分岐し、取得した delta を
/// `ai://{stream_id}/delta` イベントで、完了時の usage を `ai://{stream_id}/done` イベントで
/// 送出する。
#[tauri::command]
pub async fn ai_chat_stream(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::AppState>,
    stream_id: String,
    req: ChatRequest,
) -> Result<(), String> {
    let delta_event = format!("ai://{stream_id}/delta");
    let done_event = format!("ai://{stream_id}/done");

    let app_for_delta = app.clone();
    let delta_event_for_closure = delta_event.clone();
    let on_delta = move |chunk: String| {
        let _ = app_for_delta.emit(&delta_event_for_closure, chunk);
    };

    let usage = match req.provider.as_str() {
        "openrouter" => {
            let api_key = crate::secrets::get_secret("provider:openrouter")?;
            openrouter::chat_stream(&api_key, &req, on_delta).await?
        }
        "cloudflare" => {
            let account_id = crate::secrets::get_secret("provider:cloudflare_account_id")?;
            let api_token = crate::secrets::get_secret("provider:cloudflare_token")?;
            cloudflare::chat_stream(&account_id, &api_token, &req, on_delta).await?
        }
        other => return Err(format!("unknown provider: {other}")),
    };

    // usage_events テーブルへ記録する(Agent D の crate::usage::store::insert_usage_event を使用)。
    // 記録に失敗してもストリーミング自体は成功として扱う(記録は付加的な機能のため)。
    {
        let ev = crate::usage::store::UsageEvent {
            ts: crate::usage::time::now_iso8601(),
            provider: req.provider.clone(),
            model: req.model.clone(),
            role: None,
            input_tokens: usage.input_tokens as i64,
            output_tokens: usage.output_tokens as i64,
            cost_usd: usage.cost_usd,
            kind: "provider".to_string(),
        };
        let conn = state.usage_db.lock().await;
        if let Err(e) = crate::usage::store::insert_usage_event(&conn, &ev) {
            eprintln!("usage_events への記録に失敗: {e}");
        }
    }

    app.emit(&done_event, usage).map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub async fn ai_list_models(provider: String) -> Result<Vec<ModelInfo>, String> {
    match provider.as_str() {
        "openrouter" => {
            let api_key = crate::secrets::get_secret("provider:openrouter")?;
            openrouter::list_models(&api_key).await
        }
        "cloudflare" => cloudflare::list_models().await,
        other => Err(format!("unknown provider: {other}")),
    }
}

/// 設定 UI の「接続テスト」用。プロバイダごとに実際の資格情報を使った疎通確認を行う。
///
/// - OpenRouter: `ai_list_models` 経由で `GET /api/v1/models` を実際の API キーで叩く。
///   キーが無効なら 401 でエラーになるため、これ自体が妥当な疎通確認になっている。
/// - Cloudflare: `cloudflare::list_models` は静的リストを返すのみでネットワーク呼び出しを
///   行わないため、代わりに `cloudflare::verify_credentials` で実際に確認済みの
///   chat/completions エンドポイントへ最小リクエストを送り、資格情報の有効性を検証する。
///   account_id / token のいずれかが未設定の場合はエラーにはせず `Ok(false)` を返す。
#[tauri::command]
pub async fn ai_test_connection(provider: String) -> Result<bool, String> {
    match provider.as_str() {
        "openrouter" => Ok(ai_list_models("openrouter".to_string()).await.is_ok()),
        "cloudflare" => {
            let account_id = match crate::secrets::get_secret("provider:cloudflare_account_id") {
                Ok(v) => v,
                Err(_) => return Ok(false),
            };
            let api_token = match crate::secrets::get_secret("provider:cloudflare_token") {
                Ok(v) => v,
                Err(_) => return Ok(false),
            };
            let result = cloudflare::verify_credentials(&account_id, &api_token).await;
            if let Err(ref e) = result {
                eprintln!("cloudflare verify_credentials error: {e}");
            }
            result
        }
        other => Err(format!("unknown provider: {other}")),
    }
}

/// `GET /api/v1/key` の生 JSON をそのまま返す。フロント側で必要なフィールドを抽出する。
#[tauri::command]
pub async fn openrouter_key_info() -> Result<serde_json::Value, String> {
    let api_key = crate::secrets::get_secret("provider:openrouter")?;
    openrouter::key_info(&api_key).await
}

/// `GET /api/v1/credits` の生 JSON をそのまま返す。フロント側で必要なフィールドを抽出する。
#[tauri::command]
pub async fn openrouter_credits() -> Result<serde_json::Value, String> {
    let api_key = crate::secrets::get_secret("provider:openrouter")?;
    openrouter::credits(&api_key).await
}
