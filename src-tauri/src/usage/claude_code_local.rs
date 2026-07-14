//! `%USERPROFILE%\.claude\projects\**\*.jsonl`(Claude Code の transcript ログ)を解析し、
//! 直近5時間・直近7日のトークン使用量を推定する。PHASE3A-SPEC.md 2.4 / AI-DESIGN.md 7.3。
//! 所有: Agent D。
//!
//! 注意: Claude Code に公式のクォータ取得 API は無いため、これはあくまで transcript からの
//! 推定値(ccusage 方式に準ずる簡易版)。フロント側は出どころ(`source: 'local-logs'` /
//! 「(推定)」表記)を明示すること(AI-DESIGN.md 7.3 の設計原則: 嘘の精度を見せない)。

use serde_json::Value;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

use super::time;

#[derive(Debug, Clone, serde::Serialize)]
pub struct UsageWindowEstimate {
    pub input_tokens: i64,
    pub output_tokens: i64,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ClaudeCodeUsageEstimate {
    /// 直近5時間(ローリングウィンドウ)の推定トークン数。
    pub last_5h: UsageWindowEstimate,
    /// 直近7日の推定トークン数。
    pub last_7d: UsageWindowEstimate,
}

impl Default for ClaudeCodeUsageEstimate {
    fn default() -> Self {
        Self {
            last_5h: UsageWindowEstimate {
                input_tokens: 0,
                output_tokens: 0,
            },
            last_7d: UsageWindowEstimate {
                input_tokens: 0,
                output_tokens: 0,
            },
        }
    }
}

/// root 配下を再帰的に走査して *.jsonl ファイルを集める。
/// 読めないディレクトリ・エントリは黙ってスキップする(panic しない)。
fn find_jsonl_files(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let entries = match fs::read_dir(root) {
        Ok(e) => e,
        Err(_) => return out,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            out.extend(find_jsonl_files(&path));
        } else if path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
            out.push(path);
        }
    }
    out
}

/// ファイルの mtime を UNIX 秒で返す。取得失敗時は 0(=最も古い扱い)。
fn mtime_unix(path: &Path) -> i64 {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// transcript の1行から (timestamp_unix, input_tokens, output_tokens) を抽出する。
/// フィールド名は Claude Code のバージョンにより変わりうるため複数候補を試す
/// (トップレベル "usage" / "message.usage" の順)。
/// パースできない・該当フィールドが無い行は None を返し、呼び出し側で黙ってスキップする
/// (壊れた行があっても panic させない)。
fn parse_usage_line(line: &str) -> Option<(i64, i64, i64)> {
    let v: Value = serde_json::from_str(line).ok()?;

    let ts_str = v
        .get("timestamp")
        .and_then(|x| x.as_str())
        .or_else(|| v.get("ts").and_then(|x| x.as_str()))?;
    let ts_unix = time::parse_iso8601_prefix(ts_str)?;

    let usage = v
        .get("usage")
        .or_else(|| v.get("message").and_then(|m| m.get("usage")))?;

    let input = usage
        .get("input_tokens")
        .and_then(|x| x.as_i64())
        .unwrap_or(0);
    let output = usage
        .get("output_tokens")
        .and_then(|x| x.as_i64())
        .unwrap_or(0);

    // usage フィールドはあるが input/output がどちらも取れない行は集計対象外
    // (cache_creation_input_tokens 等のキャッシュ系は Phase3a の集計対象外。
    //  TODO(Phase3b): AI-DESIGN.md 7.2 の cached_tokens 相当を別枠で扱いたくなったら追加する)。
    if input == 0 && output == 0 {
        return None;
    }
    Some((ts_unix, input, output))
}

/// 直近5時間・直近7日のトークン使用量を推定する。
/// `.claude/projects` が存在しない(Claude Code 未使用環境)場合はエラーではなく
/// 空の推定値(0件)を返す。
pub fn estimate_recent_usage() -> Result<ClaudeCodeUsageEstimate, String> {
    let home = match std::env::var("USERPROFILE") {
        Ok(v) => v,
        Err(_) => return Ok(ClaudeCodeUsageEstimate::default()),
    };
    let root = PathBuf::from(home).join(".claude").join("projects");
    if !root.is_dir() {
        return Ok(ClaudeCodeUsageEstimate::default());
    }

    let mut files = find_jsonl_files(&root);
    // 新しい順(mtime 降順)。PHASE3A-SPEC.md 2.4 の指示通り。
    files.sort_by_key(|p| std::cmp::Reverse(mtime_unix(p)));

    let now = time::unix_now();
    let cutoff_5h = now - 5 * 3600;
    let cutoff_7d = now - 7 * 24 * 3600;

    let mut estimate = ClaudeCodeUsageEstimate::default();

    for path in files {
        let file = match fs::File::open(&path) {
            Ok(f) => f,
            Err(_) => continue,
        };
        let reader = BufReader::new(file);
        for line in reader.lines() {
            let line = match line {
                Ok(l) => l,
                Err(_) => continue, // 非UTF-8 等で読めない行は無視して継続
            };
            if line.trim().is_empty() {
                continue;
            }
            let Some((ts, input, output)) = parse_usage_line(&line) else {
                continue;
            };
            if ts < cutoff_7d {
                continue;
            }
            estimate.last_7d.input_tokens += input;
            estimate.last_7d.output_tokens += output;
            if ts >= cutoff_5h {
                estimate.last_5h.input_tokens += input;
                estimate.last_5h.output_tokens += output;
            }
        }
    }

    Ok(estimate)
}
