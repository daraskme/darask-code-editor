//! usage_events テーブルの永続化(rusqlite)。PHASE3A-SPEC.md 2.4。
//! 所有: Agent D。

use rusqlite::{params, Connection};

/// PHASE3A-SPEC.md 2.4 記載のスキーマそのまま。
/// 注意: lib.rs(Agent A 所有)が起動時に同一スキーマを直接 execute_batch 済みだが、
/// IF NOT EXISTS のためここから重複して呼んでも安全。
pub const SCHEMA_SQL: &str = "
CREATE TABLE IF NOT EXISTS usage_events (
    id INTEGER PRIMARY KEY,
    ts TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    role TEXT,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL,
    kind TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_events_provider_ts ON usage_events(provider, ts);
";

/// usage.db のマイグレーション関数。
pub fn init_db(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(SCHEMA_SQL).map_err(|e| e.to_string())
}

/// 1件の使用量イベント。`ts` は ISO8601 UTC(例: "2026-07-14T03:04:05Z")。
#[derive(Debug, Clone, serde::Serialize)]
pub struct UsageEvent {
    pub ts: String,
    pub provider: String,
    pub model: String,
    pub role: Option<String>,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cost_usd: Option<f64>,
    pub kind: String,
}

/// Agent C(`ai_chat_stream` 完了時)/ Agent B(ACP セッションの usage_update 受信時)から
/// そのまま import して呼ばれる想定の固定シグネチャ(PHASE3A-SPEC.md 2.4)。
pub fn insert_usage_event(conn: &Connection, ev: &UsageEvent) -> Result<(), String> {
    conn.execute(
        "INSERT INTO usage_events
            (ts, provider, model, role, input_tokens, output_tokens, cost_usd, kind)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            ev.ts,
            ev.provider,
            ev.model,
            ev.role,
            ev.input_tokens,
            ev.output_tokens,
            ev.cost_usd,
            ev.kind,
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// provider の `ts >= since_ts` な行から input/output tokens 合計と cost_usd 合計を返す。
/// 該当行が無い場合は (0, 0, 0.0)(Err にはしない)。
pub fn aggregate_since(
    conn: &Connection,
    provider: &str,
    since_ts: &str,
) -> Result<(i64, i64, f64), String> {
    conn.query_row(
        "SELECT COALESCE(SUM(input_tokens), 0),
                COALESCE(SUM(output_tokens), 0),
                COALESCE(SUM(cost_usd), 0.0)
         FROM usage_events
         WHERE provider = ?1 AND ts >= ?2",
        params![provider, since_ts],
        |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, f64>(2)?,
            ))
        },
    )
    .map_err(|e| e.to_string())
}

/// 当日(UTC 0時起点)の集計。
pub fn aggregate_today(conn: &Connection, provider: &str) -> Result<(i64, i64, f64), String> {
    let since = super::time::today_start_iso8601();
    aggregate_since(conn, provider, &since)
}

/// 当月(UTC 1日 0時起点)の集計。
pub fn aggregate_this_month(conn: &Connection, provider: &str) -> Result<(i64, i64, f64), String> {
    let since = super::time::month_start_iso8601();
    aggregate_since(conn, provider, &since)
}
