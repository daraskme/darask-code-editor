//! 使用量レコーダ + ダッシュボードデータ (PHASE3A-SPEC.md 2.4 / AI-DESIGN.md 7章)。
//! 所有: Agent D。
//!
//! // TODO(integrate): Agent A の lib.rs に以下を追加してもらうこと。
//! //   mod usage;
//! //   invoke_handler![ ..., usage::usage_summary, ... ]
//! // AppState は既に lib.rs 側で `pub usage_db: tokio::sync::Mutex<rusqlite::Connection>` を
//! // 持ち、起動時に本モジュールと同一スキーマで初期化・.manage() 済み(2026-07-14 時点で確認済み)。
//! // 本モジュールの init_db は IF NOT EXISTS のため二重に呼んでも安全。

pub mod claude_code_local;
pub mod cloudflare_analytics;
pub mod store;

use serde_json::{json, Value};
use tauri::State;

/// chrono 非依存の最小限の UTC 日時ユーティリティ。
/// Cargo.toml は Agent A 所有のため新規クレート(chrono 等)をここでは追加しない。
/// 日付計算は Howard Hinnant の civil_from_days / days_from_civil アルゴリズムに基づく
/// (http://howardhinnant.github.io/date_algorithms.html)。
pub(crate) mod time {
    use std::time::{SystemTime, UNIX_EPOCH};

    /// 現在時刻の UNIX 秒。取得に失敗することは通常無いが、失敗時も panic せず 0 を返す。
    pub fn unix_now() -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0)
    }

    /// 1970-01-01 からの経過日数 -> (year, month, day)。
    fn civil_from_days(z: i64) -> (i64, u32, u32) {
        let z = z + 719468;
        let era = if z >= 0 { z } else { z - 146096 } / 146097;
        let doe = z - era * 146097; // [0, 146096]
        let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365; // [0, 399]
        let y = yoe + era * 400;
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
        let mp = (5 * doy + 2) / 153; // [0, 11]
        let d = (doy - (153 * mp + 2) / 5 + 1) as u32; // [1, 31]
        let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32; // [1, 12]
        let year = if m <= 2 { y + 1 } else { y };
        (year, m, d)
    }

    /// (year, month, day) -> 1970-01-01 からの経過日数。
    fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
        let y2 = if m <= 2 { y - 1 } else { y };
        let era = if y2 >= 0 { y2 } else { y2 - 399 } / 400;
        let yoe = y2 - era * 400; // [0, 399]
        let mp: i64 = if m > 2 {
            (m - 3) as i64
        } else {
            (m + 9) as i64
        };
        let doy = (153 * mp + 2) / 5 + d as i64 - 1; // [0, 365]
        let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy; // [0, 146096]
        era * 146097 + doe - 719468
    }

    /// UNIX 秒 -> "YYYY-MM-DDTHH:MM:SSZ"。
    pub fn to_iso8601(unix_secs: i64) -> String {
        let days = unix_secs.div_euclid(86400);
        let secs_of_day = unix_secs.rem_euclid(86400);
        let (y, m, d) = civil_from_days(days);
        let h = secs_of_day / 3600;
        let mi = (secs_of_day % 3600) / 60;
        let s = secs_of_day % 60;
        format!("{y:04}-{m:02}-{d:02}T{h:02}:{mi:02}:{s:02}Z")
    }

    pub fn now_iso8601() -> String {
        to_iso8601(unix_now())
    }

    /// 今日(UTC)0時0分0秒の ISO8601 文字列。
    pub fn today_start_iso8601() -> String {
        let days = unix_now().div_euclid(86400);
        to_iso8601(days * 86400)
    }

    /// 今日(UTC)の日付のみ "YYYY-MM-DD"(Cloudflare GraphQL の date 変数用)。
    pub fn today_date_only() -> String {
        let iso = today_start_iso8601();
        iso.get(0..10).unwrap_or(&iso).to_string()
    }

    /// 当月(UTC)1日 0時0分0秒の ISO8601 文字列。
    pub fn month_start_iso8601() -> String {
        let days = unix_now().div_euclid(86400);
        let (y, m, _) = civil_from_days(days);
        to_iso8601(days_from_civil(y, m, 1) * 86400)
    }

    /// ISO8601 相当の文字列の先頭 19 文字("YYYY-MM-DDTHH:MM:SS")のみを解析する簡易パーサ。
    /// 末尾の 'Z'・小数秒・タイムゾーンオフセットは無視して UTC とみなす(Claude Code の
    /// transcript は概ね UTC の 'Z' 付きのため実用上は十分。オフセット付き文字列は無視される
    /// 点に注意)。解析できない場合は None を返し、呼び出し側で panic せず黙ってスキップさせる。
    pub fn parse_iso8601_prefix(s: &str) -> Option<i64> {
        if s.len() < 19 {
            return None;
        }
        let get = |r: std::ops::Range<usize>| -> Option<i64> { s.get(r)?.parse::<i64>().ok() };
        let y = get(0..4)?;
        let mo = get(5..7)?;
        let d = get(8..10)?;
        let h = get(11..13)?;
        let mi = get(14..16)?;
        let se = get(17..19)?;
        if !(1..=12).contains(&mo) || !(1..=31).contains(&d) {
            return None;
        }
        let days = days_from_civil(y, mo as u32, d as u32);
        Some(days * 86400 + h * 3600 + mi * 60 + se)
    }
}

/// ダッシュボード用の集約コマンド (PHASE3A-SPEC.md 2.4 / AI-DESIGN.md 7.1 UsageSnapshot)。
/// 戻り値は UsageSnapshot[] 相当の JSON(TypeScript 側の型定義は Agent G が別途行う)。
///
/// 個々の取得元(ローカル集計・Claude Code transcript 推定・将来の OpenRouter/Cloudflare API)
/// が失敗しても他のプロバイダは返せるよう、失敗は該当 snapshot の `error` フィールドに格納し、
/// この関数全体を Err にはしない(部分失敗を握り潰さない設計。PHASE3A-SPEC.md 2.4)。
///
/// 現時点では「ローカル usage_events 集計」+「claude-code の transcript 推定」のみを確実に返す
/// (部分的でも動くものを優先。PHASE3A-SPEC.md の指示通り)。OpenRouter/Cloudflare の実データ API
/// マージは下記 TODO を参照。
#[tauri::command]
pub async fn usage_summary(state: State<'_, crate::AppState>) -> Result<Vec<Value>, String> {
    let mut snapshots: Vec<Value> = Vec::new();

    {
        let conn = state.usage_db.lock().await;
        for provider_id in ["claude-code", "openrouter", "cloudflare"] {
            snapshots.push(build_local_snapshot(&conn, provider_id));
        }
        // conn (MutexGuard) はここでスコープを抜けて drop される。
    }

    // claude-code のみ、ローカル transcript 解析による 5時間/週間ウィンドウの推定値を追加する。
    let claude_code_idx = snapshots
        .iter()
        .position(|s| s.get("providerId").and_then(|v| v.as_str()) == Some("claude-code"));

    if let Some(idx) = claude_code_idx {
        match claude_code_local::estimate_recent_usage() {
            Ok(estimate) => {
                let snap = &mut snapshots[idx];
                if let Some(windows) = snap["windows"].as_array_mut() {
                    windows.push(json!({
                        "id": "5h",
                        "label": "5時間枠(推定)",
                        "used": estimate.last_5h.input_tokens + estimate.last_5h.output_tokens,
                        "limit": null,
                        "unit": "tokens",
                        "usedPercent": null,
                        "resetsAt": null,
                    }));
                    windows.push(json!({
                        "id": "week",
                        "label": "週間(推定)",
                        "used": estimate.last_7d.input_tokens + estimate.last_7d.output_tokens,
                        "limit": null,
                        "unit": "tokens",
                        "usedPercent": null,
                        "resetsAt": null,
                    }));
                }
                if let Some(sources) = snap["source"].as_array_mut() {
                    if !sources.iter().any(|v| v == "local-logs") {
                        sources.push(json!("local-logs"));
                    }
                }
            }
            Err(e) => {
                let msg = format!("Claude Code transcript 推定に失敗: {e}");
                snapshots[idx]["error"] = json!(msg);
            }
        }
    }

    // OpenRouter: API キーが設定済みであれば credits / key_info をマージする。
    // 未設定の場合は何もしない(ローカル記録のみのまま返す。設定 UI 未使用時にエラー扱いしない)。
    let openrouter_idx = snapshots
        .iter()
        .position(|s| s.get("providerId").and_then(|v| v.as_str()) == Some("openrouter"));
    if let Some(idx) = openrouter_idx {
        if let Ok(api_key) = crate::secrets::get_secret("provider:openrouter") {
            match crate::providers::openrouter::credits(&api_key).await {
                Ok(credits_json) => {
                    // OpenRouter の生レスポンスは { data: { total_credits, total_usage } } 形。
                    // フロント(UsageSnapshot.credits)が期待する { remaining, total, currency }
                    // へ変換してから格納する(生 JSON をそのまま渡すと remaining が undefined になり
                    // ProviderUsageCard 側の .toFixed(2) が例外を投げて画面全体がクラッシュしていた)。
                    let total_credits = credits_json
                        .pointer("/data/total_credits")
                        .and_then(|v| v.as_f64());
                    let total_usage = credits_json
                        .pointer("/data/total_usage")
                        .and_then(|v| v.as_f64());
                    if let (Some(total), Some(usage)) = (total_credits, total_usage) {
                        snapshots[idx]["credits"] = json!({
                            "remaining": total - usage,
                            "total": total,
                            "currency": "USD",
                        });
                        push_source(&mut snapshots[idx], "api");
                    } else {
                        append_error(
                            &mut snapshots[idx],
                            "OpenRouter credits のフィールド形式が想定と異なるため表示をスキップしました",
                        );
                    }
                }
                Err(e) => append_error(
                    &mut snapshots[idx],
                    &format!("OpenRouter credits 取得に失敗: {e}"),
                ),
            }
            match crate::providers::openrouter::key_info(&api_key).await {
                Ok(key_json) => {
                    if let Some(label) = key_json.pointer("/data/label").and_then(|v| v.as_str()) {
                        snapshots[idx]["plan"] = json!(label);
                    }
                    push_source(&mut snapshots[idx], "api");
                }
                Err(e) => append_error(
                    &mut snapshots[idx],
                    &format!("OpenRouter key情報取得に失敗: {e}"),
                ),
            }
        }
    }

    // Cloudflare: account_id + token が両方設定済みであれば当日の Neurons 消費をマージする。
    // 取得できない場合(フィールド名不一致・未設定等)はローカル推定のみのまま error に格納する
    // (嘘の値を出さない。AI-DESIGN.md 7.3 / PHASE3A-SPEC.md 2.4)。
    let cloudflare_idx = snapshots
        .iter()
        .position(|s| s.get("providerId").and_then(|v| v.as_str()) == Some("cloudflare"));
    if let Some(idx) = cloudflare_idx {
        let account_id = crate::secrets::get_secret("provider:cloudflare_account_id");
        let token = crate::secrets::get_secret("provider:cloudflare_token");
        if let (Ok(account_id), Ok(token)) = (account_id, token) {
            let neurons_result =
                cloudflare_analytics::fetch_today_neurons(&account_id, &token).await;
            if let Err(ref e) = neurons_result {
                eprintln!("cloudflare fetch_today_neurons error: {e}");
            }
            match neurons_result {
                Ok(neurons) => {
                    if let Some(windows) = snapshots[idx]["windows"].as_array_mut() {
                        let used_percent = (neurons / 10_000.0 * 100.0).clamp(0.0, 100.0);
                        windows.push(json!({
                            "id": "free-daily",
                            "label": "無料枠(1日)",
                            "used": neurons,
                            "limit": 10_000,
                            "unit": "neurons",
                            "usedPercent": used_percent,
                            "resetsAt": null,
                        }));
                    }
                    push_source(&mut snapshots[idx], "api");
                }
                Err(e) => append_error(
                    &mut snapshots[idx],
                    &format!("Cloudflare Neurons 取得に失敗: {e}"),
                ),
            }
        }
    }

    Ok(snapshots)
}

/// snapshot の `source` 配列に重複なく値を追加する。
fn push_source(snapshot: &mut Value, source: &str) {
    if let Some(sources) = snapshot["source"].as_array_mut() {
        if !sources.iter().any(|v| v == source) {
            sources.push(json!(source));
        }
    }
}

/// snapshot の `error` フィールドにメッセージを追記する(既存のエラーがあれば `; ` で連結)。
fn append_error(snapshot: &mut Value, msg: &str) {
    let combined = match snapshot["error"].as_str() {
        Some(prev) => format!("{prev}; {msg}"),
        None => msg.to_string(),
    };
    snapshot["error"] = json!(combined);
}

/// 1 プロバイダ分の UsageSnapshot(ローカル usage_events 集計のみ)を組み立てる。
/// 集計に失敗しても panic せず、0 埋め + error 文字列付きの snapshot を返す。
fn build_local_snapshot(conn: &rusqlite::Connection, provider_id: &str) -> Value {
    let mut error: Option<String> = None;

    let today_json = match store::aggregate_today(conn, provider_id) {
        Ok((input, output, cost)) => json!({
            "inputTokens": input,
            "outputTokens": output,
            "costUsd": cost,
        }),
        Err(e) => {
            error = Some(format!("today集計に失敗: {e}"));
            json!({ "inputTokens": 0, "outputTokens": 0, "costUsd": null })
        }
    };

    let this_month_json = match store::aggregate_this_month(conn, provider_id) {
        Ok((input, output, cost)) => json!({
            "inputTokens": input,
            "outputTokens": output,
            "costUsd": cost,
        }),
        Err(e) => {
            let msg = format!("thisMonth集計に失敗: {e}");
            error = Some(match error {
                Some(prev) => format!("{prev}; {msg}"),
                None => msg,
            });
            json!({ "inputTokens": 0, "outputTokens": 0, "costUsd": null })
        }
    };

    json!({
        "providerId": provider_id,
        "plan": null,
        "windows": [],
        "credits": null,
        "today": today_json,
        "thisMonth": this_month_json,
        "fetchedAt": time::now_iso8601(),
        "source": ["local-logs"],
        "error": error,
    })
}
