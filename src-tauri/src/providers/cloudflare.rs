//! Cloudflare Workers AI Provider(PHASE3A-SPEC.md 2.3 / Agent C 担当)。
//!
//! - `POST https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1/chat/completions`
//!   (OpenAI 互換、`Authorization: Bearer <api_token>`)
//!
//! account_id は機密ではないため、簡易的に `provider:cloudflare_account_id` として
//! secrets(keyring)経由で扱う(呼び出し側 = providers::mod::ai_chat_stream で取得)。

use super::{parse_openai_compatible_sse, ChatRequest, ChatUsage, ModelInfo};

/// チャットをストリーミング送信する。取得した本文チャンクは `on_delta` に順次渡す。
pub async fn chat_stream(
    account_id: &str,
    api_token: &str,
    req: &ChatRequest,
    on_delta: impl FnMut(String) + Send,
) -> Result<ChatUsage, String> {
    let messages: Vec<serde_json::Value> = req
        .messages
        .iter()
        .map(|m| serde_json::json!({ "role": m.role, "content": m.content }))
        .collect();

    let body = serde_json::json!({
        "model": req.model,
        "messages": messages,
        "stream": true,
        // OpenAI 互換の一般的な指定。最終チャンクに usage を含めるよう要求する
        // (PHASE3A-SPEC.md 2.3: "stream_options: {"include_usage": true}")。
        "stream_options": { "include_usage": true },
    });

    let url = format!(
        "https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1/chat/completions"
    );

    let client = reqwest::Client::new();
    let resp = client
        .post(url)
        .bearer_auth(api_token)
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    parse_openai_compatible_sse(resp, on_delta).await
}

/// 資格情報(account_id / api_token)が実際に有効かどうかを、確認済みの chat/completions
/// エンドポイントへ最小限の非ストリーミングリクエストを送って検証する(設定 UI の
/// 「接続テスト」用)。HTTP 2xx なら `Ok(true)`、401/403 等の認証エラーなら `Ok(false)`、
/// それ以外のネットワークエラー等は `Err` として呼び出し元に伝播する。
pub async fn verify_credentials(account_id: &str, api_token: &str) -> Result<bool, String> {
    let url = format!(
        "https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1/chat/completions"
    );

    let body = serde_json::json!({
        // 2026-05-30 に @cf/meta/llama-3.1-8b-instruct が deprecated(HTTP 410 Gone)になったため、
        // 現行の軽量モデルに差し替え(接続テストは資格情報の有効性確認が目的で、モデル自体の
        // 性能は問わないため最も軽いものを選ぶ)。
        "model": "@cf/meta/llama-3.2-1b-instruct",
        "messages": [{ "role": "user", "content": "hi" }],
        "max_tokens": 1,
        "stream": false,
    });

    let client = reqwest::Client::new();
    let resp = client
        .post(url)
        .bearer_auth(api_token)
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let status = resp.status();
    if status.is_success() {
        Ok(true)
    } else if status.as_u16() == 401 || status.as_u16() == 403 {
        Ok(false)
    } else {
        let body_text = resp.text().await.unwrap_or_default();
        Err(format!("HTTP {status}: {body_text}"))
    }
}

/// Cloudflareのモデル一覧API未確認のため静的リスト。ユーザーは自由入力も可能(フロント側)。
pub async fn list_models() -> Result<Vec<ModelInfo>, String> {
    // 2026-07-14 時点で公式モデル一覧ページに掲載されている ID(未確認だった旧リストの
    // @cf/meta/llama-3.1-8b-instruct は 2026-05-30 に deprecated 済みだったため差し替え)。
    const KNOWN_MODEL_IDS: &[&str] = &[
        "@cf/meta/llama-3.2-1b-instruct",
        "@cf/meta/llama-3.2-3b-instruct",
        "@cf/meta/llama-3.1-8b-instruct-fp8",
        "@cf/mistralai/mistral-small-3.1-24b-instruct",
        "@cf/google/gemma-4-26b-a4b-it",
    ];

    Ok(KNOWN_MODEL_IDS
        .iter()
        .map(|id| ModelInfo {
            id: id.to_string(),
            label: id.to_string(),
        })
        .collect())
}
