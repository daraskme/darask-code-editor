//! Cloudflare Workers AI の Analytics GraphQL API から当日の Neurons 消費を取得する。
//! PHASE3A-SPEC.md 2.4 / AI-DESIGN.md 7.3。所有: Agent D(2026-07-14 実機検証で確定)。
//!
//! 実アカウントでの検証結果(2026-07-14、schema introspection で確認済み):
//! - `aiInferenceAdaptiveGroups` の `sum` サブオブジェクトの実際の型は
//!   `AccountAiInferenceAdaptiveGroupsSum`。Neurons 消費量に相当するフィールドは
//!   `totalNeurons`(`requests` という名前のフィールドは存在しない)。
//! - schema introspection(`__schema`/`__type`)自体はアカウントの Analytics 権限が無くても
//!   実行できる(実データを解決しないため)。一方 `viewer.accounts(...)` を通した実データ取得は
//!   トークンに `Account > Analytics > Read` 権限が無いと `"not authorized for that account"`
//!   (`extensions.code == "authz"`)で拒否される(Workers AI の推論実行権限とは別スコープ)。
//!   この2種のエラーは区別して呼び出し元に伝える(AI-DESIGN.md 7.3「嘘の精度を見せない」)。

use serde_json::{json, Value};

const GRAPHQL_ENDPOINT: &str = "https://api.cloudflare.com/client/v4/graphql";

/// 当日(UTC)の Cloudflare Workers AI の Neurons 消費量を取得する。
/// 取得できない場合(権限不足・ネットワークエラー等)は `Err(String)` を返す(panic しない)。
/// 呼び出し元はローカル推定にフォールバックすること。
pub async fn fetch_today_neurons(account_id: &str, token: &str) -> Result<f64, String> {
    let today = super::time::today_date_only(); // "YYYY-MM-DD" (UTC)

    let query = r#"
        query NeuronsToday($accountTag: String!, $date: Date!) {
          viewer {
            accounts(filter: { accountTag: $accountTag }) {
              aiInferenceAdaptiveGroups(filter: { date: $date }, limit: 100) {
                sum {
                  totalNeurons
                }
              }
            }
          }
        }
    "#;

    let body = json!({
        "query": query,
        "variables": {
            "accountTag": account_id,
            "date": today,
        }
    });

    let client = reqwest::Client::new();
    let resp = client
        .post(GRAPHQL_ENDPOINT)
        .bearer_auth(token)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Cloudflare GraphQL へのリクエストに失敗: {e}"))?;

    let status = resp.status();
    let payload: Value = resp
        .json()
        .await
        .map_err(|e| format!("Cloudflare GraphQL レスポンスの解析に失敗(status={status}): {e}"))?;

    if let Some(errors) = payload.get("errors") {
        let has_errors = match errors.as_array() {
            Some(arr) => !arr.is_empty(),
            None => !errors.is_null(),
        };
        if has_errors {
            let is_authz = errors
                .as_array()
                .map(|arr| {
                    arr.iter().any(|e| {
                        e.pointer("/extensions/code").and_then(|c| c.as_str()) == Some("authz")
                            || e.get("message")
                                .and_then(|m| m.as_str())
                                .is_some_and(|m| m.to_lowercase().contains("not authorized"))
                    })
                })
                .unwrap_or(false);
            if is_authz {
                return Err(
                    "Cloudflare API トークンにアカウントレベルの Analytics 参照権限が無いため \
                     Neurons 使用量を取得できません。トークン作成時に「Account」→「Analytics」の \
                     Read 権限を追加してください(Workers AI の推論実行権限だけでは不足します)。"
                        .to_string(),
                );
            }
            return Err(format!("Cloudflare GraphQL がエラーを返した: {errors}"));
        }
    }

    let groups = payload
        .pointer("/data/viewer/accounts/0/aiInferenceAdaptiveGroups")
        .ok_or_else(|| "Cloudflare GraphQL レスポンスに期待した形のデータが無い".to_string())?;

    let entries = groups
        .as_array()
        .ok_or_else(|| "aiInferenceAdaptiveGroups が配列でない".to_string())?;

    let total: f64 = entries
        .iter()
        .filter_map(|g| g.pointer("/sum/totalNeurons")?.as_f64())
        .sum();

    Ok(total)
}
