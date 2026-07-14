//! JSON-RPC 2.0 の基本型(PHASE3A-SPEC.md 2.2)。
//!
//! ACP は改行区切り JSON-RPC 2.0 over stdio(Content-Length ヘッダーではない)。
//! 1 メッセージ = 1 行の UTF-8 JSON + "\n"。フレーミング/送受信は manager.rs が担う。

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const JSONRPC_VERSION: &str = "2.0";

/// client -> agent のリクエスト。
#[derive(Debug, Clone, Serialize)]
pub struct RequestMessage {
    pub jsonrpc: String,
    pub id: u64,
    pub method: String,
    pub params: Value,
}

impl RequestMessage {
    pub fn new(id: u64, method: impl Into<String>, params: Value) -> Self {
        Self {
            jsonrpc: JSONRPC_VERSION.to_string(),
            id,
            method: method.into(),
            params,
        }
    }
}

/// client -> agent の通知(応答を期待しない。例: session/cancel)。
#[derive(Debug, Clone, Serialize)]
pub struct NotificationMessage {
    pub jsonrpc: String,
    pub method: String,
    pub params: Value,
}

impl NotificationMessage {
    pub fn new(method: impl Into<String>, params: Value) -> Self {
        Self {
            jsonrpc: JSONRPC_VERSION.to_string(),
            method: method.into(),
            params,
        }
    }
}

/// JSON-RPC 2.0 のエラーオブジェクト。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResponseError {
    pub code: i64,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[allow(dead_code)] // 現状 message/code のみ利用。data は将来のデバッグ用に保持。
    pub data: Option<Value>,
}

/// 受信した 1 行をゆるく受け止めるための型。
///
/// ACP の stdout には次の 3 種類が混在する:
/// - agent -> client のリクエスト(method + id あり。こちらが応答を返す必要がある)
/// - agent -> client の通知(method のみ。id なし)
/// - こちらが送ったリクエストへの応答(id のみ。method なし。result か error のどちらかを持つ)
///
/// 種別を決め打ちせず、まずこの緩い形でパースしてから manager.rs 側で振り分ける。
#[derive(Debug, Deserialize)]
pub struct RawMessage {
    #[allow(dead_code)] // "2.0" 固定である前提でバージョン検証はしない(Phase3a では不要)。
    pub jsonrpc: Option<String>,
    pub id: Option<Value>,
    pub method: Option<String>,
    pub params: Option<Value>,
    pub result: Option<Value>,
    pub error: Option<ResponseError>,
}

/// ACP の主要メソッド名。
pub mod methods {
    /// client -> agent。バージョン・capabilities 交渉。
    pub const INITIALIZE: &str = "initialize";
    /// client -> agent。作業ディレクトリ指定でセッション作成。
    pub const SESSION_NEW: &str = "session/new";
    /// client -> agent。ユーザーメッセージ送信。
    pub const SESSION_PROMPT: &str = "session/prompt";
    /// client -> agent の通知。実行中操作の中断。
    pub const SESSION_CANCEL: &str = "session/cancel";
    /// agent -> client の通知。ストリーミング本体
    /// (agent_message_chunk / agent_thought_chunk / plan / tool_call / tool_call_update / usage_update)。
    pub const SESSION_UPDATE: &str = "session/update";
    /// agent -> client のリクエスト。ツール実行前の承認要求(応答が必要)。
    pub const SESSION_REQUEST_PERMISSION: &str = "session/request_permission";
    /// agent -> client のリクエスト。Phase3a はディスク直読み(応答が必要)。
    pub const FS_READ_TEXT_FILE: &str = "fs/read_text_file";
    /// agent -> client のリクエスト。Phase3a はディスク直書き(応答が必要)。
    pub const FS_WRITE_TEXT_FILE: &str = "fs/write_text_file";
}
