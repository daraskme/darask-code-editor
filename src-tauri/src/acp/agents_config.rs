//! 既定エージェント定義(PHASE3A-SPEC.md 2.2)。
//!
//! TODO(Phase3b): ユーザーがカスタムエージェント(Gemini CLI 等)を追加できるよう、
//! アプリデータディレクトリの agents.json を読み書きして `default_agents()` の結果に
//! マージする。Phase3a は既定 2 エージェントの返却のみで良い。

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentConfig {
    pub id: String,
    pub label: String,
    pub command: String,
    pub args: Vec<String>,
    /// 認証情報を保存する secrets キー(例: "agent:claude-code")。None ならこのエージェントは
    /// 認証キー設定UI対象外。
    pub secret_id: Option<String>,
    /// 子プロセス起動時に secret の値を注入する環境変数名(例: "ANTHROPIC_API_KEY")。
    pub env_var: Option<String>,
}

// Windows では `npx` はシェルスクリプト(npx.cmd)のため、
// `Command::new("npx")` だけだと「プログラムが見つかりません」になることがある。
// npx.cmd をコマンド名として直接指定する(PHASE3A-SPEC.md 2.2 の推奨どおり)。
#[cfg(windows)]
const NPX_COMMAND: &str = "npx.cmd";
#[cfg(not(windows))]
const NPX_COMMAND: &str = "npx";

/// 既定 2 エージェント(Claude Code / Codex)。
pub fn default_agents() -> Vec<AgentConfig> {
    vec![
        AgentConfig {
            id: "claude-code".to_string(),
            label: "Claude Code".to_string(),
            command: NPX_COMMAND.to_string(),
            args: vec![
                "-y".to_string(),
                "@agentclientprotocol/claude-agent-acp".to_string(),
            ],
            secret_id: Some("agent:claude-code".to_string()),
            env_var: Some("ANTHROPIC_API_KEY".to_string()),
        },
        AgentConfig {
            id: "codex".to_string(),
            label: "Codex".to_string(),
            command: NPX_COMMAND.to_string(),
            args: vec![
                "-y".to_string(),
                "@agentclientprotocol/codex-acp".to_string(),
            ],
            secret_id: Some("agent:codex".to_string()),
            env_var: Some("OPENAI_API_KEY".to_string()),
        },
    ]
}

pub fn find_agent(id: &str) -> Option<AgentConfig> {
    default_agents().into_iter().find(|a| a.id == id)
}
