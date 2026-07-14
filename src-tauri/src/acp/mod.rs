//! ACP (Agent Client Protocol) クライアント(PHASE3A-SPEC.md 2.2, Agent B 所有)。
//!
//! フレーミング: 改行区切り JSON-RPC 2.0 over stdio(Content-Length ヘッダーは使わない)。
//! 1 メッセージ = 1 行の UTF-8 JSON + "\n"。詳細は manager.rs のモジュールコメントを参照。
//!
//! integrate: lib.rs で以下を行うこと(Agent A 担当箇所)。
//!   1. `mod acp;` を追加する。
//!   2. `.manage(tokio::sync::Mutex::new(acp::manager::AcpManagerState::default()))` する。
//!   3. `invoke_handler!` に acp_list_agents, acp_start_session, acp_send_prompt, acp_cancel,
//!      acp_respond_permission, acp_close_session を登録する
//!      (commands/mod.rs の `pub use crate::acp::manager::{...}` のコメントアウトを外せば良い)。

pub mod agents_config;
pub mod manager;
pub mod protocol;

pub use manager::{
    acp_abort_pending_start, acp_cancel, acp_close_session, acp_list_agents,
    acp_respond_permission, acp_send_prompt, acp_start_session, acp_test_agent,
};
// lib.rs が `.manage(tokio::sync::Mutex::new(...))` の型注釈のために直接
// `acp::manager::AcpManagerState` を import するため、ここでの re-export は不要。
#[allow(unused_imports)]
pub use manager::AcpManagerState;
