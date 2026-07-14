//! ACP エージェントのプロセス管理・フレーミング・相関(PHASE3A-SPEC.md 2.2)。
//!
//! フレーミング: 子プロセスの stdout を `tokio::io::BufReader` + `lines()` で 1 行ずつ読み、
//! 各行を `serde_json::from_str` でパースする。送信も 1 メッセージ 1 行 + "\n" を stdin へ
//! 書き込む。Content-Length ヘッダーは付けない。
//!
//! JSON-RPC リクエスト ID はセッション(= 子プロセス)単位のインクリメンタル `u64`。
//! 送信した ID を `pending: HashMap<u64, oneshot::Sender<Result<Value, String>>>` で管理し、
//! 応答受信時に対応する oneshot へ send して相関する。

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::{oneshot, Mutex as TokioMutex};

use super::agents_config::{self, AgentConfig};
use super::protocol::{methods, NotificationMessage, RawMessage, RequestMessage, ResponseError};

type PendingMap = Arc<StdMutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>>;

/// 起動中のエージェントセッション 1 件分の子プロセスハンドル。
struct AgentSession {
    #[allow(dead_code)] // 現状は未使用だが、将来のセッション一覧表示等で使う想定で保持する。
    agent_id: String,
    acp_session_id: Option<String>,
    child: Child,
    stdin: Arc<TokioMutex<ChildStdin>>,
    pending: PendingMap,
    next_id: Arc<AtomicU64>,
    app: AppHandle,
}

/// フロントからの `session/request_permission` 応答待ち 1 件分。
struct PendingPermission {
    session_id: String,
    responder: oneshot::Sender<String>,
}

/// ACP マネージャの状態。
///
/// integrate: lib.rs で
/// `.manage(tokio::sync::Mutex::new(acp::manager::AcpManagerState::default()))` し、
/// `acp_list_agents` 等を `invoke_handler!` に登録すること。
#[derive(Default)]
pub struct AcpManagerState {
    sessions: HashMap<String, AgentSession>,
    pending_permissions: HashMap<String, PendingPermission>,
    permission_seq: u64,
    /// 起動処理中(spawn 済みだが initialize/session/new の応答をまだ待っている)の子プロセス。
    /// フロントが生成した `pending_id` をキーに保持し、フロントからの
    /// `acp_abort_pending_start` でユーザーがハングしたセッション開始を強制終了できるようにする
    /// (固定タイムアウトにしないのは、`npx` の初回パッケージダウンロードが正当に長時間かかり
    /// うるため)。initialize/session/new が完了したら成功・失敗を問わずここから取り除く。
    starting_processes: HashMap<String, Child>,
}

/// 起動処理中の子プロセスを `starting_processes` から取り除き、強制終了する。
/// initialize/session/new が失敗した場合の後始末に使う(呼んでも該当エントリが無ければ何もしない)。
async fn kill_and_remove_starting_process(
    state: &tauri::State<'_, TokioMutex<AcpManagerState>>,
    pending_id: &str,
) {
    let mut guard = state.lock().await;
    if let Some(mut child) = guard.starting_processes.remove(pending_id) {
        let _ = child.start_kill();
    }
}

static SESSION_SEQ: AtomicU64 = AtomicU64::new(1);

fn generate_session_id() -> String {
    let seq = SESSION_SEQ.fetch_add(1, Ordering::SeqCst);
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("acp-{ts}-{seq}")
}

/// 1 行 + "\n" を子プロセスの stdin へ書き込む。
async fn write_line(stdin: &Arc<TokioMutex<ChildStdin>>, line: &str) -> Result<(), String> {
    let mut guard = stdin.lock().await;
    guard
        .write_all(line.as_bytes())
        .await
        .map_err(|e| e.to_string())?;
    guard.write_all(b"\n").await.map_err(|e| e.to_string())?;
    guard.flush().await.map_err(|e| e.to_string())
}

/// リクエストを送信し、応答用の oneshot receiver を返す(応答は待たない)。
async fn send_request(
    stdin: &Arc<TokioMutex<ChildStdin>>,
    pending: &PendingMap,
    next_id: &Arc<AtomicU64>,
    method: &str,
    params: Value,
) -> Result<oneshot::Receiver<Result<Value, String>>, String> {
    let id = next_id.fetch_add(1, Ordering::SeqCst);
    let (tx, rx) = oneshot::channel();
    {
        let mut guard = pending
            .lock()
            .map_err(|_| "pending map mutex poisoned".to_string())?;
        guard.insert(id, tx);
    }
    let req = RequestMessage::new(id, method, params);
    let line = serde_json::to_string(&req).map_err(|e| e.to_string())?;
    write_line(stdin, &line).await?;
    Ok(rx)
}

/// リクエストを送信し、応答を待つ(起動時の initialize/session_new 用)。
async fn call(
    stdin: &Arc<TokioMutex<ChildStdin>>,
    pending: &PendingMap,
    next_id: &Arc<AtomicU64>,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    let rx = send_request(stdin, pending, next_id, method, params).await?;
    match rx.await {
        Ok(inner) => inner,
        Err(_) => Err(format!(
            "agent process closed the connection before responding to {method}"
        )),
    }
}

async fn send_notification(
    stdin: &Arc<TokioMutex<ChildStdin>>,
    method: &str,
    params: Value,
) -> Result<(), String> {
    let notif = NotificationMessage::new(method, params);
    let line = serde_json::to_string(&notif).map_err(|e| e.to_string())?;
    write_line(stdin, &line).await
}

/// エージェント(agent -> client のリクエスト)へ JSON-RPC レスポンスを書き戻す。
async fn send_response(
    stdin: &Arc<TokioMutex<ChildStdin>>,
    id: Value,
    result: Result<Value, ResponseError>,
) {
    let msg = match result {
        Ok(r) => json!({ "jsonrpc": "2.0", "id": id, "result": r }),
        Err(e) => json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": { "code": e.code, "message": e.message }
        }),
    };
    let line = match serde_json::to_string(&msg) {
        Ok(l) => l,
        Err(_) => return,
    };
    let _ = write_line(stdin, &line).await;
}

/// `fs/read_text_file`(agent -> client)。
/// TODO(Phase3b): editorStore の未保存バッファと連携する。Phase3a はディスク直読み。
async fn handle_fs_read_text_file(stdin: &Arc<TokioMutex<ChildStdin>>, id: Value, params: Value) {
    let path = params.get("path").and_then(|v| v.as_str());
    match path {
        Some(path) => match std::fs::read_to_string(path) {
            Ok(content) => send_response(stdin, id, Ok(json!({ "content": content }))).await,
            Err(e) => {
                send_response(
                    stdin,
                    id,
                    Err(ResponseError {
                        code: -32000,
                        message: format!("read failed: {e}"),
                        data: None,
                    }),
                )
                .await
            }
        },
        None => {
            send_response(
                stdin,
                id,
                Err(ResponseError {
                    code: -32602,
                    message: "missing \"path\" param".to_string(),
                    data: None,
                }),
            )
            .await
        }
    }
}

/// `fs/write_text_file`(agent -> client)。
/// TODO(Phase3b): editorStore の未保存バッファと連携する(開いているタブがあれば同期する)。
async fn handle_fs_write_text_file(stdin: &Arc<TokioMutex<ChildStdin>>, id: Value, params: Value) {
    let path = params.get("path").and_then(|v| v.as_str());
    let content = params.get("content").and_then(|v| v.as_str());
    match (path, content) {
        (Some(path), Some(content)) => match std::fs::write(path, content) {
            Ok(()) => send_response(stdin, id, Ok(json!({}))).await,
            Err(e) => {
                send_response(
                    stdin,
                    id,
                    Err(ResponseError {
                        code: -32000,
                        message: format!("write failed: {e}"),
                        data: None,
                    }),
                )
                .await
            }
        },
        _ => {
            send_response(
                stdin,
                id,
                Err(ResponseError {
                    code: -32602,
                    message: "missing \"path\" or \"content\" param".to_string(),
                    data: None,
                }),
            )
            .await
        }
    }
}

/// `session/request_permission`(agent -> client)。
/// フロントへ `acp://permission-request` イベントで転送し、`acp_respond_permission` からの
/// 応答(oneshot)を待ってからエージェントへ JSON-RPC レスポンスを書き戻す。
async fn handle_request_permission(app: &AppHandle, session_id: &str, id: Value, params: Value) {
    let (tx, rx) = oneshot::channel::<String>();
    let request_id = {
        let state = app.state::<TokioMutex<AcpManagerState>>();
        let mut guard = state.lock().await;
        guard.permission_seq += 1;
        let rid = format!("perm-{}", guard.permission_seq);
        guard.pending_permissions.insert(
            rid.clone(),
            PendingPermission {
                session_id: session_id.to_string(),
                responder: tx,
            },
        );
        rid
    };

    let payload = json!({ "requestId": request_id, "sessionId": session_id, "params": params });
    let _ = app.emit("acp://permission-request", payload);

    // options の具体的な kind/id はエージェント依存のためここでは解釈しない(フロント側の責務)。
    // 選択結果が無い場合(セッションが閉じられた等)は "cancelled" として応答する。
    let outcome = match rx.await {
        Ok(option_id) => json!({ "outcome": { "outcome": "selected", "optionId": option_id } }),
        Err(_) => json!({ "outcome": { "outcome": "cancelled" } }),
    };

    let stdin = {
        let state = app.state::<TokioMutex<AcpManagerState>>();
        let guard = state.lock().await;
        guard.sessions.get(session_id).map(|s| s.stdin.clone())
    };
    if let Some(stdin) = stdin {
        send_response(&stdin, id, Ok(outcome)).await;
    }
}

/// 子プロセスの stdout を読み続けるループ。行ごとに JSON-RPC メッセージとして振り分ける。
fn spawn_stdout_reader(
    app: AppHandle,
    session_id: String,
    stdout: ChildStdout,
    stdin: Arc<TokioMutex<ChildStdin>>,
    pending: PendingMap,
) {
    tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        loop {
            match lines.next_line().await {
                Ok(Some(line)) => {
                    if line.trim().is_empty() {
                        continue;
                    }
                    let raw: RawMessage = match serde_json::from_str(&line) {
                        Ok(v) => v,
                        Err(e) => {
                            eprintln!("acp[{session_id}]: failed to parse line: {e} ({line})");
                            continue;
                        }
                    };
                    handle_incoming(&app, &session_id, raw, &stdin, &pending).await;
                }
                Ok(None) => break, // EOF: プロセス終了
                Err(e) => {
                    eprintln!("acp[{session_id}]: stdout read error: {e}");
                    break;
                }
            }
        }

        // プロセスが終了/切断した場合、未応答の pending をすべてエラーで解決し、
        // 呼び出し側(call/send_request の待機者)が永久にハングしないようにする。
        let stale: Vec<oneshot::Sender<Result<Value, String>>> = match pending.lock() {
            Ok(mut guard) => guard.drain().map(|(_, tx)| tx).collect(),
            Err(_) => Vec::new(),
        };
        for tx in stale {
            let _ = tx.send(Err("agent process exited".to_string()));
        }

        let _ = app.emit(
            &format!("acp://{session_id}/update"),
            json!({ "sessionUpdate": "process_exit" }),
        );
    });
}

async fn handle_incoming(
    app: &AppHandle,
    session_id: &str,
    raw: RawMessage,
    stdin: &Arc<TokioMutex<ChildStdin>>,
    pending: &PendingMap,
) {
    match (&raw.method, &raw.id) {
        (Some(method), Some(id)) => {
            // agent からのリクエスト(応答が必要)。
            let method = method.clone();
            let id = id.clone();
            let params = raw.params.unwrap_or(Value::Null);
            match method.as_str() {
                methods::SESSION_REQUEST_PERMISSION => {
                    handle_request_permission(app, session_id, id, params).await;
                }
                methods::FS_READ_TEXT_FILE => {
                    handle_fs_read_text_file(stdin, id, params).await;
                }
                methods::FS_WRITE_TEXT_FILE => {
                    handle_fs_write_text_file(stdin, id, params).await;
                }
                other => {
                    send_response(
                        stdin,
                        id,
                        Err(ResponseError {
                            code: -32601,
                            message: format!("method not supported: {other}"),
                            data: None,
                        }),
                    )
                    .await;
                }
            }
        }
        (Some(method), None) => {
            // agent からの通知。
            if method == methods::SESSION_UPDATE {
                let params = raw.params.unwrap_or(Value::Null);
                // TODO(integrate/Phase3b): ACP の session/update に usage 情報を含む variant
                // (例: "usage_update")が来た場合、crate::usage::store::insert_usage_event へ
                // 記録する配線をここに追加する。現時点では実際の ACP 実装(claude-agent-acp)が
                // usage をどの variant・フィールド名で送るか未確認のため、誤ったフィールド名で
                // 嘘の値を記録しないよう見送る(AI-DESIGN.md 7.3 の「嘘の精度を見せない」方針)。
                // usage ダッシュボードの Claude Code 分は usage/claude_code_local.rs による
                // transcript 推定(source: local-logs)で代替済み。
                let _ = app.emit(&format!("acp://{session_id}/update"), params);
            } else {
                eprintln!("acp[{session_id}]: unhandled notification: {method}");
            }
        }
        (None, Some(id)) => {
            // こちらが送ったリクエストへの応答。
            let numeric_id = id.as_u64();
            let id_display = id.clone();
            let sender =
                numeric_id.and_then(|n| pending.lock().ok().and_then(|mut guard| guard.remove(&n)));
            match sender {
                Some(tx) => {
                    let result = if let Some(err) = raw.error {
                        Err(format!("{}: {}", err.code, err.message))
                    } else {
                        Ok(raw.result.unwrap_or(Value::Null))
                    };
                    let _ = tx.send(result);
                }
                None => {
                    eprintln!("acp[{session_id}]: unmatched response id: {id_display}");
                }
            }
        }
        (None, None) => {
            eprintln!("acp[{session_id}]: message with neither method nor id ignored");
        }
    }
}

#[tauri::command]
pub async fn acp_list_agents(
    _state: tauri::State<'_, TokioMutex<AcpManagerState>>,
) -> Result<Vec<AgentConfig>, String> {
    Ok(agents_config::default_agents())
}

#[tauri::command]
pub async fn acp_start_session(
    state: tauri::State<'_, TokioMutex<AcpManagerState>>,
    app: AppHandle,
    agent_id: String,
    cwd: String,
    pending_id: String,
) -> Result<String, String> {
    let agent_cfg = agents_config::find_agent(&agent_id)
        .ok_or_else(|| format!("unknown agent id: {agent_id}"))?;

    let cmd_display = format!("{} {}", agent_cfg.command, agent_cfg.args.join(" "));

    let mut command = Command::new(&agent_cfg.command);
    command
        .args(&agent_cfg.args)
        .current_dir(&cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    // 認証キー設定UI(agents_config::AgentConfig.secret_id/env_var)で保存された資格情報を
    // 子プロセスの環境変数へ注入する。未設定(secretsに値が無い)場合は何もせず、
    // ユーザーが環境変数を手動設定済みのケースも壊さない(エラーにしない設計を維持)。
    if let (Some(secret_id), Some(env_var)) = (&agent_cfg.secret_id, &agent_cfg.env_var) {
        if let Ok(value) = crate::secrets::get_secret(secret_id) {
            command.env(env_var, value);
        }
    }

    let mut child = command
        .spawn()
        .map_err(|e| format!("failed to start agent (`{cmd_display}` in `{cwd}`): {e}"))?;

    let stdin = match child.stdin.take() {
        Some(s) => s,
        None => {
            let _ = child.start_kill();
            return Err(format!("failed to open stdin for `{cmd_display}`"));
        }
    };
    let stdout = match child.stdout.take() {
        Some(s) => s,
        None => {
            let _ = child.start_kill();
            return Err(format!("failed to open stdout for `{cmd_display}`"));
        }
    };

    // stderr は読み捨てる(パイプバッファが埋まると子プロセスがブロックするため)。
    if let Some(stderr) = child.stderr.take() {
        let log_tag = agent_id.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                eprintln!("acp[{log_tag}] stderr: {line}");
            }
        });
    }

    // initialize/session/new の応答を待つ前に、フロントが `acp_abort_pending_start(pending_id)`
    // で強制終了できるよう Child を登録しておく(npx の初回パッケージダウンロード等で
    // 長時間かかりうるため、固定タイムアウトではなくキャンセル可能にする方針)。
    {
        let mut guard = state.lock().await;
        guard.starting_processes.insert(pending_id.clone(), child);
    }

    let stdin = Arc::new(TokioMutex::new(stdin));
    let pending: PendingMap = Arc::new(StdMutex::new(HashMap::new()));
    let next_id = Arc::new(AtomicU64::new(1));
    let session_id = generate_session_id();

    spawn_stdout_reader(
        app.clone(),
        session_id.clone(),
        stdout,
        stdin.clone(),
        pending.clone(),
    );

    // initialize: protocolVersion は現時点の最新として整数 1 を送る。
    // clientCapabilities は fs 読み書きのみ対応、terminal は Phase1 未実装のため false。
    let init_params = json!({
        "protocolVersion": 1,
        "clientCapabilities": {
            "fs": { "readTextFile": true, "writeTextFile": true },
            "terminal": false
        }
    });
    let init_result = match call(&stdin, &pending, &next_id, methods::INITIALIZE, init_params).await
    {
        Ok(v) => v,
        Err(e) => {
            kill_and_remove_starting_process(&state, &pending_id).await;
            return Err(format!("initialize failed for `{cmd_display}`: {e}"));
        }
    };
    if let Some(pv) = init_result.get("protocolVersion") {
        eprintln!("acp[{session_id}]: agent protocolVersion = {pv}");
    }

    // session/new: 作業ディレクトリを指定してセッションを作成する。MCP サーバは Phase3a 未使用。
    let session_new_params = json!({ "cwd": cwd, "mcpServers": [] });
    let session_new_result = match call(
        &stdin,
        &pending,
        &next_id,
        methods::SESSION_NEW,
        session_new_params,
    )
    .await
    {
        Ok(v) => v,
        Err(e) => {
            kill_and_remove_starting_process(&state, &pending_id).await;
            return Err(format!("session/new failed for `{cmd_display}`: {e}"));
        }
    };
    let acp_session_id = session_new_result
        .get("sessionId")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    // 起動処理が正常完了したので `starting_processes` から Child を取り出し、正式なセッションとして
    // `sessions` へ移す。ここに Child が無い場合は `acp_abort_pending_start` によって
    // initialize/session/new の完了と競合しつつ強制終了された稀なケースなので、エラーを返す。
    let child = {
        let mut guard = state.lock().await;
        match guard.starting_processes.remove(&pending_id) {
            Some(c) => c,
            None => {
                return Err(format!(
                    "session start for `{cmd_display}` was aborted before it could complete"
                ));
            }
        }
    };

    let session = AgentSession {
        agent_id,
        acp_session_id,
        child,
        stdin,
        pending,
        next_id,
        app,
    };

    let mut guard = state.lock().await;
    guard.sessions.insert(session_id.clone(), session);

    Ok(session_id)
}

/// 起動中(まだ initialize/session/new の応答待ち)のセッション開始を強制終了する。
/// `acp_start_session` がハングした場合にフロントから呼ばれる(このコマンドが解決すると、
/// 対応する `acp_start_session` 呼び出しは stdout EOF 経由でエラーを返して終わる)。
/// 該当する起動処理が既に完了/存在しない場合も(競合状態を考慮し)エラーにはせず `Ok(())` を返す。
#[tauri::command]
pub async fn acp_abort_pending_start(
    state: tauri::State<'_, TokioMutex<AcpManagerState>>,
    pending_id: String,
) -> Result<(), String> {
    kill_and_remove_starting_process(&state, &pending_id).await;
    Ok(())
}

#[tauri::command]
pub async fn acp_send_prompt(
    state: tauri::State<'_, TokioMutex<AcpManagerState>>,
    session_id: String,
    text: String,
) -> Result<(), String> {
    let (stdin, pending, next_id, acp_session_id, app) = {
        let guard = state.lock().await;
        let session = guard
            .sessions
            .get(&session_id)
            .ok_or_else(|| format!("unknown session: {session_id}"))?;
        (
            session.stdin.clone(),
            session.pending.clone(),
            session.next_id.clone(),
            session.acp_session_id.clone(),
            session.app.clone(),
        )
    };

    let params = json!({
        "sessionId": acp_session_id,
        "prompt": [ { "type": "text", "text": text } ]
    });
    let rx = send_request(&stdin, &pending, &next_id, methods::SESSION_PROMPT, params).await?;

    // session/prompt はエージェントのターン全体が終わるまで応答が返らない可能性があるため、
    // ここではブロックせずバックグラウンドで待ち、完了時に合成イベントとして emit する。
    // (`sessionUpdate: "prompt_result" / "prompt_error"` は本物の agent 発の session/update
    //  通知ではなく、Phase3a でこの Rust 側が合成したイベントであることに注意。)
    let app_for_task = app.clone();
    let session_id_for_task = session_id.clone();
    tokio::spawn(async move {
        match rx.await {
            Ok(Ok(result)) => {
                let _ = app_for_task.emit(
                    &format!("acp://{session_id_for_task}/update"),
                    json!({ "sessionUpdate": "prompt_result", "result": result }),
                );
            }
            Ok(Err(e)) => {
                let _ = app_for_task.emit(
                    &format!("acp://{session_id_for_task}/update"),
                    json!({ "sessionUpdate": "prompt_error", "error": e }),
                );
            }
            Err(_) => {
                // プロセス終了時の pending ドレインで通常は Ok(Err(..)) が送られるため、
                // ここに来るのは oneshot が破棄された稀なケースのみ。
            }
        }
    });

    Ok(())
}

#[tauri::command]
pub async fn acp_cancel(
    state: tauri::State<'_, TokioMutex<AcpManagerState>>,
    session_id: String,
) -> Result<(), String> {
    let (stdin, acp_session_id) = {
        let guard = state.lock().await;
        let session = guard
            .sessions
            .get(&session_id)
            .ok_or_else(|| format!("unknown session: {session_id}"))?;
        (session.stdin.clone(), session.acp_session_id.clone())
    };

    send_notification(
        &stdin,
        methods::SESSION_CANCEL,
        json!({ "sessionId": acp_session_id }),
    )
    .await
}

#[tauri::command]
pub async fn acp_respond_permission(
    state: tauri::State<'_, TokioMutex<AcpManagerState>>,
    request_id: String,
    option_id: String,
) -> Result<(), String> {
    let pending = {
        let mut guard = state.lock().await;
        guard.pending_permissions.remove(&request_id)
    };
    let pending = pending.ok_or_else(|| format!("no pending permission request: {request_id}"))?;
    pending.responder.send(option_id).map_err(|_| {
        "permission request is no longer awaited (agent may have disconnected)".to_string()
    })
}

#[tauri::command]
pub async fn acp_close_session(
    state: tauri::State<'_, TokioMutex<AcpManagerState>>,
    session_id: String,
) -> Result<(), String> {
    let mut guard = state.lock().await;
    if let Some(mut session) = guard.sessions.remove(&session_id) {
        // 終了できなくても致命的ではないため、エラーは無視して進める。
        let _ = session.child.start_kill();
    }
    guard
        .pending_permissions
        .retain(|_, p| p.session_id != session_id);
    Ok(())
}

/// 設定 UI の「接続テスト」用(認証キー設定 UI 追加要件)。
///
/// `AcpManagerState`(セッション管理用の状態)は使わない独立した関数として実装する
/// (正式なセッションは作らないため)。一時ディレクトリを cwd として子プロセスを spawn し、
/// `initialize` リクエストを1回送って最初に返ってきた JSON-RPC 応答行(result/error のどちらか)
/// で成否を判定する。判定後は成功・失敗を問わず必ず子プロセスを kill する。
#[tauri::command]
pub async fn acp_test_agent(agent_id: String) -> Result<bool, String> {
    let agent_cfg = agents_config::find_agent(&agent_id)
        .ok_or_else(|| format!("unknown agent id: {agent_id}"))?;

    // secret_id はあるが未設定(get_secret 失敗)の場合は、資格情報の問題として Ok(false) を返す
    // (Cloudflare の ai_test_connection と同じ「未設定はエラーでなく false」方針)。
    if let Some(secret_id) = &agent_cfg.secret_id {
        if crate::secrets::get_secret(secret_id).is_err() {
            return Ok(false);
        }
    }

    let cmd_display = format!("{} {}", agent_cfg.command, agent_cfg.args.join(" "));
    let cwd = std::env::temp_dir();

    let mut command = Command::new(&agent_cfg.command);
    command
        .args(&agent_cfg.args)
        .current_dir(&cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    if let (Some(secret_id), Some(env_var)) = (&agent_cfg.secret_id, &agent_cfg.env_var) {
        if let Ok(value) = crate::secrets::get_secret(secret_id) {
            command.env(env_var, value);
        }
    }

    // spawn 自体の失敗(npx.cmd が見つからない等)は資格情報の問題ではなく環境の問題なので
    // Err として区別する。
    let mut child = command.spawn().map_err(|e| {
        format!(
            "failed to start agent (`{cmd_display}` in `{}`): {e}",
            cwd.display()
        )
    })?;

    let stdin = child.stdin.take();
    let stdout = child.stdout.take();
    if let Some(stderr) = child.stderr.take() {
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(_line)) = lines.next_line().await {
                // 読み捨てる(パイプバッファが埋まると子プロセスがブロックするため)。
            }
        });
    }

    let (mut stdin, stdout) = match (stdin, stdout) {
        (Some(i), Some(o)) => (i, o),
        _ => {
            let _ = child.start_kill();
            return Err(format!("failed to open stdio for `{cmd_display}`"));
        }
    };

    let init_params = json!({
        "protocolVersion": 1,
        "clientCapabilities": {
            "fs": { "readTextFile": true, "writeTextFile": true },
            "terminal": false
        }
    });
    let req = RequestMessage::new(1, methods::INITIALIZE, init_params);

    // "テスト"操作であり acp_start_session 本来のフローと違って長時間ハングを許容する理由が
    // 無いため、ここだけは固定タイムアウト(30秒)を設ける。
    let outcome = tokio::time::timeout(std::time::Duration::from_secs(30), async {
        let line = serde_json::to_string(&req).map_err(|e| e.to_string())?;
        stdin
            .write_all(line.as_bytes())
            .await
            .map_err(|e| e.to_string())?;
        stdin.write_all(b"\n").await.map_err(|e| e.to_string())?;
        stdin.flush().await.map_err(|e| e.to_string())?;

        let mut lines = BufReader::new(stdout).lines();
        loop {
            match lines.next_line().await.map_err(|e| e.to_string())? {
                Some(line) => {
                    if line.trim().is_empty() {
                        continue;
                    }
                    let raw: RawMessage = match serde_json::from_str(&line) {
                        Ok(v) => v,
                        Err(_) => continue, // 壊れた/無関係な行は無視して次を待つ
                    };
                    if raw.result.is_some() {
                        return Ok::<bool, String>(true);
                    }
                    if raw.error.is_some() {
                        return Ok::<bool, String>(false);
                    }
                    // method を持つ行(agent からの逆方向リクエスト/通知)は無視して読み続ける。
                    continue;
                }
                None => return Ok::<bool, String>(false), // EOF: 応答前にプロセスが終了
            }
        }
    })
    .await;

    // 成功・失敗どちらの場合も子プロセスを生きたまま放置しない。
    let _ = child.start_kill();

    match outcome {
        Ok(Ok(ok)) => Ok(ok),
        Ok(Err(_)) => Ok(false),
        Err(_) => Ok(false), // タイムアウト
    }
}
