//! OpenRouter Provider(PHASE3A-SPEC.md 2.3 / Agent C 担当)。
//!
//! - `POST https://openrouter.ai/api/v1/chat/completions`(OpenAI 互換、`stream: true` で SSE)
//! - `GET  https://openrouter.ai/api/v1/models`
//! - `GET  https://openrouter.ai/api/v1/key`(レート制限・使用量)
//! - `GET  https://openrouter.ai/api/v1/credits`(total_credits/total_usage)
//!
//! 認証は `Authorization: Bearer <key>`。

use super::{parse_openai_compatible_sse, ChatRequest, ChatUsage, ModelInfo};

const BASE_URL: &str = "https://openrouter.ai/api/v1";

/// チャットをストリーミング送信する。取得した本文チャンクは `on_delta` に順次渡す。
pub async fn chat_stream(
    api_key: &str,
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
        // OpenRouter 固有: body に usage.include=true を付けると最終チャンクに usage が乗る
        // (PHASE3A-SPEC.md 2.3)。
        "usage": { "include": true },
    });

    let client = reqwest::Client::new();
    let resp = client
        .post(format!("{BASE_URL}/chat/completions"))
        .bearer_auth(api_key)
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    parse_openai_compatible_sse(resp, on_delta).await
}

/// `GET /api/v1/models` の `data` 配列から `id`(と分かれば `name`)を抽出する。
pub async fn list_models(api_key: &str) -> Result<Vec<ModelInfo>, String> {
    let client = reqwest::Client::new();
    let resp = client
        .get(format!("{BASE_URL}/models"))
        .bearer_auth(api_key)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("HTTP {status}: {body}"));
    }

    let value: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let data = value
        .get("data")
        .and_then(|d| d.as_array())
        .cloned()
        .unwrap_or_default();

    let models = data
        .iter()
        .filter_map(|m| {
            let id = m.get("id")?.as_str()?.to_string();
            let label = m
                .get("name")
                .and_then(|n| n.as_str())
                .map(|s| s.to_string())
                .unwrap_or_else(|| id.clone());
            Some(ModelInfo { id, label })
        })
        .collect();

    Ok(models)
}

/// `GET /api/v1/key` の生 JSON(レート制限・使用量)。呼び出し側で必要なフィールドを抽出する。
pub async fn key_info(api_key: &str) -> Result<serde_json::Value, String> {
    let client = reqwest::Client::new();
    let resp = client
        .get(format!("{BASE_URL}/key"))
        .bearer_auth(api_key)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("HTTP {status}: {body}"));
    }

    resp.json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())
}

/// `GET /api/v1/credits` の生 JSON(total_credits/total_usage)。
pub async fn credits(api_key: &str) -> Result<serde_json::Value, String> {
    let client = reqwest::Client::new();
    let resp = client
        .get(format!("{BASE_URL}/credits"))
        .bearer_auth(api_key)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("HTTP {status}: {body}"));
    }

    resp.json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())
}
